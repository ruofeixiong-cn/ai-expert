import createClient from "openapi-fetch";
// 类型来自 make contract 生成的内部契约。agent 改了 schema 而没同步契约时，
// 这里会在 tsc 阶段炸，而不是等到联调。
import type { paths } from "../../../contracts/internal/agent.d.ts";
import { env } from "../env.js";
import { AppError, Code } from "../core/errors.js";

const client = createClient<paths>({
  baseUrl: env.AGENT_URL,
  headers: { "x-internal-token": env.INTERNAL_TOKEN },
});

/** agent 返回的 422 是"这份素材提取不了"，要原样透给用户；其他状态是服务故障。 */
function translate(status: number, detail: unknown): never {
  const message =
    typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? "参数不合法"
        : "内容处理服务暂时不可用，请稍后重试";

  if (status === 422) throw new AppError(Code.BAD_REQUEST, message, 400);
  // 409 = 这个专家正在构建中（ADR-002）。原样透给前端，别当成服务故障
  if (status === 409) throw new AppError(Code.CONFLICT, message, 409);
  throw new AppError(Code.INTERNAL, "内容处理服务暂时不可用，请稍后重试", 502);
}

export async function extract(
  body: paths["/internal/extract"]["post"]["requestBody"]["content"]["application/json"],
) {
  const { data, error, response } = await client.POST("/internal/extract", { body });
  if (error || !data) translate(response?.status ?? 502, (error as { detail?: unknown })?.detail);
  return data;
}

/**
 * 对话是 SSE，拿的是原始流，所以不走 openapi-fetch（它会把 body 读成 JSON）。
 * 请求体形状仍然从契约推导 —— agent 改了字段名这里会编译期报错。
 */
export async function openChatStream(
  body: paths["/internal/chat"]["post"]["requestBody"]["content"]["application/json"],
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch(`${env.AGENT_URL}/internal/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    // 取 FastAPI 的 detail 字段，而不是整段响应体 —— 否则 409/422 透传给粉丝的
    // 会是一串 `{"detail":"..."}` 原文
    const detail = await res
      .json()
      .then((b) => (b as { detail?: unknown }).detail)
      .catch(() => undefined);
    translate(res.status, detail);
  }
  return res;
}

export async function requestModelExtraction(
  body: paths["/internal/extract-model"]["post"]["requestBody"]["content"]["application/json"],
) {
  const { data, error, response } = await client.POST("/internal/extract-model", { body });
  if (error || !data) translate(response?.status ?? 502, (error as { detail?: unknown })?.detail);
  return data;
}

export async function requestBuild(
  body: paths["/internal/build"]["post"]["requestBody"]["content"]["application/json"],
) {
  const { data, error, response } = await client.POST("/internal/build", { body });
  if (error || !data) translate(response?.status ?? 502, (error as { detail?: unknown })?.detail);
  return data;
}
