# M6 · 调优 —— 实施计划（Plan）

---

## 1. 改动面

| 服务 | 改什么 |
|---|---|
| `agent/` | `eval/` 语料与题目、`scripts/eval.py`、召回暴露闸门前结果、Langfuse 埋点 |
| `backend/` | **只改一个常量**（`BLINDSPOT_CONFIDENCE`），由评测结论驱动，见 ADR-001 |
| `frontend/` | 一行都不改 |
| infra | `docker-compose.yml` 加 Langfuse（独立 profile，默认不起） |

---

## 2. 目录

```
agent/
  eval/
    corpus/           固定语料（原创，3~4 篇，覆盖不同小节结构）
    golden.yaml       题目与期望
    snapshots/        历次结果，用来 diff
  scripts/eval.py     跑分 + 阈值扫描
```

语料放在仓库里而不是数据库里：**评测必须能在一台干净的机器上重跑**。
依赖某个已有专家的话，别人跑出来的分数和你的不可比。

---

## 3. `eval.py` 的三个模式

```
uv run python scripts/eval.py            # 跑分
uv run python scripts/eval.py --sweep    # 阈值扫描
uv run python scripts/eval.py --diff     # 和上一份快照对比
```

### 3.1 准备阶段

每次跑分都**新建一个临时专家**并重新构建语料，跑完删掉。

理由：复用已有专家的话，切分参数改了却还用旧切片，
分数变化就跟改动无关了 —— 那是最难发现的一类假结论。
代价是每次跑分都要付一次 embedding 的钱（几篇文章，可接受）。

### 3.2 打分

一道题一条流水线，全部走真实链路（`retrieve` → 闸门 → `generate`），
**不 mock 任何一层** —— mock 掉的那一层正是要测的东西。

| 判据 | 实现 |
|---|---|
| `must_recall` | 关键词组匹配【通过闸门的切片正文】 |
| `must_mention` | 关键词组匹配【答案】 |
| `must_not` | 答案里出现即失败 |
| 承认不知道 | 答案匹配 `ADMIT_PATTERNS`（与 M3 e2e 同一套） |
| `expect: disclaimed` | `safety` 字段或答案含免责语 |

关键词组语义固定为：**组内 AND，组间 OR**。
`[[两成, 20%]]` 意思是「出现『两成』或『20%』」，
`[[手续费, 收益]]` 意思是「同一段里同时出现『手续费』和『收益』」。

### 3.3 阈值扫描

`retrieve()` 现在只返回过闸门的结果。加一个 `retrieve_scored()`
返回**闸门之前**的完整排序（含每条的 effective 分数），
`retrieve()` 变成它 + 一次过滤 —— 保证扫描用的分数和线上跑的是同一条路径。

扫描本身不再调任何 API：拿缓存的分数，对每个候选阈值重算两个指标。

> ⚠️ 扫描的是 **effective 分数**（`rerank × chunk.confidence`），
> 不是裸 rerank 分数。降权后的注入切片本来就该按降权后的值参与判定。

---

## 4. Langfuse

```yaml
# docker-compose.yml
  langfuse:
    profiles: ["obs"]        # 默认不起 —— make up 不该因为观测组件变慢
```

代码侧：`agent/app/obs.py` 一个薄封装。

```python
LANGFUSE_ENABLED=0  →  所有埋点是 no-op，不 import langfuse
```

**默认关**，且埋点用 try/except 包住只记日志。
观测组件把主链路搞挂是本末倒置里最经典的一种。

---

## 5. 假实现下也要能跑

CI 没有 API key。`EMBEDDING_PROVIDER=fake` 时分数当然没意义
（假 rerank 按字符重合打分），但**流程不许断** ——
否则 eval.py 会慢慢腐烂成一个「只有想起来时才手动跑」的脚本。

所以 `make eval` 在 CI 里跑假实现，只断言**跑通**；
真实分数由 `REAL_LLM=1 make eval` 手动产出并记进 tasks.md。

---

## 6. 顺序

```
W1 语料与题目 → W2 eval.py 跑分 → W3 阈值扫描 → W4 用数据改参数
                                                → W5 Langfuse → W6 回归
```

W4 排在 Langfuse 前面：**尺子的价值在于用它改一次东西**。
先把埋点做完再调参，容易变成"接了个观测组件，然后就没有然后了"。
