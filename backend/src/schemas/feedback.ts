import { z } from "@hono/zod-openapi";

/**
 * 反馈与最小看板 —— 见 MVP 产品文档 §10.3、§12、验收 #5 #6。
 *
 * 这是飞轮的第一格齿轮：粉丝的一次点踩，要变成博主看得见的
 * 一条"你这里没讲过"。
 */

export const Rating = z.enum(["up", "down"]).openapi("Rating");

export const FeedbackInput = z
  .object({
    messageId: z.string().uuid("messageId 不是合法的 uuid"),
    rating: Rating,
    /** 点踩时的可选原因。摩擦必须低 —— 不填也能提交。 */
    comment: z.string().max(200, "原因最多 200 字").optional(),
  })
  .openapi("FeedbackInput");

export const FeedbackResult = z
  .object({ rating: Rating })
  .openapi("FeedbackResult");

/**
 * 疑似盲区。
 *
 * `question` 是**问题原文**，不是回答 —— 博主要的是
 * "粉丝在问什么我没讲过"，那是他下一篇文章的选题。
 */
export const Blindspot = z
  .object({
    messageId: z.string().uuid(),
    question: z.string(),
    confidence: z.number().nullable(),
    /**
     * 为什么算盲区。两者对博主是同一件事（没讲过），排查时值得分开看：
     *   'no_context'     一条相关内容都没召回到
     *   'low_confidence' 擦着入口闸门过去了，但分数很低
     */
    reason: z.enum(["no_context", "low_confidence"]),
    createdAt: z.string(),
  })
  .openapi("Blindspot");

export const ExpertStats = z
  .object({
    answers: z.number().int(),
    /**
     * 赞 /(赞+踩)。**无人评价时是 null，不是 0** ——
     * "没人评价"和"所有人都说不好"是相反的两件事。
     */
    satisfaction: z.number().nullable(),
    upVotes: z.number().int(),
    downVotes: z.number().int(),
    /** M5 接入付费前恒为 0。不粉饰，前端明写。 */
    revenueCents: z.number().int(),
    blindspots: z.number().int(),
    recentBlindspots: z.array(Blindspot),
  })
  .openapi("ExpertStats");
