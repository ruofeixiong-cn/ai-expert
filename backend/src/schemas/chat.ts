import { z } from "@hono/zod-openapi";

/** 粉丝端。这是唯一面向【非博主】用户的接口面。 */

export const ChatExpertInfo = z
  .object({
    name: z.string(),
    creatorNickname: z.string().nullable(),
    /** 这个专家读过多少段内容 —— 给粉丝一点「他真的有料」的信号 */
    knowledgeSize: z.number().int(),
    priceCents: z.number().int(),
    /** 免登录试聊剩余条数。归零后提问返回 402。 */
    trialRemaining: z.number().int(),
  })
  .openapi("ChatExpertInfo");

export const ChatInput = z
  .object({
    question: z.string().min(1, "问题不能为空").max(1000, "问题最多 1000 字"),
  })
  .openapi("ChatInput");

/**
 * SSE 事件流。
 *
 * OpenAPI 描述不了流内部的结构，事件协议以 contracts/README.md 为准：
 *   event: meta   {"message_id","confidence","chunk_ids"}
 *   event: delta  {"text"}
 *   event: done   {"finish_reason","safety","prompt_tokens","completion_tokens"}
 *   event: error  {"code","message"}
 *
 * ⚠️ 前端不能用 EventSource：它不支持 POST，也不支持自定义 header。
 *    必须 fetch + ReadableStream 手动分帧。
 *
 * ⚠️ 试聊额度用完走 event: error + code 402，【不是断流】——
 *    断流的话前端分不清「网络挂了」和「要付费」。
 */
export const ChatStream = z
  .string()
  .openapi("ChatStream", { description: "SSE 事件流，协议见 contracts/README.md" });
