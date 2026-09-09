# M3 · 对话 —— 任务清单（Tasks）

> `[x]` = 已验证通过　`[~]` = 代码已写但未跑过　`[ ]` = 未做

## U1 契约冻结
- [x] U1.1 `GET /api/chat/{slug}` + `POST /api/chat/{slug}`（SSE）
- [x] U1.2 agent `POST /internal/chat`
- [x] U1.3 `make contract` + 三方 typecheck

## U2 数据库（迁移 0008）
- [x] U2.1 `conversations` / `messages` + RLS + policy
- [x] U2.2 `GRANT SELECT ON messages TO app_agent`（只读，落库是 backend 的事）
- [x] U2.3 `experts.free_trial_messages`
- [x] U2.4 Python 镜像 + 漂移测试

## U3 agent：召回与双闸门
- [x] U3.1 `pipeline/retrieve.py`：pgvector 召回 + rerank
- [x] U3.2 入口闸门：阈值过滤；空结果直接返回，**不调模型**（D6）
- [x] U3.3 `pipeline/prompt.py`：常驻骨架 + 来源标记
- [x] U3.4 `pipeline/safety.py`：出口闸门规则
- [x] U3.5 `POST /internal/chat` 流式实现
- [x] U3.6 单测 D6 + 出口闸门

## U4 backend
- [x] U4.1 匿名粉丝身份（签名 Cookie）
- [x] U4.2 `GET /api/chat/{slug}`（未上线返回 404）
- [x] U4.3 SSE 代理 + TransformStream 嗅探 + abort 兜底（D11）
- [x] U4.4 试聊额度与 402
- [x] U4.5 落 conversations / messages
- [x] U4.6 测试 D2 / D8 / D11

## U5 frontend：`/s/:slug` 对话页
- [x] U5.1 SSE 手动分帧（`EventSource` 不支持 POST 与自定义 header）
- [x] U5.2 流式打字效果 + 试聊剩余提示
- [x] U5.3 402 → 付费引导（M5 前先占位）
- [x] U5.4 `tsc` + `vite build`

## U6 端到端
- [ ] U6.1 D3 / D4 / D9 / D10
- [ ] U6.2 D5：问库里没有的 → 诚实说不知道（真实模型）
- [ ] U6.3 D7：注入内容不影响回答（真实模型）
- [ ] U6.4 `make verify` 全绿
