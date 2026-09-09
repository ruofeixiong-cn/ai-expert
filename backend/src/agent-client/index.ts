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
  throw new AppError(Code.INTERNAL, "内容处理服务暂时不可用，请稍后重试", 502);
}

export async function extract(
  body: paths["/internal/extract"]["post"]["requestBody"]["content"]["application/json"],
) {
  const { data, error, response } = await client.POST("/internal/extract", { body });
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
