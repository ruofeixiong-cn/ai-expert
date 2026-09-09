import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // 迁移必须以 app_owner（DDL 权限）身份执行，绝不用运行时角色
    url: process.env.DATABASE_URL_OWNER ?? "postgres://app_owner:owner_dev_pw@localhost:5432/ai_expert",
  },
  strict: true,
  verbose: true,
});
