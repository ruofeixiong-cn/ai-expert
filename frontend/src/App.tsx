import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, Link } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { getAccessToken, logout, restoreSession, subscribe } from "@/lib/auth";
// 登录态丢失时清空缓存的逻辑挂在这个模块里，见 lib/queryClient.ts
import { queryClient as qc } from "@/lib/queryClient";
import { Button, Spinner } from "@/components/ui";

/**
 * 路由级代码分割（F24）。
 *
 * 分享页的真实流量几乎全是手机和微信内置浏览器：粉丝点开一个链接，
 * 不该为此下载整个 Creator 控制台 —— 七维确认页、上传页、以及它们背后的
 * 契约校验（zod）。静态 import 时这些全在同一个包里。
 *
 * 分成按需加载之后，粉丝只拿 SharePage 那一块；博主那几页在进去时才下载。
 */
const SharePage = lazy(() => import("@/features/chat/SharePage"));
const LoginPage = lazy(() => import("@/features/auth/LoginPage"));
const ExpertListPage = lazy(() => import("@/features/experts/ExpertListPage"));
const ExpertDetailPage = lazy(() => import("@/features/experts/ExpertDetailPage"));
const ModelPage = lazy(() => import("@/features/experts/ModelPage"));

const PageFallback = () => (
  <div className="flex h-full items-center justify-center py-16">
    <Spinner className="size-6" />
  </div>
);

const useAuthed = () => useSyncExternalStore(subscribe, () => getAccessToken() !== null);

function Shell() {
  return (
    <div className="min-h-full">
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <Link to="/app" className="text-sm font-semibold">AI 专家平台</Link>
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            <LogOut className="size-4" /> 退出
          </Button>
        </div>
      </header>
      <Outlet />
    </div>
  );
}

function Protected() {
  return useAuthed() ? <Shell /> : <Navigate to="/login" replace />;
}

export default function App() {
  const authed = useAuthed();
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    // 分享页是给粉丝看的，没有博主会话可恢复 ——
    // 不跳过的话每个粉丝打开链接都要先等一次注定 401 的 /refresh。
    if (location.pathname.startsWith("/s/")) return setBooting(false);
    // access token 只存内存，刷新页面就没了 ——
    // 用 httpOnly Cookie 里的 refresh token 换一个回来，恢复登录态。
    void restoreSession().finally(() => setBooting(false));
  }, []);

  if (booting) {
    return <div className="flex h-full items-center justify-center"><Spinner className="size-6" /></div>;
  }

  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            {/* 粉丝端。不需要登录，也不套 Creator 的外壳。 */}
            <Route path="/s/:slug" element={<SharePage />} />
            <Route path="/login" element={authed ? <Navigate to="/app" replace /> : <LoginPage />} />
            <Route path="/app" element={<Protected />}>
              <Route index element={<ExpertListPage />} />
              <Route path="experts/:id" element={<ExpertDetailPage />} />
              <Route path="experts/:id/model" element={<ModelPage />} />
            </Route>
            <Route path="*" element={<Navigate to={authed ? "/app" : "/login"} replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
