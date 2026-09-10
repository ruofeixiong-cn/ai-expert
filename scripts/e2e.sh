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

# ⚠️ 端口被占就直接失败，不要"看到 /internal/health 通了就往下跑"。
#
# M4 踩过：一个 12 小时前遗留的 agent 进程一直占着 8000，本脚本新起的那个
# 绑不上端口默默退出，健康检查却被【旧进程】答应了 —— 于是连续几轮 e2e
# 测的都是老代码。表现成"改了 agent 但行为没变"，极难往这个方向想。
# Pydantic 默认忽略多余字段，新加的请求字段被老进程静静丢掉，更是一点声音都没有。
_port="${AGENT_PORT:-8000}"
if lsof -ti ":${_port}" >/dev/null 2>&1; then
  echo "✗ 端口 ${_port} 已被占用 —— 很可能是上一次没退干净的 agent。" >&2
  echo "  这会让端到端测试跑在【旧代码】上，而且看起来一切正常。" >&2
  echo "  先收拾掉：kill \$(lsof -ti :${_port})" >&2
  exit 1
fi

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  # ⚠️ `uv run X` 会再 fork 一个真正跑 X 的子进程，kill 掉 uv 本身【收不走它】。
  #    漏掉这一步的后果就是上面那个端口检查在防的事：残留的 agent 继续占着
  #    8000，下一轮 e2e 悄悄跑在旧代码上。所以按端口和进程名再收一次尾。
  lsof -ti ":${_port}" 2>/dev/null | xargs -r kill 2>/dev/null || true
  pkill -f "arq app.workers.build.WorkerSettings" 2>/dev/null || true
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
