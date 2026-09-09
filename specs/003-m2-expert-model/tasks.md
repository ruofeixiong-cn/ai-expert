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
- [ ] T5.1 七维分块展示，按可靠度决定默认展开/折叠
- [ ] T5.2 **无证据条目标红** + "这条是 AI 推断的，原文里没有"
- [ ] T5.3 条目可编辑 / 删除 / 新增
- [ ] T5.4 逐块确认 + 一键全部确认（默认通过）
- [ ] T5.5 Boundaries 单独强调，未确认不给上线
- [ ] T5.6 上线后展示分享链接
- [ ] T5.7 `tsc` + `vite build`

## T6 端到端
- [ ] T6.1 C1：构建后七个维度都在
- [ ] T6.2 C10：重新生成不改变 chunk 数与 embedding
- [ ] T6.3 `make verify` 全绿
