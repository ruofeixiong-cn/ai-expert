import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import ModelPage from "./ModelPage";
import { api } from "@/api/client";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/client")>()),
  api: { GET: vi.fn(), POST: vi.fn(), PUT: vi.fn() },
}));

/**
 * F01：上线之后再也无法「重新上线」。
 *
 * 有了分享链接之后，卡片只渲染链接，上线按钮所在的分支永远不再出现 ——
 * 而旁边的文案写着「改完再点一次上线才生效」。
 */

const GET = api.GET as unknown as Mock;
const POST = api.POST as unknown as Mock;

const EVIDENCE = "11111111-1111-4111-8111-111111111111";
const MODEL = {
  persona: [],
  knowledge: [{ content: "综合费率会显著影响收益", confidence: 0.9, evidenceChunkIds: [EVIDENCE] }],
  beliefs: [],
  methodology: [],
  decisionRules: [],
  boundaries: [{ content: "不冒充本人", kind: "impersonation" }],
  examples: [],
};

const envelope = (data: unknown) => ({ data: { code: 0, message: "ok", data } });

function mockExpert(shareSlug: string | null, hasUnpublishedChanges = true) {
  GET.mockImplementation(async (path: string) =>
    path === "/api/experts/{id}/model"
      ? envelope({
          draft: MODEL, generatedAt: null, confirmed: MODEL,
          confirmedDimensions: ["boundaries"], chunkCount: 3, hasUnpublishedChanges,
        })
      : envelope({ id: "e1", name: "理财老王", shareSlug, confirmedDimensions: ["boundaries"] }),
  );
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/app/experts/e1/model"]}>
        <Routes>
          <Route path="/app/experts/:id/model" element={<ModelPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ModelPage 的上线", () => {
  beforeEach(() => {
    GET.mockReset();
    POST.mockReset();
  });

  it("未上线：显示上线按钮", async () => {
    mockExpert(null);
    renderPage();
    expect(await screen.findByRole("button", { name: "上线" })).toBeInTheDocument();
  });

  it("已上线：仍能把之后的修改推到线上", async () => {
    mockExpert("abc123");
    POST.mockResolvedValue(
      envelope({ shareSlug: "abc123", shareUrl: "http://localhost/s/abc123", publishedAt: "2026-09-11T00:00:00Z" }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /更新线上版本/ }));

    expect(await screen.findByText(/线上已更新/)).toBeInTheDocument();
    expect(POST).toHaveBeenCalledWith("/api/experts/{id}/publish", expect.anything());
  });

  /**
   * F01 后半截（ADR-009）：那句「改完要再点一次上线」以前是无条件的，
   * 于是"改了没推"和"什么都没改"长得一模一样。
   */
  it("有改动没推：明确提醒，按钮可点", async () => {
    mockExpert("abc123", true);
    renderPage();

    expect(await screen.findByText(/你有修改还没推到线上/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /更新线上版本/ })).toBeEnabled();
  });

  it("没有改动：说明线上已是最新，按钮置灰", async () => {
    mockExpert("abc123", false);
    renderPage();

    expect(await screen.findByText(/线上就是你现在看到的版本/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /更新线上版本/ })).toBeDisabled();
    expect(screen.queryByText(/你有修改还没推到线上/)).toBeNull();
  });
});
