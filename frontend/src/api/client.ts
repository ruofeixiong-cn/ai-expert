import createClient from "openapi-fetch";
// ⚠️ 这是【唯一】允许引入后端类型的地方，且只能从生成的契约引入。
// 手写接口类型 = 契约失效。类型不匹配会在 tsc 阶段炸，而不是联调时。
import type { paths } from "../../../contracts/public/api.d.ts";

export const api = createClient<paths>({ baseUrl: "" });
