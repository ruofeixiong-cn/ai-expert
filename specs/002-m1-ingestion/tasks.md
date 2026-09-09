# M1 · 内容入库 —— 任务清单（Tasks）

> `[x]` = 已验证通过　`[~]` = 代码已写但未跑过　`[ ]` = 未做

## S1 契约冻结（先做，做完再放三方并行）
- [x] S1.1 backend：9 个公开接口的 zod schema（只定义，不实现逻辑）
- [x] S1.2 agent：`POST /internal/build` 的 Pydantic schema
- [x] S1.3 `make contract` 产出两份新契约
- [x] S1.4 三方 `make typecheck` 通过
- [x] S1.5 **人工过一遍接口清单**（接口设计是产品决策，值得停一下）

## S2 数据库（迁移 0002）
- [x] S2.1 `materials` 表 + RLS + FORCE + policy
- [x] S2.2 `chunks` 加 `material_id` / `injection_flag`
- [x] S2.3 `GRANT SELECT ON materials TO app_agent`（允许清单显式开口）
- [x] S2.4 同步 `agent/app/db/tables.py` 镜像
- [x] S2.5 漂移测试通过（B9）

## S3 backend：认证与租户
- [x] S3.1 `@node-rs/argon2` + `jose` 依赖
- [x] S3.2 `POST /api/auth/register`（一个事务里建 user + tenant）
- [x] S3.3 `POST /api/auth/login` + `GET /api/me`
- [x] S3.4 `authMiddleware`：JWT → `c.set("auth", ...)`
- [x] S3.5 测试 B1 / B2

## S4 backend：专家与素材
- [x] S4.1 专家 CRUD（建/列表/详情）
- [x] S4.2 素材上传：粘贴正文 + 文件 + 链接三种 `source_type`
- [x] S4.3 `content_hash` 去重（B6）+ 字数上限
- [x] S4.4 `POST /build` → 调 agent typed client（读 `contracts/internal/agent.d.ts`）
- [x] S4.7 `POST /internal/extract`（新增）：url 抓取与 docx/pdf 解析，同步返回
- [x] S4.5 `GET /api/experts/{id}` 带最近一次构建进度
- [x] S4.6 测试 B3（跨租户返回 404）

## S5 agent：解析流水线
- [x] S5.1 `pipeline/config.py`：切分参数集中一处
- [x] S5.2 `pipeline/clean.py`：注入清洗 + 标记降权（B7）
- [x] S5.3 `pipeline/chunk.py`：标题感知切分 + 标题路径前缀（B5）
- [x] S5.4 `pipeline/embed.py`：`EmbeddingProvider` + DashScope/Fake 两实现
- [x] S5.5 `pipeline/parse.py`：trafilatura（链接）/ pymupdf / python-docx
- [x] S5.6 `workers/build.py`：ARQ 任务 + 分阶段进度 + 失败写回（B10）
- [x] S5.7 写 chunks 原子性（先删后插，同一事务）
- [x] S5.8 `POST /internal/build` 实现
- [x] S5.9 单测 B5 / B7 / B10

## S6 frontend
- [x] S6.1 登录 / 注册页
- [x] S6.2 专家列表 + 新建专家
- [x] S6.3 素材上传（粘贴正文优先，文件与链接次之）
- [x] S6.4 构建进度条（TanStack Query 轮询）
- [x] S6.5 `tsc --noEmit` + `vite build`

## S7 端到端
- [x] S7.1 B4：粘贴 3000 字 → chunks ≥ 5 且 tenant_id 全对
- [x] S7.2 B6：重复上传不产生重复 chunks
- [x] S7.3 B8：进度可读、失败可读
- [x] S7.4 B11：`make contract-check && make typecheck && make test` 全绿

---

## 当前状态：M1 完成 ✅

**测试：29 passed（backend）+ 28 passed（agent）+ 4 passed（端到端）**
`make verify` 全绿 —— 单元 / 集成 / 端到端 / 契约同步 / 三方类型检查。

| 验收 | 断言 | 结果 |
|---|---|---|
| B1 | 注册即建租户，关联正确 | ✅ token 里的 tenantId 就是新建租户 |
| B2 | 未带 JWT 访问返回 401 | ✅ 含伪造 token |
| B3 | 跨租户访问返回 404 而非 403 | ✅ 详情 / 素材 / 构建三个入口都验了 |
| B4 | 3000 字长文 → chunks ≥ 5，租户正确 | ✅ 端到端（真实向量与假向量两种模式各跑一遍） |
| B5 | 每个切片带「文章标题 > 小节标题」前缀 | ✅ |
| B6 | 重复上传不产生重复 chunks | ✅ 复用素材 + 重建不增量 |
| B7 | 注入内容标记降权但不删除 | ✅ confidence 0.2，内容仍在 |
| B8 | 进度可读、失败可读 | ✅ 断言了中途状态数 > 1，且错误信息不含堆栈 |
| B9 | agent 能读 materials，读 users 仍被拒 | ✅ |
| B10 | 向量化失败不留半截 chunks | ✅ |
| B11 | 契约幂等 + 三方类型检查 | ✅ |

### 实现过程中修掉的问题

| # | 问题 | 为什么之前没发现 |
|---|---|---|
| 1 | drizzle 相关子查询里插值 Column 渲染成裸 `"id"`，被内层表抢走，count 恒为 0 | **不报错**，只是数字一直是 0 |
| 2 | refresh token 重放检测在事务内 `update` 后 `throw`，事务回滚把吊销一起撤销 | 单测只断言"重放被拒"就会通过；要断言"另一个 token 也失效"才抓得到 |
| 3 | 合并兄弟小节时丢掉小节标题 | 切片数量看着完全正常，但搜「误区二」召回不到 |
| 4 | `authFetch` 把 Request 的 `content-type` 整个替换掉 | 所有后端测试用 `app.request` 直连，自己拼 header，**完全绕过了这个客户端** |
| 5 | 参数校验失败返回 zod 原始错误而非统一信封 | 后端测试只看 status code，不看 body 形状 |
| 6 | 全局关 `refetchOnWindowFocus` 导致切走再回来进度冻住 | 只有在真浏览器里切标签页才会遇到 |

**第 4 条最值得记**：29 个后端测试全绿，但浏览器里**每一个认证请求都会失败**。
这就是加 `make e2e` 的理由 —— 前面每层测试都在自己的边界内，没有一条真的跨过服务边界。

### 下一步

M2 七维生成。这是博主的"第一印象"时刻，产品文档 §8 说值得花最多心思打磨。
