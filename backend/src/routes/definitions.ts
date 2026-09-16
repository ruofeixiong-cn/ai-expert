import { createRoute, z } from "@hono/zod-openapi";
import { envelope, authedErrors, ErrorBody, UuidParam } from "../schemas/common.js";
import {
  RegisterInput, LoginInput, AuthResult, MeResult,
  RefreshResult, SessionInfo, RevokeResult,
} from "../schemas/auth.js";
import {
  Expert, ExpertDetail, CreateExpertInput, BuildResult,
} from "../schemas/expert.js";
import { CreateMaterialInput, CreateMaterialResult, Material } from "../schemas/material.js";
import {
  Dimension, ModelView, ConfirmDimensionInput, PublishResult,
} from "../schemas/model.js";
import { ChatExpertInfo, ChatInput, ChatStream } from "../schemas/chat.js";
import { FeedbackInput, FeedbackResult, ExpertStats } from "../schemas/feedback.js";

/**
 * M1 的公开接口契约。
 *
 * 这个文件是【契约的唯一来源】—— `make contract` 从这里生成 openapi.json，
 * 再生成前端用的 api.d.ts。改这里 = 改契约，必须重新生成并提交。
 *
 * 只定义当前里程碑真正要用的接口。M2 的七维确认、M3 的对话不在这里 ——
 * 提前定了又改，比晚点定更贵。
 */

const json = <T extends z.ZodTypeAny>(description: string, schema: T) =>
  ({ description, content: { "application/json": { schema: envelope(schema) } } }) as const;

const body = <T extends z.ZodTypeAny>(schema: T) =>
  ({ content: { "application/json": { schema } }, required: true }) as const;

const bearer = [{ bearerAuth: [] }];

// ─── 认证 ────────────────────────────────────────────────────────────────────

export const registerRoute = createRoute({
  method: "post", path: "/api/auth/register", tags: ["auth"],
  summary: "注册博主（同时自动创建租户）",
  request: { body: body(RegisterInput) },
  responses: {
    200: json("注册成功", AuthResult),
    ...authedErrors,
  },
});

export const loginRoute = createRoute({
  method: "post", path: "/api/auth/login", tags: ["auth"],
  summary: "登录",
  request: { body: body(LoginInput) },
  responses: { 200: json("登录成功", AuthResult), ...authedErrors },
});

export const meRoute = createRoute({
  method: "get", path: "/api/me", tags: ["auth"],
  summary: "当前用户与租户",
  security: bearer,
  responses: { 200: json("当前身份", MeResult), ...authedErrors },
});

export const refreshRoute = createRoute({
  method: "post", path: "/api/auth/refresh", tags: ["auth"],
  summary: "用 refresh token 换新的 access token（并轮换 refresh token）",
  description:
    "refresh token 从 httpOnly Cookie 读取，不接受请求体传入。\n\n" +
    "每次刷新都会签发新的 refresh token 并作废旧的。" +
    "若检测到已作废的 refresh token 被再次使用（重放），" +
    "判定为凭据泄露并吊销【整个会话族】，返回 1401。",
  responses: { 200: json("刷新成功", RefreshResult), ...authedErrors },
});

export const logoutRoute = createRoute({
  method: "post", path: "/api/auth/logout", tags: ["auth"],
  summary: "登出当前设备（吊销当前会话族）",
  security: bearer,
  responses: { 200: json("已登出", RevokeResult), ...authedErrors },
});

export const logoutAllRoute = createRoute({
  method: "post", path: "/api/auth/logout-all", tags: ["auth"],
  summary: "登出所有设备",
  description: "改密码或发现异常登录时应调用。已签发的 access token 会在下次请求时被拒。",
  security: bearer,
  responses: { 200: json("已登出全部", RevokeResult), ...authedErrors },
});

export const sessionsRoute = createRoute({
  method: "get", path: "/api/auth/sessions", tags: ["auth"],
  summary: "当前账号的活跃会话列表",
  security: bearer,
  responses: { 200: json("会话列表", z.array(SessionInfo)), ...authedErrors },
});

// ─── 专家 ────────────────────────────────────────────────────────────────────

export const createExpertRoute = createRoute({
  method: "post", path: "/api/experts", tags: ["expert"],
  summary: "创建 AI 专家",
  security: bearer,
  request: { body: body(CreateExpertInput) },
  responses: { 200: json("创建成功", Expert), ...authedErrors },
});

export const listExpertsRoute = createRoute({
  method: "get", path: "/api/experts", tags: ["expert"],
  summary: "我的专家列表",
  security: bearer,
  responses: { 200: json("列表", z.array(Expert)), ...authedErrors },
});

export const getExpertRoute = createRoute({
  method: "get", path: "/api/experts/{id}", tags: ["expert"],
  summary: "专家详情（含最近一次构建进度）",
  description: "不属于当前租户时返回 404 而非 403 —— 不泄露资源是否存在。",
  security: bearer,
  request: { params: z.object({ id: UuidParam }) },
  responses: { 200: json("详情", ExpertDetail), ...authedErrors },
});

// ─── 素材 ────────────────────────────────────────────────────────────────────

export const createMaterialRoute = createRoute({
  method: "post", path: "/api/experts/{id}/materials", tags: ["material"],
  summary: "上传素材（粘贴正文 / 文件 / 链接）",
  description:
    "链接抓取只承诺公众号，其他平台尽力而为；失败时前端应引导用户改用粘贴正文。" +
    "内容哈希重复时复用已有素材，返回 deduplicated: true。",
  security: bearer,
  request: { params: z.object({ id: UuidParam }), body: body(CreateMaterialInput) },
  responses: { 200: json("上传成功", CreateMaterialResult), ...authedErrors },
});

export const listMaterialsRoute = createRoute({
  method: "get", path: "/api/experts/{id}/materials", tags: ["material"],
  summary: "素材列表",
  security: bearer,
  request: { params: z.object({ id: UuidParam }) },
  responses: { 200: json("列表", z.array(Material)), ...authedErrors },
});

// ─── 专家模型（七维）─────────────────────────────────────────────────────────

export const getModelRoute = createRoute({
  method: "get", path: "/api/experts/{id}/model", tags: ["model"],
  summary: "获取七维专家模型（AI 草稿 + 博主定稿）",
  description:
    "draft 是 AI 生成的草稿，confirmed 是博主确认过的定稿。\n\n" +
    "条目的 evidenceChunkIds 为空【且 origin 是 ai】表示原文里找不到出处、是 AI 推断的 —— " +
    "前端必须标红。这是防过度推断的核心机制，见产品文档 §8.3。\n\n" +
    "origin 为 creator 的条目是博主手写或改写的，没有出处是正常的，不标红（ADR-003）。" +
    "存量数据没有这个字段，缺省视为 ai。",
  security: bearer,
  request: { params: z.object({ id: UuidParam }) },
  responses: { 200: json("七维模型", ModelView), ...authedErrors },
});

export const confirmDimensionRoute = createRoute({
  method: "put", path: "/api/experts/{id}/model/{dimension}", tags: ["model"],
  summary: "确认单个维度（分块确认）",
  description:
    "一次只提交一个维度，对应产品文档 §8.4 的「分块确认」—— " +
    "让博主一次看一块、改一块，而不是面对一个巨大的表单。\n\n" +
    "提交即视为确认该维度；未提交的维度按草稿「默认通过」。",
  security: bearer,
  request: {
    params: z.object({ id: UuidParam, dimension: Dimension }),
    body: body(ConfirmDimensionInput),
  },
  responses: { 200: json("已确认", ModelView), ...authedErrors },
});

export const regenerateModelRoute = createRoute({
  method: "post", path: "/api/experts/{id}/model/regenerate", tags: ["model"],
  summary: "重新生成七维草稿（不重新向量化）",
  description:
    "只跑提炼，直接复用已有的知识切片。博主会反复重新生成直到满意，" +
    "每次都重跑 embedding 是真金白银。\n\n" +
    "已确认的维度不受影响 —— 草稿和定稿是分开存的。",
  security: bearer,
  request: { params: z.object({ id: UuidParam }) },
  responses: { 200: json("已入队", BuildResult), ...authedErrors },
});

export const publishRoute = createRoute({
  method: "post", path: "/api/experts/{id}/publish", tags: ["model"],
  summary: "上线，生成分享链接",
  description:
    "上线前校验禁区（boundaries）非空 —— 它是合规生命线，" +
    "必须由博主主动确认，见产品文档 §7.2。\n\n" +
    "重复上线不会改变已生成的 share_slug。",
  security: bearer,
  request: { params: z.object({ id: UuidParam }) },
  responses: { 200: json("已上线", PublishResult), ...authedErrors },
});

// ─── 构建 ────────────────────────────────────────────────────────────────────

export const buildRoute = createRoute({
  method: "post", path: "/api/experts/{id}/build", tags: ["expert"],
  summary: "触发构建（解析 → 切分 → 向量化）",
  description: "立即返回 jobId；进度通过 GET /api/experts/{id} 的 lastBuild 轮询。",
  security: bearer,
  request: { params: z.object({ id: UuidParam }) },
  responses: { 200: json("已入队", BuildResult), ...authedErrors },
});

// ─── 粉丝对话 ────────────────────────────────────────────────────────────────
//
// 这两个接口不需要登录 —— 分享页首屏要求注册等于转化率归零。
// 粉丝身份靠签名 Cookie 里的匿名账号，试聊额度按它计。

export const getChatExpertRoute = createRoute({
  method: "get", path: "/api/chat/{slug}", tags: ["chat"],
  summary: "按分享短链获取专家信息",
  description: "专家未上线时返回 404 —— 不泄露这个短链是否存在过。",
  request: { params: z.object({ slug: z.string().min(4).max(32) }) },
  responses: {
    200: json("专家信息", ChatExpertInfo),
    404: {
      description: "短链无效或专家未上线",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

export const chatRoute = createRoute({
  method: "post", path: "/api/chat/{slug}", tags: ["chat"],
  summary: "向 AI 专家提问（SSE 流式返回）",
  description:
    "以 text/event-stream 返回，事件协议见 contracts/README.md。\n\n" +
    "召回结果全部低于置信度阈值时，直接回答「这个他没有讲过」，不调用生成模型 ——" +
    "既防幻觉，也不为库里没有的问题花钱。\n\n" +
    "试聊额度用完时发 `event: error` + `code: 402`，而不是断流。",
  request: {
    params: z.object({ slug: z.string().min(4).max(32) }),
    body: body(ChatInput),
  },
  responses: {
    200: {
      description: "SSE 事件流",
      content: { "text/event-stream": { schema: ChatStream } },
    },
    404: {
      description: "短链无效或专家未上线",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ─── 反馈与看板 ──────────────────────────────────────────────────────────────

export const feedbackRoute = createRoute({
  method: "post", path: "/api/chat/{slug}/feedback", tags: ["chat"],
  summary: "给一条回答点赞 / 点踩",
  description:
    "产品文档 §13 写的是全局的 `POST /api/feedback`，这里挂在分享短链下面。\n\n" +
    "原因是隔离：粉丝不属于任何租户，一个裸的 message_id 无从确定该设哪个 " +
    "`app.current_tenant` —— 全局路径要么再开一个 SECURITY DEFINER 口子" +
    "（入参是可枚举的 uuid，比 slug 危险得多），要么绕过 RLS。" +
    "挂在 slug 下则复用已有的 `resolve_share_slug`，一个新口子都不用开。\n\n" +
    "同一个粉丝对同一条回答只有一条记录 —— 赞改踩是更新，不是追加。\n\n" +
    "消息不存在、不是回答、或不属于当前粉丝的会话，一律返回 404（不是 403）。",
  request: {
    params: z.object({ slug: z.string().min(4).max(32) }),
    body: body(FeedbackInput),
  },
  responses: {
    200: json("已记录", FeedbackResult),
    404: {
      description: "短链无效，或这条消息不是你的",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

export const statsRoute = createRoute({
  method: "get", path: "/api/experts/{id}/stats", tags: ["expert"],
  summary: "Creator 最小看板（回答数 / 满意度 / 收入 / 盲区数）",
  description:
    "疑似盲区 = `finish_reason='no_context'` 或（被点踩且置信度低于阈值）。\n\n" +
    "前一项是隐性信号，**不需要粉丝点任何按钮** —— 只靠点踩的话这个数会长期是 0，" +
    "而「用户没动机主动反馈」是产品规划文档点名的头号风险。\n\n" +
    "`satisfaction` 在无人评价时是 `null` 而不是 0 ——" +
    "「没人评价」和「所有人都说不好」是相反的两件事。\n\n" +
    "`revenueCents` 在 M5 接入付费前恒为 0，前端应明写而不是当成真实数据展示。",
  security: bearer,
  request: { params: z.object({ id: UuidParam }) },
  responses: { 200: json("看板", ExpertStats), ...authedErrors },
});
