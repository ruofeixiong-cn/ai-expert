import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Sparkles } from "lucide-react";
import { api, errorMessage } from "@/api/client";
import { Alert, Button, Card, Input, Label, Spinner } from "@/components/ui";

export default function ExpertListPage() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: experts, isPending } = useQuery({
    queryKey: ["experts"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/experts");
      if (error || !data) throw error;
      return data.data;
    },
  });

  const create = useMutation({
    mutationFn: async (n: string) => {
      const { data, error } = await api.POST("/api/experts", { body: { name: n } });
      if (error || !data) throw error;
      return data.data;
    },
    onSuccess: () => { setName(""); setError(null); qc.invalidateQueries({ queryKey: ["experts"] }); },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-lg font-semibold">我的 AI 专家</h1>
      <p className="mt-1 text-sm text-ink-600">上传你的内容，AI 学习你的知识和方法。</p>

      <Card className="mt-6 p-4">
        <form
          onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(name.trim()); }}
          className="flex items-end gap-3"
        >
          <div className="flex-1">
            <Label htmlFor="name">新建专家</Label>
            <Input
              id="name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="例如：理财老王" maxLength={40}
            />
          </div>
          <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
            <Plus className="size-4" /> 创建
          </Button>
        </form>
        {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      </Card>

      <div className="mt-6 space-y-3">
        {isPending && <div className="flex justify-center py-10"><Spinner /></div>}

        {experts?.length === 0 && (
          <Card className="flex flex-col items-center gap-3 px-4 py-14 text-center">
            <Sparkles className="size-7 text-ink-400" />
            <p className="text-sm text-ink-600">还没有专家。先创建一个，然后把你的文章喂给它。</p>
          </Card>
        )}

        {experts?.map((e) => (
          <Link key={e.id} to={`/app/experts/${e.id}`} className="block">
            <Card className="p-4 transition hover:border-brand-500 hover:shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{e.name}</div>
                  <div className="mt-1 text-xs text-ink-600">
                    {e.materialCount} 篇素材 · {e.chunkCount} 个知识切片
                  </div>
                </div>
                <StatusBadge status={e.status} />
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: "building" | "online" | "offline" }) {
  const map = {
    building: ["待完善", "bg-amber-50 text-amber-700"],
    online: ["已上线", "bg-emerald-50 text-emerald-700"],
    offline: ["已下线", "bg-ink-100 text-ink-600"],
  } as const;
  const [label, cls] = map[status];
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{label}</span>;
}
