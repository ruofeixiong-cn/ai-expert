import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { getDb, closeDb, tenantTx, systemTx } from "../src/db/client.js";

/**
 * M0 的核心测试：验收标准 #8（租户 A 检索不到租户 B 的知识）。
 *
 * 这些断言是【安全测试】，因此数据库不可达时必须【失败】而不是跳过 ——
 * 跳过会让 CI 变绿，给人"隔离已验证"的错觉。
 */

const AGENT_URL =
  process.env.DATABASE_URL_AGENT_JS ??
  "postgres://app_agent:agent_dev_pw@localhost:5432/ai_expert";

let tenantA: string;
let tenantB: string;
let chunkA: string;
let chunkB: string;

async function seed() {
  const db = getDb();
  const suffix = Date.now().toString(36);

  const [user] = await db.execute<{ id: string }>(sql`
    insert into users (role, nickname) values ('creator', ${"seed_" + suffix})
    returning id
  `);
  const userId = user!.id;

  const mk = async (name: string) => {
    const [t] = await db.execute<{ id: string }>(sql`
      insert into tenants (owner_user_id, name) values (${userId}, ${name}) returning id
    `);
    const tenantId = t!.id;
    // experts / chunks 都有 RLS 且 FORCE，所以连播种也必须在租户上下文里
    const chunkId = await tenantTx(tenantId, async (tx) => {
      const [e] = await tx.execute<{ id: string }>(sql`
        insert into experts (tenant_id, owner_id, name)
        values (${tenantId}, ${userId}, ${name}) returning id
      `);
      const [c] = await tx.execute<{ id: string }>(sql`
        insert into chunks (tenant_id, expert_id, channel, content)
        values (${tenantId}, ${e!.id}, 'knowledge', ${"secret of " + name}) returning id
      `);
      return c!.id;
    });
    return { tenantId, chunkId };
  };

  const a = await mk("tenant_a_" + suffix);
  const b = await mk("tenant_b_" + suffix);
  tenantA = a.tenantId; chunkA = a.chunkId;
  tenantB = b.tenantId; chunkB = b.chunkId;
}

beforeAll(async () => {
  try {
    await getDb().execute(sql`select 1`);
  } catch (e) {
    throw new Error(
      "数据库不可达。隔离测试不允许跳过 —— 请先 `make up && make migrate`。\n" + String(e),
    );
  }
  await seed();
});

afterAll(async () => { await closeDb(); });

describe("RLS 租户隔离", () => {
  // A3
  it("设置租户 A 后，按 id 查租户 B 的 chunk 返回 0 行", async () => {
    const own = await tenantTx(tenantA, (tx) =>
      tx.execute(sql`select id from chunks where id = ${chunkA}`));
    expect(own.length).toBe(1);

    const other = await tenantTx(tenantA, (tx) =>
      tx.execute(sql`select id from chunks where id = ${chunkB}`));
    expect(other.length).toBe(0);
  });

  it("租户 A 全表扫 chunks 也看不到 B 的行", async () => {
    const rows = await tenantTx(tenantA, (tx) =>
      tx.execute<{ tenant_id: string }>(sql`select tenant_id from chunks`));
    expect(rows.every((r) => r.tenant_id === tenantA)).toBe(true);
  });

  // A5：fail-closed —— 未设置租户时是 0 行，不是抛异常
  it("未设置 app.current_tenant 时查 chunks 返回 0 行（而非报错）", async () => {
    const rows = await systemTx((tx) => tx.execute(sql`select id from chunks`));
    expect(rows.length).toBe(0);
  });

  // A7：WITH CHECK
  it("以租户 A 身份插入 tenant_id = B 的行会被拒绝", async () => {
    await expect(
      tenantTx(tenantA, async (tx) => {
        const [e] = await tx.execute<{ id: string }>(sql`select id from experts limit 1`);
        return tx.execute(sql`
          insert into chunks (tenant_id, expert_id, channel, content)
          values (${tenantB}, ${e!.id}, 'knowledge', 'cross-tenant write')
        `);
      }),
    ).rejects.toThrow();
  });

  // A6：权限允许清单
  it("app_agent 角色查 users 表被拒绝（GRANT 未授权）", async () => {
    const agentSql = postgres(AGENT_URL, { max: 1 });
    try {
      await expect(agentSql`select id from users limit 1`).rejects.toThrow(/permission denied/i);
    } finally {
      await agentSql.end();
    }
  });

  it("app_agent 角色可以读写 chunks", async () => {
    const agentSql = postgres(AGENT_URL, { max: 1 });
    try {
      await agentSql.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${tenantA}, true)`;
        const rows = await tx`select id from chunks`;
        expect(rows.length).toBeGreaterThan(0);
      });
    } finally {
      await agentSql.end();
    }
  });
});
