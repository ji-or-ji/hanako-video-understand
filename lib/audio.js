/**
 * 语音轨：抽轨 → 静音分析 → 按停顿分块 → 逐块转录。
 *
 * 为什么按静音切块而不是整条丢给 ASR：
 *   - 逐块才有时间戳，能跟画面轨对齐
 *   - 停顿合并能少调几次接口（实测 40 秒三段语音，3 次调用压到 1 次）
 *
 * 旧实现是全局去静音再转录，时间轴会错位，这里不用那条路。
 */

import { join } from "node:path";
import { readFile, mkdir } from "node:fs/promises";

const NOISE_DB = -30;
const MIN_SPEECH_RATIO = 0.02;
const MIN_CORE_CHARS = 4;
const MAX_AUDIO_SECONDS = 600;
const ASR_CONCURRENCY = 6;

/**
 * 切块预设。块越碎时间戳越准，但请求次数变多；块太碎还会让转写丢上下文。
 * 费用与块数无关（接口按时长计费），这里省的是调用次数和等待时间。
 */
export const AUDIO_PRESETS = {
  economy: { blockSeconds: 120, gapSeconds: 6.0, minSilence: 0.5 },
  balanced: { blockSeconds: 20, gapSeconds: 1.5, minSilence: 0.5 },
  precision: { blockSeconds: 20, gapSeconds: 0.8, minSilence: 0.3 },
};

/** 抽音轨为单声道 16k wav。 */
export async function extractAudio(media, video, outWav) {
  await mkdir(join(outWav, ".."), { recursive: true });
  await media.runText(media.FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", video, "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "pcm_s16le", outWav,
  ], { timeoutMs: 900000 });
  return outWav;
}

/** 返回 { silences: [{start,end}], duration }。 */
export async function detectSilence(media, wav, noiseDb = NOISE_DB, minDur = 0.3) {
  const { stderr } = await media.runCaptured(media.FFMPEG, [
    "-hide_banner", "-i", wav,
    "-af", `silencedetect=noise=${noiseDb}dB:d=${minDur}`,
    "-f", "null", "-",
  ], { timeoutMs: 900000 });

  const silences = [];
  let cur = null;
  for (const line of stderr.split(/\r?\n/)) {
    if (line.includes("silence_start:")) {
      const v = Number((line.split("silence_start:")[1] || "").trim().split(/\s+/)[0]);
      cur = Number.isFinite(v) ? v : null;
    } else if (line.includes("silence_end:") && cur != null) {
      const v = Number((line.split("silence_end:")[1] || "").trim().split(/\s+/)[0]);
      if (Number.isFinite(v)) silences.push({ start: cur, end: v });
      cur = null;
    }
  }
  const duration = await media.probeDuration(wav);
  return { silences, duration };
}

/** 由静音区间反推语音区间。 */
export function speechSpans(silences, total, minGap = 0.05) {
  const spans = [];
  let cursor = 0;
  for (const s of silences || []) {
    if (s.start > cursor + minGap) spans.push([cursor, Math.min(s.start, total)]);
    cursor = Math.max(cursor, s.end);
  }
  if (total > cursor + minGap) spans.push([cursor, total]);
  return spans.filter(([a, b]) => b > a);
}

/** 把碎语音区间合并成块，减少 ASR 调用次数。 */
export function mergeSpans(spans, maxLen = BLOCK_SECONDS, gap = GAP_SECONDS) {
  const out = [];
  for (const [s, e] of spans || []) {
    const last = out[out.length - 1];
    if (last && e - last[0] <= maxLen && s - last[1] <= gap) {
      last[1] = Math.max(last[1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

/** 切出 [start, end] 的音频片段。 */
export async function cutAudio(media, wav, outWav, start, end) {
  await mkdir(join(outWav, ".."), { recursive: true });
  await media.runText(media.FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", Math.max(0, start).toFixed(3),
    "-to", Math.max(0, end).toFixed(3),
    "-i", wav, "-ac", "1", "-ar", "16000",
    "-c:a", "pcm_s16le", outWav,
  ], { timeoutMs: 300000 });
  return outWav;
}

/** 转录单个音频块，multipart 上传。 */
export async function transcribeBlock(fetchImpl, wavPath, { url, apiKey, model, timeoutMs = 240000 }) {
  const buf = await readFile(wavPath);
  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([buf], { type: "audio/wav" }), "a.wav");

  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ASR HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return String(data?.text || "");
}

/** 去掉音乐符号、标点、空白后的实质字符。 */
export function transcriptCore(text) {
  if (!text) return "";
  return (String(text).match(/[\u4e00-\u9fffA-Za-z0-9]/g) || []).join("");
}

/**
 * 把一段转录按句末标点切开，再按字数比例把时间分下去。
 *
 * 为什么只能估：SiliconFlow 的转写接口只返回整段文本，不给词级时间戳。
 * 所以块内的时间点是根据字数反推的，语速均匀时误差小，语速忽快忽慢就会偏。
 * 这是目前能做到的最细粒度，要在输出里说清楚是估算。
 */
export function splitIntoSegments(text, start, end) {
  const s = String(text || "").trim();
  if (!s) return [];
  const parts = s.split(/(?<=[。！？!?；;…])/).map((x) => x.trim()).filter(Boolean);
  if (parts.length <= 1) return [{ start, end, text: s }];

  const weights = parts.map((x) => Math.max(1, x.replace(/\s/g, "").length));
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(0.1, end - start);
  const out = [];
  let cursor = start;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const share = (span * weights[i]) / total;
    const segEnd = isLast ? end : Math.min(end, cursor + Math.max(0.4, share));
    out.push({ start: cursor, end: segEnd, text: parts[i] });
    cursor = segEnd;
  }
  return out;
}

/**
 * 完整音频链路。返回 { skipped, reason, segments, text, speechRatio, duration }。
 */
export async function audioTranscript(media, video, outDir, opts = {}) {
  const {
    mode = "api",
    fetchImpl = globalThis.fetch,
    url,
    apiKey,
    model,
    maxAudioSeconds = MAX_AUDIO_SECONDS,
    log,
  } = opts;

  // 预设打底，显式传的单个参数优先
  const preset = AUDIO_PRESETS[opts.preset] || AUDIO_PRESETS.precision;
  const blockSeconds = opts.blockSeconds ?? preset.blockSeconds;
  const gapSeconds = opts.gapSeconds ?? preset.gapSeconds;
  const minSilence = opts.minSilence ?? preset.minSilence;
  if (mode === "off") {
    return { skipped: true, reason: "disabled", segments: [], text: "" };
  }

  const info = await media.probeAudio(video);
  if (!info.hasAudio) {
    return { skipped: true, reason: "no_audio", segments: [], text: "" };
  }

  await mkdir(outDir, { recursive: true });
  const wav = await extractAudio(media, video, join(outDir, "audio.wav"));
  const { silences, duration } = await detectSilence(media, wav, NOISE_DB, minSilence);

  const silentTotal = silences.reduce((a, s) => a + Math.max(0, s.end - s.start), 0);
  const speechRatio = duration > 0 ? Math.max(0, 1 - Math.min(1, silentTotal / duration)) : 0;
  log?.info?.(`audio: duration=${duration.toFixed(1)}s speech=${(speechRatio * 100).toFixed(0)}%`);

  if (speechRatio < MIN_SPEECH_RATIO) {
    return { skipped: true, reason: "silent", segments: [], text: "", speechRatio, duration };
  }

  let blocks = mergeSpans(speechSpans(silences, duration), blockSeconds, gapSeconds);
  if (maxAudioSeconds > 0) {
    blocks = blocks
      .filter(([a]) => a < maxAudioSeconds)
      .map(([a, b]) => [a, Math.min(b, maxAudioSeconds)]);
  }
  if (!blocks.length) blocks = [[0, Math.min(duration, maxAudioSeconds || duration)]];

  if (!apiKey) {
    return { skipped: true, reason: "no_key", segments: [], text: "", speechRatio, duration };
  }

  const segments = [];
  const failed = [];

  // 分块并发转录。接口按时长计费、不按次数，所以并发不增加成本，
  // 只把串行的等待叠起来。并发数保守取 6，远低于接口的 QPS 限制。
  const collected = new Array(blocks.length).fill(null);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= blocks.length) return;
      const [a, b] = blocks[i];
      const segWav = join(outDir, `block${i}.wav`);
      try {
        await cutAudio(media, wav, segWav, a, b);
        const text = await transcribeBlock(fetchImpl, segWav, {
          url, apiKey, model,
          timeoutMs: 240000,
        });
        collected[i] = { start: a, end: b, text };
        log?.info?.(`asr block ${i + 1}/${blocks.length} ${text.length} chars`);
      } catch (e) {
        failed.push({ index: i, error: e.message });
        log?.warn?.(`asr block ${i} failed: ${e.message}`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(ASR_CONCURRENCY, blocks.length) }, () => worker())
  );

  for (const item of collected) {
    if (!item) continue;
    if (transcriptCore(item.text)) {
      segments.push(...splitIntoSegments(item.text, item.start, item.end));
    }
  }

  if (!segments.length) {
    return {
      skipped: true,
      reason: failed.length ? "asr_failed" : "no_speech_content",
      tried: failed,
      segments: [],
      text: "",
      speechRatio,
      duration,
    };
  }

  const text = segments.map((s) => s.text).join(" ").trim();
  if (transcriptCore(text).length < MIN_CORE_CHARS) {
    return { skipped: true, reason: "no_speech_content", segments, text, speechRatio, duration };
  }

  return {
    skipped: false,
    segments,
    text,
    speechRatio,
    duration,
    blocks: blocks.length,
    failed: failed.length ? failed : undefined,
  };
}
