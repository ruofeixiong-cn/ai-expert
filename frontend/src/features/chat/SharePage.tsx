import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { Send, Sparkles, Lock, ThumbsUp, ThumbsDown } from "lucide-react";
import { api, type Schema } from "@/api/client";
import { streamChat } from "@/lib/sse";
import { Button, Card, Input, Spinner, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";

type Rating = "up" | "down";
type Msg = {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  /** 回答落库后的 id，从 SSE 的 meta 事件拿。没有它就没法打分。 */
  id?: string;
  rating?: Rating | null;
};

type Info = Schema<"ChatExpertInfo">;

/**
 * 粉丝端。这是唯一面向【非博主】用户的页面。
 *
 * 不需要登录 —— 分享页首屏要求注册等于转化率归零。
 * 身份是后端下发的匿名 Cookie，试聊额度按它计。
 */
export default function SharePage() {
  const { slug = "" } = useParams();
  const [info, setInfo] = useState<Info | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [paywall, setPaywall] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const [commentFor, setCommentFor] = useState<string | null>(null);
  const [comment, setComment] = useState("");

  const load = async (withHistory = false) => {
    const { data, error } = await api.GET("/api/chat/{slug}", { params: { path: { slug } } });
    if (error || !data) return setNotFound(true);
    setInfo(data.data);
    // 只在首次进页面时铺历史 —— 提问过程中再铺会把正在流式输出的那条冲掉
    if (withHistory) {
      setMsgs(
        data.data.history.map((h) => ({
          role: h.role, text: h.content, id: h.id, rating: h.myRating,
        })),
      );
    }
  };
  useEffect(() => { void load(true); }, [slug]);
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
        if (ev.event === "meta") {
          // 回答此刻才有 id，赞/踩按钮要靠它
          setMsgs((m) => {
            const next = [...m];
            next[next.length - 1] = { ...next[next.length - 1]!, id: ev.data.message_id };
            return next;
          });
        } else if (ev.event === "delta") {
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

  /**
   * 打分。
   *
   * 摩擦必须低到接近零 —— 「用户没动机主动反馈」是产品规划文档点名的头号风险。
   * 所以先乐观更新按钮状态，网络失败再回滚：粉丝点完立刻看到反应，
   * 不用等一个 round trip。
   */
  async function rate(messageId: string, rating: Rating, text?: string) {
    const prev = msgs.find((m) => m.id === messageId)?.rating ?? null;
    setMsgs((m) => m.map((x) => (x.id === messageId ? { ...x, rating } : x)));

    const { error } = await api.POST("/api/chat/{slug}/feedback", {
      params: { path: { slug } },
      body: { messageId, rating, ...(text ? { comment: text } : {}) },
    });
    if (error) setMsgs((m) => m.map((x) => (x.id === messageId ? { ...x, rating: prev } : x)));
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
          <div key={m.id ?? i} className={cn("flex flex-col", m.role === "user" ? "items-end" : "items-start")}>
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

            {/* 回答落库拿到 id 之后才能打分；流式输出过程中不显示 */}
            {m.role === "assistant" && m.id && !m.streaming && (
              <div className="mt-1.5 flex items-center gap-1 pl-1">
                <RateButton
                  active={m.rating === "up"}
                  label="有帮助"
                  onClick={() => { setCommentFor(null); void rate(m.id!, "up"); }}
                >
                  <ThumbsUp className="size-3.5" />
                </RateButton>
                <RateButton
                  active={m.rating === "down"}
                  label="没帮助"
                  onClick={() => {
                    setCommentFor(m.id!);
                    setComment("");
                    void rate(m.id!, "down");
                  }}
                >
                  <ThumbsDown className="size-3.5" />
                </RateButton>
              </div>
            )}

            {/* 原因是可选的锦上添花 —— 上面那一下已经落库了，不填也没关系 */}
            {commentFor === m.id && (
              <div className="mt-1.5 flex w-full max-w-[85%] items-center gap-2 pl-1">
                <Input
                  autoFocus
                  value={comment}
                  maxLength={200}
                  onChange={(e) => setComment(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void rate(m.id!, "down", comment.trim() || undefined);
                      setCommentFor(null);
                    }
                  }}
                  placeholder="哪里不对？（可不填）"
                  className="h-8 flex-1 text-xs"
                />
                <button
                  type="button"
                  className="shrink-0 text-xs text-ink-400 hover:text-ink-600"
                  onClick={() => {
                    if (comment.trim()) void rate(m.id!, "down", comment.trim());
                    setCommentFor(null);
                  }}
                >
                  {comment.trim() ? "提交" : "跳过"}
                </button>
              </div>
            )}
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

function RateButton({
  active, label, onClick, children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        "rounded-md p-1.5 transition-colors",
        active ? "bg-brand-50 text-brand-600" : "text-ink-400 hover:bg-ink-100 hover:text-ink-600",
      )}
    >
      {children}
    </button>
  );
}
