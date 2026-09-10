import type { KeyboardEvent } from "react";

/**
 * 回车提交、Shift + 回车换行，并且【不打断输入法组字】（F04）。
 *
 * 拼音输入法里回车的意思是「把候选词上屏」。组字期间浏览器照样派发 keydown：
 *   Chrome / Firefox：isComposing = true
 *   Safari：compositionend 先于 keydown 触发，isComposing 已经是 false，
 *           只能靠 keyCode 229 认出来
 * 两个都要判断，缺一个就有一类用户会把打了一半的问题发出去。
 *
 * 组字中的回车也【不能 preventDefault】，否则候选词上不了屏。
 *
 * 所有「回车提交」都走这里，不要在组件里手写 onKeyDown。
 */
export function onEnterSubmit(submit: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  };
}
