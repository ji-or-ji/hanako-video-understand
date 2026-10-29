/**
 * ffmpeg / ffprobe 的最小封装。
 *
 * 全部走 execFile 的数组参数，不经过 shell，所以 Windows 下带中文、空格、
 * 括号的路径都不需要转义。这是移植时最容易踩坑的地方：
 * 用字符串拼命令在 PowerShell 下会炸，用数组参数就不会。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

function fail(bin, err) {
  const detail = (err?.stderr || err?.stdout || err?.message || String(err))
    .toString()
    .trim()
    .slice(0, 400);
  return new Error(`${bin} 执行失败：${detail}`);
}

export function createMediaTools({ ffmpeg, ffprobe, log } = {}) {
  const FFMPEG = ffmpeg || "ffmpeg";
  const FFPROBE = ffprobe || "ffprobe";

  async function runText(bin, args, { timeoutMs = 180000 } = {}) {
    try {
      const { stdout } = await run(bin, args, {
        timeout: timeoutMs,
        maxBuffer: DEFAULT_MAX_BUFFER,
        encoding: "utf8",
        windowsHide: true,
      });
      return stdout;
    } catch (e) {
      throw fail(bin, e);
    }
  }

  async function runBuffer(bin, args, { timeoutMs = 180000, maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
    try {
      const { stdout } = await run(bin, args, {
        timeout: timeoutMs,
        maxBuffer,
        encoding: "buffer",
        windowsHide: true,
      });
      return stdout;
    } catch (e) {
      throw fail(bin, e);
    }
  }

  /** 基础信息：时长、帧率、宽高。 */
  async function probeMedia(video) {
    const out = await runText(FFPROBE, [
      "-v", "quiet", "-print_format", "json",
      "-show_format", "-show_streams", "-select_streams", "v:0", video,
    ]);
    const data = JSON.parse(out || "{}");
    const fmt = data.format || {};
    const st = (data.streams || [])[0] || {};
    const duration = Number(fmt.duration || st.duration || 0);
    let fps = 0;
    const raw = st.avg_frame_rate || "0/0";
    if (typeof raw === "string" && raw.includes("/")) {
      const [num, den] = raw.split("/").map(Number);
      fps = den ? num / den : 0;
    }
    log?.info?.(`probe: duration=${duration}s fps=${fps.toFixed(2)} ${Number(st.width || 0)}x${Number(st.height || 0)}`);
    return {
      duration,
      fps,
      width: Number(st.width || 0),
      height: Number(st.height || 0),
    };
  }

  /** 视频流每个包的 (时间, 字节数)，用于估算码率密度。 */
  async function probePackets(video) {
    const out = await runText(FFPROBE, [
      "-v", "quiet", "-print_format", "json",
      "-select_streams", "v:0",
      "-show_entries", "packet=pts_time,size", video,
    ]);
    const data = JSON.parse(out || "{}");
    const res = [];
    for (const pk of data.packets || []) {
      const t = pk.pts_time;
      const s = pk.size;
      if (t == null || s == null) continue;
      const tf = Number(t);
      const si = Number(s);
      if (!Number.isFinite(tf) || !Number.isFinite(si)) continue;
      res.push([tf, si]);
    }
    res.sort((a, b) => a[0] - b[0]);
    return res;
  }

  /** 探测音轨，没有音轨返回 hasAudio=false。 */
  async function probeAudio(video) {
    let streams = [];
    try {
      const out = await runText(FFPROBE, [
        "-v", "quiet", "-print_format", "json",
        "-select_streams", "a:0", "-show_streams", video,
      ], { timeoutMs: 60000 });
      streams = JSON.parse(out || "{}").streams || [];
    } catch {
      streams = [];
    }
    if (!streams.length) return { hasAudio: false };
    const st = streams[0];
    return {
      hasAudio: true,
      codec: st.codec_name || null,
      channels: Number(st.channels || 0),
      sampleRate: Number(st.sample_rate || 0),
    };
  }

  async function probeDuration(path) {
    const out = await runText(FFPROBE, [
      "-v", "quiet", "-print_format", "json", "-show_format", path,
    ]);
    return Number(JSON.parse(out || "{}").format?.duration || 0);
  }

  /**
   * 拿 stdout 和 stderr 两路输出，不看退出码。
   * ffmpeg 的 silencedetect 把结果全打在 stderr 上，属于日志式输出。
   */
  async function runCaptured(bin, args, { timeoutMs = 300000 } = {}) {
    try {
      const { stdout, stderr } = await run(bin, args, {
        timeout: timeoutMs,
        maxBuffer: DEFAULT_MAX_BUFFER,
        encoding: "utf8",
        windowsHide: true,
      });
      return { stdout: stdout || "", stderr: stderr || "", code: 0 };
    } catch (e) {
      return {
        stdout: (e?.stdout || "").toString(),
        stderr: (e?.stderr || e?.message || "").toString(),
        code: e?.code ?? -1,
      };
    }
  }

  return {
    FFMPEG,
    FFPROBE,
    runText,
    runBuffer,
    runCaptured,
    probeMedia,
    probePackets,
    probeAudio,
    probeDuration,
  };
}
