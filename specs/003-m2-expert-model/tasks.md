# M2 · 七维专家模型 —— 任务清单（Tasks）

> `[x]` = 已验证通过　`[~]` = 代码已写但未跑过　`[ ]` = 未做

## T1 契约冻结
- [x] T1.1 七维数据结构的 zod schema（后端）
- [x] T1.2 四个公开接口定义
- [x] T1.3 agent `POST /internal/extract-model` 的 Pydantic schema
- [x] T1.4 `make contract` + 三方 typecheck

## T2 数据库（迁移 0005）
- [x] T2.1 `expert_model_drafts` 表 + RLS + FORCE + policy
- [x] T2.2 `GRANT SELECT/INSERT/UPDATE ON expert_model_drafts TO app_agent`（不给 DELETE）
- [x] T2.3 `experts` 加 `confirmed_dimensions` / `published_at`
- [x] T2.4 `build_jobs` 加 `kind`
- [x] T2.5 同步 Python 镜像 + 漂移测试

## T3 agent：七维提炼
- [x] T3.1 `pipeline/sample.py`：按素材均匀采样，字符预算内
- [x] T3.2 `pipeline/extract_model.py`：Pydantic AI + 短序号引用
- [x] T3.3 证据校验：编造的序号丢弃，条目降级为无证据（C3）
- [x] T3.4 Boundaries 平台三层默认模板（C4）
- [x] T3.5 Examples 无证据则丢弃（C5）
- [x] T3.6 接入 `run_build` 的 extracting 阶段
- [x] T3.7 `model` 类型任务 + `POST /internal/extract-model`
- [x] T3.8 失败保留旧草稿（C11）
- [x] T3.9 单测 C2 / C3 / C4 / C5 / C11

## T4 backend
- [x] T4.1 `GET /model`：草稿 + 定稿 + 已确认维度
- [x] T4.2 `PUT /model/{dimension}`：分块确认（C6）
- [x] T4.3 `POST /model/regenerate`
- [x] T4.4 `POST /publish`：boundaries 校验 + share_slug（C7 / C8）
- [x] T4.5 测试 C6 / C7 / C8 / C9

## T5 frontend：分块确认页（本里程碑最值得打磨的界面）
- [x] T5.1 七维分块展示，按可靠度决定默认展开/折叠
- [x] T5.2 **无证据条目标红** + "这条是 AI 推断的，原文里没有"
- [x] T5.3 条目可编辑 / 删除 / 新增
- [x] T5.4 逐块确认（「一键全部确认」没做：未确认的维度本来就按草稿默认通过，
      再加一个按钮只会让博主以为不点就不生效）
- [x] T5.5 Boundaries 单独强调，未确认不给上线
- [x] T5.6 上线后展示分享链接
- [x] T5.7 `tsc` + `vite build`

## T6 端到端
- [x] T6.1 C1：构建后七个维度都在
- [x] T6.2 C10：重新生成不改变 chunk 数与 embedding
- [x] T6.3 `make verify` 全绿

---

## 当前状态：M2 完成 ✅

`make verify` 全绿：backend 39 + agent 36 + 端到端 9。
端到端两种模式都跑过 —— 假实现 6 秒，真实 qwen-max + 百炼向量 33 秒。

| 验收 | 断言 | 结果 |
|---|---|---|
| C1 | 构建后七个维度都在 | ✅ 端到端 |
| C2 | 证据 ID 全部指向该专家真实存在的切片 | ✅ 端到端拿数据库核对，不只看格式 |
| C3 | 编造的引用编号被丢弃，条目降级为无证据而非报错 | ✅ 单测 |
| C4 | 禁区恒为平台三层模板，不由 AI 生成 | ✅ 单测 + 端到端 |
| C5 | 无出处的问答样本被丢弃 | ✅ 单测 |
| C6 | 分块确认只影响被提交的那一维 | ✅ |
| C7 | 禁区为空不允许上线 | ✅ |
| C8 | 短链稳定，重复上线不变 | ✅ |
| C9 | 跨租户确认 / 上线返回 404 | ✅ |
| C10 | 重新生成不重跑向量化 | ✅ 端到端逐条比对 chunk 的 id、时间戳与向量前 4 维 |
| C11 | 提炼失败保留旧草稿，错误可读 | ✅ 单测 |

### 真实数据上的提炼效果（qwen-max，一篇 4 段理财文章）

```
persona        常用具体数字论证 / 语气直接，不绕弯子
knowledge      历史收益高不代表未来表现好 / 综合费率会显著影响最终收益 …
beliefs        普通人不适合做择时
decisionRules  只有急着用钱或基金经理换人时才停定投
boundaries     3 条平台模板
examples       4 条，答案全部出自原文

16 个证据引用 → 16 个真实存在，0 个脑补
```

### 实现过程中发现并修掉的问题

| # | 问题 | 怎么发现的 |
|---|---|---|
| 1 | 模型把「只有急用钱或基金经理换人才停定投」归进 beliefs，而它是决策规则 | **只有跑真实数据才会暴露**。prompt 加消歧后分类正确 |
| 2 | 提炼接进流水线后，agent 测试从 0.3 秒变 29 秒且每次花钱 | 跑测试时看时间 |
| 3 | 具名组件上直接 `.nullable()` 把可空烘进组件本身，前端 `keyof` 得到 `never` | 前端 tsc |
| 4 | agent 的 `response_model=None` 让契约缺响应结构 | 后端 tsc |

第 1 条最值得记：**假数据永远测不出提炼质量问题**。
`EXTRACT_PROVIDER=fake` 只能验结构与证据链，质量必须用真模型看。

### 下一步

M3 对话。四路召回 → Confidence Check → SSE 流式 → Safety Check。
两个已经拿到的校准数据会用上：rerank 相关 0.2956 / 无关 0.0059，
embedding 相关 0.7544 / 无关 0.2961。
