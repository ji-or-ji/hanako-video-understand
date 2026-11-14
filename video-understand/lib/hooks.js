/**
 * 用户这一轮粘了视频，就在模型开口之前把它看懂。
 *
 * 原生支持视频的模型不需要这一层。这里补的是「模型看不见画面」的缺口：
 * 附件在消息里只留下一行 [attached_video: 路径]，模型拿到的是路径不是内容，
 * 于是每次都得靠它自己想起来调 understand_video。改成在这里直接跑完，
 * 结果作为一条上下文递进去，模型一开口就已经知道视频里发生了什么。
 *
 * 关键一点：AppHost 读不到 session-files 下的绝对路径（ERR_ACCESS_DENIED），
 * 所以不能拿路径交给 ffmpeg。消息里那行 [SessionFile] {...} 带着 fileId，
 * 用 fileId 走 hosted materialize，宿主自己把文件摆到可读位置。
 *
 * 输入来源按可靠度排三条：
 * 1. session/input —— 用户提交那一刻的原始输入
 * 2. agent/before-start 的 prompt —— 实测这一层带着完整附件标记
 * 3. 会话文件里刚落库的 user 消息 —— 兜底（这条路常被沙箱挡住）
 *
 * 两个兜底：
 * - 同一份附件（fileId，或路径 + 大小 + mtime）只跑一次，结果落盘复用
 * - 任何异常都吞掉，注入是旁路能力，不能因为它让整轮对话起不来
 */
import { open, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { understandAsText } from "../tools/understand-video.js";

const VIDEO_TAG_RE = /\[attached_video:\s*([^\]\n]+)\]/g;
const SESSION_FILE_MARK = "[SessionFile]";
const CACHE_FILE = "auto-cache.json";
const STATE_FILE = "auto-state.json";
const TAIL_BYTES = 256 * 1024;
const MAX_VIDEOS_PER_TURN = 2;
const INPUT_FRESH_MS = 120 * 1000;

/** session/input 抓到的最近一次输入，before-start 紧跟其后触发，用时间窗判断是否同一轮。 */
const recentInput = { text: "", at: 0 };

/** 从 start 位置的 { 开始，按括号配平取出一个完整 JSON 对象文本。 */
function takeJsonObject(src, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 把一段消息文本拆成附件条目：fileId 与视频路径按出现顺序配对。
 * 配不齐也能用，缺哪个就用另一个。
 */
function extractAttachments(text) {
  const src = typeof text === "string" ? text : "";
  const ids = [];
  let at = src.indexOf(SESSION_FILE_MARK);
  while (at !== -1) {
    const brace = src.indexOf("{", at + SESSION_FILE_MARK.length);
    if (brace === -1) break;
    const raw = takeJsonObject(src, brace);
    if (raw) {
      try {
        const meta = JSON.parse(raw);
        if (meta && typeof meta.fileId === "string") {
          ids.push({ fileId: meta.fileId, label: typeof meta.label === "string" ? meta.label : "" });
        }
      } catch {
        // 解析不了就当没有这条
      }
      at = src.indexOf(SESSION_FILE_MARK, brace + raw.length);
    } else {
      at = src.indexOf(SESSION_FILE_MARK, brace + 1);
    }
  }

  const paths = [];
  let m;
  VIDEO_TAG_RE.lastIndex = 0;
  while ((m = VIDEO_TAG_RE.exec(src)) !== null) {
    const p = m[1].trim();
    if (p) paths.push(p);
  }

  const total = Math.max(ids.length, paths.length);
  const out = [];
  for (let i = 0; i < total; i += 1) {
    const id = ids[i] || null;
    const path = paths[i] || "";
    if (!id && !path) continue;
    out.push({
      fileId: id?.fileId || null,
      label: id?.label || (path ? basename(path) : "视频"),
      path,
    });
  }
  return out;
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

async function readTail(path, bytes = TAIL_BYTES) {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const start = Math.max(0, info.size - bytes);
    const buffer = Buffer.alloc(info.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/** 会话文件是 JSONL，倒着找最后一条 user 消息。 */
async function lastUserMessage(sessionPath) {
  if (!sessionPath || typeof sessionPath !== "string") return { error: "no-session-path" };
  let tail;
  try {
    tail = await readTail(sessionPath);
  } catch (err) {
    return { error: err?.code || err?.message || "read failed" };
  }
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 尾部截断会把首行切半，解析不了就跳过
    }
    if (entry?.type !== "message") continue;
    if (entry?.message?.role !== "user") continue;
    return { id: entry.id || null, text: messageText(entry.message) };
  }
  return null;
}

async function readJson(dataDir, name, fallback) {
  try {
    const raw = await readFile(join(dataDir, name), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(dataDir, name, value) {
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, name), JSON.stringify(value, null, 2), "utf8");
  } catch {
    // 落盘失败不影响这一轮
  }
}

/** 没有 fileId 时的退路：拿路径做指纹，读不到就当没缓存。 */
async function fingerprint(path) {
  try {
    const info = await stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

function renderBlock(items) {
  const lines = [
    "<video-understand-auto>",
    "用户这一轮附加了视频，内容已经由插件自动识别完成，下面就是画面内容。",
    "不需要再调用 understand_video 工具，也不要再向用户索要视频路径。",
    "",
  ];
  for (const item of items) {
    lines.push(`【${item.name}】${item.text}`);
    lines.push("");
  }
  lines.push("</video-understand-auto>");
  return lines.join("\n");
}

export function registerHooks(sdk) {
  // 用户提交那一刻先抓住原始输入，before-start 跟不上或者拿不到附件时用它
  sdk.hooks.onDecision("session/input", (invocation) => {
    try {
      const text = typeof invocation?.text === "string" ? invocation.text : "";
      if (text.trim()) {
        recentInput.text = text;
        recentInput.at = Date.now();
      }
    } catch {
      // 抓不到就算了，还有另外两条路
    }
    return undefined;
  });

  sdk.hooks.onDecision("agent/before-start", async (invocation) => {
    try {
      const cfg = (await sdk.config.getAll()) || {};
      if (cfg.autoUnderstand === false) return undefined;

      const sessionPath = invocation?.session?.sessionPath || null;
      const prompt = String(invocation?.prompt || "");
      const state = await readJson(sdk.dataDir, STATE_FILE, {});
      // 字数设置变了，旧缓存就不能再用，否则改了配置看不到变化
      const segChars = Math.min(2000, Math.max(20, Number(cfg.segmentChars) || 160));

      let attachments = [];
      let source = "none";

      // 1) 刚才那次输入里抓到的原文
      if (recentInput.text && Date.now() - recentInput.at < INPUT_FRESH_MS) {
        const found = extractAttachments(recentInput.text);
        if (found.length) {
          attachments = found;
          source = "session/input";
        }
      }

      // 2) before-start 自己的 prompt
      if (attachments.length === 0) {
        const found = extractAttachments(prompt);
        if (found.length) {
          attachments = found;
          source = "prompt";
        }
      }

      // 3) 会话文件里刚落库的那条 user 消息
      let messageId = null;
      if (attachments.length === 0) {
        const latest = await lastUserMessage(sessionPath);
        if (latest?.error) {
          await sdk.logger.info(`auto understand: session file unavailable (${latest.error})`);
          return undefined;
        }
        if (!latest) return undefined;
        messageId = latest.id;
        if (messageId && state.lastMessageId === messageId) return undefined;
        const found = extractAttachments(latest.text);
        if (found.length) {
          attachments = found;
          source = "session-file";
        }
      }

      if (attachments.length === 0) {
        await sdk.logger.info(
          `auto understand: no video in turn (prompt=${prompt.length} chars, `
          + `input=${recentInput.text.length} chars, sessionPath=${sessionPath ? "yes" : "no"})`,
        );
        return undefined;
      }

      await sdk.logger.info(
        `auto understand: ${attachments.length} video(s) from ${source}, `
        + `fileIds=${attachments.map((a) => a.fileId || "-").join(",")}`,
      );

      const picked = attachments.slice(0, MAX_VIDEOS_PER_TURN);
      const cache = await readJson(sdk.dataDir, CACHE_FILE, {});
      const items = [];

      for (const att of picked) {
        const name = att.label || "视频";
        const base = att.fileId || att.path;
        if (!base) continue;
        const key = `${base}#${segChars}`;

        if (att.fileId) {
          const hit = cache[key];
          if (hit?.text) {
            items.push({ name, text: hit.text });
            await sdk.logger.info(`auto understand: cache hit ${key}`);
            continue;
          }
        }
        // 有 fileId 就走宿主 materialize，不碰路径；没有才退回本地文件
        const video = att.fileId ? { kind: "session-file", fileId: att.fileId } : att.path;
        const text = await understandAsText(sdk, { video, detail: "summary", includeAudio: true });
        if (!text) {
          await sdk.logger.info(`auto understand: empty result for ${key}`);
          continue;
        }

        items.push({ name, text });
        const fp = att.fileId ? null : await fingerprint(att.path);
        cache[key] = {
          ...(fp ? { size: fp.size, mtimeMs: fp.mtimeMs } : {}),
          text,
          at: Date.now(),
        };
        await sdk.logger.info(`auto understand: done ${key} (${text.length} chars)`);
      }

      if (attachments.length > picked.length) {
        items.push({
          name: "其余附件",
          text: `这一轮还有 ${attachments.length - picked.length} 个视频没有自动处理，需要时再调 understand_video。`,
        });
      }

      await writeJson(sdk.dataDir, CACHE_FILE, cache);
      if (messageId) {
        state.lastMessageId = messageId;
        await writeJson(sdk.dataDir, STATE_FILE, state);
      }

      if (items.length === 0) return undefined;

      return {
        message: {
          customType: "video-understand-auto",
          content: renderBlock(items),
          display: false,
        },
      };
    } catch (err) {
      await sdk.logger.warn(`auto understand failed: ${err?.message || err}`);
      return undefined;
    }
  });
}
