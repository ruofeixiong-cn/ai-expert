import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Code } from "../core/errors.js";

const KB = 1024;
const MB = 1024 * KB;

/**
 * 请求体大小上限（B07）。
 *
 * 第一版没有任何上限：一个几百 MB 的 JSON 会被 Node 整个读进内存。
 *
 * 素材上传单独放宽：20MB 的文件 base64 之后约 27MB，再加一层 JSON 外壳。
 * 其余接口（登录、七维确认、提问……）最大的也就几十 KB，256KB 已经很宽松。
 */
export const MATERIAL_UPLOAD_MAX = 30 * MB;
export const DEFAULT_BODY_MAX = 256 * KB;

const MATERIAL_UPLOAD = /^\/api\/experts\/[^/]+\/materials$/;

const tooLarge = (c: Context) =>
  c.json({ code: Code.PAYLOAD_TOO_LARGE, message: "请求内容太大", data: null }, 413);

const materialUpload = bodyLimit({ maxSize: MATERIAL_UPLOAD_MAX, onError: tooLarge });
const everythingElse = bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: tooLarge });

export const bodyLimits: MiddlewareHandler = (c, next) =>
  (c.req.method === "POST" && MATERIAL_UPLOAD.test(c.req.path) ? materialUpload : everythingElse)(c, next);
