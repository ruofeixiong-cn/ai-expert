# M2 · 七维专家模型 —— 实现方案（Plan）

## 1. 草稿与定稿分离（本里程碑的核心结构决策）

```
agent（AI 生成）                         backend（博主确认）
  ↓ 写                                      ↓ 写
expert_model_drafts.model  ──读──▶  确认 ──▶  experts.expert_model
      「AI 说的」                              「博主认过的」
```

**为什么不让 agent 直接写 `experts.expert_model`**

1. **权限边界**：`app_agent` 只被 GRANT 了 `chunks` / `build_jobs` / `materials`。
   给它 `experts` 的 UPDATE 权限，就打开了"内容处理服务能改业务表"的口子。
   新建一张它自己的表、显式 GRANT，是允许清单机制的正确用法。
2. **不引入反向依赖**：另一个做法是 agent 回调 backend 的内部接口，
   但那会让 agent → backend 也产生依赖，两个服务互相调，边界就糊了。
3. **产品语义本来就是两个状态**：产品文档 §8 的整套设计就是"AI 生成 + 博主确认"。
   把它落成两张表，而不是一个字段加一个 `confirmed` 布尔，
   语义更清楚，也天然支持"重新生成不覆盖已确认内容"。

## 2. 数据结构

```jsonc
{
  "persona":       [{ "content": "...", "confidence": 0.8, "evidenceChunkIds": ["…"] }],
  "knowledge":     [ /* 同上 */ ],
  "beliefs":       [ /* 同上 */ ],
  "methodology":   [ /* 同上 */ ],
  "decisionRules": [ /* 同上 */ ],
  "boundaries":    [{ "content": "...", "kind": "impersonation|professional_advice|out_of_scope" }],
  "examples":      [{ "question": "...", "answer": "...", "evidenceChunkIds": ["…"] }]
}
```

`evidenceChunkIds` 是防脑补的抓手（spec §2）。Boundaries 不带证据 —— 它不是从原文提炼的。

## 3. 提炼流程

```
run_build（M1 已有）
  ├ parsing  →  chunking  →  embedding  →  写 chunks     ← M1
  └ extracting（新增，progress 90）
       1. 采样切片：按素材均匀取，总量不超过字符预算
       2. 编号：给每个切片一个短序号（c1, c2 …），映射到真实 UUID
       3. 调 qwen-max，Pydantic AI 约束结构化输出，要求每条给出引用序号
       4. 校验证据：把序号映射回 UUID；【模型编造的序号直接丢掉】，
          该条目降级为"无证据"（前端标红），而不是让整个提炼失败
       5. Boundaries 覆盖成平台三层默认模板
       6. 写 expert_model_drafts（整行替换）
```

**为什么给切片编短序号而不是直接给 UUID**：UUID 有 36 个字符，几十个切片光 ID 就占掉上千
token，而且模型复制长随机串很容易出错。`c1`/`c2` 这种短标记既省 token 又不易抄错，
映射回真实 ID 由我们自己做，模型编造的序号也一眼能查出来。

### 采样策略

一个专家可能有几千个切片，全喂进去既超上下文也烧钱。M2 的做法：
- 按素材轮转取切片（保证每篇文章都有代表），直到达到 `MAX_EXTRACT_CHARS`
- 优先取每篇的前几个切片（开头通常最能体现观点与风格）

这是个近似策略，M6 有黄金集后再用数据校准。

## 4. Boundaries：平台模板而非 AI 生成

产品文档 §7.2 把禁区拆成三层。这三类是**通用合规风险**，不是博主的个人特征，
AI 从文章里提炼不出来，硬让它猜只会给博主"平台已经想好了"的错觉。

所以由平台提供三条默认模板（对应三层），博主在其上增删改：

| kind | 默认文案 |
|---|---|
| `impersonation` | 被问"你是不是本人"时，如实说明自己是 AI 专家，不冒充博主本人 |
| `professional_advice` | 涉及投资、医疗、法律等具体操作时，给出免责说明，不提供确定性建议 |
| `out_of_scope` | 博主没有公开表达过立场的话题，说明"这个问题我没讲过"，不替博主编造观点 |

`POST /publish` 会校验 boundaries 非空 —— 这是合规生命线（C7）。

## 5. 重新生成不重新向量化（C10）

博主会反复重新生成七维直到满意。每次都重跑 embedding 是真金白银。

做法：`build_jobs` 加 `kind` 列（`full` | `model`）。
- `full`：M1 的完整流程（解析 → 切分 → 向量化 → 提炼）
- `model`：只跑提炼，直接读已有 chunks

`POST /api/experts/{id}/model/regenerate` → `POST /internal/extract-model` → 入队 `model` 类型任务。

## 6. 数据库变更（迁移 0005）

| 变更 | 说明 |
|---|---|
| 新建 `expert_model_drafts` | `expert_id` 主键（一个专家一份草稿，整行替换）、`tenant_id`、`model` jsonb、`chunk_count`、`generated_at`。**开 RLS + FORCE** |
| `GRANT SELECT, INSERT, UPDATE ON expert_model_drafts TO app_agent` | 允许清单显式开口。不给 DELETE —— 草稿只被覆盖，不该被 agent 删 |
| `experts` 加 `confirmed_dimensions text[]` | 记录博主确认过哪几个维度 |
| `experts` 加 `published_at` | 上线时间 |
| `build_jobs` 加 `kind` | `full` / `model` |

## 7. 契约

### 公开
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/experts/{id}/model` | 草稿 + 定稿 + 已确认维度 |
| PUT | `/api/experts/{id}/model/{dimension}` | **一次确认一个维度**（分块确认） |
| POST | `/api/experts/{id}/model/regenerate` | 重新生成（不重新向量化） |
| POST | `/api/experts/{id}/publish` | 上线，返回 share_slug |

`PUT` 按维度切开而不是整包提交，是为了对上产品文档 §8.4 的"分块确认"：
一次看一块、改一块、确认一块，而不是让博主面对一个巨大的表单。

### 内部
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/internal/extract-model` | 入队 `model` 类型任务 |

## 8. Pydantic AI 的使用边界

只出现在 `agent/app/pipeline/extract_model.py` 一个文件里（`agent/CLAUDE.md` 已写死这条）。
它负责 schema 约束 + 输出校验 + 失败带错误回喂重试。不允许侵入检索链路。

模型用 `qwen-max` 而不是 `qwen-plus`：这一步每个专家只跑几次，
质量直接决定博主的第一印象，是最不该省钱的地方。
