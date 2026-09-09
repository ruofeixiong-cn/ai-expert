import { useEffect, useState, useSyncExternalStore } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, Link } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { getAccessToken, logout, restoreSession, subscribe } from "@/lib/auth";
import { Button, Spinner } from "@/components/ui";
import LoginPage from "@/features/auth/LoginPage";
import ExpertListPage from "@/features/experts/ExpertListPage";
import ExpertDetailPage from "@/features/experts/ExpertDetailPage";
import ModelPage from "@/features/experts/ModelPage";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,            // 401 已由 api client 自动刷新重试，这里不必再叠
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
});

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
