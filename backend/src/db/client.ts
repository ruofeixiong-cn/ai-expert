import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { env } from "../env.js";
import { schema } from "./schema/index.js";

/**
 * ⚠️ 这是全后端【唯一】允许开数据库事务的文件。
 * `make lint-db-access` 会拒绝在别处出现 db.transaction(。
 *
 * 原因：租户隔离依赖每个事务里正确设置 app.current_tenant。
 * 只要有一处绕开 tenantTx()，RLS 就失去意义。
 */

let _sqlClient: postgres.Sql | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

/** 惰性初始化 —— openapi 导出脚本会 import 本模块，但绝不能连库。 */
export function getDb() {
  if (!_db) {
    _sqlClient = postgres(env.DATABASE_URL_BACKEND, { max: 10 });
    _db = drizzle(_sqlClient, { schema });
  }
  return _db;
}

export async function closeDb() {
  await _sqlClient?.end();
  _sqlClient = undefined;
  _db = undefined;
}

type Db = ReturnType<typeof getDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 在租户上下文中执行。所有涉及 experts / chunks / build_jobs 的读写都必须走这里。
 *
 * 关键实现细节 —— 为什么是 set_config 而不是 SET LOCAL：
 *   `SET LOCAL app.current_tenant = $1` 是非法 SQL，SET 语句不接受绑定参数。
 *   set_config(name, value, is_local) 的第三个参数 true 等价于 SET LOCAL，
 *   且可以安全地传参，不需要字符串拼接（否则就是 SQL 注入面）。
 *
 * 为什么必须在事务里：
 *   is_local=true 的设置在事务结束时自动回滚。若用 SET（非 LOCAL），
 *   租户会粘在连接上，连接归还池子后被下一个请求复用 → 跨租户泄露。
 */
export async function tenantTx<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * 无租户上下文的事务：只用于 users / tenants 这类租户外的表
 * （注册、登录、按 share_slug 反查 expert 归属哪个租户）。
 * 受 RLS 保护的表在这里查会返回 0 行 —— 这是刻意的 fail-closed。
 */
export async function systemTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}
