import { useEffect, useState, useSyncExternalStore } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, Link } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { getAccessToken, logout, restoreSession, subscribe } from "@/lib/auth";
// 登录态丢失时清空缓存的逻辑挂在这个模块里，见 lib/queryClient.ts
import { queryClient as qc } from "@/lib/queryClient";
import { Button, Spinner } from "@/components/ui";
import LoginPage from "@/features/auth/LoginPage";
import ExpertListPage from "@/features/experts/ExpertListPage";
import ExpertDetailPage from "@/features/experts/ExpertDetailPage";
import ModelPage from "@/features/experts/ModelPage";
import SharePage from "@/features/chat/SharePage";

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
      </BrowserRouter>
    </QueryClientProvider>
  );
}
