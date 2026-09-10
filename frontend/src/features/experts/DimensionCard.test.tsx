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
    expect(onConfirm).toHaveBeenCalledWith([{ ...ORIGINAL[0], content: "改过的说法" }]);

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
    expect(screen.getByText(/第 2 条还没填/)).toBeInTheDocument();
  });

  it("真实样本：契约要求有原文出处，不提供手动添加", () => {
    const example: AnyItem[] = [{ question: "定投要停吗", answer: "急用钱才停", evidenceChunkIds: [EVIDENCE] }];
    renderCard(vi.fn(), { dim: "examples", items: example });

    fireEvent.click(screen.getByRole("button", { name: /真实样本/ }));

    expect(screen.queryByRole("button", { name: /添加一条/ })).toBeNull();
    expect(screen.getByText(/暂不支持手动添加/)).toBeInTheDocument();
  });
});
