# ADR-007：契约不只生成类型，也生成约束

- **状态**：已接受
- **日期**：2026-09-16
- **相关**：`docs/M0-M6回顾与加固计划.md` §6.3、F03、F16；ADR-003（条件约束那部分）；
  根 `CLAUDE.md`「`contracts/` 禁止手写」

## 背景

`make contract` 原来只生成 TS 类型。`min(1)`、`max(200)` 这些**约束**停在 OpenAPI 里，
前端拿不到，于是只能**手抄**一份：

```ts
// 旧代码，dimensions.ts
// ⚠️ 这里是手抄契约里的 min(1)……手抄的约束迟早会和后端对不上
if (e.evidenceChunkIds.length === 0) return `第 ${n} 条没有原文出处`;
```

F03 就是抄漏一条的后果：前端"添加一条"给 `evidenceChunkIds` 的是 `[]`，
而契约要求至少一条 —— **类型检查全过，运行时必然 400**，而且当时确认失败还会清空编辑。
F16（正文字数只显示不限制）是同一类：约束只活在后端。

这轮加固里这份手抄又长了一条（样本证据按 `origin` 分叉），说明它在持续变贵。

## 决定

`make contract` 增加一步：`contracts/public/openapi.json` → `contracts/public/zod.ts`，
产物同样在 `contracts/` 下，同样**禁止手写**，同样由 `make contract-check` 守门。

前端提交前的校验改用生成的 schema：后端加一条约束，前端自动就有。

### 为什么自己写生成器，不用现成的库

这份 spec 的构造面很窄（41 个组件，只用到 object / string / number / integer /
boolean / array / enum / $ref / allOf / oneOf / anyOf / 可空 / 长度与范围 / format）。
自己生成能保证**遇到不认识的构造就抛错**，而不是悄悄降级成 `z.any()` ——
后者等于把"契约即编译期检查"又变回"靠人记得"，正是本 ADR 要消灭的东西。

`scripts/gen-contract-zod.mjs` 里有一张 `SUPPORTED` 关键字表，出现表外的关键字就让
`make contract` 失败，逼人显式支持它。生成过程中已经触发过一次（`{"type":"null"}`），
这正是它该有的行为。

### zod 版本必须和 backend 一致

同一个 `min(1)` 在两边得是同一个意思，所以 zod 放在**根** `package.json`
（生成物在 `contracts/` 下，要从那里能解析到），版本与 `backend/package.json` 对齐。
生成器启动时会比对两边的大版本，不一致直接报错 —— 这条规则是工具化的，不靠记。

### 表达不进 JSON Schema 的，留在前端显式写

条件约束（`ExampleItem` 的证据要求随 `origin` 分叉，ADR-003）在 JSON Schema 里没有对应物，
`.refine()` 也不会被导出。这类规则：

- 服务端仍然是权威（`.refine()` 在 backend 的 zod 里照常生效）；
- 前端就近写一句显式判断，并在注释里点名 ADR；
- 有一条测试专门守着"生成的 schema 放行、前端补的那句拦住"，防止哪天顺手删掉。

## 后果

- 前端 bundle 多了 zod：实测 **347.79 kB → 405.48 kB（gzip 111.05 → 125.67，+14.6 kB）**。
  粉丝在手机上打开分享页也要下载它，而分享页根本不用这些校验 ——
  这让 F24（路由级代码分割）从"锦上添花"变成"有具体数字的待办"。
- `contracts/public/zod.ts` 只提供**运行期约束**。类型仍然从 `api.d.ts` 取，
  不要 `z.infer` —— 一份契约两个类型来源，迟早对不上。文件头写了这句。
- 校验报错现在由 zod 的 issue 翻译而来，措辞从「第 2 条还没填内容」变成
  「第 2 条的内容还没填」，并且能指出是哪个字段（问题 / 回答 / 内容）。

## 被否决的方案

- **把 backend 的 zod schema 直接共享给前端**：最短路径，但 backend 的 schema 依赖
  `@hono/zod-openapi`，等于让前端依赖后端的运行时；而且 `contracts/` 作为唯一跨服务产物
  的约定会被绕过。
- **`openapi-zod-client` 之类的库**：会连 zodios 客户端一起生成，而我们已经有
  `openapi-fetch`；更关键的是它对不认识的构造是"尽力而为"，不会报错。
- **只在前端手写一份 zod**：还是手抄，只是换了个写法。
