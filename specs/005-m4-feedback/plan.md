# M4 · 反馈与看板 —— 实施计划（Plan）

---

## 1. 改动面

| 服务 | 改什么 |
|---|---|
| `backend/` | 迁移 0011、feedbacks 表、2 个接口、1 个服务 |
| `frontend/` | 分享页赞/踩按钮、专家详情页看板卡片 |
| `agent/` | **一行都不改** |

agent 不参与是对的：反馈是业务数据，不是内容处理。
`app_agent` 也**不给 feedbacks 任何权限** —— M6 评测将来若要读，那天再单独 GRANT。

---

## 2. 数据库（迁移 0011）

```sql
CREATE TABLE feedbacks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  message_id   uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  fan_user_id  uuid NOT NULL REFERENCES users(id),
  rating       text NOT NULL,          -- 'up' | 'down'
  comment      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX feedbacks_message_fan_uidx ON feedbacks (message_id, fan_user_id);
```

**唯一索引就是"改主意"的实现**：赞→踩走 `ON CONFLICT DO UPDATE`，
不是插第二条。否则满意度会被同一个人投两次票污染。

RLS 照旧三件套（ENABLE / FORCE / tenant_isolation policy）。

`ON DELETE CASCADE` 挂在 message 上：删对话就带走反馈，不留孤儿行。

---

## 3. 接口

### 3.1 `POST /api/chat/{slug}/feedback` —— 粉丝，不需登录

```
body: { messageId, rating: 'up'|'down', comment?: string(≤200) }
```

写入前的三道校验，缺一不可：

| 校验 | 挡住什么 | 靠什么 |
|---|---|---|
| slug → tenant | 跨租户 | `resolve_share_slug` + RLS |
| message 属于 assistant | 给自己的提问打分 | `role = 'assistant'` |
| **conversation.fan_user_id = 我** | **给别人的对话打分** | **应用层显式 join** |

第三条 RLS 管不了（见 spec §4）。任何一条不过 → **404**，不是 403。

### 3.2 `GET /api/experts/{id}/stats` —— 博主，需登录

```
{ answers, satisfaction: number|null, upVotes, downVotes,
  revenueCents: 0, blindspots, recentBlindspots: [...] }
```

### 3.3 `GET /api/chat/{slug}` 补 `history`

**这是写 M4 时发现的一个 M3 漏洞**：粉丝关掉页面再打开，对话记录没了，
但试聊额度是按库里的回答数算的 —— 屏幕上空空如也，却显示"剩余 1 条"。

顺手补上：返回最近 50 条历史，每条带 `myRating`。
F1「刷新后按钮保持选中」也就自然成立了 —— 否则那条验收根本无从谈起。

---

## 4. 盲区判定放在哪

**一个常量，一处 SQL。**

```ts
// backend/src/services/feedback.ts
export const BLINDSPOT_CONFIDENCE = 0.15;
const IS_BLINDSPOT = sql`coalesce(m.confidence, 0) < ${BLINDSPOT_CONFIDENCE}`;
```

判据只有置信度 —— 点踩不参与。**为什么，以及这一版是怎么被真实模型推翻重写的，
见 spec §5。** 简短版：一个 0.1163 的问题擦着入口闸门过去了，
模型自己答「这个他没有讲过」，`finish_reason` 是 `stop` 而不是 `no_context`，
粉丝看完就走没点踩 —— 按第一版规则，一个教科书级的盲区一条都记不上。

## 5. 看板 SQL

一次 `execute` 拿全部计数，再一次拿盲区列表。不做 N+1。

问题原文用 `LATERAL` 取回答**之前最近的那条 user 消息** ——
不能靠 `id-1` 之类的顺序假设，`created_at DESC LIMIT 1` 才是真的。

> ⚠️ 用裸 SQL 而非 Drizzle 表达式，是因为 M2 踩过：
> Drizzle 的关联子查询会把 `${experts.id}` 渲染成裸 `"id"`，
> 被内层表捕获，**结果恒为 0 且不报错**。裸 SQL 里写全限定名，眼睛能看见。

---

## 6. 前端

### 6.1 分享页

每条 assistant 消息下面一排：`👍 👎`。点踩后展开一个可选的原因输入框
（一行，200 字，可以直接不填就走）。

**摩擦必须低到接近零** —— 规划文档把"用户没动机反馈"列为头号风险。
点一下就落库，原因是可选的锦上添花。

`message_id` 从 SSE 的 `meta` 事件拿（M3 已经在发，前端之前扔掉了）。

### 6.2 专家详情页

`status = 'online'` 时才显示看板卡片 —— 没上线的专家不可能有数据，
显示四个 0 只会让人以为出了问题。

- 满意度 `null` → 显示「暂无评价」，不显示 0%
- 收入 → 显示 `¥0.00` + 灰字「M5 接入付费后生效」
- 盲区列表 → 问题原文 + 时间 + 一个标签说明为什么算盲区
  （「没有相关内容」/「被点踩且置信度低」）

---

## 7. 顺序

```
V1 契约 → V2 迁移 → V3 backend 服务 → V4 backend 路由+测试 → V5 前端 → V6 端到端
```

契约先冻结，前后端才能并行；迁移在服务之前，否则 schema 漂移测试会红。
