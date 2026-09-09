SHELL := /bin/bash
.DEFAULT_GOAL := help

# Docker Desktop for Mac 不一定把 CLI 链到 /usr/local/bin（那步要管理员密码）。
# 注意：光用绝对路径不够 —— docker 还要调用同目录的 docker-credential-desktop，
# 所以必须把整个目录加进 PATH。
# （export PATH := 不行 —— GNU make 用它启动时的 PATH 直接 exec，不看变量。）
DOCKER_BIN := $(shell command -v docker 2>/dev/null || echo /Applications/Docker.app/Contents/Resources/bin/docker)
DOCKER_DIR := $(shell dirname $(DOCKER_BIN))
DOCKER := PATH="$(DOCKER_DIR):$$PATH" docker
.PHONY: help install up down migrate dev health contract contract-check test typecheck lint-db-access clean

help: ## 显示所有命令
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## 安装三个服务的依赖
	pnpm install
	cd agent && uv sync

up: ## 起本地基础设施（postgres + redis）
	$(DOCKER) compose up -d
	@echo "等待 postgres 就绪..."
	@until $(DOCKER) compose exec -T postgres pg_isready -U app_owner -d ai_expert >/dev/null 2>&1; do sleep 1; done
	@echo "✓ postgres ready"

down: ## 停掉基础设施（保留数据卷）
	$(DOCKER) compose down

migrate: ## 跑数据库迁移（以 app_owner 身份）
	pnpm --filter backend migrate

dev: ## 同时起三个服务
	pnpm --filter backend dev & \
	(cd agent && uv run uvicorn app.main:app --reload --port $${AGENT_PORT:-8000}) & \
	pnpm --filter frontend dev & \
	wait

health: ## 检查三个服务的健康端点
	@echo "backend :" && curl -sS http://localhost:8787/health  | head -c 200 && echo
	@echo "agent   :" && curl -sS http://localhost:8000/internal/health | head -c 200 && echo
	@echo "frontend:" && curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:5173/

contract: ## 重新生成两份 OpenAPI 与 TS 类型
	pnpm --filter backend openapi:export
	cd agent && uv run python scripts/export_openapi.py
	pnpm exec openapi-typescript contracts/public/openapi.json        -o contracts/public/api.d.ts
	pnpm exec openapi-typescript contracts/internal/agent-openapi.json -o contracts/internal/agent.d.ts

contract-check: contract ## CI 守门：契约与代码不同步则失败
	@git diff --exit-code contracts/ || \
	  (echo ""; echo "✗ contracts/ 与代码不同步 —— 请提交 make contract 的产物"; exit 1)
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

test: lint-db-access ## 跑全部测试（需要 postgres 在跑）
	pnpm --filter backend test
	cd agent && uv run pytest -q

clean: ## 清干净（含数据卷，会删数据）
	$(DOCKER) compose down -v
	rm -rf node_modules */node_modules agent/.venv
