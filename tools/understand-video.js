/**
 * 视频理解工具入口。
 *
 * 输入两种形态都吃：
 *   - ResourceRef（拖进对话的附件、挂载文件、本地路径）
 *   - 裸字符串路径（图省事）
 *
 * 输出一段带时间戳的摘要，完整时间轴可以另存，之后追问细节时再取。
 */

import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, extname } from "node:path";
import { createMediaTools } from "../lib/media.js";
import { planFrames, extractAt, adaptiveExtract } from "../lib/frames.js";
import { audioTranscript, transcriptCore } from "../lib/audio.js";
import { describeVideo, mergeTracks, condenseSegments, fmtTs } from "../lib/timeline.js";

export const name = "understand_video";
export const description =
  "看懂一个视频：按画面变化自适应抽帧，转录音轨，用视觉模型产出带时间戳的描述。"
  + "适合「这个视频讲了什么」「第几秒发生了什么」这类问题。"
  + "视频可以是对话里的附件，也可以是本地路径。";

export const parameters = {
  type: "object",
  properties: {
    video: {
      description:
        "视频来源。对话附件传 {kind:'session-file', fileId}，"
        + "本地文件传 {kind:'local-file', path}，也可以直接传路径字符串。",
      anyOf: [
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["session-file"] },
            fileId: { type: "string" }
          },
          required: ["kind", "fileId"]
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["local-file"] },
            path: { type: "string" }
          },
          required: ["kind", "path"]
        },
        { type: "string" }
      ]
    },
    detail: {
      type: "string",
      enum: ["summary", "timeline"],
      default: "summary",
      description: "summary 只给压缩摘要；timeline 连完整分段一起返回"
    },
    includeAudio: {
      type: "boolean",
      default: true,
      description: "是否转录音轨，默认开"
    },
    maxFrames: {
      type: "integer",
      description: "最多抽几帧，0 或省略表示自适应"
    }
  },
  required: ["video"]
};

function pickFetch(ctx) {
  return ctx?.network?.fetch?.bind(ctx.network) || globalThis.fetch;
}

/**
 * 配置来源三合一：host 注入的 ctx.config 优先，其次插件自己的 dataDir/config.json。
 * dev 槽里的插件有时候拿不到 host 注入值，留这一条不会误事。
 */
async function loadConfig(ctx) {
  const cfg = { ...(ctx?.config || {}) };
  const missing = !cfg.visionApiKey || (cfg.asrMode !== "off" && !cfg.asrApiKey);
  if (missing && ctx?.dataDir) {
    try {
      const extra = JSON.parse(await readFile(join(ctx.dataDir, "config.json"), "utf8"));
      for (const [k, v] of Object.entries(extra)) {
        if (cfg[k] == null || cfg[k] === "") cfg[k] = v;
      }
    } catch {
      // 没有外部配置就按默认值走
    }
  }
  return cfg;
}

/** 把各种输入形态统一成 ResourceRef。 */
function toRef(video) {
  if (typeof video === "string" && video.trim()) {
    return { kind: "local-file", path: video.trim() };
  }
  if (video && typeof video === "object" && typeof video.kind === "string") {
    return video;
  }
  return null;
}

/** materialize 的返回形态在不同版本可能是字符串或对象，这里都接住。 */
async function materialize(ctx, ref) {
  if (!ctx?.resources?.materialize) {
    if (ref.kind === "local-file") return ref.path;
    throw new Error("当前宿主不支持资源 materialize，请直接传本地路径。");
  }
  const out = await ctx.resources.materialize(ref);
  if (typeof out === "string") return out;
  // 宿主实际返回 { resourceKey, resource, filePath, version }，filePath 是那份本地副本
  const candidates = [out?.filePath, out?.path, out?.localPath, out?.resource?.filePath, out?.resource?.path];
  for (const p of candidates) {
    if (typeof p === "string" && p) return p;
  }
  throw new Error(`materialize 返回了无法识别的结果：${JSON.stringify(out).slice(0, 400)}`);
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export async function execute(input, ctx) {
  const cfg = await loadConfig(ctx);
  const log = ctx?.log;
  const startedAt = Date.now();

  const ref = toRef(input?.video);
  if (!ref) return "需要指定视频：传会话附件或本地路径。";

  const ffmpeg = cfg.ffmpegPath?.trim() || "ffmpeg";
  const ffprobe = cfg.ffprobePath?.trim() || "ffprobe";
  const media = createMediaTools({ ffmpeg, ffprobe, log });

  const apiUrl = cfg.visionApiUrl?.trim() || "https://api.deepseek.com/chat/completions";
  const apiKey = cfg.visionApiKey?.trim() || "";
  const model = cfg.visionModel?.trim() || "deepseek-flash";
  if (!apiKey) return "还没配置视觉模型 API Key。插件设置里填 visionApiKey 就能用。";

  let workDir = null;
  try {
    const videoPath = await materialize(ctx, ref);
    const st = await stat(videoPath).catch(() => null);
    if (!st || !st.isFile()) return `找不到视频文件：${videoPath}`;
    if (st.size < 1024) return `文件太小，不像是视频：${videoPath}`;

    workDir = await mkdtemp(join(tmpdir(), "hana-video-"));
    const framesDir = join(workDir, "frames");
    const audioDir = join(workDir, "audio");

    // 1) 规划：先判定有没有画面
    const plan = await planFrames(media, videoPath, {
      minFrames: Number(cfg.minFrames) || 0,
      maxFrames: Number(input?.maxFrames) || Number(cfg.maxFrames) || 0,
      maxHeight: Number(cfg.maxHeight) || 720,
    });

    // 2) 音频
    let audio = { skipped: true, reason: "disabled", segments: [], text: "" };
    const wantAudio = input?.includeAudio !== false && (cfg.asrMode || "api") !== "off";
    if (wantAudio) {
      audio = await audioTranscript(media, videoPath, audioDir, {
        mode: cfg.asrMode || "api",
        fetchImpl: pickFetch(ctx),
        url: cfg.asrApiUrl?.trim() || "https://api.siliconflow.cn/v1/audio/transcriptions",
        apiKey: cfg.asrApiKey?.trim() || "",
        model: cfg.asrModel?.trim() || "FunAudioLLM/SenseVoiceSmall",
        log,
      });
    }

    // 纯音频文件：没有画面，只出转录稿
    if (!plan.hasVideo) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (audio.skipped) {
        const why = audio.reason === "no_audio" ? "既没有画面也没有音轨"
          : audio.reason === "silent" ? "没有可识别的语音（可能全是音乐或静音）"
          : audio.reason === "no_key" ? "没配置转写 Key"
          : audio.reason === "asr_failed" ? "转写接口调用失败"
          : audio.reason === "disabled" ? "音频处理被关掉了"
          : `原因：${audio.reason}`;
        return `这个文件没有画面，${why}。`;
      }
      const lines = [
        `音频：${basename(videoPath)}`,
        `时长 ${fmtDuration(plan.duration)} · 语音 ${audio.segments.length} 段 · 耗时 ${elapsed}s`,
        "",
        input?.detail === "timeline" ? "【完整转录】" : "【转录】",
      ];
      if (input?.detail === "timeline") {
        for (const s of audio.segments) lines.push(`${fmtTs(s.start)} ${s.text}`);
      } else {
        lines.push(condenseSegments(audio.segments, null, 60, 8) || audio.text);
      }
      lines.push("", "时间点按句长比例估算，不是词级时间戳。");
      return lines.join("\n");
    }

    // 3) 抽帧
    if (!plan.times.length) return "没抽到有效帧，视频可能全是黑屏或解码失败。";

    const frames = await extractAt(media, videoPath, plan.times, framesDir, {
      maxHeight: Number(cfg.maxHeight) || 720,
    });
    if (!frames.length) return "抽帧全部失败，检查 ffmpeg 能不能正常解码这个文件。";

    // 3) 视觉理解
    const vision = await describeVideo(pickFetch(ctx), frames, {
      transcript: audio.text || "",
      apiUrl,
      apiKey,
      model,
      duration: plan.duration,
      log,
    });

    // 4) 合并声画
    const visualSegs = vision.segments || [];
    const summary = visualSegs.length
      ? mergeTracks(visualSegs, audio.segments || [])
      : (vision.summary || "");

    // 5) 落盘完整时间轴
    let savedPath = "";
    if (cfg.keepTimeline !== false && ctx?.dataDir) {
      try {
        const dir = join(ctx.dataDir, "timelines");
        await mkdir(dir, { recursive: true });
        const key = `${Date.now()}-${basename(videoPath, extname(videoPath))}`.replace(/[\\/:*?"<>|]/g, "_");
        savedPath = join(dir, `${key}.json`);
        await writeFile(savedPath, JSON.stringify({
          source: videoPath,
          duration: plan.duration,
          frames: frames.map((f) => ({ time: f.time })),
          visual: visualSegs,
          audio: audio.segments || [],
          summary,
          usage: vision.usage || {},
          createdAt: new Date().toISOString(),
        }, null, 2), "utf8");
      } catch (e) {
        log?.warn?.(`timeline save failed: ${e.message}`);
        savedPath = "";
      }
    }

    // 6) 组装输出
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const audioNote = audio.skipped
      ? (audio.reason === "no_audio" ? "无音轨"
        : audio.reason === "no_key" ? "音频未转录（缺 Key）"
        : audio.reason === "silent" ? "音轨几乎静音"
        : audio.reason === "asr_failed" ? "转写失败"
        : "音频未转录")
      : `语音 ${audio.blocks ? `${audio.blocks} 块 / ` : ""}${audio.segments.length} 句`;

    const lines = [
      `视频：${basename(videoPath)}`,
      `时长 ${fmtDuration(plan.duration)} · 抽了 ${frames.length} 帧 · ${audioNote} · 耗时 ${elapsed}s`,
      "",
      "【内容】",
      summary || "（模型没给出可用描述）",
    ];

    if (input?.detail === "timeline" && visualSegs.length) {
      lines.push("", "【完整时间轴】");
      for (const s of visualSegs) {
        lines.push(`${fmtTs(s.start)}-${fmtTs(s.end)} 画面：${s.text}`);
      }
      if (audio.segments?.length) {
        lines.push("", "【语音】");
        for (const s of audio.segments) {
          lines.push(`${fmtTs(s.start)}-${fmtTs(s.end)} ${s.text}`);
        }
      }
    }

    if (savedPath) {
      lines.push("", `完整时间轴已存：${savedPath}`);
    }

    const usage = vision.usage || {};
    if (usage.prompt_tokens || usage.completion_tokens) {
      lines.push(`视觉模型用量：输入 ${usage.prompt_tokens || 0} / 输出 ${usage.completion_tokens || 0} token`);
    }

    return lines.join("\n");
  } catch (e) {
    log?.error?.("understand_video failed:", e.message);
    return `视频理解失败：${e.message}`;
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
