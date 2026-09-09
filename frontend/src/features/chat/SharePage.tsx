import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { Send, Sparkles, Lock } from "lucide-react";
import { api } from "@/api/client";
import { streamChat } from "@/lib/sse";
import { Button, Card, Spinner, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";

type Msg = { role: "user" | "assistant"; text: string; streaming?: boolean };

/**
 * 粉丝端。这是唯一面向【非博主】用户的页面。
 *
 * 不需要登录 —— 分享页首屏要求注册等于转化率归零。
 * 身份是后端下发的匿名 Cookie，试聊额度按它计。
 */
export default function SharePage() {
  const { slug = "" } = useParams();
  const [info, setInfo] = useState<{
    name: string; creatorNickname: string | null; knowledgeSize: number; trialRemaining: number;
  } | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [paywall, setPaywall] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const load = async () => {
    const { data, error } = await api.GET("/api/chat/{slug}", { params: { path: { slug } } });
    if (error || !data) return setNotFound(true);
    setInfo(data.data);
  };
  useEffect(() => { void load(); }, [slug]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  async function ask() {
    const question = input.trim();
    if (!question || busy) return;
    setInput("");
    setPaywall(null);
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", text: question }, { role: "assistant", text: "", streaming: true }]);

    const ac = new AbortController();
    try {
      for await (const ev of streamChat(slug, question, ac.signal)) {
        if (ev.event === "delta") {
          setMsgs((m) => {
            const next = [...m];
            const last = next[next.length - 1]!;
            next[next.length - 1] = { ...last, text: last.text + ev.data.text };
            return next;
          });
        } else if (ev.event === "error") {
          // 402 是"要付费"，不是"出错了" —— 分开处理
          if (ev.data.code === 402) {
            setPaywall(ev.data.message);
            setMsgs((m) => m.slice(0, -2)); // 收回没答成的那一轮
          } else {
            setMsgs((m) => {
              const next = [...m];
              next[next.length - 1] = { role: "assistant", text: ev.data.message };
              return next;
            });
          }
        }
      }
    } finally {
      setBusy(false);
      setMsgs((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, streaming: false } : x)));
      void load(); // 刷新试聊剩余
    }
  }

  if (notFound) {
    return (
      <div className="flex min-h-full items-center justify-center px-6 text-center">
        <div>
          <p className="text-sm text-ink-600">这个链接无效，或者专家还没有上线。</p>
        </div>
      </div>
    );
  }
  if (!info) return <div className="flex min-h-full items-center justify-center"><Spinner /></div>;

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col px-4">
      <header className="py-6 text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-brand-50">
          <Sparkles className="size-5 text-brand-600" />
        </div>
        <h1 className="mt-3 text-base font-semibold">{info.name}</h1>
        <p className="mt-1 text-xs text-ink-600">
          {info.creatorNickname ? `${info.creatorNickname} 的 AI 专家 · ` : ""}
          读过他 {info.knowledgeSize} 段内容
        </p>
      </header>

      <div className="flex-1 space-y-4 pb-4">
        {msgs.length === 0 && (
          <Card className="px-4 py-8 text-center">
            <p className="text-sm text-ink-600">问点什么吧 —— 他写过的话题都可以聊。</p>
            <p className="mt-2 text-xs text-ink-400">
              回答基于他公开发表的内容；他没讲过的，这里不会替他编。
            </p>
          </Card>
        )}

        {msgs.map((m, i) => (
          <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                m.role === "user"
                  ? "bg-brand-600 text-white"
                  : "border border-ink-200 bg-white text-ink-900",
              )}
            >
              {m.text}
              {m.streaming && <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-ink-400 align-middle" />}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      {paywall && (
        <Card className="mb-4 flex items-center gap-3 border-amber-200 bg-amber-50 p-4">
          <Lock className="size-5 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-800">{paywall}</div>
        </Card>
      )}

      <div className="sticky bottom-0 bg-ink-50 pb-4 pt-2">
        <div className="flex items-end gap-2">
          <Textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(); }
            }}
            placeholder={info.trialRemaining > 0 ? "问他一个问题…" : "试聊次数已用完"}
            disabled={info.trialRemaining === 0 && !busy}
            className="min-h-10 flex-1"
          />
          <Button onClick={() => void ask()} loading={busy} disabled={!input.trim()} className="h-10">
            <Send className="size-4" />
          </Button>
        </div>
        <p className="mt-2 text-center text-xs text-ink-400">
          {info.trialRemaining > 0
            ? `还可以免费问 ${info.trialRemaining} 次`
            : "免费次数已用完"}
          {" · "}内容由 AI 基于博主公开内容生成，仅供参考
        </p>
      </div>
    </div>
  );
}
