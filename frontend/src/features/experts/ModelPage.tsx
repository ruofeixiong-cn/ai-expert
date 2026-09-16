import { useState } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, RefreshCw, Rocket, Sparkles } from "lucide-react";
import { api, errorMessage } from "@/api/client";
import { Alert, Button, Card, Spinner } from "@/components/ui";
import { DimensionCard } from "./DimensionCard";
import { DIMENSIONS, isAiInferred, type AnyItem, type Dim, type Model } from "./dimensions";

export default function ModelPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [published, setPublished] = useState<{ shareUrl: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const model = useQuery({
    queryKey: ["model", id],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/experts/{id}/model", { params: { path: { id } } });
      if (error || !data) throw error;
      return data.data;
    },
  });

  const expert = useQuery({
    queryKey: ["expert", id],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/experts/{id}", { params: { path: { id } } });
      if (error || !data) throw error;
      return data.data;
    },
  });

  const confirm = useMutation({
    mutationFn: async ({ dim, items }: { dim: Dim; items: AnyItem[] }) => {
      const { data, error } = await api.PUT("/api/experts/{id}/model/{dimension}", {
        params: { path: { id, dimension: dim } },
        body: { items },
      });
      if (error || !data) throw error;
      return data.data;
    },
    // 失败由卡片自己就近显示并保留博主的编辑（F03），这里不再往页面底部报
    onSuccess: (d) => {
      setNotice(null); // 有了新的未上线修改，「线上已更新」不再成立
      qc.setQueryData(["model", id], d);
    },
  });

  const regenerate = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/api/experts/{id}/model/regenerate", {
        params: { path: { id } },
      });
      if (error || !data) throw error;
      return data.data;
    },
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ["expert", id] }); },
    onError: (e) => setError(errorMessage(e)),
  });

  const publish = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/api/experts/{id}/publish", { params: { path: { id } } });
      if (error || !data) throw error;
      return data.data;
    },
    onSuccess: (d) => {
      setError(null);
      setPublished(d);
      qc.invalidateQueries({ queryKey: ["expert", id] });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (model.isPending) return <div className="flex justify-center py-20"><Spinner /></div>;
  if (model.isError) return <div className="p-10 text-center text-sm text-ink-600">专家不存在</div>;

  const m = model.data;
  const effective = m.confirmed as Model | null;

  if (!effective) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <Sparkles className="mx-auto size-8 text-ink-400" />
        <p className="mt-4 text-sm text-ink-600">
          还没有专家模型。先上传内容并构建，AI 会读完你的文章后生成一份思维说明书。
        </p>
        <Link to={`/app/experts/${id}`} className="mt-4 inline-block">
          <Button variant="outline">去上传内容</Button>
        </Link>
      </div>
    );
  }

  const flaggedTotal = DIMENSIONS.reduce(
    (n, d) => n + (effective[d.key] as AnyItem[]).filter(isAiInferred).length,
    0,
  );
  const boundariesEmpty = effective.boundaries.length === 0;
  const shareUrl = published?.shareUrl ?? (expert.data?.shareSlug
    ? `${location.origin}/s/${expert.data.shareSlug}`
    : null);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link to={`/app/experts/${id}`} className="inline-flex items-center gap-1 text-sm text-ink-600 hover:text-ink-900">
        <ArrowLeft className="size-4" /> 返回
      </Link>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">这是 AI 理解的你</h1>
          <p className="mt-1 text-sm text-ink-600">
            读了你的 {m.chunkCount} 段内容，提炼出下面这份思维说明书。
            <br />
            <span className="text-ink-400">不改就默认通过 —— 你只需要看红色的部分。</span>
          </p>
        </div>
        <Button variant="outline" size="sm" loading={regenerate.isPending}
                onClick={() => regenerate.mutate()}>
          <RefreshCw className="size-4" /> 重新生成
        </Button>
      </div>

      {flaggedTotal > 0 && (
        <div className="mt-4">
          <Alert tone="error">
            有 <strong>{flaggedTotal}</strong> 条内容在你的原文里找不到出处，是 AI 自己推断的。
            请核对或删掉 —— 上线后粉丝会把这些当成你本人的观点。
          </Alert>
        </div>
      )}
      {flaggedTotal === 0 && (
        <div className="mt-4">
          <Alert tone="success">
            每一条都能在你的原文里找到出处，没有 AI 自己编的内容。
          </Alert>
        </div>
      )}

      <div className="mt-5 space-y-3">
        {DIMENSIONS.map((d) => (
          <DimensionCard
            key={d.key}
            dim={d.key}
            items={effective[d.key] as AnyItem[]}
            confirmed={m.confirmedDimensions.includes(d.key)}
            onConfirm={(items) => confirm.mutateAsync({ dim: d.key, items })}
          />
        ))}
      </div>

      {error && <div className="mt-4"><Alert>{error}</Alert></div>}

      <Card className="mt-6 p-4">
        {shareUrl ? (
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">
              <Check className="size-4" /> 已上线
            </div>
            <p className="mt-1 text-sm text-ink-600">把这个链接发给你的粉丝：</p>
            <div className="mt-2 flex gap-2">
              <input
                readOnly
                value={shareUrl}
                className="flex-1 rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-sm"
              />
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(shareUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }}
              >
                <Copy className="size-4" /> {copied ? "已复制" : "复制"}
              </Button>
            </div>

            {/*
              F01：第一版在这里只有链接、没有按钮 —— 上线之后的修改永远到不了粉丝那里，
              而这一段的文案一直在让博主「改完再点一次上线」。
              publish 接口本身支持重复调用：短链不变，只更新线上快照。
            */}
            {/*
              提示分两句（ADR-009）：改了没推 vs 线上已是最新。
              第一版这句话是无条件的，于是"改完没推"和"什么都没改"长得一模一样 ——
              该提醒的时候不显眼，不该提醒的时候一直在唠叨。
            */}
            <div className="mt-3 flex items-center justify-between gap-4">
              {m.hasUnpublishedChanges ? (
                <p className="text-xs font-medium text-amber-700">
                  你有修改还没推到线上。粉丝现在拿到的仍是上一次上线的版本 —— 点右边的按钮生效。
                </p>
              ) : (
                <p className="text-xs text-ink-400">
                  线上就是你现在看到的版本。之后再改的话，记得回来点一次「更新线上版本」。
                </p>
              )}
              <Button
                variant={m.hasUnpublishedChanges ? "primary" : "outline"}
                size="sm"
                className="shrink-0"
                loading={publish.isPending}
                disabled={boundariesEmpty || !m.hasUnpublishedChanges}
                onClick={() =>
                  publish.mutate(undefined, {
                    onSuccess: () => setNotice("线上已更新为当前版本，粉丝下一次提问就会用上。"),
                  })
                }
              >
                <Rocket className="size-4" /> 更新线上版本
              </Button>
            </div>
            {notice && <div className="mt-3"><Alert tone="success">{notice}</Alert></div>}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm text-ink-600">
              {boundariesEmpty
                ? "上线前请先确认「拒绝回答」—— 那是保护你的合规底线。"
                : "确认完就可以上线，拿到分享给粉丝的链接。"}
            </div>
            <Button size="lg" loading={publish.isPending} disabled={boundariesEmpty}
                    onClick={() => publish.mutate()}>
              <Rocket className="size-4" /> 上线
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
