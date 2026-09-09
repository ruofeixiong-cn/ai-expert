import createClient from "openapi-fetch";
// ⚠️ 唯一允许引入后端类型的地方，且只能从生成的契约引入。
// 手写接口类型 = 契约失效：后端改字段名时前端不会报错，等到联调才发现。
import type { paths, components } from "../../../contracts/public/api.d.ts";
import { getAccessToken, refreshAccessToken } from "../lib/auth";

/** 认证接口自己管 Cookie，不该被 401 重试逻辑掺和。 */
const isAuthEndpoint = (url: string) => url.includes("/api/auth/");

/**
 * 带认证的 fetch：挂 Bearer token；遇到 401 先刷新再重试一次。
 *
 * 放在 fetch 层而不是每个调用点，是为了让"token 过期"对业务代码完全透明 ——
 * 页面代码不需要知道 token 什么时候过期，也就不会漏处理。
 */
const authFetch: typeof fetch = async (input, init) => {
  // ⚠️ openapi-fetch 传进来的是一个【Request 对象】，init 是 undefined。
  //    第一版写成了 `fetch(input, { ...init, headers: {...} })`，
  //    结果 {...init} 展开成空对象，把 Request 自带的
  //    content-type: application/json 整个替换掉了 ——
  //    后端收不到 JSON body，所有字段都是 undefined，
  //    表现为"注册时提示 password 必填"，而密码明明填了。
  //
  //    正确做法：从 Request 出发，在它已有的 headers 上【追加】。
  const base = new Request(input as RequestInfo, init);

  const attempt = async (token: string | null) => {
    const req = base.clone(); // body 只能读一次，重试前必须先克隆
    const headers = new Headers(req.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(new Request(req, { headers, credentials: "include" }));
  };

  let res = await attempt(getAccessToken());

  if (res.status === 401 && !isAuthEndpoint(base.url)) {
    // refreshAccessToken 内部会合并并发刷新，这里不必自己去重
    const token = await refreshAccessToken();
    if (token) res = await attempt(token);
  }
  return res;
};

export const api = createClient<paths>({ baseUrl: "", fetch: authFetch });

/**
 * 从生成的契约里取某个接口的请求体类型。
 *
 * 页面代码用它来标注表单产出的对象 —— 后端改了字段名或必填项，
 * 这里会在 tsc 阶段炸，而不是等到用户点提交才发现 400。
 */
export type ReqBody<P extends keyof paths> = paths[P] extends {
  post: { requestBody: { content: { "application/json": infer B } } };
}
  ? B
  : never;

/** 契约里定义的数据结构。页面代码用它标注状态，后端改结构时编译期就会炸。 */
export type Schema<K extends keyof components["schemas"]> = components["schemas"][K];

/** 后端统一响应体 {code, message, data}；错误码表见 contracts/README.md。 */
export type ApiError = { code: number; message: string; data: null };

export function errorMessage(error: unknown, fallback = "操作失败，请稍后重试") {
  if (error && typeof error === "object" && "message" in error) {
    const m = (error as ApiError).message;
    if (typeof m === "string" && m) return m;
  }
  return fallback;
}
