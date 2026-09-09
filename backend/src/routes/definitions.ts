import { createRoute, z } from "@hono/zod-openapi";
import { envelope, authedErrors, UuidParam } from "../schemas/common.js";
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
    "条目的 evidenceChunkIds 为空表示【原文里找不到出处，是 AI 推断的】—— " +
    "前端必须标红。这是防过度推断的核心机制，见产品文档 §8.3。",
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
