# backend —— 业务与钱（Node + Hono + Drizzle）

对外唯一的公网 API 面。agent 服务只在内网可达，前端永远不直连它。

## 只做这些

认证、租户、专家 CRUD、素材上传 OSS、credits 账本、支付回调、反馈、看板聚合、
**全部数据库 DDL**、把 agent 的 SSE 流代理给浏览器。

## 绝不做

任何 embedding / 检索 / rerank / prompt 组装。这些全在 `agent/`。

## 数据库

- **本服务拥有全系统唯一的 schema 定义**：`src/db/schema/index.ts`。
  改了之后跑 `pnpm db:generate` 生成迁移。
- RLS 策略、角色 GRANT 这类语句 drizzle-kit 不会生成，手写在
  `drizzle/0001_rls_and_roles.sql` 那样的自定义迁移里
  （用 `pnpm exec drizzle-kit generate --custom --name xxx` 开新文件）。
- **给 agent 开表权限要显式写 GRANT。** `app_agent` 刻意没有
  `ALTER DEFAULT PRIVILEGES`，新表默认对 Python 不可达。
  写 GRANT 前先问一句：agent 真的需要碰这张表吗？

## 唯一的事务入口

```ts
await tenantTx(tenantId, async (tx) => { /* 受 RLS 保护的表在这里读写 */ });
await systemTx(async (tx) => { /* 只用于 users / tenants 这类租户外的表 */ });
```

`src/db/client.ts` 之外出现 `db.transaction(` 会被 `make lint-db-access` 拒绝。

## 接口约定

- 统一响应体 `{ code, message, data }`，`code: 0` 表示成功。
  前端按 `code` 分支，不解析 `message`。
- 路由用 `@hono/zod-openapi` 的 `createRoute` 定义 —— zod schema 就是契约来源，
  改完必须跑 `make contract`。
- 全异步。任何同步阻塞调用会卡住 SSE 流。

## SSE 代理有个坑

不能用 `new Response(upstream.body)` 零拷贝透传 —— 那样 Node 看不到流里的
`event: done`，就无法结算 credits、无法落 `messages`。必须用 `TransformStream`
边转发边嗅探，并挂 `c.req.raw.signal` 的 abort handler 兜底（客户端中途断开时
`flush` 不一定触发）。

## 完成一个改动前

```
pnpm exec tsc --noEmit && pnpm test && make contract
```
