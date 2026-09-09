import { z } from "zod";

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
});

export const env = Env.parse(process.env);
