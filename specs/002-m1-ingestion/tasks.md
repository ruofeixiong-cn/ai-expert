# M1 · 内容入库 —— 任务清单（Tasks）

> `[x]` = 已验证通过　`[~]` = 代码已写但未跑过　`[ ]` = 未做

## S1 契约冻结（先做，做完再放三方并行）
- [x] S1.1 backend：9 个公开接口的 zod schema（只定义，不实现逻辑）
- [x] S1.2 agent：`POST /internal/build` 的 Pydantic schema
- [x] S1.3 `make contract` 产出两份新契约
- [x] S1.4 三方 `make typecheck` 通过
- [ ] S1.5 **人工过一遍接口清单**（接口设计是产品决策，值得停一下）

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
- [ ] S5.1 `pipeline/config.py`：切分参数集中一处
- [ ] S5.2 `pipeline/clean.py`：注入清洗 + 标记降权（B7）
- [ ] S5.3 `pipeline/chunk.py`：标题感知切分 + 标题路径前缀（B5）
- [ ] S5.4 `pipeline/embed.py`：`EmbeddingProvider` + DashScope/Fake 两实现
- [ ] S5.5 `pipeline/parse.py`：trafilatura（链接）/ pymupdf / python-docx
- [ ] S5.6 `workers/build.py`：ARQ 任务 + 分阶段进度 + 失败写回（B10）
- [ ] S5.7 写 chunks 原子性（先删后插，同一事务）
- [ ] S5.8 `POST /internal/build` 实现
- [ ] S5.9 单测 B5 / B7 / B10

## S6 frontend
- [ ] S6.1 登录 / 注册页
- [ ] S6.2 专家列表 + 新建专家
- [ ] S6.3 素材上传（粘贴正文优先，文件与链接次之）
- [ ] S6.4 构建进度条（TanStack Query 轮询）
- [ ] S6.5 `tsc --noEmit` + `vite build`

## S7 端到端
- [ ] S7.1 B4：粘贴 3000 字 → chunks ≥ 5 且 tenant_id 全对
- [ ] S7.2 B6：重复上传不产生重复 chunks
- [ ] S7.3 B8：进度可读、失败可读
- [ ] S7.4 B11：`make contract-check && make typecheck && make test` 全绿
