import { describe, it, expect, afterAll } from "vitest";
import { closeDb } from "../src/db/client.js";
import { Code } from "../src/core/errors.js";
import { MAX_FILE_BASE64_CHARS } from "../src/schemas/material.js";
import { call, creatorWithExpert, json } from "./helpers.js";

/**
 * B07：请求体大小。
 *
 * 第一版没有任何上限：一个几百 MB 的 JSON 会被 Node 整个读进内存，
 * 文件的 base64 也不设长度 —— 然后原样转给 agent 再解码一遍。
 */
afterAll(async () => { await closeDb(); });

const MB = 1024 * 1024;

describe("请求体大小", () => {
  it("普通接口：超过上限返回 413，统一信封", async () => {
    const res = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: "a@b.c", password: "x".repeat(300 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect((await json(res)).code).toBe(Code.PAYLOAD_TOO_LARGE);
  });

  it("素材接口：10 万字的长文正常通过（中文约 300KB，超过普通接口的上限）", async () => {
    const { token, id } = await creatorWithExpert();
    const res = await call(`/api/experts/${id}/materials`, {
      method: "POST", token,
      body: JSON.stringify({ sourceType: "paste", title: "长文", content: "定".repeat(90_000) }),
    });
    expect(res.status).toBe(200);
  });

  it("素材接口：超过 30MB 返回 413", async () => {
    const { token, id } = await creatorWithExpert();
    const res = await call(`/api/experts/${id}/materials`, {
      method: "POST", token,
      body: JSON.stringify({
        sourceType: "file", title: "t", filename: "a.pdf", contentBase64: "A".repeat(31 * MB),
      }),
    });
    expect(res.status).toBe(413);
  });

  it("文件的 base64 超过 20MB 文件对应的长度：参数校验就拒，不转给 agent", async () => {
    const { token, id } = await creatorWithExpert();
    const res = await call(`/api/experts/${id}/materials`, {
      method: "POST", token,
      body: JSON.stringify({
        sourceType: "file", title: "t", filename: "a.pdf", contentBase64: "A".repeat(MAX_FILE_BASE64_CHARS + 4),
      }),
    });
    expect(res.status).toBe(400);
    // 是 backend 的参数校验拒的（信息里带字段名），不是 agent 解码之后才拒的
    expect((await json(res)).message).toContain("contentBase64");
  });
});
