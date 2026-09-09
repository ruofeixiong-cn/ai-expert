import { useEffect, useState } from "react";
import { api } from "./api/client";

/**
 * M0 的前端只做一件事：证明契约类型链路是通的。
 * 如果后端把 readyz 的字段改名而没跑 make contract，这个文件会编译失败。
 */
export default function App() {
  const [ready, setReady] = useState<{ database: string; agent: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .GET("/readyz")
      .then(({ data, error }) => {
        if (error || !data) return setErr("后端不可达");
        // data.data 的类型来自 contracts/public/api.d.ts，不是 any
        setReady({ database: data.data.database, agent: data.data.agent });
      })
      .catch(() => setErr("后端不可达"));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui", padding: 32, lineHeight: 1.8 }}>
      <h1 style={{ fontSize: 20 }}>AI 专家平台 · M0</h1>
      {err && <p style={{ color: "#c00" }}>{err}</p>}
      {ready && (
        <ul>
          <li>database: {ready.database}</li>
          <li>agent: {ready.agent}</li>
        </ul>
      )}
      {!ready && !err && <p>检查依赖中…</p>}
    </main>
  );
}
