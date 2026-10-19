/**
 * 时间轴：提示词、JSON 解析、分段规整、压缩、声画合并。
 *
 * 两个关键取舍，都是从原项目继承的：
 *   1. 摘要固定上限（默认 6 行），10 秒和 10 分钟的视频注入成本一样
 *   2. 声画共用同一份预算，不是各占一份；黑屏但有说话的片子不会丢内容
 */

import { readFile } from "node:fs/promises";

/** 秒 → mm:ss（超过一小时用 h:mm:ss）。 */
export function fmtTs(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
           : `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function buildVisionPrompt(transcript = "", maxChars = 8000) {
  if (transcript) {
    return "这是从一段视频中按时间顺序抽取的关键帧。视频里的语音转录如下：\n"
      + transcript.slice(0, maxChars)
      + "\n\n请综合画面和语音，用一段话概括这段视频的内容，200 字以内。"
      + "以画面为主要依据，只写能从画面和语音中确认的内容，不要推测，也不要解释判断过程。";
  }
  return "这是从一段视频中按时间顺序抽取的关键帧。"
    + "请用一段话概括这段视频的内容，200 字以内。"
    + "只写能从画面中确认的内容，不要推测。";
}

export function buildTimelinePrompt(frameTimes, transcript = "", maxChars = 8000) {
  const n = frameTimes.length;
  const tail = n ? fmtTs(frameTimes[n - 1]) : "00:00";
  let head = `这是从一段视频中按时间顺序抽取的 ${n} 个关键帧，`
    + `每张图前面的方括号是它出现的时间点，视频约 ${tail}。\n`;
  if (transcript) head += "视频里的语音转录：\n" + transcript.slice(0, maxChars) + "\n";
  head += "\n请按时间顺序分段描述画面内容。只输出 JSON，格式：\n"
    + '{"segments":[{"start":起始秒数,"end":结束秒数,"text":"描述"}]}\n'
    + "规则：每段 80 字以内，描述文字里不要写时间标记；"
    + "start/end 为秒数，按时间递增、首尾相接、不重叠；"
    + "相邻画面相同就并成一段，不要逐帧罗列；"
    + "以画面为主要依据，只写能确认的内容，不推测，不解释判断过程。";
  return head;
}

/** 从模型输出里抠出第一个完整 JSON 对象。 */
export function extractJson(text) {
  let s = String(text || "").trim();
  if (!s) return null;
  if (s.startsWith("```")) {
    s = s.replace(/`/g, "").trim();
    const i = s.indexOf("{");
    if (i >= 0) s = s.slice(i);
  }
  const cands = [s];
  if (s.includes("{") && s.includes("}")) {
    cands.push(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
  }
  for (const c of cands) {
    try {
      return JSON.parse(c);
    } catch {
      // 试下一个候选
    }
  }
  return null;
}

/** 校验并规整分段：转秒数、排序、去重叠、丢空段。 */
export function cleanSegments(items, duration = null) {
  const out = [];
  for (const it of items || []) {
    if (!it || typeof it !== "object") continue;
    let txt = String(it.text || it.desc || "").trim();
    txt = txt.replace(/^\s*[[【]\d{1,2}:\d{2}(?::\d{2})?[\]】]\s*/, "").trim();
    if (!txt) continue;
    let a = Number(it.start ?? 0);
    let b = Number(it.end ?? a);
    if (!Number.isFinite(a)) continue;
    if (!Number.isFinite(b)) b = a;
    if (b <= a) b = a + 0.1;
    out.push({ start: Math.max(0, a), end: b, text: txt });
  }
  out.sort((x, y) => x.start - y.start);
  const fixed = [];
  for (const seg of out) {
    const last = fixed[fixed.length - 1];
    if (last && seg.start < last.end) {
      seg.start = last.end;
      if (seg.end <= seg.start) continue;
    }
    fixed.push(seg);
  }
  if (duration) {
    for (const seg of fixed) seg.end = Math.min(seg.end, Number(duration));
  }
  return fixed.filter((s) => s.end > s.start);
}

/** 把详细时间轴压成粗粒度摘要（注入上下文用）。 */
export function condenseSegments(segments, granularity = null, segChars = 40, targetLines = 6) {
  if (!segments || !segments.length) return "";
  if (segments.length <= targetLines) {
    return segments
      .map((s) => `${fmtTs(s.start || 0)} ${String(s.text || "").slice(0, segChars)}`)
      .join("\n");
  }
  let g = granularity;
  if (!g || g <= 0) {
    const span = Number(segments[segments.length - 1].end || 0) - Number(segments[0].start || 0);
    g = Math.max(8, span / Math.max(1, targetLines));
  }
  const lines = [];
  let bucket = null;
  let buf = [];

  const flush = () => {
    if (!buf.length) return;
    let text = buf.join(" ");
    if (text.length > segChars) text = text.slice(0, segChars - 1) + "…";
    lines.push(`${fmtTs(bucket)} ${text}`);
  };

  for (const seg of segments) {
    const st = Number(seg.start || 0);
    if (bucket == null || st - bucket >= g) {
      flush();
      bucket = st;
      buf = [];
    }
    buf.push(String(seg.text || "").trim());
  }
  flush();
  return lines.join("\n");
}

/** 把视觉与音频两条轨道合成一条摘要，共用同一份行数预算。 */
export function mergeTracks(visual, audio, targetLines = 6, segChars = 40) {
  const items = [];
  for (const s of visual || []) {
    items.push({ start: Number(s.start || 0), end: Number(s.end || 0), kind: "画面", text: String(s.text || "").trim() });
  }
  for (const s of audio || []) {
    items.push({ start: Number(s.start || 0), end: Number(s.end || 0), kind: "语音", text: String(s.text || "").trim() });
  }
  const kept = items.filter((x) => x.text);
  if (!kept.length) return "";
  kept.sort((a, b) => a.start - b.start);

  let buckets;
  if (kept.length <= targetLines) {
    buckets = kept.map((x) => [x]);
  } else {
    const span = Math.max(1e-6, kept[kept.length - 1].end - kept[0].start);
    const step = span / targetLines;
    buckets = Array.from({ length: targetLines }, () => []);
    for (const x of kept) {
      const i = Math.min(targetLines - 1, Math.floor((x.start - kept[0].start) / step));
      buckets[i].push(x);
    }
  }

  const lines = [];
  for (const bucket of buckets) {
    if (!bucket.length) continue;
    const vis = bucket.filter((x) => x.kind === "画面");
    const aud = bucket.filter((x) => x.kind === "语音");
    let parts;
    if (vis.length && aud.length) {
      const half = Math.max(8, Math.floor(segChars / 2));
      parts = [`画面：${vis[0].text.slice(0, half)}`, `语音：${aud[0].text.slice(0, half)}`];
    } else if (vis.length) {
      parts = [`画面：${vis[0].text.slice(0, segChars)}`];
    } else {
      parts = [`语音：${aud[0].text.slice(0, segChars)}`];
    }
    lines.push(`${fmtTs(bucket[0].start)} ${parts.join(" / ")}`);
  }
  return lines.join("\n");
}

/** 解析模型输出为 { segments, summary, raw }。 */
export function parseTimeline(text, duration = null, targetLines = 6) {
  const raw = String(text || "").trim();
  const obj = extractJson(raw);
  const segs = cleanSegments(obj && typeof obj === "object" ? obj.segments : null, duration);
  const summary = segs.length ? condenseSegments(segs, null, 40, targetLines) : raw;
  return { segments: segs, summary, raw };
}

/**
 * 把关键帧交给视觉模型。
 * frames: [{ path, time }]，给了 time 就走时间轴模式。
 */
export async function describeVideo(fetchImpl, frames, {
  transcript = "",
  apiUrl,
  apiKey,
  model,
  duration = null,
  timeoutMs = 240000,
  maxChars = 8000,
  targetLines = 6,
  log,
} = {}) {
  const frameTimes = frames.map((f) => f.time);
  const useTimeline = frameTimes.length > 0;
  const prompt = useTimeline
    ? buildTimelinePrompt(frameTimes, transcript, maxChars)
    : buildVisionPrompt(transcript, maxChars);

  const content = [{ type: "text", text: prompt }];
  for (let i = 0; i < frames.length; i++) {
    if (useTimeline) content.push({ type: "text", text: `[${fmtTs(frameTimes[i])}]` });
    const b64 = await readFile(frames[i].path, "base64");
    content.push({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64," + b64 },
    });
  }

  const maxTokens = useTimeline
    ? Math.min(4000, Math.max(800, 140 * frames.length))
    : 600;

  const payload = {
    model,
    messages: [{ role: "user", content }],
    max_tokens: maxTokens,
    // DeepSeek 的推理默认开着，会把 max_tokens 全烧在思考上，content 空着回来。
    // 视觉理解不需要推理链，显式关掉。
    thinking: { type: "disabled" },
  };
  if (useTimeline) payload.response_format = { type: "json_object" };

  log?.info?.(`vision: ${frames.length} frames, max_tokens=${maxTokens}`);
  const res = await fetchImpl(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`视觉接口 HTTP ${res.status}: ${bodyText.slice(0, 300)}`);

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(`视觉接口返回的不是 JSON：${bodyText.slice(0, 200)}`);
  }
  const text = String(body?.choices?.[0]?.message?.content || "");
  const usage = body?.usage || {};
  log?.info?.(`vision usage: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}`);

  if (useTimeline) {
    const out = parseTimeline(text, duration, targetLines);
    return { ...out, usage };
  }
  const stripped = text.trim();
  return { segments: [], summary: stripped, raw: text, usage };
}
