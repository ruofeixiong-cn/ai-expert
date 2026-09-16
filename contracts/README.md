# contracts —— 跨服务契约

**这个目录全部是生成产物，禁止手写。** 由 `make contract` 生成，
`make contract-check` 在 CI 里守门（有 diff 就构建失败）。

```
backend  --(src/openapi.ts)-------->  public/openapi.json
                                        --(openapi-typescript)-->  public/api.d.ts   ← frontend 消费（类型）
                                        --(gen-contract-zod.mjs)-> public/zod.ts     ← frontend 消费（约束）
agent    --(scripts/export_openapi.py)--> internal/agent-openapi.json
                                        --(openapi-typescript)-->  internal/agent.d.ts ← backend 消费
```

`api.d.ts` 给**类型**，`zod.ts` 给**运行期约束**（长度、范围、枚举、必填）。
只有类型的时候，前端只能手抄后端的 `min(1)`，抄漏了类型检查照样全过、运行时必然 400 ——
F03 就是这么来的。见 [ADR-007](../docs/adr/007-contract-zod-constraints.md)。

**不要从 `zod.ts` 里 `z.infer` 类型**：一份契约两个类型来源，迟早对不上。类型只从 `api.d.ts` 取。

| 契约 | 谁产出 | 谁消费 | 说明 |
|---|---|---|---|
| `public/` | backend | frontend | 公网 API，前端唯一的接口面 |
| `internal/` | agent | backend | 内网 API，需 `x-internal-token` |

改了任一侧的 schema 而没跑 `make contract`，消费方下次 `tsc` 就会失败 ——
这是三个服务能并行开发的技术基础。

---

## SSE 事件协议

对话接口 `POST /api/chat/{share_slug}` 以 SSE 返回。三方共同约定：

```
event: meta    data: {"message_id":"...","confidence":0.82,"chunk_ids":["...","..."]}
event: delta   data: {"text":"..."}
event: done    data: {"finish_reason":"stop","safety":"pass","prompt_tokens":1203,"completion_tokens":388}
event: error   data: {"code":402,"message":"余额不足"}
```

| 事件 | 何时 | 备注 |
|---|---|---|
| `meta` | 流开始，delta 之前 | 前端拿 `message_id` 用于点赞点踩 |
| `delta` | 多次 | 增量文本 |
| `done` | 流正常结束 | backend 靠它结算 credits + 落 `messages` |

`finish_reason` 的取值：

| 值 | 含义 | 花了模型的钱吗 |
|---|---|---|
| `stop` | 正常生成完 | 是 |
| `no_context` | 召回一条都没过入口闸门，直接答「这个他没有讲过」 | **否** |
| `identity` | 身份提问（「你是真人吗」），召回之前就答掉了 | **否** |
| `length` / `error` | 截断 / 出错 | 视情况 |

> `no_context` 与 `identity` 的 `confidence` 都是 0，但**只有前者算疑似盲区** ——
> 「你是不是 AI」不是知识缺口，博主不需要为它补一篇文章。

| `error` | 任意时刻，之后立即结束 | **付费墙走这里，不要直接断流** |

三个坑：

- **`message_id` 由 backend 生成，agent 只负责原样回显。**
  它是这条回答将来在 `messages` 表里的主键，backend 在 `beginChat` 时就定好，
  随 `POST /internal/chat` 传给 agent，落库时用同一个值。
  让 agent 自己 `uuid4()` 的话，这个 id 不指向任何一行 ——
  前端拿它去打分稳定 404，而三方各自的单测全绿（各造各的 id，谁也发现不了）。
- **前端不能用 `EventSource`** —— 它不支持 POST，也不支持自定义 header 带 JWT。
  必须 `fetch` + `ReadableStream` 手动分帧。
- **backend 不能零拷贝透传** —— `new Response(upstream.body)` 会让 Node 看不到
  `done` 事件，无法结算。必须 `TransformStream` 边转发边嗅探。

---

## 错误码

统一响应体 `{ code, message, data }`。前端按 `code` 分支，**不要解析 `message`**。

| code | 含义 | 前端动作 |
|---|---|---|
| 0 | 成功 | —— |
| 1001 | 参数校验失败 | 表单标红 |
| 1401 | 未登录 / token 失效 | 跳登录 |
| 1403 | 无权访问该资源 | 提示无权限 |
| 1404 | 资源不存在 | 404 页 |
| 402 | credits 不足 | **弹充值**（HTTP 也用 402） |
| 1429 | 触发限流 | 提示稍后再试 |
| 1409 | 资源冲突（如邮箱已注册）。**`/api/auth/refresh` 返回 1409 表示另一个标签页刚刚刷新过** | 表单标红；refresh 的 1409 要稍候重试一次，**不要清登录态** |
| 1413 | 请求体太大（素材上传 30MB，其余接口 256KB） | 提示内容太大 |
| 5000 | 服务内部错误 | 通用错误提示 |

---

## 认证流程

```
登录/注册 ──▶ 响应体: { accessToken, expiresIn: 900 }
              Set-Cookie: ae_rt=<refresh>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth

任何请求  ──▶ Authorization: Bearer <accessToken>

收到 1401 ──▶ POST /api/auth/refresh（浏览器自动带 Cookie，无需前端传任何东西）
              ├─ 200 → 拿到新 accessToken，重放原请求
              ├─ 409 → 另一个标签页刚刚刷新过：稍候重试，【不要】清登录态
              └─ 401 → 清空本地状态，跳登录页
```

**前端必须遵守的三条**

1. **accessToken 只存内存**（React state / 模块变量），不要进 `localStorage`。
   它 15 分钟就过期，刷新页面重新 `POST /refresh` 拿一个即可。
2. **refresh token 前端完全不接触** —— 它在 httpOnly Cookie 里，JS 读不到也不该读。
   刷新请求带 `credentials: "include"` 即可。
3. **并发请求收到 401 时要合并刷新**：多个请求同时 401 会触发多次 `/refresh`，
   而每次刷新都会轮换 —— 后到的那次会拿着已作废的 token，被判定为重放，
   **直接把用户踢下线**。必须用一个 in-flight Promise 把并发刷新合并成一次。

> 第 3 条是最容易踩的坑：功能测试全过，一到真实页面（同时发好几个请求）就随机掉线。
