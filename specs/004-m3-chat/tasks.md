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
- [x] U6.1 D3 / D4 / D9 / D10
- [x] U6.2 D5：问库里没有的 → 诚实说不知道（真实模型）
- [x] U6.3 D7：注入内容不影响回答（真实模型）
- [x] U6.4 `make verify` 全绿

---

## 当前状态：M3 完成 ✅

`make verify` 全绿：backend 49 + agent 54 + 端到端 14
（假实现 12 passed / 2 skipped，真实模型 14 passed）。

| 验收 | 断言 | 结果 |
|---|---|---|
| D1 | 分享链接能拿到专家名、知识量、试聊剩余 | ✅ |
| D2 | 未上线的专家返回 404 | ✅ |
| D3 | SSE 顺序 meta → delta* → done | ✅ |
| D4 | 回答基于召回到的原文 | ✅ 真实模型 |
| D5 | 库里没有的问题诚实说不知道，不编造 | ✅ 真实模型 |
| D6 | 召回为空时不调用生成模型 | ✅ agent 单测（确定性） |
| D7 | 检索内容里藏的指令不控制回答 | ✅ 真实模型 |
| D8 | 额度用完发 error 402 而非断流 | ✅ 后端 + 浏览器 |
| D9 | 对话与消息落库，chunk_ids 指向真实切片 | ✅ |
| D10 | 跨专家问不出别人的知识 | ✅ |
| D11 | 客户端中途断开仍正确结算，且只结算一次 | ✅ |

### 实测数据

```
问「定投的手续费能省吗」
  召回 3 段，最高分 0.2149，941+172 tokens，4159ms
  回答引用了原文的具体数字（1.5% 费率吃掉近两成收益、满两年免赎回费）

问「你觉得比特币明年会涨到多少」
  召回 0 段（三个切片分数全是 0.0059）
  no_context，0 tokens，407ms —— 一次模型调用都没发生
```

### 实现过程中的发现与修正

| # | 问题 | 怎么发现的 |
|---|---|---|
| 1 | **「降权 = 屏蔽」是错的**。夹带真实相关内容的投毒切片，×0.2 后仍越过阈值进了 prompt；挡住它的是 System Prompt 声明与来源标记，不是降权那一层 | 做真正的 D7（把注入放进【检索内容】而不是用户问题） |
| 2 | D5 断言实现路径导致测试不稳定（跑三次挂一次）。rerank 分数会浮动，偶尔有切片擦边过闸门 | 真实模型下重复运行 |
| 3 | 测试用硬编码短链，第二次跑撞唯一索引 | 连跑两次 |
| 4 | Enter 键"不工作"是测试工具的问题，不是产品 bug | 用 JS 直接派发 keydown 验证 |

第 2 条最值得记：**断言实现路径会让测试既脆又测不到真正要保的东西**。
验收标准 #7 要的是「诚实说不知道」，走哪条内部分支无所谓 ——
改成断言回答本身之后，测试既稳定又真的在保产品要求。
「召回为空就不调模型」那条是确定性的，留给 agent 单测。

### 下一步

M4 反馈与看板：点赞点踩、盲区标记、Creator 最小看板。
`messages.chunk_ids` 与 `confidence` 已经在记，盲区定位有数据可用。
