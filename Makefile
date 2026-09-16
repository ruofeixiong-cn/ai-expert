SHELL := /bin/bash
.DEFAULT_GOAL := help

# Docker Desktop for Mac 装在 "User" 模式时，CLI 在 ~/.docker/bin 且不在 PATH 里
# （"System" 模式才装到 /usr/local/bin，但那要管理员密码）。
# 注意：光用绝对路径不够 —— docker 还要调用同目录的 docker-credential-desktop，
# 所以必须把整个目录加进 PATH。
# （export PATH := 不行 —— GNU make 用它启动时的 PATH 直接 exec，不看变量。）
DOCKER_BIN := $(shell command -v docker 2>/dev/null \
                || ls $(HOME)/.docker/bin/docker 2>/dev/null \
                || echo /Applications/Docker.app/Contents/Resources/bin/docker)
DOCKER_DIR := $(shell dirname $(DOCKER_BIN))
DOCKER := PATH="$(DOCKER_DIR):$$PATH" docker
.PHONY: help install up down migrate dev worker health contract contract-check test e2e eval seed verify typecheck lint-db-access clean

help: ## 显示所有命令
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## 安装三个服务的依赖
	pnpm install
	cd agent && uv sync

up: ## 起本地基础设施（postgres + redis）
	$(DOCKER) compose up -d
	@echo "等待 postgres 就绪..."
	@until $(DOCKER) compose exec -T postgres pg_isready -U postgres -d ai_expert >/dev/null 2>&1; do sleep 1; done
	@echo "✓ postgres ready"

down: ## 停掉基础设施（保留数据卷）
	$(DOCKER) compose down

migrate: ## 跑数据库迁移（以 app_owner 身份）
	pnpm --filter backend migrate

dev: ## 同时起三个服务 + 构建 worker
	pnpm --filter backend dev & \
	(cd agent && uv run uvicorn app.main:app --reload --port $${AGENT_PORT:-8000}) & \
	(cd agent && uv run arq app.workers.build.WorkerSettings) & \
	pnpm --filter frontend dev & \
	wait

worker: ## 只起构建 worker
	cd agent && uv run arq app.workers.build.WorkerSettings

health: ## 检查三个服务的健康端点
	@echo "backend :" && curl -sS http://localhost:8787/health  | head -c 200 && echo
	@echo "agent   :" && curl -sS http://localhost:8000/internal/health | head -c 200 && echo
	@echo "frontend:" && curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:5173/

contract: ## 重新生成两份 OpenAPI 与 TS 类型
	pnpm --filter backend openapi:export
	cd agent && uv run python scripts/export_openapi.py
	pnpm exec openapi-typescript contracts/public/openapi.json        -o contracts/public/api.d.ts
	pnpm exec openapi-typescript contracts/internal/agent-openapi.json -o contracts/internal/agent.d.ts
	node scripts/gen-contract-zod.mjs

contract-check: contract ## CI 守门：契约与代码不同步则失败
	@git diff --exit-code contracts/ || \
	  (echo ""; echo "✗ contracts/ 与代码不同步 —— 请提交 make contract 的产物"; exit 1)
	@# git diff 看不见【未跟踪】的文件：新增一个产物却忘了 git add，上面那句会静默放行
	@test -z "$$(git ls-files --others --exclude-standard contracts/)" || \
	  (echo ""; echo "✗ contracts/ 下有未提交的新产物："; \
	   git ls-files --others --exclude-standard contracts/; exit 1)
	@echo "✓ contracts 同步"

typecheck: ## 三方类型检查
	pnpm --filter backend  exec tsc --noEmit
	pnpm --filter frontend exec tsc --noEmit
	cd agent && uv run python -c "import app.main; print('✓ agent imports')"

lint-db-access: ## 禁止在唯一入口之外裸开数据库连接
	@bad=$$(grep -rn --include=*.ts 'db\.transaction(' backend/src | grep -v 'backend/src/db/client.ts' || true); \
	 if [ -n "$$bad" ]; then echo "✗ 只允许在 db/client.ts 里开事务:"; echo "$$bad"; exit 1; fi
	@bad=$$(grep -rn --include=*.py 'engine\.begin(\|engine\.connect(' agent/app | grep -v 'agent/app/db/session.py' || true); \
	 if [ -n "$$bad" ]; then echo "✗ 只允许在 db/session.py 里开连接:"; echo "$$bad"; exit 1; fi
	@echo "✓ 数据库访问入口唯一"

test: lint-db-access ## 跑单元与集成测试（需要 postgres 在跑）
	pnpm --filter backend test
	pnpm --filter frontend test
	cd agent && uv run pytest -q

e2e: ## 端到端测试（自动起 agent + worker；需要 make up 已执行）
	./scripts/e2e.sh

seed: ## 灌入本地体验用的演示数据（需要 make dev 已在跑）
	node scripts/seed-demo.mjs $(SEED_ARGS)

eval: ## 黄金问答集跑分（REAL_LLM=1 走真实模型；SWEEP=1 追加阈值扫描）
	cd agent && uv run python scripts/eval.py $(if $(SWEEP),--sweep,)

eval-diff: ## 对比最近两份评测快照
	cd agent && uv run python scripts/eval.py --diff

verify: ## 提交前全量验证（每一项都跑完，最后汇总）
# ⚠️ 不要写成 `verify: test e2e eval contract-check typecheck`。
# 那样任何一项失败，make 立刻停 —— 后面的检查【一次都没跑】，而输出看上去只是"有个错"。
# 真实事故：contract-check 因为产物没提交而失败，typecheck 因此被跳过，
# 一个类型错误就这样进了 main（2026-09-16）。
# 所以这里逐项跑、逐项记，最后一起报。快的排前面，反馈早一点。
#
# eval 进 verify 是刻意的：假实现下分数没有意义，但【流程必须跑通】——
# 否则 eval.py 会慢慢腐烂成一个"只有想起来时才手动跑"的脚本，
# 而那正是所有评测工具的死法。真实分数由 REAL_LLM=1 make eval 手动产出。
	@fail=""; \
	for t in typecheck contract-check test e2e eval; do \
	  echo ""; echo "──────── make $$t ────────"; \
	  $(MAKE) $$t || fail="$$fail $$t"; \
	done; \
	echo ""; \
	if [ -n "$$fail" ]; then echo "✗ verify 失败：$$fail"; exit 1; fi; \
	echo "✓ verify 全绿"

clean: ## 清干净（含数据卷，会删数据）
	$(DOCKER) compose down -v
	rm -rf node_modules */node_modules agent/.venv
