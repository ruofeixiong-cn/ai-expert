// 由 `make contract` 从 contracts/public/openapi.json 生成 —— 禁止手写。
//
// 这里只有【运行期约束】（长度、范围、枚举、必填）。类型仍然从 api.d.ts 取，
// 不要从这里 z.infer —— 一份契约两个类型来源，迟早对不上。
//
// 表达不进 JSON Schema 的条件约束（比如 ExampleItem 按 origin 分叉的证据规则）
// 不在这里，由服务端兜底，前端要写就近的显式判断（见 ADR-003 / ADR-007）。

import { z } from "zod";

export const Blindspot = z.object({
  messageId: z.string().uuid(),
  question: z.string(),
  confidence: z.number().nullable(),
  reason: z.enum(["no_context", "low_confidence"]),
  createdAt: z.string(),
});

/** 冒充风险 / 专业建议风险 / 立场越界 —— 产品文档 §7.2 的三层边界 */
export const BoundaryKind = z.enum(["impersonation", "professional_advice", "out_of_scope"]);

export const BuildResult = z.object({
  jobId: z.string().uuid(),
});

/** 构建阶段。extracting = 正在提炼七维专家模型。 */
export const BuildStage = z.enum(["queued", "parsing", "chunking", "embedding", "extracting", "done"]).nullable();

export const ChatInput = z.object({
  question: z.string().min(1).max(1000),
});

export const ChatMessage = z.object({
  id: z.string().uuid(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  myRating: z.enum(["up", "down"]).nullable(),
});

/** SSE 事件流，协议见 contracts/README.md */
export const ChatStream = z.string();

export const CreateExpertInput = z.object({
  name: z.string().min(1).max(40),
});

export const CreateMaterialInput = z.union([z.object({
  sourceType: z.literal("paste"),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(100000),
}), z.object({
  sourceType: z.literal("file"),
  title: z.string().min(1).max(200),
  filename: z.string().min(1).max(255),
  contentBase64: z.string().min(1).max(27962028),
}), z.object({
  sourceType: z.literal("url"),
  url: z.string().url(),
})]);

export const Dimension = z.enum(["persona", "knowledge", "beliefs", "methodology", "decisionRules", "boundaries", "examples"]);

export const ErrorBody = z.object({
  code: z.number(),
  message: z.string(),
  data: z.null(),
});

export const ExpertStatus = z.enum(["building", "online", "offline"]);

export const HealthData = z.object({
  service: z.string(),
  status: z.literal("ok"),
});

/** ai = AI 提炼；creator = 博主手写或改写过。缺省视为 ai。 */
export const ItemOrigin = z.enum(["ai", "creator"]).default("ai");

export const LoginInput = z.object({
  account: z.string().min(1),
  password: z.string().min(1),
});

export const PublishResult = z.object({
  shareSlug: z.string(),
  shareUrl: z.string(),
  publishedAt: z.string().datetime(),
});

export const Rating = z.enum(["up", "down"]);

export const ReadyData = z.object({
  database: z.enum(["ok", "down"]),
  agent: z.enum(["ok", "down"]),
});

export const RefreshResult = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int(),
});

export const RegisterInput = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(6).max(20).optional(),
  password: z.string().min(8).max(72),
  nickname: z.string().min(1).max(40).optional(),
});

export const RevokeResult = z.object({
  revoked: z.number().int(),
});

export const SessionInfo = z.object({
  id: z.string().uuid(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  current: z.boolean(),
  lastUsedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

/** paste=粘贴正文（最可靠）；file=上传文件；url=粘贴链接（只承诺公众号） */
export const SourceType = z.enum(["paste", "file", "url"]);

export const TenantPublic = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

export const UserPublic = z.object({
  id: z.string().uuid(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  nickname: z.string().nullable(),
  role: z.enum(["creator", "user"]),
});

export const AuthResult = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int(),
  user: UserPublic,
  tenant: TenantPublic,
});

export const BoundaryItem = z.object({
  content: z.string().min(1),
  kind: BoundaryKind,
});

export const BuildProgress = z.object({
  jobId: z.string().uuid(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  progress: z.number().int().min(0).max(100),
  stage: BuildStage,
  error: z.string().nullable(),
  updatedAt: z.string().datetime(),
}).nullable();

export const ChatExpertInfo = z.object({
  name: z.string(),
  creatorNickname: z.string().nullable(),
  knowledgeSize: z.number().int(),
  priceCents: z.number().int(),
  trialRemaining: z.number().int(),
  history: z.array(ChatMessage),
});

export const ExampleItem = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  evidenceChunkIds: z.array(z.string().uuid()),
  origin: ItemOrigin,
});

export const Expert = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: ExpertStatus,
  materialCount: z.number().int(),
  chunkCount: z.number().int(),
  createdAt: z.string().datetime(),
});

export const ExpertStats = z.object({
  answers: z.number().int(),
  satisfaction: z.number().nullable(),
  upVotes: z.number().int(),
  downVotes: z.number().int(),
  revenueCents: z.number().int(),
  blindspots: z.number().int(),
  recentBlindspots: z.array(Blindspot),
});

export const FeedbackInput = z.object({
  messageId: z.string().uuid(),
  rating: Rating,
  comment: z.string().max(200).optional(),
});

export const FeedbackResult = z.object({
  rating: Rating,
});

export const Material = z.object({
  id: z.string().uuid(),
  sourceType: SourceType,
  title: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  charCount: z.number().int(),
  contentHash: z.string(),
  chunkCount: z.number().int(),
  createdAt: z.string().datetime(),
});

export const MeResult = z.object({
  user: UserPublic,
  tenant: TenantPublic,
});

export const ModelItem = z.object({
  content: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidenceChunkIds: z.array(z.string().uuid()),
  origin: ItemOrigin,
});

export const ConfirmDimensionInput = z.object({
  items: z.array(z.union([ModelItem, BoundaryItem, ExampleItem])),
});

export const CreateMaterialResult = z.object({
  material: Material,
  deduplicated: z.boolean(),
});

export const ExpertDetail = Expert.and(z.object({
  lastBuild: BuildProgress,
  hasDraft: z.boolean(),
  confirmedDimensions: z.array(z.string()),
  shareSlug: z.string().nullable(),
  publishedAt: z.string().datetime().nullable(),
}));

export const ModelView = z.object({
  draft: z.object({
  persona: z.array(ModelItem),
  knowledge: z.array(ModelItem),
  beliefs: z.array(ModelItem),
  methodology: z.array(ModelItem),
  decisionRules: z.array(ModelItem),
  boundaries: z.array(BoundaryItem),
  examples: z.array(ExampleItem),
}).nullable(),
  generatedAt: z.string().datetime().nullable(),
  confirmed: z.object({
  persona: z.array(ModelItem),
  knowledge: z.array(ModelItem),
  beliefs: z.array(ModelItem),
  methodology: z.array(ModelItem),
  decisionRules: z.array(ModelItem),
  boundaries: z.array(BoundaryItem),
  examples: z.array(ExampleItem),
}).nullable(),
  confirmedDimensions: z.array(Dimension),
  chunkCount: z.number().int(),
  hasUnpublishedChanges: z.boolean(),
});
