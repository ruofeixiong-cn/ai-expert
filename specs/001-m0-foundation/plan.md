# M0 · 地基 —— 实现方案（Plan）

## 1. 已确认的技术决策

| 决策 | 结论 | 依据 |
|---|---|---|
| 服务拆分 | frontend(React) / backend(Node) / agent(Python) | 见 `docs/技术选型与工程结构.md` §1 |
| 数据库归属 | **方案 B**：Python 读写 `chunks` / `build_jobs`，用受限角色 | 检索调优回路（切分→embedding→召回→阈值）必须留在同一门语言 |
| Node 框架 | **Hono** + `@hono/zod-openapi` | zod schema 直出 OpenAPI，契约零额外代码 |
| ORM | **Drizzle** + drizzle-kit | RLS 要在事务里 `set_config`、chunks 要 `vector(1024)`，都需要 SQL 级控制权 |
| PG 驱动 | postgres.js | 与 drizzle 配合好，事务 API 简洁 |
| Python DB | SQLAlchemy Core + asyncpg（**不做迁移**） | 表结构归 Node，Python 只需类型安全的查询构造 |

## 2. 三个 PG 角色

| 角色 | 谁用 | 权限 | RLS |
|---|---|---|---|
| `app_owner` | drizzle-kit 迁移 | DDL；是所有表的 owner | 被 `FORCE` 强制生效 |
| `app_backend` | Node 运行时 | 全部业务表 DML（含 `ALTER DEFAULT PRIVILEGES`，新表自动授权） | 生效 |
| `app_agent` | Python 运行时 | **允许清单**：`chunks`/`build_jobs` DML + `experts` SELECT。**无默认授权**，新表默认不可见 | 生效 |

> `app_agent` 刻意不给 `ALTER DEFAULT PRIVILEGES`：以后新增的业务表（orders / credit_ledger / users）对 Python **默认不可达**，要显式开口才行。这是"允许清单 > 拒绝清单"。

## 3. 关键实现点

### 3.1 `SET LOCAL` 不能带绑定参数 ⚠️

`SET LOCAL app.current_tenant = $1` 是**非法 SQL**——`SET` 不接受参数占位符。必须用函数形式：

```sql
SELECT set_config('app.current_tenant', $1, true)   -- 第三个参数 true = is_local，等价于 SET LOCAL
```

两侧都用这个写法。（`docs/技术选型与工程结构.md` §5.3 里我写的 `SET LOCAL ... = :t` 是错的，已随本次实现修正。）

### 3.2 RLS 策略必须处理空串

```sql
USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
```

`current_setting(..., true)` 在未设置时返回 NULL，但被设置成空串时返回 `''`，而 `''::uuid` 会抛错。`NULLIF` 把两种情况统一成 NULL → 比较结果 NULL → 0 行，fail-closed。

### 3.3 迁移分两个文件

| 文件 | 内容 | 生成方式 |
|---|---|---|
| `0000_init.sql` | 建表、索引 | `drizzle-kit generate`（从 schema 自动生成） |
| `0001_rls_and_roles.sql` | RLS enable/force/policy + GRANT/REVOKE | 手写（drizzle-kit 不会生成这些） |

角色的**创建**不在迁移里，在 `infra/postgres/init/01-roles.sql`——因为它需要 superuser，且生产环境（RDS）由 DBA 一次性执行。迁移只做 GRANT，角色不存在就会失败，这是期望行为（fail fast）。

### 3.4 唯一连接入口

```ts
// backend/src/db/client.ts —— 全项目唯一允许开事务的地方
export function tenantTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>
```
```python
# agent/app/db/session.py —— 全项目唯一允许开连接的地方
async def tenant_conn(tenant_id: UUID) -> AsyncIterator[AsyncConnection]
```

配套 CI 检查：`make lint-db-access` 用 grep 禁止在这两个文件之外出现裸 `db.transaction(` / `engine.begin(`。

### 3.5 索引策略（M0 只建 btree）

```sql
CREATE INDEX chunks_tenant_expert_channel_idx ON chunks (tenant_id, expert_id, channel);
```

**不建 HNSW**。RLS 会给每个查询加 `tenant_id` 谓词，单租户 chunk 量小时先 btree 过滤再精确扫描，召回率 100%。M1 结束后压测，单租户超过约 2 万 chunk 再上 HNSW。

### 3.6 契约管线

```
backend  --(src/openapi.ts)-->  contracts/public/openapi.json
                                  --(openapi-typescript)-->  contracts/public/api.d.ts
agent    --(scripts/export_openapi.py)--> contracts/internal/agent-openapi.json
                                  --(openapi-typescript)-->  contracts/internal/agent.d.ts
```

导出脚本**不得连数据库**——因此 `db` 必须惰性初始化，`app.ts` 只组装路由。

## 4. 表结构（M0 首版）

| 表 | RLS | 说明 |
|---|---|---|
| `users` | ❌ | 登录/注册在租户上下文之外；`is_anonymous` 为免登录试聊预留 |
| `tenants` | ❌ | 租户自身 |
| `experts` | ✅ | 租户内资源 |
| `chunks` | ✅ | `vector(1024)` + `embedding_model`/`embedding_dim`（换模型时要能识别重算范围） |
| `build_jobs` | ✅ | 构建进度，Python 写、Node 读 |

`orders` / `credit_ledger` / `materials` / `conversations` / `messages` / `feedbacks` 留到对应里程碑再加。
