import { z } from "zod";

const Env = z.object({
  DATABASE_URL_BACKEND: z
    .string()
    .default("postgres://app_backend:backend_dev_pw@localhost:5432/ai_expert"),
  AGENT_URL: z.string().default("http://localhost:8000"),
  INTERNAL_TOKEN: z.string().default("dev_internal_token_change_me"),
  BACKEND_PORT: z.coerce.number().default(8787),
});

export const env = Env.parse(process.env);
