# ADR-003：七维条目需要区分「AI 提炼」与「博主手写」

- **状态**：已实现（backend + frontend，2026-09-16）
- **日期**：2026-09-11
- **相关**：`docs/M0-M6回顾与加固计划.md` 的 F02、F03；根 `CLAUDE.md`「前端发现接口缺字段：不要自己造 mock」

## 背景

七维确认页用 `evidenceChunkIds.length === 0` 判定「AI 推断、原文无出处」，并把该条标红：
"AI 推断的，你的原文里没有这句 —— 请核对或删掉"，顶部警告也会把它计入。

但博主在确认页**手动添加**的条目同样没有出处（前端 `emptyItem` 给的是 `[]`），
于是博主本人写的话被指认为 AI 编造。「怎么决策」维度的提示恰恰在鼓励博主自己补，
补得越多，红得越多。这是 M2 最核心的信任界面，误导的方向正好反了。

同一个根因还导致：`ExampleItem.evidenceChunkIds` 要求 `min(1)`，博主无法手动添加问答样本。

契约里没有任何能区分来源的字段。前端自己推断（比如记住本地新增的下标）在确认、刷新后
就会丢失，而且等于前端私自发明数据语义 —— 按 `CLAUDE.md`，前端停下，由后端补。

## 需要 backend 补

1. `ModelItem`、`ExampleItem` 增加 `origin: "ai" | "creator"`。
   **缺省视为 `"ai"`** —— 已有的 jsonb 草稿与快照不需要数据迁移。
2. `PUT /api/experts/{id}/model/{dimension}` 接受并持久化 `origin`。
3. `ExampleItem` 的证据约束改为：`origin = "ai"` 时 `min(1)`，`origin = "creator"` 时允许为空。
4. 跑 `make contract`，提交 `contracts/` 的变更。

agent 不需要改：它生成的草稿不带 `origin`，按缺省即为 `"ai"`。

## 语义约定（前后端共同遵守）

| 情形 | origin | 前端是否标红 |
|---|---|---|
| AI 提炼，有出处 | ai | 否 |
| AI 提炼，无出处（推断） | ai | **是** |
| 博主新增 | creator | 否 |
| 博主改写了一条 AI 条目 | creator（出处保留，仅作参考） | 否 —— 博主已经亲自过目并认领 |

前端的判定随之改为 `origin !== "creator" && evidenceChunkIds.length === 0`。

## 实现记录（2026-09-16）

- backend：`ItemOrigin` 注册为具名组件，`ModelItem` / `ExampleItem` 各加一个
  `origin`（`.default("ai")`）。`ExampleItem` 的证据约束从无条件 `min(1)`
  改为 `.refine(origin === "creator" || evidenceChunkIds.length >= 1)` ——
  `.refine()` 产生 ZodEffects，一度担心会让 `.openapi()` 的具名组件注册失效，
  实测没有问题，契约里 `ExampleItem` 仍是具名组件，只是不再带 `minItems`。
  条件约束表达不进 JSON Schema，由服务端兜底。
- frontend：判定改为 `isAiInferred`（先排除 `creator`），
  `emptyItem` 给新条目 `origin: "creator"`，博主改过的条目在 `patch` 里也归为
  `creator`；「真实样本」的"添加一条"入口恢复。禁区不加 `origin`（它是平台模板）。
- 不做数据迁移：存量 jsonb 里没有这个字段，读出来是 `undefined`，
  前端按 `!== "creator"` 判定，等价于 `ai`。backend 有一条回归测试守着这个读路径。

## 被否决的方案

- **前端用本地状态记住哪些是新增的**：确认、刷新之后就丢，且把数据语义藏在浏览器里，
  后端、看板、agent 都看不到。
- **用 `confidence = 1` 表示博主手写**：复用一个语义完全不同的字段，
  下一个读代码的人一定会误解；而且 AI 也可能给出 1.0。
