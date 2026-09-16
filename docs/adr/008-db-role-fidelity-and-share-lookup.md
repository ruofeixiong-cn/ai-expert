# ADR-008：本地数据库角色与生产对齐，短链解析不再依赖 owner 绕过 RLS

- **状态**：已接受
- **日期**：2026-09-16
- **相关**：`docs/M0-M6回顾与加固计划.md` 的 B27；迁移 `0001_rls_and_roles.sql`、
  `0010_share_lookup.sql`、`0016_build_jobs_one_active.sql`；ADR-002；
  根 `CLAUDE.md`「隔离是这个项目最不能出错的东西」

## 背景

`resolve_share_slug` 是 `SECURITY DEFINER` 函数，以属主身份读 `experts`，
而 `experts` 开了 `FORCE ROW LEVEL SECURITY`。它在本地能工作，**只是因为本地的属主
`app_owner` 恰好是超级用户**（docker 的 `POSTGRES_USER`），超级用户连 FORCE 也能绕过。

本地实测（2026-09-16）：

| 执行身份 | `select count(*) from experts where status='online'` |
|---|---|
| `app_owner`（超级用户 + BYPASSRLS） | **508** |
| 普通角色（模拟 RDS 迁移账号） | **0** |

生产环境（阿里云 RDS）的迁移账号通常不是真正的超级用户、也没有 BYPASSRLS。
那时函数在没有租户上下文的情况下读 `experts` → FORCE RLS 生效 → 0 行 →
**所有分享链接 404**，而接口、日志、测试都不会有任何异常。

这不止是一个函数的问题，**根因是测试环境保真度**：本地 owner 的权限比生产大，
于是一整类「依赖 owner 绕过 RLS」的代码在本地永远是绿的。
`0016` 迁移里那条跨租户的数据清理 UPDATE 是同一根因的第二个实例（当时已写在注释里）。
只修函数不修保真度，下一个同类问题还是要等到生产才发现。

## 决定

### 1. 本地角色与生产对齐（infra）

- docker 初始化改用独立的超级用户（`POSTGRES_USER=postgres`）执行 `01-roles.sql`；
  建扩展这类确实需要超级用户的动作留在这里。
- `app_owner` 降为**普通角色**：`NOSUPERUSER NOBYPASSRLS`，通过持有 `ai_expert` 库与
  `public` schema 的**属主权**来跑迁移 —— 这与生产上 DBA 给应用账号的权限形状一致。
- 迁移仍然以 `app_owner` 身份执行，`DATABASE_URL_OWNER` 不变。

于是「靠 owner 特权才能跑通」的代码会在本地**立刻变红**，而不是等到生产。

### 2. 短链解析改为「角色限定的策略」（backend 迁移 0017）

- 新增角色 `share_resolver`：`NOLOGIN`、无密码，**不能连库**，只作为函数属主存在。
- `experts` 上加一条限定角色的策略：

  ```sql
  CREATE POLICY "share_lookup" ON "experts" FOR SELECT TO share_resolver
    USING (status = 'online' AND expert_model IS NOT NULL);
  ```

- `GRANT SELECT ON experts TO share_resolver`，并把 `resolve_share_slug` 的属主改为它。
  函数体不变，仍然只接受 slug、只返回两个 uuid、只对已上线专家返回。
- 改属主要求 app_owner「能 SET ROLE 到新属主」，所以 init 里给一句
  **`GRANT share_resolver TO app_owner WITH INHERIT FALSE`**（PG16+）：
  app_owner 能 `SET ROLE` 过去改属主，却**不继承**它的可见性 ——
  实测 app_owner 读 `experts` 仍然是 0 行。
  迁移末尾断言「没有任何角色以继承方式成为 share_resolver 的成员」，
  不满足就让迁移失败。

**为什么这次可以用策略，而 `0010` 当初否决了策略**：`0010` 否决的是**不限定角色**的策略。
permissive 策略之间是 OR 的，不限定角色等于让 `app_backend` 在无租户上下文时读到
已上线专家的**整行**，包括 `confirmed_model`（博主还没上线的编辑中内容）。
加上 `TO share_resolver` 之后，这条策略只对该角色生效：
`app_backend` / `app_agent` 的可见性一个字节都没变，而 `share_resolver` 不能登录，
只在这个函数体内短暂成为 `current_user`。原来的反对理由不再适用。

### 3. 不给 `share_resolver` BYPASSRLS

创建带 BYPASSRLS 的角色需要超级用户，托管 RDS 上通常做不到 —— 那样这个修复本身
又会变成「本地能跑、生产跑不了」。而且一个常驻的、能看穿全库的角色本身就是风险面。
策略方案只需要 CREATEROLE。

### 4. 今后需要跨租户改数据的迁移，必须显式脱下 FORCE

不得依赖 owner 特权。成对写：

```sql
ALTER TABLE "x" NO FORCE ROW LEVEL SECURITY;
-- 数据清理
ALTER TABLE "x" FORCE ROW LEVEL SECURITY;
```

`0016` 保持原样（它已经选择了 fail fast 并写明），这条规则约束的是后续迁移。

### 5. 回归保护

新增测试，断言三件事：

1. 以**普通角色**执行 `resolve_share_slug`，能解析到已上线专家；
2. 未上线 / 无 `expert_model` 的专家解析不到；
3. `app_backend` 在无租户上下文时，`experts` 仍然一行都读不到 ——
   证明这条策略没有削弱隔离。

## 后果

- **本地数据卷必须重建**：`01-roles.sql` 只在首次创建数据卷时执行。
  重建会清掉现有的演示数据（含 508 个在线专家），需要重新跑种子。
- `app_owner` 降权后，任何「以 owner 身份跨租户读写」的脚本都会立刻失败。
  **实测结果：一处都没有。** 原以为 `agent/tests/conftest.py` 与
  `agent/scripts/eval.py` 的种子数据会红，结果两者本来就在写入前设了
  `app.current_tenant`（conftest 里甚至写着「owner 播种同样要设租户」的注释）。
  agent 105 条测试全绿。唯一真正依赖 owner 特权的，就是短链解析这一处。
- 改函数属主还需要新属主对 schema 有 `CREATE` 权限，迁移里临时给、改完立刻收回。
- **依赖 PostgreSQL 16+**（`GRANT ... WITH INHERIT FALSE` 与
  `pg_auth_members.inherit_option` 都是 16 引入的）。迁移开头显式检查版本并给出可读的报错。
- **运维注意**：以后要改 `resolve_share_slug`，app_owner 不再是属主，
  迁移里要先 `SET ROLE share_resolver`，改完 `RESET ROLE`。
- 生产上线顺序：先由 DBA 执行一次更新后的 `01-roles.sql`（建 `share_resolver`），
  再跑迁移。顺序反了迁移会 fail fast，不会静默。

## 被否决的方案

- **让 app_owner 在生产上也是超级用户**：把「迁移账号能绕过 RLS」制度化，
  等于承认隔离的最后一道保障可以被运维身份绕过；RDS 上通常也做不到。
- **不限定角色的 `experts` 策略**：`0010` 已否决，理由仍然成立。
- **单独一张 `share_links` 表**：`0010` 已否决（数据重复，上线/改名要同步，迟早不一致）。
- **把 slug 解析挪到应用层缓存**：缓存冷启动时还是要回数据库，问题原样存在。
- **「迁移里用完成员资格就 REVOKE 掉」**：第一版这么写的，实测跑不通 ——
  成员资格的授予者是 init 脚本里的高权限账号，PG16 只允许拥有该授予者权限的角色撤销它
  （`permission denied to revoke privileges granted by role "postgres"`）。
  `WITH INHERIT FALSE` 才是这个问题的正解：不用撤，本来就不继承。
