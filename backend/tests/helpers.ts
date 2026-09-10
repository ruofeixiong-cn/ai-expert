import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { tenantTx } from "../src/db/client.js";
import { experts, expertModelDrafts } from "../src/db/schema/index.js";
import { readFanToken } from "../src/services/chat.js";

/** 加固（B0x）测试共用的造数据工具。老的 spec 各自带一份，没有迁过来。 */

export const app = createApp();

export const uniqEmail = (prefix = "h") =>
  `${prefix}${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;

export const call = (path: string, init: RequestInit & { token?: string; cookie?: string } = {}) =>
  app.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
  });

export const json = async (r: Response) => (await r.json()) as any;

const MODEL = {
  persona: [{ content: "语气直接", confidence: 1, evidenceChunkIds: [] }],
  knowledge: [], beliefs: [], methodology: [], decisionRules: [],
  boundaries: [{ content: "不冒充本人", kind: "impersonation" }],
  examples: [],
};

/** 注册一个博主并建一个专家，返回 token 与专家 id。 */
export async function creatorWithExpert() {
  const reg = await json(await call("/api/auth/register", {
    method: "POST", body: JSON.stringify({ email: uniqEmail("c"), password: "pass12345678" }),
  }));
  const token = reg.data.accessToken as string;
  const tenantId = reg.data.tenant.id as string;
  const id = (await json(await call("/api/experts", {
    method: "POST", token, body: JSON.stringify({ name: "定投老王" }),
  }))).data.id as string;
  return { token, tenantId, id };
}

/** 造一个已上线的专家，返回它的短链。 */
export async function publishedExpert(freeTrial = 3) {
  const { token, tenantId, id } = await creatorWithExpert();
  await tenantTx(tenantId, (tx) =>
    tx.insert(expertModelDrafts).values({ expertId: id, tenantId, chunkCount: 5, model: MODEL }),
  );
  await tenantTx(tenantId, (tx) =>
    tx.update(experts).set({ freeTrialMessages: freeTrial }).where(eq(experts.id, id)),
  );
  const pub = (await json(await call(`/api/experts/${id}/publish`, { method: "POST", token }))).data;
  return { token, tenantId, id, slug: pub.shareSlug as string };
}

/** 以匿名粉丝身份打开一次分享页，返回 Cookie 与粉丝 id。 */
export async function newFan(slug: string) {
  const res = await call(`/api/chat/${slug}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const id = await readFanToken(cookie.replace("ae_fan=", ""));
  if (!id) throw new Error("没拿到匿名粉丝身份");
  return { cookie, id };
}
