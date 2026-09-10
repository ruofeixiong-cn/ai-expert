# AI 专家平台

> 把知识型博主的知识和经验，变成一个 24 小时在线、能变现的 AI 专家。

博主上传自己写过的文章 → AI 读完后提炼出一份「思维说明书」（怎么说话、信什么、
怎么分析、什么不能答）→ 博主确认后上线 → 粉丝付费向这个 AI 专家提问。

商业模式是**粉丝付费**：博主免费建专家，平台抽成 + 博主分成。

---

## 架构

三个服务，**Node 管钱，Python 管脑**：

```
                    ┌──────────────┐
   浏览器  ────────▶ │  frontend    │  React 19 + Vite + Tailwind v4
                    └──────┬───────┘
                           │ HTTPS，唯一公网 API
                           ▼
                    ┌──────────────┐
                    │  backend     │  Node 22 + Hono + Drizzle
                    │  业务与钱     │  认证 / 租户 / 素材 / 支付 / 看板
                    │              │  拥有全部 DDL，SSE 代理
                    └──────┬───────┘
                           │ 内网 HTTP + 共享密钥（永不公网暴露）
                           ▼
                    ┌──────────────┐
                    │  agent       │  Python 3.12 + FastAPI + ARQ
                    │  内容与模型   │  解析 / 切分 / 向量化 / 召回
                    │              │  七维提炼 / 流式生成
                    └──────┬───────┘
                           ▼
              PostgreSQL 16 + pgvector · Redis · 阿里百炼
```

**为什么这么切**：一边全是 CRUD + IO（Node 强项，且与前端共用 TypeScript 和契约类型），
一边全是内容处理与模型调用（Python 强项：trafilatura、pymupdf、tokenizer、评测工具链）。
中间只有 4 个内部接口。

完整的技术选型理由见 [`docs/技术选型与工程结构.md`](docs/技术选型与工程结构.md)。

---

## 快速开始

### 前置

| 工具 | 版本 | 说明 |
|---|---|---|
| Node | ≥ 22 | |
| pnpm | ≥ 10 | `corepack enable` |
| uv | 最新 | Python 包管理，会自动装 3.12 |
| Docker | 最新 | 跑 PostgreSQL 与 Redis |

> macOS 上 Docker Desktop 若装成 "User" 模式，CLI 在 `~/.docker/bin` 且不在 PATH 里。
> Makefile 会自动找到它，你不用配；只是终端里直接敲 `docker` 会找不到。

### 跑起来

```bash
cp .env.example .env          # 按需填 DASHSCOPE_API_KEY
make install                  # 装三个服务的依赖
make up                       # 起 PostgreSQL(pgvector) + Redis
make migrate                  # 建表 + RLS 策略 + 角色授权
make dev                      # 同时起 frontend / backend / agent / worker
```

打开 <http://localhost:5173> ，注册一个博主账号即可。

**没有百炼 API Key 也能跑通全流程**：向量化和七维提炼都有确定性的假实现，
由 `EMBEDDING_PROVIDER` / `EXTRACT_PROVIDER` 控制（默认 `auto`：有 key 用真的，
没 key 自动退回假的）。

> ⚠️ 假实现**没有语义也没有提炼能力**，只能验证链路是否打通。
> 评估检索质量或提炼质量必须用真实 Key。

### 端口

| 服务 | 地址 |
|---|---|
| frontend | http://localhost:5173 |
| backend | http://localhost:8787 |
| agent（内网） | http://localhost:8000 |

---

## 想先跑起来看看

```bash
make up && make migrate && make dev    # 起服务
make seed                              # 另开终端：灌演示数据
```

然后跟着 **[docs/本地体验.md](docs/本地体验.md)** 走一遍：
建专家 → 确认七维 → 上线 → 以粉丝身份提问 → 点赞点踩 → 回看看板。
里面有一份**带预期表现的试题清单**（该答出什么、该拒答什么、该守住什么）。

---

## 常用命令

```bash
make help            # 列出全部命令
make dev             # 起全部服务
make test            # 单元 + 集成测试（需要 make up）
make e2e             # 跨服务端到端（自动起 agent + worker）
make seed            # 灌演示数据（三篇文章 + 演示账号），配合 docs/本地体验.md
make eval            # 黄金问答集跑分（SWEEP=1 追加阈值扫描）
make verify          # 提交前一把梭：test + e2e + eval + contract-check + typecheck
make contract        # 重新生成两份 OpenAPI 与 TS 类型
make down            # 停掉基础设施（保留数据）
make clean           # 清干净（含数据卷，会删数据）
```

`REAL_LLM=1 make e2e` 会用真实的百炼模型跑端到端；默认用假实现（快、免费、确定性）。
`REAL_LLM=1 SWEEP=1 make eval` 跑真实分数并输出阈值曲线 —— 调参数前后各跑一次，
用 `make eval-diff` 看哪几道题的结论变了。

---

## 目录结构

```
├── docs/                   产品文档与技术方案
├── specs/                  各里程碑的规格（spec / plan / tasks）
├── contracts/              ★ 唯一的跨服务产物，全部由 make contract 生成
│   ├── public/             backend → frontend
│   └── internal/           agent → backend
├── frontend/               React 19 + Vite + Tailwind v4
├── backend/                Node + Hono + Drizzle（拥有全部 DDL）
├── agent/                  Python 3.12 + FastAPI + ARQ
├── infra/postgres/init/    扩展与运行时角色（生产环境需手工执行一次）
└── scripts/                端到端编排等
```

---

## 三条开发约定

这三条是这个项目最不能破的规则，改代码前请先读 [`CLAUDE.md`](CLAUDE.md)。

### 1. 契约是编译期检查，不是文档

`contracts/` 全部由 `make contract` 生成，**禁止手写**。
后端改了字段名而没同步契约，前端下次 `tsc` 就会失败 —— CI 里 `make contract-check` 会拦。

这是三个服务能并行开发的技术基础。

### 2. 租户隔离由数据库强制

PostgreSQL 的 Row Level Security，不是应用层的 `WHERE tenant_id = ?`。
两条铁律：

- 只能通过 `tenantTx()`（Node）/ `tenant_conn()`（Python）访问受 RLS 保护的表。
  `make lint-db-access` 会拒绝在别处开连接。
- 设置租户只能用 `set_config('app.current_tenant', $1, true)`。
  `SET LOCAL x = $1` 是非法 SQL；`SET`（不带 LOCAL）会把租户粘在连接上，
  连接归还池子后被下一个请求复用 → **跨租户泄露**。

### 3. 权限是允许清单，不是拒绝清单

三个 PostgreSQL 角色：`app_owner`（迁移）/ `app_backend`（Node）/ `app_agent`（Python）。

`app_agent` 刻意**没有** `ALTER DEFAULT PRIVILEGES` —— 以后新增的表对 Python
默认不可达，要开口必须显式写一条 `GRANT`。写的时候人会停一秒想：
"agent 真的需要碰这张表吗？需要写吗？"

目前它被授权的全部表：

```
chunks              DELETE,INSERT,SELECT,UPDATE
build_jobs          DELETE,INSERT,SELECT,UPDATE
expert_model_drafts INSERT,SELECT,UPDATE          ← 没有 DELETE
experts             SELECT
materials           SELECT
```

---

## 进度

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** 地基 | 三服务骨架、RLS 隔离、跨服务契约管线 | ✅ |
| **M1** 内容入库 | 认证与租户、素材上传、切分、向量化、构建进度 | ✅ |
| **M2** 七维模型 | AI 提炼专家模型、分块确认、上线分享 | ✅ |
| **M3** 对话 | 知识召回、双闸门、SSE 流式、免登录分享页 | ✅ |
| **M4** 反馈与看板 | 点赞点踩、疑似盲区、Creator 最小看板 | ✅ |
| **M5** 付费 | credits 账本、兑换码、微信支付 | 暂缓（等备案） |
| **M6** 调优 | 黄金问答集、阈值校准、Langfuse 可观测 | ✅ |

测试：backend 64 + agent 72 + 端到端 15，外加 29 道黄金问答集。

每个里程碑的验收标准与实现记录在 `specs/` 下，包括**做的时候踩到的坑**
—— 那部分往往比代码本身更值得看。

---

## 文档

| 文档 | 讲什么 |
|---|---|
| [`docs/AI专家平台-产品规划文档.md`](docs/AI专家平台-产品规划文档.md) | 一期/二期/三期、五层能力演进、数据飞轮 |
| [`docs/AI专家平台-MVP产品文档.md`](docs/AI专家平台-MVP产品文档.md) | MVP 范围、七维结构、双闸门、数据模型 |
| [`docs/技术选型与工程结构.md`](docs/技术选型与工程结构.md) | 选型理由与取舍，含实测的模型可用性与阈值校准 |
| [`contracts/README.md`](contracts/README.md) | 契约管线、SSE 事件协议、错误码表 |
| [`CLAUDE.md`](CLAUDE.md) | 开发边界规则 |
