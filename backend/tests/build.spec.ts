import { describe, it, expect, afterAll } from "vitest";
import { closeDb, tenantTx } from "../src/db/client.js";
import { buildJobs } from "../src/db/schema/index.js";
import { STALE_BUILD_SECONDS } from "../src/services/expert.js";
import { call, creatorWithExpert, json } from "./helpers.js";

/**
 * B06 的 backend 一半：约束（DDL）与状态展示。见 docs/adr/002-build-job-concurrency.md。
 */
afterAll(async () => { await closeDb(); });

const insertJob = (tenantId: string, expertId: string, values: Partial<typeof buildJobs.$inferInsert>) =>
  tenantTx(tenantId, (tx) => tx.insert(buildJobs).values({ tenantId, expertId, ...values }));

describe("构建任务", () => {
  it("同一个专家不能同时有两个进行中的任务 —— 数据库层保证，不靠应用层记得查", async () => {
    const { tenantId, id } = await creatorWithExpert();
    await insertJob(tenantId, id, { status: "running" });

    // 全量构建和「只重新提炼」写同一份草稿，所以跨 kind 也不行
    const err = await insertJob(tenantId, id, { kind: "model", status: "queued" }).catch((e) => e);

    const pg = err?.cause ?? err;
    expect(pg?.constraint_name).toBe("build_jobs_one_active_per_expert");
  });

  it("已经结束的任务不受限制：历史可以有任意多条", async () => {
    const { tenantId, id } = await creatorWithExpert();
    await insertJob(tenantId, id, { status: "succeeded" });
    await insertJob(tenantId, id, { status: "failed" });
    await expect(insertJob(tenantId, id, { status: "queued" })).resolves.toBeDefined();
  });

  it("长时间没有进展的任务，对外显示为已中断，而不是永远在转", async () => {
    const { token, tenantId, id } = await creatorWithExpert();
    await insertJob(tenantId, id, {
      status: "running", progress: 40, stage: "embedding",
      updatedAt: new Date(Date.now() - (STALE_BUILD_SECONDS + 60) * 1000),
    });

    const d = (await json(await call(`/api/experts/${id}`, { token }))).data;

    expect(d.lastBuild.status).toBe("failed");
    expect(d.lastBuild.error).toMatch(/没有进展/);
  });

  it("还在正常推进的任务照常显示", async () => {
    const { token, tenantId, id } = await creatorWithExpert();
    await insertJob(tenantId, id, { status: "running", progress: 40, stage: "embedding" });

    const d = (await json(await call(`/api/experts/${id}`, { token }))).data;

    expect(d.lastBuild.status).toBe("running");
    expect(d.lastBuild.error).toBeNull();
  });
});
