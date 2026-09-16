import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DimensionCard } from "./DimensionCard";
import type { AnyItem, Dim } from "./dimensions";

/**
 * F03：确认失败时编辑内容被清空。
 *
 * 第一版在请求发出的同时就清掉了 dirty，于是 effect 立刻把草稿换回服务端旧数据：
 * 请求中编辑内容闪回旧版，请求失败则永久丢失。
 */

const EVIDENCE = "11111111-1111-4111-8111-111111111111";
const ORIGINAL: AnyItem[] = [{ content: "原来的说法", confidence: 0.9, evidenceChunkIds: [EVIDENCE] }];

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// beliefs 默认展开，不用先点标题
function renderCard(
  onConfirm: (items: AnyItem[]) => Promise<unknown>,
  { dim = "beliefs" as Dim, items = ORIGINAL } = {},
) {
  return render(<DimensionCard dim={dim} items={items} confirmed={false} onConfirm={onConfirm} />);
}

function edit(value: string) {
  fireEvent.change(screen.getByDisplayValue("原来的说法"), { target: { value } });
}

const clickConfirm = () => fireEvent.click(screen.getByRole("button", { name: "确认这一块" }));

describe("DimensionCard 的确认", () => {
  it("请求进行中：编辑内容不闪回旧版", async () => {
    const d = deferred();
    renderCard(() => d.promise);

    edit("改过的说法");
    clickConfirm();

    expect(screen.getByDisplayValue("改过的说法")).toBeInTheDocument();
    await act(async () => d.resolve());
  });

  it("请求失败：编辑内容保留，并在这张卡片里说明原因", async () => {
    renderCard(() => Promise.reject({ code: 1001, message: "beliefs 的条目格式不对" }));

    edit("改过的说法");
    clickConfirm();

    expect(await screen.findByText("beliefs 的条目格式不对")).toBeInTheDocument();
    expect(screen.getByDisplayValue("改过的说法")).toBeInTheDocument();
  });

  it("请求成功：之后以服务端返回的数据为准", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderCard(onConfirm);

    edit("改过的说法");
    await act(async () => clickConfirm());
    // 博主动过的条目归他（ADR-003）：出处保留，但不再算 AI 推断
    expect(onConfirm).toHaveBeenCalledWith([
      { ...ORIGINAL[0], content: "改过的说法", origin: "creator" },
    ]);

    const saved: AnyItem[] = [{ content: "服务端规范化后的说法", confidence: 0.9, evidenceChunkIds: [EVIDENCE] }];
    rerender(<DimensionCard dim="beliefs" items={saved} confirmed onConfirm={onConfirm} />);

    expect(screen.getByDisplayValue("服务端规范化后的说法")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已确认" })).toBeInTheDocument();
  });

  it("有空条目：不发请求，就近提示", () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderCard(onConfirm);

    fireEvent.click(screen.getByRole("button", { name: /添加一条/ }));
    clickConfirm();

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/第 2 条的内容还没填/)).toBeInTheDocument();
  });

});

/**
 * F02 / ADR-003：条目来源。
 *
 * 修复前判定「AI 推断」只看证据是否为空，于是博主亲手写的条目被标成
 * "AI 推断的，你的原文里没有这句" —— M2 最核心的信任界面，指认方向正好反了。
 */
describe("条目来源", () => {
  const AI_GUESS: AnyItem[] = [{ content: "AI 脑补的立场", confidence: 0.4, evidenceChunkIds: [] }];
  const redFlags = () => screen.queryAllByText(/AI 推断的/);

  it("AI 推断的条目照常标红", () => {
    renderCard(vi.fn(), { items: AI_GUESS });
    expect(redFlags()).toHaveLength(1);
  });

  it("博主自己加的条目不被指认成 AI 编造", () => {
    renderCard(vi.fn(), { items: AI_GUESS });

    fireEvent.click(screen.getByRole("button", { name: /添加一条/ }));

    // 新条目同样没有出处，但它是博主写的 —— 红色标记只能还是那一条
    expect(redFlags()).toHaveLength(1);
    expect(screen.getByText("你写的")).toBeInTheDocument();
  });

  it("博主改写过的 AI 条目不再标红", () => {
    renderCard(vi.fn(), { items: AI_GUESS });
    expect(redFlags()).toHaveLength(1);

    fireEvent.change(screen.getByDisplayValue("AI 脑补的立场"), {
      target: { value: "我自己的立场" },
    });

    expect(redFlags()).toHaveLength(0);
  });

  it("真实样本：博主可以手动补一条，不再撞必然的 400", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const example: AnyItem[] = [
      { question: "定投要停吗", answer: "急用钱才停", evidenceChunkIds: [EVIDENCE] },
    ];
    renderCard(onConfirm, { dim: "examples", items: example });

    fireEvent.click(screen.getByRole("button", { name: /真实样本/ }));
    fireEvent.click(screen.getByRole("button", { name: /添加一条/ }));
    // 第 2 行才是刚加的那条
    fireEvent.change(screen.getAllByPlaceholderText(/粉丝可能会这样问/)[1]!, {
      target: { value: "定投要不要择时" },
    });
    fireEvent.change(screen.getAllByPlaceholderText(/你在原文里是这样回答的/)[1]!, {
      target: { value: "不要" },
    });
    await act(async () => clickConfirm());

    // 关键：手写样本没有出处，前端不再本地拦截，后端也不再 400
    expect(onConfirm).toHaveBeenCalledWith([
      example[0],
      { question: "定投要不要择时", answer: "不要", evidenceChunkIds: [], origin: "creator" },
    ]);
  });
});
