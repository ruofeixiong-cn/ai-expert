# frontend —— React 19 + Vite + TypeScript

两个界面，一套代码：
- `/app/*` Creator 控制台（需登录）：上传内容、七维确认、看板
- `/s/:slug` 粉丝对话页（分享链接）：试聊 → 付费墙 → 对话 → 点赞点踩

## 接口调用

**所有请求必须通过 `src/api/client.ts` 的 openapi-fetch client**，
类型来自 `contracts/public/api.d.ts`（`make contract` 生成）。

- **禁止手写接口类型。** 手写 = 契约失效，后端改字段名时前端不会报错。
- **接口不存在或字段缺失时，不要自己造 mock 蒙混过去。**
  在 `docs/adr/` 记一条说明"需要后端补 X"，然后停下来。

## SSE 流式有个坑

对话接口是 `POST /api/chat/:slug` + SSE。**`EventSource` 不支持 POST，
也不支持自定义 header 带 JWT**，必须用 `fetch` + `ReadableStream` 手动分帧
（`src/lib/sse.ts`）。事件协议见 `contracts/README.md`。

付费墙是 `event: error` + `code: 402`，不是断流 ——
断流的话前端分不清"网络挂了"和"要付费"。

## 栈约定

TanStack Query 管服务端状态（构建进度轮询靠它）；zustand 只放少量 UI 状态；
表单用 react-hook-form + zod；组件用 shadcn/ui（copy-in，不是依赖）。

## 完成一个改动前

```
pnpm exec tsc --noEmit && pnpm build
```
