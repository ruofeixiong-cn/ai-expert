# M0 · 地基 —— 规格（Spec）

**状态**：进行中
**上游**：`docs/AI专家平台-MVP产品文档.md` §9（数据隔离）、§12（表结构）、§14（验收标准 #8）
**下游**：M1 内容入库

---

## 1. 为什么要有 M0

MVP 的 9 条验收里，**第 8 条"租户 A 的专家检索不到租户 B 的知识"是唯一一条无法事后补的**。它是基础设施属性：一旦业务代码在没有隔离的库上长起来，再回头补 RLS 需要重审每一条 SQL。

同时，三个服务（frontend / backend / agent）并行开发的前提是**契约先存在**。契约机制不在 M0 建好，M1 就会出现三方各自臆想接口。

因此 M0 的存在意义只有两条：**把隔离做成基础设施**，**把契约做成可编译产物**。它不交付任何用户可见功能。

---

## 2. 范围

### 做

1. 三服务骨架跑起来（frontend / backend / agent），各有健康检查
2. 数据库 schema 的第一版：`users` / `tenants` / `experts` / `chunks` / `build_jobs`
3. **RLS 隔离**：策略 + `FORCE` + 三个 PG 角色 + 权限允许清单
4. **两侧 tenant 会话入口**：Node 的 `tenantTx()`、Python 的 `tenant_conn()`，全项目唯一开连接的地方
5. **契约管线**：两份 OpenAPI + 两份 TS 类型，`make contract` 幂等
6. 隔离的自动化测试（Node 侧 + Python 侧各一份）

### 不做

认证逻辑、任何业务接口、内容解析、向量化、检索、支付、UI 页面。M0 的前端只有一个证明"能调通后端"的页面。

---

## 3. 验收标准（可执行，全部通过才算 M0 完成）

| # | 断言 | 验证方式 |
|---|---|---|
| A1 | 三个服务启动后健康检查全绿 | `make health` |
| A2 | 迁移可从空库跑到最新，且可重复执行不报错 | `make migrate` ×2 |
| A3 | **设置 tenant A 后，按 id 查 tenant B 的 chunk 返回 0 行**（Node 侧） | `backend/tests/rls.spec.ts` |
| A4 | **同上（Python 侧）** | `agent/tests/test_rls.py` |
| A5 | **未设置 `app.current_tenant` 时查 chunks 返回 0 行**（fail-closed，不是报错） | 两侧测试 |
| A6 | **以 `app_agent` 角色查 `users` 表 → permission denied** | 两侧测试 |
| A7 | 以 tenant A 身份插入 tenant_id = B 的行 → 被拒绝（`WITH CHECK` 生效） | 两侧测试 |
| A8 | Python 侧表定义与真实 DDL 一致（列名/类型无漂移） | `agent/tests/test_schema_drift.py` |
| A9 | `make contract` 连续跑两次，`git diff contracts/` 为空 | `make contract-check` |
| A10 | 前端 `tsc --noEmit` 通过，且调用后端用的是 `contracts/public/api.d.ts` 的类型 | `make typecheck` |

> A5 的 "0 行而不是报错" 是刻意的：策略必须 fail-closed。如果忘记设置租户就抛异常，开发者会倾向于加 try/catch 绕过；返回 0 行则会让功能直接不工作，逼着人正确设置。

---

## 4. 明确的非目标

- **不追求性能**：M0 不建 HNSW，不做连接池调优。
- **不追求安全完备**：dev 密码写在 `.env.example` 里；生产密钥管理是部署时的事。
- **不封装抽象**：M0 只建立"唯一入口"（`tenantTx` / `tenant_conn`），不预先设计 repository / service 分层。

---

## 5. 风险

| 风险 | 后果 | 对策 |
|---|---|---|
| `SET LOCAL` 写成 `SET` | 租户粘在连接上，跨租户泄露 | 两侧只允许通过 `tenantTx`/`tenant_conn` 开连接；CI grep 禁止裸连接 |
| 表 owner 绕过 RLS | 策略形同虚设 | 必须 `FORCE ROW LEVEL SECURITY`；运行时角色 ≠ 表 owner |
| `current_setting` 返回空串 | `''::uuid` 抛错而非返回 0 行 | 策略里用 `NULLIF(..., '')` |
| Python 表定义与 DDL 漂移 | 运行时才发现字段不存在 | A8 的漂移测试 |
