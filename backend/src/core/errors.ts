import { HTTPException } from "hono/http-exception";

/**
 * 错误码表见 contracts/README.md。前端按 code 分支，不解析 message。
 * 新增错误码必须同步更新那张表 —— 否则前端不知道怎么处理。
 */
export const Code = {
  OK: 0,
  BAD_REQUEST: 1001,
  UNAUTHORIZED: 1401,
  FORBIDDEN: 1403,
  NOT_FOUND: 1404,
  CONFLICT: 1409,
  PAYMENT_REQUIRED: 402,
  RATE_LIMITED: 1429,
  PAYLOAD_TOO_LARGE: 1413,
  INTERNAL: 5000,
} as const;

export class AppError extends HTTPException {
  constructor(
    public readonly appCode: number,
    message: string,
    status = 400,
  ) {
    super(status as never, { message });
  }
}

export const badRequest = (m: string) => new AppError(Code.BAD_REQUEST, m, 400);
export const unauthorized = (m = "未登录或登录已失效") => new AppError(Code.UNAUTHORIZED, m, 401);
export const conflict = (m: string) => new AppError(Code.CONFLICT, m, 409);

/**
 * 资源不存在【或不属于当前租户】统一返回 404。
 *
 * 刻意不用 403：403 等于告诉攻击者"这个 id 存在，只是你没权限"。
 * 而且 RLS 让跨租户查询直接返回 0 行，天然就走到这里。
 */
export const notFound = (m = "资源不存在") => new AppError(Code.NOT_FOUND, m, 404);
