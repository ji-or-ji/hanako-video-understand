/**
 * 视频理解工具入口（v2 App）。
 *
 * 输入两种形态都吃：
 *   - ResourceRef（拖进对话的附件、挂载文件、本地路径）
 *   - 裸字符串路径（图省事）
 *
 * 输出一段带时间戳的摘要，完整时间轴可以另存，之后追问细节时再取。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { createMediaTools } from "../lib/media.js";
import { planFrames, extractAt } from "../lib/frames.js";
import { audioTranscript } from "../lib/audio.js";
import { describeVideo, mergeTracks, condenseSegments, fmtTs } from "../lib/timeline.js";

const DESCRIPTION =
  "看懂一个视频：按画面变化自适应抽帧，转录音轨，用视觉模型产出带时间戳的描述。"
  + "适合「这个视频讲了什么」「第几秒发生了什么」这类问题。"
  + "视频可以是对话里的附件，也可以是本地路径。";

const PARAMETERS = {
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
            fileId: { type: "string" },
          },
          required: ["kind", "fileId"],
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["local-file"] },
            path: { type: "string" },
          },
          required: ["kind", "path"],
        },
        { type: "string" },
      ],
    },
    detail: {
      type: "string",
      enum: ["summary", "timeline"],
      default: "summary",
      description: "summary 只给压缩摘要；timeline 连完整分段一起返回",
    },
    includeAudio: {
      type: "boolean",
      default: true,
      description: "是否转录音轨，默认开",
    },
    maxFrames: {
      type: "integer",
      description: "最多抽几帧，0 或省略表示自适应",
    },
  },
  required: ["video"],
};

function text(body) {
  return { content: [{ type: "text", text: body }] };
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
async function materialize(sdk, ref) {
  const out = await sdk.resources.materialize(ref);
  if (typeof out === "string") return out;
  const candidates = [
    out?.filePath,
    out?.path,
    out?.localPath,
    out?.resource?.filePath,
    out?.resource?.path,
    out?.content?.filePath,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  throw new Error(`materialize 返回了无法识别的结果：${JSON.stringify(out).slice(0, 300)}`);
}

async function refSize(sdk, ref) {
  try {
    const info = await sdk.resources.stat(ref);
    const size = Number(info?.size ?? info?.content?.size ?? NaN);
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

/** 设置里没填就用 PATH；宿主负责解析真实路径，App 不去扫文件系统。 */
async function resolveBinary(sdk, configured, name) {
  const explicit = typeof configured === "string" ? configured.trim() : "";
  if (explicit) return explicit;
  const found = await sdk.process.resolveExecutable({ candidates: [name] });
  if (!found?.path) {
    throw new Error(`找不到 ${name}：先装好并让它出现在 PATH 里，或者在设置里填绝对路径`);
  }
  return found.path;
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

async function runUnderstanding(sdk, input) {
  const cfg = (await sdk.config.getAll()) || {};
  const log = sdk.logger;
  const startedAt = Date.now();

  const ref = toRef(input?.video);
  if (!ref) return text("需要指定视频：传会话附件或本地路径。");

  const apiKey = String(cfg.visionApiKey || "").trim();
  if (!apiKey) return text("还没配置视觉模型 API Key。设置 → 扩展 → 视频理解里填 visionApiKey 就能用。");

  const ffmpeg = await resolveBinary(sdk, cfg.ffmpegPath, "ffmpeg");
  const ffprobe = await resolveBinary(sdk, cfg.ffprobePath, "ffprobe");
  const media = createMediaTools({ ffmpeg, ffprobe, log });

  const apiUrl = String(cfg.visionApiUrl || "").trim() || "https://api.deepseek.com/chat/completions";
  const model = String(cfg.visionModel || "").trim() || "deepseek-flash";

  let workDir = null;
  try {
    const videoPath = await materialize(sdk, ref);
    const size = await refSize(sdk, ref);
    if (size !== null && size < 1024) return text(`文件太小，不像是视频：${videoPath}`);

    await mkdir(join(sdk.dataDir, "tmp"), { recursive: true });
    workDir = await mkdtemp(join(sdk.dataDir, "tmp", "run-"));
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
        fetchImpl: sdk.network.fetch.bind(sdk.network),
        url: String(cfg.asrApiUrl || "").trim() || "https://api.siliconflow.cn/v1/audio/transcriptions",
        apiKey: String(cfg.asrApiKey || "").trim(),
        model: String(cfg.asrModel || "").trim() || "FunAudioLLM/SenseVoiceSmall",
        preset: String(cfg.asrPreset || "").trim() || "precision",
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
        return text(`这个文件没有画面，${why}。`);
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
      return text(lines.join("\n"));
    }

    // 3) 抽帧
    if (!plan.times.length) return text("没抽到有效帧，视频可能全是黑屏或解码失败。");

    const frames = await extractAt(media, videoPath, plan.times, framesDir, {
      maxHeight: Number(cfg.maxHeight) || 720,
    });
    if (!frames.length) return text("抽帧全部失败，检查 ffmpeg 能不能正常解码这个文件。");

    // 4) 视觉理解
    const vision = await describeVideo(sdk.network.fetch.bind(sdk.network), frames, {
      transcript: audio.text || "",
      apiUrl,
      apiKey,
      model,
      duration: plan.duration,
      log,
    });

    // 5) 合并声画
    const visualSegs = vision.segments || [];
    const summary = visualSegs.length
      ? mergeTracks(visualSegs, audio.segments || [])
      : (vision.summary || "");

    // 6) 落盘完整时间轴
    let savedPath = "";
    if (cfg.keepTimeline !== false) {
      try {
        const dir = join(sdk.dataDir, "timelines");
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
      } catch (err) {
        await log.warn(`timeline save failed: ${err?.message || err}`);
        savedPath = "";
      }
    }

    // 7) 组装输出
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
      for (const s of visualSegs) lines.push(`${fmtTs(s.start)}-${fmtTs(s.end)} 画面：${s.text}`);
      if (audio.segments?.length) {
        lines.push("", "【语音】");
        for (const s of audio.segments) lines.push(`${fmtTs(s.start)}-${fmtTs(s.end)} ${s.text}`);
      }
    }

    if (savedPath) lines.push("", `完整时间轴已存：${savedPath}`);

    const usage = vision.usage || {};
    if (usage.prompt_tokens || usage.completion_tokens) {
      lines.push(`视觉模型用量：输入 ${usage.prompt_tokens || 0} / 输出 ${usage.completion_tokens || 0} token`);
    }

    return text(lines.join("\n"));
  } catch (err) {
    await log.error(`understand_video failed: ${err?.message || err}`);
    return text(`视频理解失败：${err?.message || err}`);
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function register(sdk) {
  await sdk.tools.register({
    name: "understand_video",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    execute: (args) => runUnderstanding(sdk, args),
  });
}
