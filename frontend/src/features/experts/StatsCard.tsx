import { useQuery } from "@tanstack/react-query";
import { MessageSquare, ThumbsUp, Wallet, Search } from "lucide-react";
import { api, type Schema } from "@/api/client";
import { Card, Spinner } from "@/components/ui";

type Stats = Schema<"ExpertStats">;
type Blindspot = Schema<"Blindspot">;

/**
 * Creator 最小看板 —— 产品文档 §5 的"只做 3~5 个数字"。
 *
 * 只在专家已上线时挂出来：没上线的专家不可能有数据，
 * 显示四个 0 只会让博主以为出了问题。
 */
export default function StatsCard({ expertId }: { expertId: string }) {
  const q = useQuery({
    queryKey: ["stats", expertId],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/experts/{id}/stats", {
        params: { path: { id: expertId } },
      });
      if (error || !data) throw error;
      return data.data as Stats;
    },
  });

  if (q.isLoading) {
    return <Card className="mt-6 flex justify-center p-8"><Spinner /></Card>;
  }
  const s = q.data;
  if (!s) return null;

  return (
    <div className="mt-6">
      <h2 className="mb-3 text-sm font-medium text-ink-800">这个专家干得怎么样</h2>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat icon={<MessageSquare className="size-4" />} label="回答数" value={String(s.answers)} />
        <Stat
          icon={<ThumbsUp className="size-4" />}
          label="满意度"
          /* 「没人评价」和「所有人都说不好」是相反的两件事，
             用同一个 0% 表示会把博主吓死 */
          value={s.satisfaction === null ? "暂无评价" : `${Math.round(s.satisfaction * 100)}%`}
          hint={s.satisfaction === null ? undefined : `${s.upVotes} 赞 · ${s.downVotes} 踩`}
          muted={s.satisfaction === null}
        />
        <Stat
          icon={<Wallet className="size-4" />}
          label="收入"
          value={`¥${(s.revenueCents / 100).toFixed(2)}`}
          /* 现在真实收入就是 0。不粉饰成看起来像真数据的 0 */
          hint="接入付费后生效"
          muted
        />
        <Stat
          icon={<Search className="size-4" />}
          label="疑似盲区"
          value={String(s.blindspots)}
          tone={s.blindspots > 0 ? "warn" : undefined}
        />
      </div>

      {s.recentBlindspots.length > 0 && (
        <Card className="mt-3 p-4">
          <div className="text-sm font-medium">粉丝问了、但你没讲过的</div>
          <p className="mt-1 text-xs text-ink-600">
            这些是下一篇文章的选题 —— 补上之后，专家就能回答它们了。
          </p>
          <ul className="mt-3 space-y-2">
            {s.recentBlindspots.map((b: Blindspot) => (
              <li key={b.messageId} className="flex items-start justify-between gap-3 text-sm">
                <span className="text-ink-900">{b.question}</span>
                <span className="shrink-0 rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-600">
                  {b.reason === "no_context" ? "完全没有相关内容" : "相关内容太少"}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Stat({
  icon, label, value, hint, muted, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
  tone?: "warn";
}) {
  return (
    <Card className="p-3">
      <div className="flex items-center gap-1.5 text-xs text-ink-600">
        {icon}
        {label}
      </div>
      <div
        className={
          "mt-1.5 font-semibold " +
          (muted ? "text-base text-ink-400" : "text-xl ") +
          (tone === "warn" && !muted ? "text-amber-600" : "")
        }
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-ink-400">{hint}</div>}
    </Card>
  );
}
