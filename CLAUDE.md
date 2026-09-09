# AI 专家平台

把知识型博主的知识和经验，变成一个 24 小时在线、能变现的 AI 专家。
商业模式：博主免费建专家，**粉丝付费提问**，平台抽成 + 博主分成。

产品文档在 `docs/`，技术方案在 `docs/技术选型与工程结构.md`，
当前里程碑的规格在 `specs/`。

## 三个服务

| 目录 | 技术栈 | 职责 | 一句话 |
|---|---|---|---|
| `frontend/` | React 19 + Vite + TS | Creator 控制台 + 粉丝对话页 | —— |
| `backend/` | Node + Hono + Drizzle | 认证、租户、专家、素材、credits、支付、看板、**全部 DDL**、SSE 代理 | **管钱** |
| `agent/` | Python 3.12 + FastAPI + ARQ | 解析、切分、向量化、召回、rerank、双闸门、七维提炼、流式生成 | **管脑** |

`contracts/` 是唯一的跨服务产物，全部由 `make contract` 生成。

## 边界规则（硬约束）

- **一个任务只改一个服务目录。** 需要跨界时，先在 `docs/adr/` 记一条再动。
- **`contracts/` 禁止手写。** 它是 `make contract` 的产物；手写会在下次生成时被覆盖，
  并让"契约即编译期检查"失效。
- **`agent/` 不得包含任何数据库迁移。** 表结构的唯一来源是
  `backend/src/db/schema/index.ts`。要加列去那里加。
- **改了 API schema 必须跑 `make contract` 并提交 `contracts/` 的变更。**
  CI 的 `make contract-check` 会拦。
- **前端发现接口缺字段：不要自己造 mock 蒙混过去。** 在 `docs/adr/` 记一条说明
  "需要后端补 X"，然后停下来。

## 隔离是这个项目最不能出错的东西

租户隔离由数据库强制（RLS + 角色权限），不靠应用层自觉。
两条铁律，改任何涉及数据库的代码前先读 `specs/001-m0-foundation/plan.md` §3：

1. **只能通过 `tenantTx()`（Node）/ `tenant_conn()`（Python）访问受 RLS 保护的表。**
   `make lint-db-access` 会拒绝在别处开连接。
2. **设置租户只能用 `set_config('app.current_tenant', $1, true)`。**
   `SET LOCAL x = $1` 是非法 SQL；`SET`（不带 LOCAL）会把租户粘在连接上，
   连接归还池子后被下一个请求复用 → 跨租户泄露。

## 常用命令

```
make install   # 装三个服务的依赖
make up        # 起 postgres + redis
make migrate   # 跑迁移
make dev       # 同时起三个服务
make contract  # 重新生成契约
make test      # 全部测试（需要 postgres 在跑）
```
