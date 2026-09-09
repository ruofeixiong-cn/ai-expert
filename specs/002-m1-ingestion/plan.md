# M1 · 内容入库 —— 实现方案（Plan）

## 1. 数据链路全景

```
浏览器
  │ POST /api/auth/login → JWT{userId, tenantId, role}
  │ POST /api/experts                        ┐
  │ POST /api/experts/{id}/materials         │ backend（Node）
  │ POST /api/experts/{id}/build             │ 认证 · 租户上下文 · 素材落库
  ▼                                          ┘
backend ──POST /internal/build──▶ agent（Python）
  │        {expertId, tenantId}                │ ARQ 入队，立即返回 jobId
  │                                            ▼
  │                                     worker: build_expert
  │                                       1. 读 materials（app_agent 只读）
  │                                       2. clean  → 注入清洗 + 标记
  │                                       3. chunk  → 标题感知切分
  │                                       4. embed  → Provider（真/假可切）
  │                                       5. 事务内写 chunks（全成功或全回滚）
  │                                       各阶段更新 build_jobs.progress
  ▼
GET /api/experts/{id} ──读 build_jobs──▶ 前端轮询进度
```

## 2. 关键决策

### 2.1 M1 不接 OSS

原始文本存 `materials.raw_text`（Postgres `text` 列，一篇长文几万字完全放得下）。
`storage_key` 字段现在就建好但留空 —— 接 OSS 时只需要填这个字段 + 把 `raw_text` 改成惰性加载，不用改表结构。

**理由**：OSS 需要阿里云账号 + AccessKey，是一条外部依赖。M1 的价值是证明数据链路，不该被账号申请卡住。
文件上传（.docx/.pdf）在 M1 也是**先解析成文本再丢弃原文件** —— 真正需要留存原文件是二期的事。

### 2.2 Embedding 走可切换 Provider

```python
class EmbeddingProvider(Protocol):
    name: str
    dim: int
    async def embed(self, texts: list[str]) -> list[list[float]]: ...
```

| 实现 | 何时用 | 说明 |
|---|---|---|
| `DashScopeEmbedding` | 有 `DASHSCOPE_API_KEY` 时 | 百炼 `text-embedding-v3`，OpenAI 兼容端点 |
| `FakeEmbedding` | 无 key / CI / 单测 | **确定性**：`sha256(text)` 播种伪随机，同文本永远同向量 |

由 `EMBEDDING_PROVIDER` 环境变量选择，默认 `auto`（有 key 用真的，没 key 用假的并在启动日志里明确警告）。

**为什么值得**：
- 百炼 key 还没到位，但 M1 现在就要能端到端跑通；
- CI 不该依赖外部 API（会 flaky、会花钱）；
- 假向量是确定性的，所以"同内容 → 同向量"这类断言仍然成立。

⚠️ 假向量**没有语义**，所以 M3 的检索质量测试必须用真 Provider。这一点写进 `agent/CLAUDE.md`。

### 2.3 切分策略

```
1. 按 Markdown 标题层级切段（H1/H2/H3），维护"标题路径"
2. 段落聚合到 400~600 token，重叠 10~15%
3. 每个 chunk 的【嵌入文本】 = "文章标题 > 小节标题\n\n" + 正文
   （入库的 content 也带这个前缀，M3 拼 prompt 时才知道这段出自哪）
```

**token 计数**：M1 用字符近似（中文 1 token ≈ 1~1.5 字），封装成 `count_tokens()`。
不引 tokenizer 依赖 —— 精确计数对切分质量的影响远小于"标题前缀"这一条，等 M6 调优时再换。

所有切分参数集中在 `agent/app/pipeline/config.py`，M6 调优时只改这一个文件。

### 2.4 注入清洗：标记而非删除

```python
INJECTION_PATTERNS = [
    r"忽略(以上|之前|上面)(所有)?(的)?(指令|要求|提示)",
    r"(系统|System)\s*(提示词|prompt)",
    r"ignore\s+(all\s+)?(previous|above)\s+instructions",
    r"you\s+are\s+now",
    r"<\|im_(start|end)\|>",
]
```

命中的 chunk：`source` 保持不变，`confidence` 降到 `0.2`，并记 `injection_flag`。
**不删除** —— 因为可能是博主在写"如何防范提示词注入"的正常文章。降权让它进不了高置信度召回（M3 的 Confidence Check 会滤掉），但内容仍在。

### 2.5 写 chunks 必须原子

一次构建可能产生几十上百条 chunks。中途失败留下半截数据，会让"重新构建"产生重复。
所以：**先删除该 material 已有的 chunks，再批量插入，全部在一个事务里**。

```python
async with tenant_conn(tenant_id) as conn:   # 一个事务
    await conn.execute(delete(chunks).where(chunks.c.material_id == mid))
    await conn.execute(insert(chunks), rows)
```

### 2.6 成本护栏

| 护栏 | 值 | 位置 |
|---|---|---|
| 单次构建 chunk 上限 | 2000 | agent，超出则 `failed` 并提示分批 |
| 单条 material 字数上限 | 100,000 | backend，上传时就拒 |
| embedding 批大小 | 25 | agent，百炼单次上限 |
| 内容去重 | `content_hash` | backend 落 material 时算，重复直接复用 |

## 3. 数据库变更（迁移 0002）

| 变更 | 说明 |
|---|---|
| 新建 `materials` 表 | 含 `tenant_id`，**要开 RLS + FORCE + policy** |
| `chunks` 加 `material_id` | 溯源用；M3 回答时要能说"出自哪篇文章" |
| `chunks` 加 `injection_flag` | §2.4 的标记 |
| `GRANT SELECT ON materials TO app_agent` | **允许清单机制的第一次实际使用** —— 显式开口，不是自动继承 |
| `materials` 的 `(tenant_id, expert_id)` 索引 | |

`materials` 字段：
`id, tenant_id, expert_id, source_type('paste'|'file'|'url'), source_url, title, raw_text, content_hash, storage_key, created_at`

**没有 `status` 列** —— 构建状态统一看 `build_jobs`，避免两处状态互相矛盾。

## 4. 认证实现

| 项 | 做法 |
|---|---|
| 密码哈希 | `@node-rs/argon2` |
| Token | `jose` 签 JWT，payload `{sub, tenantId, role}`，有效期 7 天（M1 先不做 refresh） |
| 中间件 | `authMiddleware` 解析 JWT → `c.set("auth", {userId, tenantId, role})` |
| 租户注入 | 路由里 `tenantTx(c.get("auth").tenantId, ...)`，**不允许从请求体读 tenantId** |
| 注册即建租户 | 一个事务里 `insert users` + `insert tenants`，失败一起回滚 |

## 5. 契约（本轮先冻结，再实现）

### 公开 API（backend → frontend）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册博主，返回 token；同时建租户 |
| POST | `/api/auth/login` | 登录 |
| GET | `/api/me` | 当前用户 + 租户 |
| POST | `/api/experts` | 创建专家 |
| GET | `/api/experts` | 我的专家列表 |
| GET | `/api/experts/{id}` | 专家详情 + 最近一次构建进度 |
| POST | `/api/experts/{id}/materials` | 上传素材（粘贴/文件/链接） |
| GET | `/api/experts/{id}/materials` | 素材列表 |
| POST | `/api/experts/{id}/build` | 触发构建，返回 jobId |

### 内部 API（agent → backend）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/internal/build` | 入队构建任务，立即返回 jobId |
| GET | `/internal/health` / `/internal/readyz` | M0 已有 |

M2 的 `/internal/extract-model`、M3 的 `/internal/chat` 本轮不定义 —— 契约只冻结当前里程碑真正要用的部分，避免定了又改。
