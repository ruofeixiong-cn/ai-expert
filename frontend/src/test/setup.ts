import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// jsdom 没有实现 scrollIntoView，对话页每来一段文字都会调它
Element.prototype.scrollIntoView = () => {};
