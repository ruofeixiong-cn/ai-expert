#!/usr/bin/env bash
# 端到端测试的编排：起 agent + worker，跑测试，无论成败都清理干净。
#
# backend 在测试进程内运行（同一份代码），所以这里只需要拉起跨进程的两个依赖。
# postgres / redis 由 `make up` 提供。
set -euo pipefail
cd "$(dirname "$0")/.."

# 向量化与七维提炼都用确定性假实现：E2E 验的是【跨服务链路】，
# 不是向量质量、也不是提炼质量。真实 LLM 会让测试变慢、花钱、并因限流随机失败。
# 需要走真实模型时：REAL_LLM=1 make e2e
_provider="${REAL_LLM:-}"
export EMBEDDING_PROVIDER="${_provider:+auto}"; export EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-fake}"
export EXTRACT_PROVIDER="${_provider:+auto}";   export EXTRACT_PROVIDER="${EXTRACT_PROVIDER:-fake}"
export CHAT_PROVIDER="${_provider:+auto}";      export CHAT_PROVIDER="${CHAT_PROVIDER:-fake}"
export RERANK_PROVIDER="${_provider:+auto}";    export RERANK_PROVIDER="${RERANK_PROVIDER:-fake}"

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "→ 启动 agent（LLM 全部走 ${_provider:+真实模型}${_provider:-假实现}）"
(cd agent && uv run uvicorn app.main:app --port "${AGENT_PORT:-8000}" >/tmp/e2e-agent.log 2>&1) &
pids+=($!)

echo "→ 启动构建 worker"
(cd agent && uv run arq app.workers.build.WorkerSettings >/tmp/e2e-worker.log 2>&1) &
pids+=($!)

echo -n "→ 等待 agent 就绪"
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:${AGENT_PORT:-8000}/internal/health" >/dev/null 2>&1; then
    echo " ✓"; break
  fi
  echo -n "."; sleep 0.5
done
curl -sf "http://localhost:${AGENT_PORT:-8000}/internal/health" >/dev/null || {
  echo " ✗ agent 没起来："; tail -20 /tmp/e2e-agent.log; exit 1;
}

# worker 启动稍慢，给它连上 redis 的时间
sleep 1.5

echo "→ 运行端到端测试"
E2E=1 pnpm --filter backend exec vitest run tests/e2e.spec.ts
status=$?

if [ $status -ne 0 ]; then
  echo "──── worker 日志 ────"; tail -30 /tmp/e2e-worker.log
  echo "──── agent 日志 ────";  tail -20 /tmp/e2e-agent.log
fi
exit $status
