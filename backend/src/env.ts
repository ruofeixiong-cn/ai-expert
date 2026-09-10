import { resolve } from "node:path";
import { z } from "zod";

/*
 * 加载根目录的 .env。
 *
 * ⚠️ 在这之前 backend【根本不读 .env】—— 所有配置都靠下面的默认值兜着，
 *    所以本地一切正常，`.env.example` 里记的那些变量却全是摆设。
 *    最危险的是生产：运维照着 .env.example 设了 JWT_SECRET，
 *    进程照样用开发默认值 `dev_jwt_secret_change_me_in_prod` 签发 token，
 *    而且没有任何报错。是做本地体验流程时点开分享链接才发现的
 *    （PUBLIC_WEB_URL 设了不生效）。
 *
 * agent 侧一直是好的：pydantic-settings 的 env_file 就指着同一个文件。
 *
 * process.loadEnvFile 不覆盖已存在的环境变量 —— shell 传进来的优先，
 * .env 只补空缺。测试里 `NODE_ENV=test pnpm test` 这类用法不受影响。
 */
try {
  process.loadEnvFile(resolve(import.meta.dirname, "../../.env"));
} catch {
  // 没有 .env 是正常的：CI 和容器里靠真实环境变量注入
}

/** 只为本地开箱即用的默认值。生产环境检测到它们就拒绝启动，见 assertProductionSecrets。 */
export const DEV_DEFAULTS = {
  JWT_SECRET: "dev_jwt_secret_change_me_in_prod",
  INTERNAL_TOKEN: "dev_internal_token_change_me",
  DB_PASSWORD: "backend_dev_pw",
} as const;

const Env = z.object({
  DATABASE_URL_BACKEND: z
    .string()
    .default(`postgres://app_backend:${DEV_DEFAULTS.DB_PASSWORD}@localhost:5432/ai_expert`),
  AGENT_URL: z.string().default("http://localhost:8000"),
  INTERNAL_TOKEN: z.string().default(DEV_DEFAULTS.INTERNAL_TOKEN),
  BACKEND_PORT: z.coerce.number().default(8787),
  JWT_SECRET: z.string().min(16).default(DEV_DEFAULTS.JWT_SECRET),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  /*
   * 分享链接 `/s/{slug}` 的对外地址。
   *
   * 留空则回退到请求自身的 origin —— 生产上这是对的：按技术方案 §12，
   * `/s/:slug` 由 backend 渲染 og 壳（微信分享卡片要），域名就是 API 域名。
   *
   * 但**本地开发必须显式设置**：dev 环境下这个路由由 Vite 提供（5173），
   * backend（8787）上根本没有它。不设的话上线拿到的链接是 404，
   * 而接口返回 200、数据库一切正常 —— 只有点开才发现。
   */
  PUBLIC_WEB_URL: z.string().default(""),
});

type EnvShape = z.infer<typeof Env>;

/**
 * 生产环境不许用开发默认值启动（B05）。
 *
 * JWT_SECRET 的默认值能通过 min(16)。部署时忘了配，服务照样起来、照样工作 ——
 * 签名密钥就是写在仓库里的公开字符串，任何人都能伪造任何人的 token，
 * 而且没有任何报错。所以让它在启动的那一刻失败。
 *
 * 一次列出全部问题：改一个报一个，部署要来回好几轮。
 */
export function assertProductionSecrets(
  e: Pick<EnvShape, "NODE_ENV" | "JWT_SECRET" | "INTERNAL_TOKEN" | "DATABASE_URL_BACKEND">,
) {
  if (e.NODE_ENV !== "production") return;

  const problems: string[] = [];
  if (e.JWT_SECRET === DEV_DEFAULTS.JWT_SECRET || e.JWT_SECRET.length < 32) {
    problems.push("JWT_SECRET（至少 32 位随机串）");
  }
  if (e.INTERNAL_TOKEN === DEV_DEFAULTS.INTERNAL_TOKEN || e.INTERNAL_TOKEN.length < 24) {
    problems.push("INTERNAL_TOKEN（至少 24 位随机串，与 agent 一致）");
  }
  if (e.DATABASE_URL_BACKEND.includes(DEV_DEFAULTS.DB_PASSWORD)) {
    problems.push("DATABASE_URL_BACKEND（仍是开发密码）");
  }
  if (problems.length > 0) {
    throw new Error(`生产环境仍在使用开发默认值：${problems.join("；")}。请在部署环境里设置真实值。`);
  }
}

export const env = Env.parse(process.env);
assertProductionSecrets(env);
