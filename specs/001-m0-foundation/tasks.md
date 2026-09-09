# M0 · 地基 —— 任务清单（Tasks）

> 勾选规则：**必须有对应的验证动作通过**才能勾。
> `[x]` = 已验证通过　`[~]` = 代码已写但未跑过　`[ ]` = 未做/被阻塞

## T1 仓库与工作区
- [x] T1.1 `git init` + `.gitignore`
- [x] T1.2 根 `package.json`（`packageManager: pnpm`，覆盖家目录里那个 yarn 声明）+ `pnpm-workspace.yaml`
- [x] T1.3 `Makefile` 统一入口
- [x] T1.4 `.env.example`
- [x] T1.5 四份 `CLAUDE.md`（根 + 三服务）

## T2 本地基础设施
- [x] T2.1 `docker-compose.yml`：postgres(pgvector) + redis
- [x] T2.2 `infra/postgres/init/01-roles.sql`：建 vector 扩展 + `app_backend` / `app_agent` 角色
- [x] T2.3 `make up` 起来，`make health` 数据库可连

## T3 backend（Node + Hono + Drizzle）
- [x] T3.1 `package.json` / `tsconfig.json` / `drizzle.config.ts`
- [x] T3.2 `src/db/schema/` 五张表（含 `vector(1024)`）
- [x] T3.3 `drizzle-kit generate` 产出 `0000_init.sql`
- [x] T3.4 手写 `0001_rls_and_roles.sql`：RLS + FORCE + policy + GRANT/REVOKE
- [x] T3.5 `src/db/client.ts`：`tenantTx()`（`set_config(..., true)`）
- [x] T3.6 `src/app.ts`：Hono + zod-openapi，`/health` + `/readyz`
- [x] T3.7 `src/openapi.ts`：导出 openapi.json（**不连库**）
- [x] T3.8 `tsc --noEmit` 通过

## T4 agent（Python + FastAPI）
- [x] T4.1 `pyproject.toml` + uv 锁定 Python 3.12
- [x] T4.2 `app/db/tables.py`：SQLAlchemy Core 表定义（手写，无迁移）
- [x] T4.3 `app/db/session.py`：`tenant_conn()`
- [x] T4.4 `app/main.py`：`/internal/health` + `/internal/readyz` + `x-internal-token` 校验
- [x] T4.5 `scripts/export_openapi.py`
- [x] T4.6 `uv sync` 成功，模块可导入

## T5 frontend（React + Vite）
- [x] T5.1 `package.json` / `vite.config.ts` / `tsconfig.json`
- [x] T5.2 `src/api/client.ts`：openapi-fetch，类型来自 `contracts/public/api.d.ts`
- [x] T5.3 一个健康检查页面（证明契约类型真的在用）
- [x] T5.4 `tsc --noEmit` + `vite build` 通过

## T6 契约管线
- [x] T6.1 `make contract` 产出两份 openapi.json + 两份 .d.ts
- [x] T6.2 `make contract-check`：重复运行无 diff
- [x] T6.3 `contracts/README.md`：SSE 事件协议 + 错误码表

## T7 隔离验证（M0 的核心）
- [x] T7.1 `backend/tests/rls.spec.ts`：A3 / A5 / A6 / A7
- [x] T7.2 `agent/tests/test_rls.py`：A4 / A5 / A6 / A7
- [x] T7.3 `agent/tests/test_schema_drift.py`：A8
- [x] T7.4 `make lint-db-access`：禁止裸连接
- [x] T7.5 `make test` 全绿

---

## 阻塞项

| 阻塞 | 影响任务 | 解除方式 |
|---|---|---|
| 本机无 Docker / Postgres / Homebrew | T2.3、T7.1~T7.5 | 安装 Docker Desktop 后 `make up && make migrate && make test` |

---

## 当前状态：M0 完成 ✅

**33/33 完成并验证。10 条验收标准全部通过。**

| 验收 | 断言 | 结果 |
|---|---|---|
| A1 | 三服务健康检查全绿 | ✅ backend / agent / frontend 均 200；agent `readyz` 返回 `database: ok`；缺 `x-internal-token` 时 401 |
| A2 | 迁移可重复执行 | ✅ 连跑三次，第二次起只有 `NOTICE ... already exists, skipping`，非错误 |
| A3 | 租户 A 查不到租户 B 的 chunk（Node 侧） | ✅ |
| A4 | 同上（Python 侧） | ✅ |
| A5 | 未设置租户返回 0 行而非报错（fail-closed） | ✅ 未设置与空串两种情况都验证了 |
| A6 | `app_agent` 查 `users`/`tenants` → permission denied | ✅ 另外验证了 `experts` 只读（UPDATE 被拒） |
| A7 | 跨租户写入被 `WITH CHECK` 拒绝 | ✅ 两侧 |
| A8 | Python 表定义与真实 DDL 无漂移 | ✅ |
| A9 | `make contract` 幂等 | ✅ |
| A10 | 前端用的是生成的类型 | ✅ 反证：后端字段改名后前端 `tsc` 报 `TS2339` |

测试总数：Node 6 条 + Python 11 条 = **17 条断言全过**。

### 数据库实况核对（不只信测试，直接查 catalog）

```
  relname   | rls | forced        tablename  |    policyname
------------+-----+--------      ------------+------------------
 build_jobs | t   | t             build_jobs | tenant_isolation
 chunks     | t   | t             chunks     | tenant_isolation
 experts    | t   | t             experts    | tenant_isolation
 tenants    | f   | f
 users      | f   | f

app_agent 实际被授权的表（允许清单生效）：
 build_jobs | DELETE,INSERT,SELECT,UPDATE
 chunks     | DELETE,INSERT,SELECT,UPDATE
 experts    | SELECT
```

### 实现过程中修掉的问题

| # | 问题 | 修法 |
|---|---|---|
| 1 | `SET LOCAL app.current_tenant = $1` 是非法 SQL（SET 不接受绑定参数） | 改用 `set_config(name, value, true)`，两侧统一；技术选型文档同步修正 |
| 2 | `current_setting(..., true)` 被设成空串时 `''::uuid` 抛错，策略从"过滤"变成"报错" | 策略加 `NULLIF(..., '')` |
| 3 | pytest-asyncio 的 session 级 fixture 与 function 级事件循环不匹配 | `asyncio_default_fixture_loop_scope`/`_test_loop_scope` 都设为 session |
| 4 | Docker Desktop for Mac 没把 CLI 链到 PATH，且 `docker-credential-desktop` 也在同一目录 | Makefile 内联 `PATH="$(DOCKER_DIR):$$PATH" docker`（`export PATH :=` 无效——GNU make 用启动时的 PATH 直接 exec） |

### 下一步

M1 内容入库。开工前先冻结 M1 的接口契约，再放三方并行。
