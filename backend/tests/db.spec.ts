import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { closeDb, getDb, systemTx, tenantTx } from "../src/db/client.js";
import { call, publishedExpert } from "./helpers.js";

/**
 * B04：嵌套事务会耗死连接池。
 *
 * getChatExpert 曾在 tenantTx 里又开了一个 systemTx —— 一个请求同时占 2 个连接。
 * 池上限 10，postgres.js 取连接默认不超时：10 个粉丝同时打开分享页，
 * 就可能每人占着 1 个、等第 2 个，全部挂起。
 *
 * 光修掉那一处不够，下一个人还会再写出来。所以在唯一的事务入口上直接拦。
 */
afterAll(async () => { await closeDb(); });

describe("事务入口", () => {
  it("systemTx 里不能再开事务", async () => {
    await expect(systemTx(() => systemTx(async () => 1))).rejects.toThrow(/嵌套/);
  });

  it("tenantTx 里不能再开 systemTx", async () => {
    await expect(tenantTx(randomUUID(), () => systemTx(async () => 1))).rejects.toThrow(/嵌套/);
  });

  it("事务里不能绕过 tx、直接用 getDb() 另开连接", async () => {
    await expect(systemTx(async () => getDb().execute(sql`select 1`))).rejects.toThrow(/嵌套/);
  });

  // 放在最后：修复前它会把连接池卡死，后面的用例都会跟着超时
  it("30 个粉丝同时打开分享页，全部正常返回", async () => {
    const { slug } = await publishedExpert();
    const res = await Promise.all(Array.from({ length: 30 }, () => call(`/api/chat/${slug}`)));
    expect(res.map((r) => r.status)).toEqual(Array(30).fill(200));
  }, 15_000);
});
