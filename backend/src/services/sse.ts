/**
 * SSE 流的转发与嗅探。
 *
 * ⚠️ 不能用 `new Response(upstream.body)` 零拷贝透传。
 *    那样 Node 完全看不到流里的内容 —— 收不到 `event: done`，
 *    就无法结算额度、无法把回答落库。转发和嗅探必须同时做。
 */

export type DoneData = {
  finish_reason?: string;
  safety?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  latency_ms?: number;
  answer?: string;
};

export type MetaData = { message_id?: string; confidence?: number; chunk_ids?: string[] };

/**
 * 边转发边解析。
 *
 * delta 也要解析（B02）：粉丝看到一部分回答后关掉页面，要把他看到的那部分落库、
 * 并按已消费扣额度 —— 否则「看到九成再关页面」就能无限白嫖。
 * 每帧只有十来个字，一次 JSON.parse 的开销和一次模型调用相比可以忽略。
 */
export class SseSniffer {
  private buffer = "";
  meta: MetaData | null = null;
  done: DoneData | null = null;
  /** 已经转发给粉丝的增量文本 */
  partial = "";
  errored = false;

  feed(text: string) {
    this.buffer += text;
    // SSE 以空行分帧。最后一段可能不完整，留在 buffer 里等下一次。
    const frames = this.buffer.split("\n\n");
    this.buffer = frames.pop() ?? "";
    for (const frame of frames) this.parse(frame);
  }

  /** 流结束时把 buffer 里最后一帧也处理掉 —— 否则末尾没有空行的 done 会丢。 */
  flush() {
    if (this.buffer.trim()) this.parse(this.buffer);
    this.buffer = "";
  }

  private parse(frame: string) {
    let event = "";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!event || !data) return;
    try {
      if (event === "meta") this.meta = JSON.parse(data) as MetaData;
      else if (event === "delta") this.partial += (JSON.parse(data) as { text?: string }).text ?? "";
      else if (event === "done") this.done = JSON.parse(data) as DoneData;
      else if (event === "error") this.errored = true;
    } catch {
      /* 半截 JSON 直接忽略，不该让一帧解析失败影响转发 */
    }
  }
}

export const sseFrame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * 把上游流转发给客户端，同时嗅探，结束时调用 settle。
 *
 * `settle` 必须幂等：正常结束走 flush，客户端中途关页面走 abort，
 * 两条路径都可能触发，也可能都触发。
 */
export function teeStream(
  upstream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  settle: (s: SseSniffer) => Promise<void> | void,
): ReadableStream<Uint8Array> {
  const sniffer = new SseSniffer();
  let settled = false;
  const once = async () => {
    if (settled) return;
    settled = true;
    try {
      await settle(sniffer);
    } catch (err) {
      console.error("[sse] 结算失败", err);
    }
  };

  // 客户端中途断开时 flush 不一定触发，abort 兜底
  signal.addEventListener("abort", () => {
    sniffer.flush();
    void once();
  });

  const decoder = new TextDecoder();
  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk); // 先转发，不给首字延迟添堵
        sniffer.feed(decoder.decode(chunk, { stream: true }));
      },
      async flush() {
        sniffer.flush();
        await once();
      },
    }),
  );
}
