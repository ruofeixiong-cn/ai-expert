import { describe, it, expect } from "vitest";
import { assertProductionSecrets, DEV_DEFAULTS } from "../src/env.js";

/**
 * B05：生产环境不许用开发默认值启动。
 *
 * JWT_SECRET 的默认值能通过 min(16) 校验。部署时忘了配，服务照样起来 ——
 * 签名密钥就是写在仓库里的公开字符串，任何人都能伪造任何人的 token，
 * 而且没有任何报错。
 */

const PROD = {
  NODE_ENV: "production" as const,
  JWT_SECRET: "j".repeat(48),
  INTERNAL_TOKEN: "i".repeat(48),
  DATABASE_URL_BACKEND: "postgres://app_backend:from-vault@db:5432/ai_expert",
};
const DEV_DB = `postgres://app_backend:${DEV_DEFAULTS.DB_PASSWORD}@localhost:5432/ai_expert`;

describe("生产环境的密钥检查", () => {
  it("默认 JWT_SECRET：拒绝启动", () => {
    expect(() => assertProductionSecrets({ ...PROD, JWT_SECRET: DEV_DEFAULTS.JWT_SECRET })).toThrow(/JWT_SECRET/);
  });

  it("过短的 JWT_SECRET：拒绝启动", () => {
    expect(() => assertProductionSecrets({ ...PROD, JWT_SECRET: "x".repeat(20) })).toThrow(/JWT_SECRET/);
  });

  it("默认 INTERNAL_TOKEN：拒绝启动", () => {
    expect(() => assertProductionSecrets({ ...PROD, INTERNAL_TOKEN: DEV_DEFAULTS.INTERNAL_TOKEN })).toThrow(/INTERNAL_TOKEN/);
  });

  it("连接串还是开发密码：拒绝启动", () => {
    expect(() => assertProductionSecrets({ ...PROD, DATABASE_URL_BACKEND: DEV_DB })).toThrow(/DATABASE_URL_BACKEND/);
  });

  it("一次列出全部问题，而不是改一个报一个", () => {
    const run = () =>
      assertProductionSecrets({
        NODE_ENV: "production",
        JWT_SECRET: DEV_DEFAULTS.JWT_SECRET,
        INTERNAL_TOKEN: DEV_DEFAULTS.INTERNAL_TOKEN,
        DATABASE_URL_BACKEND: DEV_DB,
      });
    expect(run).toThrow(/JWT_SECRET[\s\S]*INTERNAL_TOKEN[\s\S]*DATABASE_URL_BACKEND/);
  });

  it("真实值：通过", () => {
    expect(() => assertProductionSecrets(PROD)).not.toThrow();
  });

  it("开发环境：允许默认值（本地开箱即用）", () => {
    expect(() =>
      assertProductionSecrets({ ...PROD, NODE_ENV: "development", JWT_SECRET: DEV_DEFAULTS.JWT_SECRET }),
    ).not.toThrow();
  });
});
