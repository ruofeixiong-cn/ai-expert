import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import SharePage from "./SharePage";
import { api } from "@/api/client";
import { streamChat } from "@/lib/sse";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/client")>()),
  api: { GET: vi.fn(), POST: vi.fn() },
}));
vi.mock("@/lib/sse", () => ({ streamChat: vi.fn() }));

const GET = api.GET as unknown as Mock;
const STREAM = streamChat as unknown as Mock;

const INFO = {
  name: "理财老王", creatorNickname: "老王", knowledgeSize: 16,
  priceCents: 990, trialRemaining: 3, history: [],
};

const ok = (data: unknown) => ({ data: { code: 0, message: "ok", data }, response: { status: 200 } });
const fail = (status: number) => ({
  data: undefined, error: { code: status * 10, message: "出错了" }, response: { status },
});
const offline = () => Promise.reject(new TypeError("Failed to fetch"));

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/s/abc"]}>
      <Routes>
        <Route path="/s/:slug" element={<SharePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const box = () => screen.getByPlaceholderText("问他一个问题…");

function ask(question: string) {
  fireEvent.change(box(), { target: { value: question } });
  fireEvent.keyDown(box(), { key: "Enter" });
}

function answerWith(text: string) {
  STREAM.mockImplementation(async function* () {
    yield { event: "meta", data: { message_id: "m1", confidence: 0.8, chunk_ids: [] } };
    yield { event: "delta", data: { text } };
    yield { event: "done", data: { finish_reason: "stop", safety: "pass" } };
  });
}

beforeEach(() => {
  GET.mockReset();
  STREAM.mockReset();
});

/**
 * F05：分享页一次刷新失败，整页变成「链接无效」。
 *
 * 首屏加载和「回答后刷新额度」共用一个 load()，任何失败都 setNotFound(true)。
 */
describe("SharePage 的加载失败", () => {
  it("首屏 404：说链接无效", async () => {
    GET.mockResolvedValue(fail(404));
    renderPage();
    expect(await screen.findByText(/链接无效/)).toBeInTheDocument();
  });

  it("首屏 502：不说链接无效，给重试", async () => {
    GET.mockResolvedValueOnce(fail(502)).mockResolvedValueOnce(ok(INFO));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "重试" }));

    expect(await screen.findByText("理财老王")).toBeInTheDocument();
    expect(screen.queryByText(/链接无效/)).toBeNull();
  });

  it("首屏断网：不说链接无效，给重试", async () => {
    GET.mockImplementationOnce(offline).mockResolvedValueOnce(ok(INFO));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "重试" }));

    expect(await screen.findByText("理财老王")).toBeInTheDocument();
  });

  it.each([
    ["502", () => Promise.resolve(fail(502))],
    ["断网", offline],
  ])("回答后刷新额度失败（%s）：对话留在屏幕上", async (_, refresh) => {
    GET.mockResolvedValueOnce(ok(INFO)).mockImplementationOnce(refresh);
    answerWith("手续费会吃掉近两成收益");
    renderPage();
    await screen.findByText("理财老王");

    ask("定投的手续费能省吗");

    expect(await screen.findByText("手续费会吃掉近两成收益")).toBeInTheDocument();
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.getByText("定投的手续费能省吗")).toBeInTheDocument();
    expect(screen.queryByText(/链接无效/)).toBeNull();
  });
});

/** F04 在真实页面上的回归：组字中的回车不发送。 */
describe("SharePage 的输入", () => {
  it("输入法组字中按回车：不发送", async () => {
    GET.mockResolvedValue(ok(INFO));
    renderPage();
    await screen.findByText("理财老王");

    fireEvent.change(box(), { target: { value: "dingtou" } });
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });

    expect(STREAM).not.toHaveBeenCalled();
  });
});
