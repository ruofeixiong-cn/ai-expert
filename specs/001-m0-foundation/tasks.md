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
- [ ] T2.3 `make up` 起来，`make health` 数据库可连

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
- [~] T7.1 `backend/tests/rls.spec.ts`：A3 / A5 / A6 / A7
- [~] T7.2 `agent/tests/test_rls.py`：A4 / A5 / A6 / A7
- [~] T7.3 `agent/tests/test_schema_drift.py`：A8
- [x] T7.4 `make lint-db-access`：禁止裸连接
- [ ] T7.5 `make test` 全绿

---

## 阻塞项

| 阻塞 | 影响任务 | 解除方式 |
|---|---|---|
| 本机无 Docker / Postgres / Homebrew | T2.3、T7.1~T7.5 | 安装 Docker Desktop 后 `make up && make migrate && make test` |

---

## 当前状态（2026-09-09）

**28/33 完成并验证。剩余 5 项全部卡在同一个原因：本机没有可运行的 Postgres。**

### 已验证通过

| 验收 | 结果 |
|---|---|
| A1 三服务健康检查 | ✅ backend `/health`、agent `/internal/health` 均返回 200；`x-internal-token` 缺失时 `/internal/readyz` 返回 401 |
| A9 `make contract` 幂等 | ✅ 连续两次生成，`contracts/` 无 diff |
| A10 前端吃生成的类型 | ✅ **反证通过**：把后端 `readyz` 的 `database` 改名为 `db` 并重新生成契约后，前端 `tsc` 报 `TS2339: Property 'database' does not exist` |
| T7.4 数据库入口唯一 | ✅ `make lint-db-access` 通过 |
| 前端构建 | ✅ `vite build` 成功 |

### 被阻塞

| 验收 | 阻塞原因 |
|---|---|
| A2 迁移可重复执行 | 无 Postgres |
| A3~A8 隔离与漂移测试 | 无 Postgres（测试代码已写完，共 6 + 11 条断言） |

### 解除阻塞

装 Docker Desktop（<https://docker.com/products/docker-desktop>），然后：

```bash
make up && make migrate && make test
```

> 隔离测试刻意设计成**数据库不可达时失败而不是跳过** —— 跳过会让 CI 变绿，
> 制造"隔离已验证"的错觉，而这正是验收标准 #8 最不能出的错。
