import { useState } from "react";
import { useNavigate } from "react-router";
import { api, errorMessage } from "@/api/client";
import { setAccessToken } from "@/lib/auth";
import { Alert, Button, Card, Input, Label } from "@/components/ui";

export default function LoginPage() {
  const nav = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res =
        mode === "login"
          ? await api.POST("/api/auth/login", { body: { account, password } })
          : await api.POST("/api/auth/register", {
              body: {
                password,
                nickname: nickname || undefined,
                ...(account.includes("@") ? { email: account } : { phone: account }),
              },
            });
      if (res.error || !res.data) return setError(errorMessage(res.error));
      // refresh token 已由服务端写进 httpOnly Cookie，前端只拿 access token
      setAccessToken(res.data.data.accessToken);
      nav("/app", { replace: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-xl font-semibold text-ink-900">AI 专家平台</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-600">
            把你的知识和经验，
            <br />
            变成一个 24 小时在线的 AI 专家
          </p>
        </div>

        <Card className="p-6">
          <div className="mb-5 flex gap-1 rounded-lg bg-ink-100 p-1">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); setError(null); }}
                className={
                  "flex-1 rounded-md py-1.5 text-sm font-medium transition " +
                  (mode === m ? "bg-white text-ink-900 shadow-sm" : "text-ink-600 hover:text-ink-800")
                }
              >
                {m === "login" ? "登录" : "注册"}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <Label htmlFor="account">邮箱或手机号</Label>
              <Input
                id="account" value={account} onChange={(e) => setAccount(e.target.value)}
                autoComplete="username" placeholder="you@example.com" required
              />
            </div>

            {mode === "register" && (
              <div>
                <Label htmlFor="nickname">昵称</Label>
                <Input
                  id="nickname" value={nickname} onChange={(e) => setNickname(e.target.value)}
                  placeholder="粉丝看到的名字" maxLength={40}
                />
              </div>
            )}

            <div>
              <Label htmlFor="password">密码</Label>
              <Input
                id="password" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                placeholder={mode === "register" ? "至少 8 位" : ""}
                minLength={mode === "register" ? 8 : undefined} required
              />
            </div>

            {error && <Alert>{error}</Alert>}

            <Button type="submit" size="lg" className="w-full" loading={busy}>
              {mode === "login" ? "登录" : "注册并创建专家"}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
