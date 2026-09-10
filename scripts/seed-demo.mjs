#!/usr/bin/env node
/**
 * 本地体验用的种子数据。
 *
 * 建一个固定的演示账号，把 agent/eval/corpus/ 里的三篇原创文章
 * 当素材传进去 —— 那批语料同时也是 M6 黄金问答集的底料，
 * 所以「该答得出什么、不该答什么」是有据可查的，不是随手编的内容。
 *
 *   node scripts/seed-demo.mjs            # 只建账号 + 传素材（推荐，剩下的自己点）
 *   node scripts/seed-demo.mjs --build    # 顺带触发构建并等它跑完
 *   node scripts/seed-demo.mjs --publish  # 一路建到上线，直接拿分享链接
 *
 * 可以反复跑：账号已存在就直接登录，素材重复会被内容哈希去重。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = process.env.API ?? "http://localhost:8787";
const EMAIL = "demo@ai-expert.local";
const PASSWORD = "demo12345678";
const EXPERT = "定投老王";

const args = new Set(process.argv.slice(2));
const wantBuild = args.has("--build") || args.has("--publish");
const wantPublish = args.has("--publish");

let token = "";
const call = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ...body };
};

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

// ── 1. 账号 ──────────────────────────────────────────────────
const reg = await call("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ email: EMAIL, password: PASSWORD, nickname: "定投老王" }),
}).catch(() => die(`连不上 backend（${API}）。先在另一个终端跑 \`make dev\`。`));

if (reg.code === 0) {
  token = reg.data.accessToken;
  console.log(`✓ 新建演示账号 ${EMAIL}`);
} else if (reg.code === 1409) {
  const login = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account: EMAIL, password: PASSWORD }),
  });
  if (login.code !== 0) die(`账号已存在但登录失败：${login.message}`);
  token = login.data.accessToken;
  console.log(`✓ 演示账号已存在，直接登录 ${EMAIL}`);
} else {
  die(`注册失败：${reg.message ?? reg.status}`);
}

// ── 2. 专家 ──────────────────────────────────────────────────
const list = await call("/api/experts");
let expert = list.data?.find((e) => e.name === EXPERT);
if (!expert) {
  const created = await call("/api/experts", {
    method: "POST",
    body: JSON.stringify({ name: EXPERT }),
  });
  if (created.code !== 0) die(`创建专家失败：${created.message}`);
  expert = created.data;
  console.log(`✓ 新建专家「${EXPERT}」`);
} else {
  console.log(`✓ 专家「${EXPERT}」已存在`);
}

// ── 3. 素材 ──────────────────────────────────────────────────
const corpusDir = join(ROOT, "agent/eval/corpus");
const files = readdirSync(corpusDir).filter((f) => f.endsWith(".md")).sort();
let added = 0;
let deduped = 0;
for (const f of files) {
  const content = readFileSync(join(corpusDir, f), "utf8");
  const title = content.match(/^#\s+(.+)$/m)?.[1] ?? f.replace(/\.md$/, "");
  const r = await call(`/api/experts/${expert.id}/materials`, {
    method: "POST",
    body: JSON.stringify({ sourceType: "paste", title, content }),
  });
  if (r.code !== 0) die(`上传「${title}」失败：${r.message}`);
  r.data.deduplicated ? deduped++ : added++;
}
console.log(`✓ 素材 ${files.length} 篇（新增 ${added}，已存在 ${deduped}）`);

// ── 4. 构建 ──────────────────────────────────────────────────
if (wantBuild) {
  const b = await call(`/api/experts/${expert.id}/build`, { method: "POST" });
  if (b.code !== 0) die(`触发构建失败：${b.message}`);
  process.stdout.write("→ 构建中");
  const deadline = Date.now() + 180_000;
  let detail;
  while (Date.now() < deadline) {
    detail = (await call(`/api/experts/${expert.id}`)).data;
    const s = detail.lastBuild?.status;
    if (s === "succeeded") break;
    if (s === "failed") die(`构建失败：${detail.lastBuild.error}`);
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (detail?.lastBuild?.status !== "succeeded") die("构建超时。看看 worker 起了没：make worker");
  console.log(` ✓ ${detail.chunkCount} 个知识切片`);
}

// ── 5. 上线 ──────────────────────────────────────────────────
let shareUrl = null;
if (wantPublish) {
  const p = await call(`/api/experts/${expert.id}/publish`, { method: "POST" });
  if (p.code !== 0) {
    die(`上线失败：${p.message}\n  （禁区为空时会拒绝上线 —— 那是合规底线，先在页面上确认「拒绝回答」）`);
  }
  shareUrl = p.data.shareUrl;
  console.log(`✓ 已上线`);
}

// ── 收尾 ────────────────────────────────────────────────────
const web = process.env.WEB ?? "http://localhost:5173";
console.log(`
───────────────────────────────────────────────
  登录     ${web}/login
  账号     ${EMAIL}
  密码     ${PASSWORD}

  专家页   ${web}/app/experts/${expert.id}`);
if (shareUrl) console.log(`  分享链接 ${shareUrl}`);
console.log(`
  下一步与试题清单：docs/本地体验.md
───────────────────────────────────────────────
`);
