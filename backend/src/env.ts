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

const Env = z.object({
  DATABASE_URL_BACKEND: z
    .string()
    .default("postgres://app_backend:backend_dev_pw@localhost:5432/ai_expert"),
  AGENT_URL: z.string().default("http://localhost:8000"),
  INTERNAL_TOKEN: z.string().default("dev_internal_token_change_me"),
  BACKEND_PORT: z.coerce.number().default(8787),
  // 生产环境必须覆盖。默认值只为让本地开箱即用。
  JWT_SECRET: z.string().min(16).default("dev_jwt_secret_change_me_in_prod"),
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

export const env = Env.parse(process.env);
