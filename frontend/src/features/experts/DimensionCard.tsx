import { useEffect, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Plus, Trash2 } from "lucide-react";
import { errorMessage } from "@/api/client";
import { Alert, Button, Card, Input, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  BOUNDARY_KIND_LABEL, DIMENSIONS, emptyItem, isEvidenceless, validateItems,
  type AnyItem, type Dim,
} from "./dimensions";

const ATTENTION: Record<string, { label: string; cls: string; open: boolean }> = {
  high:     { label: "AI 拿手",   cls: "bg-emerald-50 text-emerald-700", open: false },
  medium:   { label: "请核对",    cls: "bg-amber-50 text-amber-700",     open: true },
  low:      { label: "需要你补",  cls: "bg-red-50 text-red-700",         open: true },
  template: { label: "平台模板",  cls: "bg-brand-50 text-brand-700",     open: true },
  extract:  { label: "原文抽取",  cls: "bg-ink-100 text-ink-600",        open: false },
};

export function DimensionCard({
  dim, items, confirmed, onConfirm,
}: {
  dim: Dim;
  items: AnyItem[];
  confirmed: boolean;
  /** 返回的 Promise 失败时，博主的编辑原样保留 */
  onConfirm: (items: AnyItem[]) => Promise<unknown>;
}) {
  const meta = DIMENSIONS.find((d) => d.key === dim)!;
  const attn = ATTENTION[meta.attention]!;
  const [open, setOpen] = useState(attn.open);
  const [draft, setDraft] = useState<AnyItem[]>(items);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 服务端数据变了（比如重新生成草稿）就同步过来，但别覆盖博主正在改的内容
  useEffect(() => {
    if (!dirty) setDraft(items);
  }, [items, dirty]);

  const flagged = draft.filter(isEvidenceless).length;

  const edit = (next: (d: AnyItem[]) => AnyItem[]) => {
    setDirty(true);
    setError(null);
    setDraft(next);
  };
  const patch = (i: number, next: Partial<AnyItem>) =>
    edit((d) => d.map((it, idx) => (idx === i ? ({ ...it, ...next } as AnyItem) : it)));
  const remove = (i: number) => edit((d) => d.filter((_, idx) => idx !== i));
  const add = () => { setOpen(true); edit((d) => [...d, emptyItem(dim)]); };

  /**
   * 请求成功之后才清 dirty（F03）。
   *
   * 第一版是 `onConfirm(draft); setDirty(false)` —— 请求还没回来 dirty 就清了，
   * 上面的 effect 立刻把草稿换回服务端的旧数据：请求中编辑内容闪回旧版，
   * 请求失败则永久丢失。而契约要求内容非空、样本必须有出处，
   * 博主加了一条还没填的空条目就必然 400，整张卡片的编辑随之消失。
   *
   * 所以：先按契约约束查一遍，不合格就不发；发了就等结果，失败时一个字都不动。
   */
  async function confirm() {
    const problem = validateItems(dim, draft);
    if (problem) return setError(problem);

    setError(null);
    setSaving(true);
    try {
      await onConfirm(draft);
      setDirty(false);
    } catch (e) {
      setError(errorMessage(e, "没保存成功，你的修改还在，稍后再点一次确认"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={cn("overflow-hidden", confirmed && "border-emerald-200")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-ink-50"
      >
        <ChevronDown className={cn("size-4 shrink-0 text-ink-400 transition", open && "rotate-180")} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{meta.title}</span>
            <span className={cn("rounded-full px-2 py-0.5 text-xs", attn.cls)}>{attn.label}</span>
            {confirmed && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                <Check className="size-3" /> 已确认
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-ink-600">{meta.question}</div>
        </div>
        <div className="shrink-0 text-right text-xs text-ink-600">
          <div>{draft.length} 条</div>
          {flagged > 0 && (
            <div className="mt-0.5 font-medium text-red-600">{flagged} 条待核</div>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-ink-200 px-4 py-4">
          {meta.hint && (
            <p className="mb-3 rounded-lg bg-ink-50 px-3 py-2 text-xs leading-relaxed text-ink-600">
              {meta.hint}
            </p>
          )}

          <div className="space-y-3">
            {draft.length === 0 && (
              <p className="py-3 text-center text-sm text-ink-400">
                这一块是空的{meta.attention === "low" ? " —— 建议你补几条" : ""}
              </p>
            )}

            {draft.map((item, i) => (
              <ItemRow
                key={i}
                dim={dim}
                item={item}
                onChange={(n) => patch(i, n)}
                onRemove={() => remove(i)}
              />
            ))}
          </div>

          {/* 错误就近显示在这张卡片里 —— 以前报在页面最底部，博主点完确认根本看不见 */}
          {error && <div className="mt-3"><Alert>{error}</Alert></div>}

          <div className="mt-4 flex items-center justify-between gap-3">
            {dim === "examples" ? (
              // 契约要求样本至少有一条原文出处（ExampleItem.evidenceChunkIds.min(1)），
              // 手动加的必然没有 —— 给按钮只会让博主填完再撞一个 400。
              // 等 ADR-003 的来源字段落地后再放开。
              <span className="text-xs text-ink-400">样本只从你的原文里抽取，暂不支持手动添加</span>
            ) : (
              <Button variant="ghost" size="sm" type="button" onClick={add}>
                <Plus className="size-4" /> 添加一条
              </Button>
            )}
            <Button
              size="sm"
              type="button"
              loading={saving}
              onClick={() => void confirm()}
              variant={confirmed && !dirty ? "outline" : "primary"}
            >
              {confirmed && !dirty ? "已确认" : "确认这一块"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function ItemRow({
  dim, item, onChange, onRemove,
}: {
  dim: Dim;
  item: AnyItem;
  onChange: (next: Partial<AnyItem>) => void;
  onRemove: () => void;
}) {
  const flagged = isEvidenceless(item);

  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        flagged ? "border-red-200 bg-red-50/40" : "border-ink-200",
      )}
    >
      {dim === "examples" ? (
        <div className="space-y-2">
          <Input
            value={(item as { question: string }).question}
            onChange={(e) => onChange({ question: e.target.value } as Partial<AnyItem>)}
            placeholder="粉丝可能会这样问…"
          />
          <Textarea
            rows={3}
            value={(item as { answer: string }).answer}
            onChange={(e) => onChange({ answer: e.target.value } as Partial<AnyItem>)}
            placeholder="你在原文里是这样回答的…"
          />
        </div>
      ) : (
        <Textarea
          rows={2}
          value={(item as { content: string }).content}
          onChange={(e) => onChange({ content: e.target.value } as Partial<AnyItem>)}
          placeholder={dim === "boundaries" ? "什么情况下应该拒绝回答…" : "一句话，用你自己的说法…"}
        />
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        {dim === "boundaries" ? (
          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700">
            {BOUNDARY_KIND_LABEL[(item as { kind: string }).kind] ?? "边界"}
          </span>
        ) : flagged ? (
          /**
           * ★ 这一行是整个 M2 的产品要害。
           *
           * 产品文档 §8.3 把「AI 过度推断」列为最大的坑：博主看到"自己"说了
           * 一句从没说过的话，比看到"这个我没讲过"糟糕一百倍。
           *
           * 所以不能只是标个色 —— 要明说【原文里找不到出处】，
           * 让博主知道该盯哪一条，也让他知道我们没有拿他的名义瞎编。
           *
           * ⚠️ 已知误判：博主手动添加的条目也没有出处，会被误标成 AI 推断。
           *    契约里没有区分来源的字段，等 backend 补齐，见 docs/adr/003。
           */
          <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600">
            <AlertTriangle className="size-3.5" />
            AI 推断的，你的原文里没有这句 —— 请核对或删掉
          </span>
        ) : (
          <span className="text-xs text-ink-400">
            出自你的 {(item as { evidenceChunkIds: string[] }).evidenceChunkIds.length} 段原文
          </span>
        )}

        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded p-1 text-ink-400 hover:bg-red-50 hover:text-red-600"
          aria-label="删除这一条"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </div>
  );
}
