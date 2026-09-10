import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { onEnterSubmit } from "./keyboard";

/**
 * F04：中文输入法回车误发送。
 *
 * 拼音输入法里，回车的意思是「把候选词上屏」，不是「发送」。
 * 组字期间浏览器照样派发 keydown —— 不判断的话，打了一半的问题就被发出去，
 * 还白扣一次试聊额度。
 *
 * M3 当时用 JS 直接派发 keydown 验证 Enter 键，恰好绕过了组字，所以没测出来。
 */
function Field({ submit }: { submit: () => void }) {
  return <textarea aria-label="问题" onKeyDown={onEnterSubmit(submit)} />;
}

function setup() {
  const submit = vi.fn();
  render(<Field submit={submit} />);
  return { submit, el: screen.getByLabelText("问题") };
}

describe("onEnterSubmit", () => {
  it("普通回车：提交，并阻止换行", () => {
    const { submit, el } = setup();
    const notPrevented = fireEvent.keyDown(el, { key: "Enter" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it("Shift + 回车：换行，不提交", () => {
    const { submit, el } = setup();
    fireEvent.keyDown(el, { key: "Enter", shiftKey: true });
    expect(submit).not.toHaveBeenCalled();
  });

  it("组字中的回车（Chrome / Firefox 标记 isComposing）：不提交，也不拦截", () => {
    const { submit, el } = setup();
    const notPrevented = fireEvent.keyDown(el, { key: "Enter", isComposing: true });
    expect(submit).not.toHaveBeenCalled();
    // 不能 preventDefault —— 那样候选词就上不了屏
    expect(notPrevented).toBe(true);
  });

  it("组字中的回车（Safari 只给 keyCode 229）：不提交", () => {
    const { submit, el } = setup();
    fireEvent.keyDown(el, { key: "Enter", keyCode: 229 });
    expect(submit).not.toHaveBeenCalled();
  });

  it("其他按键：不提交", () => {
    const { submit, el } = setup();
    fireEvent.keyDown(el, { key: "a" });
    expect(submit).not.toHaveBeenCalled();
  });
});
