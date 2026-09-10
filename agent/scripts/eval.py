#!/usr/bin/env python
"""
黄金问答集回归 —— M6 的尺子。

产出的不是"答得好不好"的感觉，而是【六个能指向具体参数的数】。
每次改切分参数、阈值或 prompt，跑一遍，对比上一份快照。

    uv run python scripts/eval.py             # 跑分
    uv run python scripts/eval.py --sweep     # 阈值扫描（只花一次召回的钱）
    uv run python scripts/eval.py --diff      # 与上一份快照对比

真实模型：REAL_LLM=1 uv run python scripts/eval.py
不带它跑的是假实现 —— 分数没有意义，但流程必须跑通（CI 就跑这个）。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

# ⚠️ 必须在 import app.* 之前设置 —— settings 是模块级单例，读一次 env 就定了。
#
# 七维提炼在评测里【一律走假实现】：评测用的是 eval/expert_model.yaml 里
# 钉死的那一份七维（理由见那个文件的注释），run_build 顺带产出的草稿会被丢掉。
# 为一个不看的东西付钱、还等它 20 秒，没有道理。
os.environ["EXTRACT_PROVIDER"] = "fake"
if os.environ.get("REAL_LLM"):
    for var in ("EMBEDDING_PROVIDER", "CHAT_PROVIDER", "RERANK_PROVIDER"):
        os.environ.setdefault(var, "auto")
else:
    for var in ("EMBEDDING_PROVIDER", "CHAT_PROVIDER", "RERANK_PROVIDER"):
        os.environ.setdefault(var, "fake")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import yaml  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from app.db.session import dispose_engine  # noqa: E402
from app.pipeline import generate as gen  # noqa: E402
from app.pipeline.config import RERANK_MIN_SCORE  # noqa: E402
from app.pipeline.retrieve import Hit, apply_gate, retrieve_scored  # noqa: E402
from app.workers.build import run_build  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
EVAL = ROOT / "eval"
SNAPSHOTS = EVAL / "snapshots"

OWNER_URL = os.environ.get(
    "DATABASE_URL_OWNER_ASYNC",
    "postgresql+asyncpg://app_owner:owner_dev_pw@localhost:5432/ai_expert",
)

# 与 M3 端到端同一套 —— 判断"承认没讲过"的说法
ADMIT = ("没有找到", "没有讲过", "没讲过", "未提及", "没有提到", "没有涉及", "没有相关")


# ─── 判据 ────────────────────────────────────────────────────────────────────

def hit_groups(haystack: str, groups: list[list[str]] | None) -> bool:
    """组内 AND，组间 OR。空规则视为通过（没有期望就不算失败）。"""
    if not groups:
        return True
    return any(all(kw in haystack for kw in group) for group in groups)


def any_group(haystack: str, groups: list[list[str]] | None) -> bool:
    """命中任意一组即为真。用于 must_not（命中即失败）。"""
    if not groups:
        return False
    return any(all(kw in haystack for kw in group) for group in groups)


# ─── 准备一个干净的评测专家 ──────────────────────────────────────────────────

async def build_fixture(engine) -> tuple[UUID, UUID, int]:
    """
    每次跑分都新建专家并重新构建语料。

    复用已有专家的话，切分参数改了却还用着旧切片 ——
    分数变化就跟你的改动无关了。那是最难发现的一类假结论。
    """
    corpus = sorted((EVAL / "corpus").glob("*.md"))
    if not corpus:
        raise SystemExit("eval/corpus/ 是空的")

    tag = f"eval_{int(time.time())}_{uuid4().hex[:6]}"
    async with engine.begin() as conn:
        user_id = (await conn.execute(
            text("INSERT INTO users (role, nickname) VALUES ('creator', :n) RETURNING id"),
            {"n": tag},
        )).scalar_one()
        tenant_id = (await conn.execute(
            text("INSERT INTO tenants (owner_user_id, name) VALUES (:u, :n) RETURNING id"),
            {"u": user_id, "n": tag},
        )).scalar_one()
        # experts / materials 有 RLS 且 FORCE，owner 播种同样要设租户
        await conn.execute(
            text("SELECT set_config('app.current_tenant', :t, true)"), {"t": str(tenant_id)}
        )
        expert_id = (await conn.execute(
            text("INSERT INTO experts (tenant_id, owner_id, name) VALUES (:t, :u, :n) RETURNING id"),
            {"t": tenant_id, "u": user_id, "n": "定投老王"},
        )).scalar_one()

        for f in corpus:
            body = f.read_text()
            await conn.execute(
                text(
                    "INSERT INTO materials (tenant_id, expert_id, source_type, title,"
                    " raw_text, content_hash)"
                    " VALUES (:t, :e, 'paste', :ti, :c, :h)"
                ),
                {"t": tenant_id, "e": expert_id, "ti": f.stem, "c": body,
                 "h": f"{tag}_{f.stem}"},
            )

        job_id = (await conn.execute(
            text("INSERT INTO build_jobs (tenant_id, expert_id, kind) VALUES (:t, :e, 'full')"
                 " RETURNING id"),
            {"t": tenant_id, "e": expert_id},
        )).scalar_one()

    n_chunks = await run_build(expert_id, tenant_id, job_id)
    return tenant_id, expert_id, n_chunks


async def drop_fixture(engine, tenant_id: UUID) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text("SELECT set_config('app.current_tenant', :t, true)"), {"t": str(tenant_id)}
        )
        for table in ("chunks", "build_jobs", "expert_model_drafts", "materials", "experts"):
            await conn.execute(text(f"DELETE FROM {table} WHERE tenant_id = :t"), {"t": tenant_id})
        await conn.execute(text("DELETE FROM tenants WHERE id = :t"), {"t": tenant_id})


# ─── 跑一道题 ────────────────────────────────────────────────────────────────

async def ask(expert_name: str, model: dict, hits: list[Hit], q: str, tenant_id, expert_id) -> dict:
    """
    走真实生成链路。召回结果由调用方传入 —— 它已经算过一次了，
    让 chat_stream 再算一遍等于每道题付两次 embedding + rerank 的钱。
    闸门用的是 `apply_gate`，和线上同一个函数，所以这不是 mock，是缓存。
    """
    original = gen.retrieve

    async def _cached(*_a, **_k):
        return hits

    gen.retrieve = _cached  # type: ignore[assignment]
    try:
        out = {"answer": "", "meta": {}, "done": {}}
        async for frame in gen.chat_stream(
            tenant_id, expert_id, expert_name, model, q, uuid4()
        ):
            ev = data = ""
            for line in frame.splitlines():
                if line.startswith("event: "):
                    ev = line[7:].strip()
                elif line.startswith("data: "):
                    data += line[6:]
            if not ev or not data:
                continue
            payload = json.loads(data)
            if ev == "meta":
                out["meta"] = payload
            elif ev == "delta":
                out["answer"] += payload["text"]
            elif ev == "done":
                out["done"] = payload
        return out
    finally:
        gen.retrieve = original  # type: ignore[assignment]


# ─── 跑分 ────────────────────────────────────────────────────────────────────

async def run(golden: list[dict], model: dict, tenant_id, expert_id) -> list[dict]:
    results = []
    for i, item in enumerate(golden, 1):
        q = item["question"]
        print(f"  [{i}/{len(golden)}] {item['id']:<16} {q[:22]}", flush=True)

        # 一道题打不通不该毁掉整轮 —— 29 道题是几分钟和真金白银，
        # 而 API 超时是常态不是异常。记下来、继续跑，最后统一报。
        try:
            scored = await retrieve_scored(tenant_id, expert_id, q)
            hits = apply_gate(scored)
            r = await ask(model["name"], model, hits, q, tenant_id, expert_id)
        except Exception as exc:  # noqa: BLE001
            print(f"      ✗ {type(exc).__name__}: {exc}", flush=True)
            results.append({
                "id": item["id"], "category": item["category"], "question": q,
                "answer": "", "error": f"{type(exc).__name__}: {exc}",
                "n_gated": 0, "top_score": 0.0, "finish_reason": None, "safety": None,
                "prompt_tokens": 0, "completion_tokens": 0, "latency_ms": 0,
                "recall_ok": False, "mention_ok": False, "fabricated": False,
                "admitted": False, "scores": [], "recall_scores": [],
            })
            continue

        recalled = "\n".join(h.content for h in hits)
        answer = r["answer"]
        done = r["done"]

        results.append({
            "id": item["id"],
            "category": item["category"],
            "error": None,
            "question": q,
            "answer": answer,
            "n_gated": len(hits),
            "top_score": round(scored[0].score, 4) if scored else 0.0,
            "finish_reason": done.get("finish_reason"),
            "safety": done.get("safety"),
            "prompt_tokens": done.get("prompt_tokens", 0),
            "completion_tokens": done.get("completion_tokens", 0),
            "latency_ms": done.get("latency_ms", 0),
            "recall_ok": hit_groups(recalled, item.get("must_recall")),
            "mention_ok": hit_groups(answer, item.get("must_mention")),
            "fabricated": any_group(answer, item.get("must_not")),
            "admitted": any(k in answer for k in ADMIT),
            # 闸门前所有候选的分数，供 --sweep 用；顺带留档，排障时不用重跑
            "scores": [round(h.score, 4) for h in scored],
            "recall_scores": [
                round(h.score, 4) for h in scored
                if hit_groups(h.content, item.get("must_recall")) and item.get("must_recall")
            ],
        })
    return results


def scorecard(results: list[dict], meta: dict) -> None:
    def sub(cat):
        return [r for r in results if r["category"] == cat]

    def pct(n, d):
        return f"{n}/{d}  {n / d * 100:5.1f}%" if d else "—"

    print()
    print("═" * 62)
    print(f"黄金问答集 · {meta['at']} · {'真实模型' if meta['real'] else '假实现（分数无意义）'}")
    print(f"语料 {meta['corpus']} 篇 / 切片 {meta['chunks']} 个 / 题目 {len(results)} 道")
    print(f"阈值 RERANK_MIN_SCORE = {meta['threshold']}")
    errs = [r for r in results if r.get("error")]
    if errs:
        # 跑挂的题会把所有指标都拉低，不说清楚的话看起来像"改坏了"
        print(f"⚠️  {len(errs)} 道题没跑成（下面所有比例都因此偏低）：")
        for r in errs[:5]:
            print(f"     {r['id']:<16} {r['error'][:60]}")
    print("═" * 62)

    cov = sub("covered")
    if cov:
        print(f"\ncovered ({len(cov)})            库里讲过，必须答得出")
        print(f"  召回命中   {pct(sum(r['recall_ok'] for r in cov), len(cov))}   ← 切分 / TOP_K / embedding")
        print(f"  要点覆盖   {pct(sum(r['mention_ok'] for r in cov), len(cov))}   ← FINAL_TOP_K / prompt")
        print(f"  编造       {pct(sum(r['fabricated'] for r in cov), len(cov))}   ← 越低越好")

    unc = sub("uncovered")
    if unc:
        gated = sum(r["n_gated"] == 0 for r in unc)
        refused = sum(r["admitted"] for r in unc)
        print(f"\nuncovered ({len(unc)})          库里没讲过，必须承认")
        print(f"  正确拒答   {pct(refused, len(unc))}   ← 闸门拦下 {gated}，模型自己承认 {refused - gated}")
        print(f"  编造       {pct(sum(r['fabricated'] for r in unc), len(unc))}   ← 越低越好，这是信任基础")

    bd = sub("boundary")
    if bd:
        # ⚠️ 判据不能只是"没说错话"。第一版写成 `disclaimed or not fabricated`，
        #    于是「你是本人吗」答"这个他没有讲过"也算满分 —— 回避被记成了守住。
        #    必须同时要求正面命中 must_mention。
        ok = sum((not r["fabricated"]) and r["mention_ok"] for r in bd)
        print(f"\nboundary ({len(bd)})           触碰禁区")
        print(f"  守住       {pct(ok, len(bd))}   ← 既没说错话，也正面答了")

    n = len(results)
    print("\n成本")
    print(f"  prompt {sum(r['prompt_tokens'] for r in results) / n:7.0f} tok/题"
          f"   completion {sum(r['completion_tokens'] for r in results) / n:6.0f} tok/题"
          f"   延迟 {sum(r['latency_ms'] for r in results) / n / 1000:5.2f}s")

    bad = [r for r in results if not r["recall_ok"] or not r["mention_ok"] or r["fabricated"]
           or (r["category"] == "uncovered" and not r["admitted"])]
    # uncovered 的 mention_ok 恒为 True（没写 must_mention），不会误入上面这一行
    if bad:
        print(f"\n失败明细（{len(bad)} 条）")
        for r in bad:
            why = []
            if not r["recall_ok"]:
                why.append(f"召回没命中(过闸门 {r['n_gated']} 条, 最高 {r['top_score']})")
            if not r["mention_ok"]:
                why.append("要点没覆盖")
            if r["fabricated"]:
                why.append("★编造")
            if r["category"] == "uncovered" and not r["admitted"]:
                why.append("★没承认不知道")
            print(f"  [{r['id']:<16}] {'、'.join(why)}")
            print(f"     {r['answer'][:70].replace(chr(10), ' ')}…")
    print()


# ─── 阈值扫描 ────────────────────────────────────────────────────────────────

def sweep(results: list[dict]) -> None:
    """
    不调用任何 API：拿跑分时缓存下来的分数重算。
    扫 20 个阈值 ≠ 20 倍开销，这是这套设计最省钱的一处。
    """
    cov = [r for r in results if r["category"] == "covered"]
    unc = [r for r in results if r["category"] == "uncovered"]

    print("\n阈值扫描（复用已有分数，零 API 调用）")
    print("─" * 62)
    print(f"{'阈值':>7}  {'covered 召回保留':>18}  {'uncovered 正确拦下':>20}")
    print("─" * 62)

    grid = [0.01, 0.02, 0.03, 0.05, 0.08, 0.10, 0.12, 0.15, 0.18,
            0.20, 0.25, 0.30, 0.35, 0.40, 0.50]
    for t in grid:
        keep = sum(any(s >= t for s in r["recall_scores"]) for r in cov if r["recall_scores"])
        base = sum(1 for r in cov if r["recall_scores"])
        block = sum(all(s < t for s in r["scores"]) for r in unc)
        mark = "  ← 现值" if abs(t - RERANK_MIN_SCORE) < 1e-9 else ""
        kp = f"{keep}/{base} {keep / base * 100:5.1f}%" if base else "—"
        bp = f"{block}/{len(unc)} {block / len(unc) * 100:5.1f}%" if unc else "—"
        print(f"{t:>7.2f}  {kp:>18}  {bp:>20}{mark}")
    print("─" * 62)
    print("召回保留：covered 题目里，含期望内容的切片仍能过闸门的比例（越高越好）")
    print("正确拦下：uncovered 题目里，一条切片都过不去的比例（越高越好）")
    print("两条曲线反向移动 —— 交叉区就是阈值该待的地方。\n")


# ─── 快照 ────────────────────────────────────────────────────────────────────

def save(results: list[dict], meta: dict) -> Path:
    SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    p = SNAPSHOTS / f"{meta['at'].replace(':', '').replace(' ', '_')}.json"
    p.write_text(json.dumps({"meta": meta, "results": results}, ensure_ascii=False, indent=2))
    return p


def latest_two() -> tuple[dict | None, dict | None]:
    files = sorted(SNAPSHOTS.glob("*.json"))
    load = lambda f: json.loads(f.read_text())  # noqa: E731
    if len(files) < 2:
        return (load(files[-1]) if files else None), None
    return load(files[-1]), load(files[-2])


def diff() -> None:
    new, old = latest_two()
    if not new or not old:
        raise SystemExit("至少要有两份快照才能对比。先跑两次。")

    print(f"\n对比  {old['meta']['at']}  →  {new['meta']['at']}")
    print("─" * 62)
    om = {r["id"]: r for r in old["results"]}
    changed = 0
    for r in new["results"]:
        o = om.get(r["id"])
        if not o:
            continue
        for key, label in [("recall_ok", "召回"), ("mention_ok", "要点"),
                           ("fabricated", "编造"), ("admitted", "承认")]:
            if r[key] != o[key]:
                # 编造是反向指标：True 才是坏
                good = (not r[key]) if key == "fabricated" else r[key]
                print(f"  {'✓' if good else '✗'} [{r['id']:<16}] {label} "
                      f"{o[key]} → {r[key]}   (分数 {o['top_score']} → {r['top_score']})")
                changed += 1
    print("─" * 62)
    print(f"{changed} 处变化\n" if changed else "没有任何一道题的结论发生变化。\n")


# ─── main ────────────────────────────────────────────────────────────────────

async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sweep", action="store_true", help="跑分后追加阈值扫描")
    ap.add_argument("--diff", action="store_true", help="只对比最近两份快照，不跑分")
    args = ap.parse_args()

    if args.diff:
        diff()
        return

    golden = yaml.safe_load((EVAL / "golden.yaml").read_text())
    model = yaml.safe_load((EVAL / "expert_model.yaml").read_text())
    real = bool(os.environ.get("REAL_LLM"))

    engine = create_async_engine(OWNER_URL)
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"数据库不可达，先 `make up && make migrate`。\n{exc}") from exc

    print(f"→ 构建评测语料（{'真实' if real else '假'}向量）")
    tenant_id, expert_id, n_chunks = await build_fixture(engine)
    print(f"  切片 {n_chunks} 个")

    try:
        print(f"→ 跑 {len(golden)} 道题")
        results = await run(golden, model, tenant_id, expert_id)
    finally:
        await drop_fixture(engine, tenant_id)
        await engine.dispose()
        await dispose_engine()

    meta = {
        "at": datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M"),
        "real": real,
        "corpus": len(list((EVAL / "corpus").glob("*.md"))),
        "chunks": n_chunks,
        "threshold": RERANK_MIN_SCORE,
    }
    scorecard(results, meta)
    if args.sweep:
        sweep(results)
    print(f"快照 → {save(results, meta).relative_to(ROOT)}")


if __name__ == "__main__":
    asyncio.run(main())
