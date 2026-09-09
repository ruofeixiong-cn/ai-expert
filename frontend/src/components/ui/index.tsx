import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** shadcn 风格的最小组件集：只写这四个页面真正用到的，用到了再加。 */

const button = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition " +
    "disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 " +
    "focus-visible:outline-offset-2 focus-visible:outline-brand-500",
  {
    variants: {
      variant: {
        primary: "bg-brand-600 text-white hover:bg-brand-700",
        outline: "border border-ink-200 bg-white hover:bg-ink-50 text-ink-800",
        ghost: "hover:bg-ink-100 text-ink-600",
        danger: "text-red-600 hover:bg-red-50",
      },
      size: { sm: "h-8 px-3", md: "h-9 px-4", lg: "h-11 px-6 text-base" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export function Button({
  className, variant, size, loading, children, ...props
}: ComponentProps<"button"> & VariantProps<typeof button> & { loading?: boolean }) {
  return (
    <button className={cn(button({ variant, size }), className)} disabled={loading || props.disabled} {...props}>
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

const field =
  "w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm " +
  "placeholder:text-ink-400 focus:border-brand-500 focus:outline-none " +
  "focus:ring-2 focus:ring-brand-500/20 disabled:bg-ink-50";

export const Input = ({ className, ...p }: ComponentProps<"input">) => (
  <input className={cn(field, "h-9", className)} {...p} />
);

export const Textarea = ({ className, ...p }: ComponentProps<"textarea">) => (
  <textarea className={cn(field, "resize-y leading-relaxed", className)} {...p} />
);

export const Label = ({ className, ...p }: ComponentProps<"label">) => (
  <label className={cn("block text-sm font-medium text-ink-800 mb-1.5", className)} {...p} />
);

export const Card = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("rounded-xl border border-ink-200 bg-white", className)} {...p} />
);

export function Alert({ tone = "error", children }: { tone?: "error" | "info" | "success"; children: ReactNode }) {
  const tones = {
    error: "bg-red-50 text-red-700 border-red-200",
    info: "bg-brand-50 text-brand-700 border-brand-200",
    success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  } as const;
  return (
    <div className={cn("rounded-lg border px-3 py-2 text-sm", tones[tone])} role="status">
      {children}
    </div>
  );
}

export function Progress({ value, tone = "brand" }: { value: number; tone?: "brand" | "danger" }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
      <div
        className={cn(
          "h-full rounded-full transition-all duration-500",
          tone === "danger" ? "bg-red-500" : "bg-brand-600",
        )}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export const Spinner = ({ className }: { className?: string }) => (
  <Loader2 className={cn("size-5 animate-spin text-ink-400", className)} />
);
