import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, systemTx } from "../src/db/client.js";
import { creatorWithExpert, publishedExpert } from "./helpers.js";

/**
 * B27（见 docs/adr/008）：短链解析曾经只在本地能跑通。
 *
 * resolve_share_slug 是 SECURITY DEFINER，以属主身份读 experts，而 experts 开了
 * FORCE ROW LEVEL SECURITY。本地的 app_owner 是超级用户，连 FORCE 也绕过，
 * 于是它一直是绿的；生产上迁移账号不是超级用户 → 0 行 → 所有分享链接 404，
 * 接口、日志、测试都不会有任何异常。
 *
 * 第一条用例是尺子本身：只要本地数据库又把 app_owner 变成超级用户，
 * 这一整类「靠 owner 特权才跑得通」的代码就会重新变绿，而我们不会知道。
 */
afterAll(async () => { await closeDb(); });

describe("B27 · 短链解析不依赖 owner 特权", () => {
  it("本地的 app_owner 必须是普通角色（权限形状和生产一样）", async () => {
    const [row] = await systemTx((tx) => tx.execute(sql`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'app_owner'
    `)) as unknown as Array<{ rolsuper: boolean; rolbypassrls: boolean }>;

    expect(row, "app_owner 角色不存在？").toBeDefined();
    expect(row!.rolsuper, "app_owner 是超级用户：它会绕过 FORCE RLS，本地测试失去意义").toBe(false);
    expect(row!.rolbypassrls, "app_owner 有 BYPASSRLS：同上").toBe(false);
  });

  it("没有角色【继承】share_resolver，否则策略会顺着成员关系扩散", async () => {
    // app_owner 是它的成员（改属主要用），但必须是 INHERIT FALSE：
    // 能 SET ROLE 过去，却不会顺带获得它的可见性。
    const rows = await systemTx((tx) => tx.execute(sql`
      select pg_get_userbyid(member) as member, inherit_option
      from pg_auth_members where roleid = 'share_resolver'::regrole
    `)) as unknown as Array<{ member: string; inherit_option: boolean }>;

    expect(rows.filter((r) => r.inherit_option).map((r) => r.member)).toEqual([]);
  });

  it("没有租户上下文时，已上线专家的短链能解析出来", async () => {
    const { slug, id, tenantId } = await publishedExpert();

    const rows = await systemTx((tx) => tx.execute(sql`
      select expert_id, tenant_id from resolve_share_slug(${slug})
    `)) as unknown as Array<{ expert_id: string; tenant_id: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.expert_id).toBe(id);
    expect(rows[0]!.tenant_id).toBe(tenantId);
  });

  it("未上线的专家解析不到", async () => {
    await creatorWithExpert(); // 建了但没上线
    const rows = await systemTx((tx) => tx.execute(sql`
      select expert_id from resolve_share_slug('nope-not-a-real-slug')
    `)) as unknown as unknown[];

    expect(rows).toHaveLength(0);
  });

  it("这条策略没有削弱隔离：无租户上下文时 experts 仍然一行都读不到", async () => {
    await publishedExpert(); // 确保库里确实有已上线的专家

    const [row] = await systemTx((tx) => tx.execute(sql`
      select count(*)::int as n from experts
    `)) as unknown as Array<{ n: number }>;

    expect(row!.n, "app_backend 在无租户上下文时读到了 experts 的行").toBe(0);
  });
});
