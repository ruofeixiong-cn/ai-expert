/**
 * SSE 客户端。
 *
 * ⚠️ 不能用 `EventSource`：它只支持 GET，也不支持自定义 header。
 *    对话接口是 POST，所以必须 fetch + ReadableStream 手动分帧。
 */

export type SseEvent =
  | { event: "meta"; data: { message_id: string; confidence: number; chunk_ids: string[] } }
  | { event: "delta"; data: { text: string } }
  | { event: "done"; data: { finish_reason: string; safety: string } }
  | { event: "error"; data: { code: number; message: string } };

function parseFrame(frame: string): SseEvent | null {
  let event = "";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  if (!event || !data) return null;
  try {
    return { event, data: JSON.parse(data) } as SseEvent;
  } catch {
    return null; // 半截 JSON 忽略，别让一帧毁掉整条流
  }
}

export async function* streamChat(
  slug: string,
  question: string,
  signal: AbortSignal,
): AsyncGenerator<SseEvent> {
  const res = await fetch(`/api/chat/${encodeURIComponent(slug)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
    credentials: "include", // 带上匿名身份 Cookie
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    yield {
      event: "error",
      data: { code: body?.code ?? 5000, message: body?.message ?? "连接失败，请重试" },
    };
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? ""; // 最后一段可能不完整，留着等下一块
    for (const f of frames) {
      const ev = parseFrame(f);
      if (ev) yield ev;
    }
  }
  // ⚠️ 末尾没有空行的最后一帧。done 事件正好可能在这里 ——
  //    漏掉的话表现成"回答显示正常但状态永远停在生成中"。
  if (buf.trim()) {
    const ev = parseFrame(buf);
    if (ev) yield ev;
  }
}
