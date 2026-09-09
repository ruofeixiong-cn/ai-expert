/**
 * 导出公开契约。
 * 这个脚本【不能连数据库】—— 所以 db/client.ts 是惰性初始化的。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../contracts/public/openapi.json");

const doc = createApp().getOpenAPI31Document({
  openapi: "3.1.0",
  info: {
    title: "AI 专家平台 · 公开 API",
    version: "0.0.1",
    description: "前端唯一的 API 面。agent 服务只在内网可达，不出现在这份契约里。",
  },
});

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`✓ ${out}`);
