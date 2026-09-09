import { useState } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, Link2, ClipboardPaste, Hammer, Sparkles } from "lucide-react";
import { api, errorMessage, type ReqBody } from "@/api/client";
import { Alert, Button, Card, Input, Label, Progress, Spinner, Textarea } from "@/components/ui";

type Tab = "paste" | "file" | "url";

/** 素材上传的请求体，直接来自契约。三个表单产出的对象都要满足它。 */
type MaterialInput = ReqBody<"/api/experts/{id}/materials">;

const STAGE_LABEL: Record<string, string> = {
  queued: "排队中", parsing: "读取素材", chunking: "切分知识",
  embedding: "向量化", done: "完成",
};

export default function ExpertDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("paste");
  // 保存成功后重挂表单，清空已提交的内容 —— 否则正文还留在框里，
  // 博主容易以为没存上而再点一次
  const [formKey, setFormKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const expert = useQuery({
    queryKey: ["expert", id],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/experts/{id}", { params: { path: { id } } });
      if (error || !data) throw error;
      return data.data;
    },
    // 构建期间自动轮询；结束就停下 —— 别让一个后台标签页无限打后端
    refetchInterval: (q) => {
      const s = q.state.data?.lastBuild?.status;
      return s === "queued" || s === "running" ? 1200 : false;
    },
    // ⚠️ 上面的轮询在【后台标签页里不会执行】（TanStack Query 的默认行为，
    //    这是对的：不该让一个没人看的标签页一直打后端）。
    //    但全局关掉了 refetchOnWindowFocus，于是"开始构建 → 切去别的标签页
    //    找文章 → 切回来"会看到进度条永远冻在 0%。
    //    所以这一个查询单独打开 focus 重取，回到页面立刻同步真实进度。
    refetchOnWindowFocus: true,
  });

  const materials = useQuery({
    queryKey: ["materials", id],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/experts/{id}/materials", { params: { path: { id } } });
      if (error || !data) throw error;
      return data.data;
    },
  });

  const upload = useMutation({
    mutationFn: async (body: MaterialInput) => {
      const { data, error } = await api.POST("/api/experts/{id}/materials", {
        params: { path: { id } }, body,
      });
      if (error || !data) throw error;
      return data.data;
    },
    onSuccess: (r) => {
      setError(null);
      setNotice(r.deduplicated ? "这篇内容已经传过了，已复用原来的素材。" : "素材已保存。");
      setFormKey((k) => k + 1);
      qc.invalidateQueries({ queryKey: ["materials", id] });
      qc.invalidateQueries({ queryKey: ["expert", id] });
    },
    onError: (e) => { setNotice(null); setError(errorMessage(e)); },
  });

  const build = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/api/experts/{id}/build", { params: { path: { id } } });
      if (error || !data) throw error;
      return data.data;
    },
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ["expert", id] }); },
    onError: (e) => setError(errorMessage(e)),
  });

  if (expert.isPending) return <div className="flex justify-center py-20"><Spinner /></div>;
  if (expert.isError) return <div className="p-10 text-center text-sm text-ink-600">专家不存在</div>;

  const e = expert.data;
  const job = e.lastBuild;
  const building = job?.status === "queued" || job?.status === "running";

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link to="/app" className="inline-flex items-center gap-1 text-sm text-ink-600 hover:text-ink-900">
        <ArrowLeft className="size-4" /> 返回
      </Link>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{e.name}</h1>
          <p className="mt-1 text-sm text-ink-600">
            {e.materialCount} 篇素材 · {e.chunkCount} 个知识切片
          </p>
        </div>
        <Button onClick={() => build.mutate()} loading={build.isPending || building}
                disabled={e.materialCount === 0}>
          <Hammer className="size-4" />
          {building ? "构建中" : e.chunkCount > 0 ? "重新构建" : "开始构建"}
        </Button>
      </div>

      {e.hasDraft && (
        <Link to={`/app/experts/${id}/model`} className="mt-4 block">
          <Card className="flex items-center justify-between p-4 transition hover:border-brand-500 hover:shadow-sm">
            <div className="flex items-center gap-3">
              <Sparkles className="size-5 text-brand-600" />
              <div>
                <div className="text-sm font-medium">
                  {e.confirmedDimensions.length > 0 ? "继续确认专家模型" : "AI 已经读完了你的内容"}
                </div>
                <div className="mt-0.5 text-xs text-ink-600">
                  {e.shareSlug
                    ? "已上线 · 可继续调整后重新上线"
                    : `去看看 AI 理解的你（已确认 ${e.confirmedDimensions.length}/7 块）`}
                </div>
              </div>
            </div>
            <span className="text-sm text-brand-600">查看 →</span>
          </Card>
        </Link>
      )}

      {job && (
        <Card className="mt-4 p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className={job.status === "failed" ? "text-red-600" : "text-ink-800"}>
              {job.status === "failed" ? "构建失败" : STAGE_LABEL[job.stage ?? "queued"] ?? "处理中"}
            </span>
            <span className="text-ink-600">{job.status === "failed" ? "" : `${job.progress}%`}</span>
          </div>
          <Progress value={job.status === "failed" ? 100 : job.progress}
                    tone={job.status === "failed" ? "danger" : "brand"} />
          {job.error && <p className="mt-2 text-sm text-red-600">{job.error}</p>}
        </Card>
      )}

      <Card className="mt-6 p-4">
        <div className="mb-4 flex gap-1 rounded-lg bg-ink-100 p-1">
          {([
            ["paste", "粘贴正文", ClipboardPaste],
            ["file", "上传文件", FileText],
            ["url", "粘贴链接", Link2],
          ] as const).map(([key, label, Icon]) => (
            <button key={key} type="button"
              onClick={() => { setTab(key); setError(null); setNotice(null); }}
              className={
                "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition " +
                (tab === key ? "bg-white text-ink-900 shadow-sm" : "text-ink-600 hover:text-ink-800")
              }>
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </div>

        {tab === "paste" && <PasteForm key={formKey} onSubmit={upload.mutate} busy={upload.isPending} />}
        {tab === "file" && <FileForm key={formKey} onSubmit={upload.mutate} busy={upload.isPending} />}
        {tab === "url" && <UrlForm key={formKey} onSubmit={upload.mutate} busy={upload.isPending} />}

        {error && <div className="mt-3"><Alert>{error}</Alert></div>}
        {notice && <div className="mt-3"><Alert tone="success">{notice}</Alert></div>}
      </Card>

      <div className="mt-6">
        <h2 className="mb-3 text-sm font-medium text-ink-800">已上传的素材</h2>
        {materials.data?.length === 0 && (
          <p className="rounded-lg border border-dashed border-ink-200 px-4 py-8 text-center text-sm text-ink-600">
            还没有素材。粘贴一篇你写过的文章试试。
          </p>
        )}
        <div className="space-y-2">
          {materials.data?.map((m) => (
            <Card key={m.id} className="flex items-center justify-between px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{m.title ?? "未命名"}</div>
                <div className="mt-0.5 text-xs text-ink-600">
                  {m.charCount} 字 · {m.chunkCount > 0 ? `${m.chunkCount} 个切片` : "待构建"}
                </div>
              </div>
              <span className="ml-3 shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-600">
                {{ paste: "粘贴", file: "文件", url: "链接" }[m.sourceType]}
              </span>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

type Submit = (body: MaterialInput) => void;

function PasteForm({ onSubmit, busy }: { onSubmit: Submit; busy: boolean }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ sourceType: "paste", title, content }); }}
          className="space-y-3">
      <div>
        <Label htmlFor="t">标题</Label>
        <Input id="t" value={title} onChange={(e) => setTitle(e.target.value)}
               placeholder="这篇文章的标题" maxLength={200} required />
      </div>
      <div>
        <Label htmlFor="c">正文</Label>
        <Textarea id="c" rows={10} value={content} onChange={(e) => setContent(e.target.value)}
                  placeholder="粘贴文章正文，支持 Markdown 标题（# ## ###）——&#10;带标题的文章切分质量明显更好。" required />
        <p className="mt-1 text-xs text-ink-400">{content.length} / 100000 字</p>
      </div>
      <Button type="submit" loading={busy} disabled={!title.trim() || !content.trim()}>保存素材</Button>
    </form>
  );
}

function FileForm({ onSubmit, busy }: { onSubmit: Submit; busy: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!file) return;
    const buf = await file.arrayBuffer();
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    onSubmit({
      sourceType: "file",
      title: file.name.replace(/\.[^.]+$/, ""),
      filename: file.name,
      contentBase64: btoa(bin),
    });
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <Label htmlFor="f">选择文件</Label>
        <Input id="f" type="file" accept=".md,.markdown,.txt,.docx,.pdf" className="h-auto py-1.5"
               onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        <p className="mt-1 text-xs text-ink-400">支持 .md / .txt / .docx / .pdf（扫描件暂不支持）</p>
      </div>
      <Button type="submit" loading={busy} disabled={!file}>上传并解析</Button>
    </form>
  );
}

function UrlForm({ onSubmit, busy }: { onSubmit: Submit; busy: boolean }) {
  const [url, setUrl] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ sourceType: "url", url }); }} className="space-y-3">
      <div>
        <Label htmlFor="u">文章链接</Label>
        <Input id="u" type="url" value={url} onChange={(e) => setUrl(e.target.value)}
               placeholder="https://mp.weixin.qq.com/s/..." required />
        <p className="mt-1 text-xs text-ink-400">
          目前只保证公众号链接。其他平台可能有反爬，抓不到时请改用「粘贴正文」。
        </p>
      </div>
      <Button type="submit" loading={busy} disabled={!url.trim()}>抓取并保存</Button>
    </form>
  );
}
