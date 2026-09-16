import { describe, expect, it } from "vitest";
import * as contract from "../../../../contracts/public/zod";
import { validateItems, type AnyItem } from "./dimensions";

/**
 * ADR-007：提交前的校验用的是【生成的】约束，不再手抄后端的 min/max。
 *
 * F03 就是手抄漏了一条的后果：类型检查全过，运行时必然 400。
 * 这组用例盯住两件事 —— 生成物确实带着约束，以及前端确实在用它。
 */

const EVIDENCE = "11111111-1111-4111-8111-111111111111";
const item = (over: Record<string, unknown> = {}): AnyItem =>
  ({ content: "一句话", confidence: 1, evidenceChunkIds: [EVIDENCE], ...over }) as AnyItem;

describe("生成的契约约束", () => {
  it("带着后端写的 min/max，而不是一个空壳", () => {
    expect(contract.ModelItem.safeParse(item({ content: "" })).success).toBe(false);
    expect(contract.ModelItem.safeParse(item()).success).toBe(true);

    // 素材标题 200 字上限：以前前端只显示字数、不拦，提交后才被服务端拒（F16 同源）
    const material = (title: string) =>
      contract.CreateMaterialInput.safeParse({ sourceType: "paste", title, content: "正文" });
    expect(material("x".repeat(200)).success).toBe(true);
    expect(material("x".repeat(201)).success).toBe(false);
  });

  it("origin 缺省解析成 ai —— 和后端一致", () => {
    const parsed = contract.ModelItem.parse({
      content: "一句话", confidence: 1, evidenceChunkIds: [],
    });
    // 若生成器给 origin 多套一层 .optional()，这里会变成 undefined
    expect(parsed.origin).toBe("ai");
  });
});

describe("validateItems", () => {
  it("空内容：拦在本地，不发请求", () => {
    expect(validateItems("beliefs", [item({ content: "" })])).toMatch(/内容还没填/);
  });

  it("合法条目：放行", () => {
    expect(validateItems("beliefs", [item()])).toBeNull();
  });

  it("禁区按 BoundaryItem 校验：缺 kind 不放行", () => {
    expect(validateItems("boundaries", [{ content: "不冒充本人" } as AnyItem])).not.toBeNull();
    expect(
      validateItems("boundaries", [{ content: "不冒充本人", kind: "impersonation" } as AnyItem]),
    ).toBeNull();
  });

  it("样本：问题或回答没填，指出是哪一个", () => {
    const e = (over: Record<string, unknown>) =>
      validateItems("examples", [
        { question: "问", answer: "答", evidenceChunkIds: [EVIDENCE], ...over } as AnyItem,
      ]);
    expect(e({ question: "" })).toMatch(/问题还没填/);
    expect(e({ answer: "" })).toMatch(/回答还没填/);
  });

  /**
   * 条件约束表达不进 JSON Schema，所以生成的 schema 放行 —— 必须由前端补一句显式判断。
   * 这一条同时守着"别哪天顺手把它删了"。
   */
  it("样本的证据按来源分叉：生成的 schema 管不了，前端补", () => {
    const noEvidence = { question: "问", answer: "答", evidenceChunkIds: [] };
    expect(contract.ExampleItem.safeParse({ ...noEvidence, origin: "ai" }).success).toBe(true);

    expect(validateItems("examples", [{ ...noEvidence, origin: "ai" } as AnyItem])).toMatch(/出处/);
    expect(validateItems("examples", [{ ...noEvidence, origin: "creator" } as AnyItem])).toBeNull();
  });
});
