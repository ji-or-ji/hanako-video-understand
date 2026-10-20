/**
 * 自适应抽帧。
 *
 * 核心思路（移植自 mai-video-adaptive 的 adaptive_frames.py）：
 *   1. ffprobe 读每个视频包的 (时间, 字节数)
 *   2. 按时间分桶，桶内平均码率当作「画面信息密度」的代理
 *   3. 先估画面新颖率（重复播放的片子会被压到极低）
 *   4. 有效内容量 = 时长 × 新颖率^1.5，推出该抽几帧
 *   5. 把密度曲线归一化成累积分布，在累积轴上均匀撒点
 *      —— 密度高处累积区间更宽，自然被更多点命中
 *
 * 为什么不用定时抽帧：5 秒钟切一张，遇到静止画面全是废帧，遇到快节奏
 * 场景又漏关键画面。按密度撒点把帧花在变化剧烈的地方。
 */

import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

const NOVELTY_SAMPLES = 32;
const NOVELTY_PX = 8;
const NOVELTY_THRESHOLD = 0.97;
const MAX_CAP = 48;

/** 按时间分桶，返回 [桶中心时间], [密度]（字节/秒）。 */
export function buildDensity(packets, duration, bucketS = 0.5) {
  if (duration <= 0 || !packets.length) return [[], []];
  const n = Math.max(1, Math.ceil(duration / bucketS));
  const acc = new Array(n).fill(0);
  for (const [t, size] of packets) {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(t / bucketS)));
    acc[idx] += size;
  }
  const centers = [];
  for (let i = 0; i < n; i++) centers.push((i + 0.5) * bucketS);
  return [centers, acc.map((a) => a / bucketS)];
}

/** 滑动平均，压掉单个包的噪声。 */
export function smooth(dens, win = 3) {
  if (win <= 1 || dens.length <= 2) return [...dens];
  const half = Math.floor(win / 2);
  const out = [];
  for (let i = 0; i < dens.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(dens.length, i + half + 1);
    const seg = dens.slice(lo, hi);
    out.push(seg.reduce((a, b) => a + b, 0) / seg.length);
  }
  return out;
}

/** 时长决定基础帧数，再夹进上下限。 */
export function decideFrameCount(duration, minFrames, maxFrames, secondsPerFrame = 4.0) {
  const base = Math.round(duration / Math.max(0.5, secondsPerFrame));
  return Math.max(minFrames, Math.min(maxFrames, base));
}

/** CDF 均匀撒点，返回升序去重的时间点。 */
export function pickTimes(centers, dens, nFrames, duration) {
  if (!centers.length || nFrames <= 0) return [];
  const total = dens.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    const out = [];
    for (let i = 0; i < nFrames; i++) out.push((duration * (i + 0.5)) / nFrames);
    return out;
  }
  const cum = [];
  let s = 0;
  for (const d of dens) {
    s += d;
    cum.push(s / total);
  }
  const times = [];
  for (let k = 0; k < nFrames; k++) {
    const q = (k + 0.5) / nFrames;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < q) lo = mid + 1;
      else hi = mid;
    }
    times.push(Math.min(centers[lo], Math.max(0, duration - 0.02)));
  }
  const uniq = [];
  for (const t of times) {
    if (!uniq.length || t - uniq[uniq.length - 1] > 1e-6) uniq.push(t);
  }
  return uniq;
}

/**
 * 一次 ffmpeg 调用抽出 samples 张 px*px 的 RGB 原始图，用来估新颖率。
 * 全部在本地算，零 API 成本。
 */
export async function probeThumbnails(media, video, duration, samples = NOVELTY_SAMPLES, px = NOVELTY_PX) {
  const rate = Math.max(1e-6, samples / Math.max(0.1, duration));
  const buf = await media.runBuffer(media.FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-i", video,
    "-vf", `fps=${rate.toFixed(6)},scale=${px}:${px}:flags=bilinear`,
    "-frames:v", String(Math.max(1, samples)),
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { timeoutMs: 120000, maxBuffer: 8 * 1024 * 1024 });

  const frameBytes = px * px * 3;
  const out = [];
  for (let i = 0; i + frameBytes <= buf.length; i += frameBytes) {
    out.push(buf.subarray(i, i + frameBytes));
  }
  return out;
}

/** RGB 原始图 → 指纹：灰度看构图，直方图看色彩分布。 */
export function fingerprint(raw, bins = 16) {
  const gray = [];
  const hist = new Array(3 * bins).fill(0);
  const n = Math.floor(raw.length / 3);
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const r = raw[i];
    const g = raw[i + 1];
    const b = raw[i + 2];
    gray.push(0.299 * r + 0.587 * g + 0.114 * b);
    hist[Math.min(bins - 1, Math.floor((r * bins) / 256))] += 1;
    hist[bins + Math.min(bins - 1, Math.floor((g * bins) / 256))] += 1;
    hist[2 * bins + Math.min(bins - 1, Math.floor((b * bins) / 256))] += 1;
  }
  if (n) for (let i = 0; i < hist.length; i++) hist[i] /= n;
  return { gray, hist };
}

function cos(a, b) {
  let num = 0;
  let da = 0;
  let db = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    num += a[i] * b[i];
    da += a[i] * a[i];
    db += b[i] * b[i];
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export function fpSimilarity(f1, f2, wGray = 0.5, wHist = 0.5) {
  return wGray * cos(f1.gray, f2.gray) + wHist * cos(f1.hist, f2.hist);
}

/**
 * 估内容新颖率。
 *
 * 把探针帧按时间对半切，看后半段有多少能在前半段找到高度相似的匹配。
 * 循环播放的内容后半段几乎全被前半覆盖，新颖率趋近 0；一路推进的接近 1。
 */
export function noveltyScan(media, video, duration, samples = NOVELTY_SAMPLES, px = NOVELTY_PX, threshold = NOVELTY_THRESHOLD) {
  return probeThumbnails(media, video, duration, samples, px).then((raws) => {
    const all = raws.map((r) => fingerprint(r));
    const n = all.length;
    if (n < 4) return { novelty: 1, repeat: 0 };
    const half = Math.floor(n / 2);
    const front = all.slice(0, half);
    const back = all.slice(half);
    let matched = 0;
    for (const b of back) {
      let best = 0;
      for (const f of front) {
        const sim = fpSimilarity(b, f);
        if (sim > best) best = sim;
        if (best >= threshold) break;
      }
      if (best >= threshold) matched++;
    }
    const repeat = matched / back.length;
    return { novelty: 1 - repeat, repeat };
  });
}

/** 由「时长 × 新颖率」推出帧数区间与目标帧数。 */
export function adaptivePlan(duration, novelty, {
  secondsPerFrame = 4.0,
  minFloor = 3,
  maxCap = MAX_CAP,
  noveltyPower = 1.5,
} = {}) {
  const ratio = Math.max(0, Math.min(1, novelty)) ** noveltyPower;
  const eff = duration * ratio;
  const raw = eff / Math.max(0.5, secondsPerFrame);

  let lo = Math.max(minFloor, Math.round(raw * 0.5));
  let hi = raw > 0 ? Math.round(raw * 1.4) : minFloor + 2;
  hi = Math.min(maxCap, Math.max(lo + 1, hi));
  lo = Math.min(lo, hi - 1);
  const target = Math.max(lo, Math.min(hi, raw > 0 ? Math.round(raw) : lo));
  return { minFrames: lo, maxFrames: hi, target };
}

/**
 * 补帧：CDF 撒点会往高码率区挤，遇到「黑底＋字幕」这类画面几乎没变、
 * 但文字在变的视频，帧数会被压到下限，导致一大段时间只有一帧代表。
 * 这里在过大的空隙里补点，让时间轴上有基本覆盖，总数仍然受 maxCap 约束。
 */
export function fillGaps(times, maxGap, maxCap) {
  if (!times.length || maxGap <= 0) return times;
  const out = [times[0]];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > maxGap) {
      const extra = Math.max(1, Math.floor(gap / maxGap) - 1);
      for (let k = 1; k <= extra; k++) {
        out.push(times[i - 1] + (gap * k) / (extra + 1));
      }
    }
    out.push(times[i]);
  }
  return out.length > maxCap ? out.slice(0, maxCap) : out;
}

/** 规划：只算时间点，不抽帧。 */
export async function planFrames(media, video, opts = {}) {
  const {
    minFrames = 0,
    maxFrames = 0,
    bucketS = 0.5,
    secondsPerFrame = 4.0,
    smoothWin = 3,
    noveltySamples = NOVELTY_SAMPLES,
    noveltyPx = NOVELTY_PX,
    noveltyThreshold = NOVELTY_THRESHOLD,
    maxCap = MAX_CAP,
  } = opts;

  const info = await media.probeMedia(video);
  const duration = info.duration;
  if (!(duration > 0)) throw new Error("读不出时长，文件可能损坏或不是媒体文件。");

  // 纯音频文件没有视频流：直接告诉上层“没有画面”，不要硬抽帧。
  if (!info.width || !info.height) {
    return {
      duration,
      fps: info.fps,
      width: 0,
      height: 0,
      hasVideo: false,
      times: [],
      frameCount: 0,
      minFrames: 0,
      maxFrames: 0,
      novelty: -1,
      packets: 0,
      buckets: 0,
    };
  }

  const packets = await media.probePackets(video);
  const [centers, rawDens] = buildDensity(packets, duration, bucketS);
  const dens = smooth(rawDens, smoothWin);

  const adaptive = !minFrames && !maxFrames;
  let novelty = -1;
  let lo;
  let hi;
  let n;

  if (adaptive) {
    const scan = await noveltyScan(media, video, duration, noveltySamples, noveltyPx, noveltyThreshold);
    novelty = scan.novelty;
    const p = adaptivePlan(duration, novelty, { secondsPerFrame, maxCap });
    lo = p.minFrames;
    hi = p.maxFrames;
    n = p.target;
  } else {
    lo = minFrames || 8;
    hi = maxFrames || 24;
    lo = Math.max(1, Math.min(lo, hi - 1));
    n = decideFrameCount(duration, lo, hi, secondsPerFrame);
  }

  const times = fillGaps(
    pickTimes(centers, dens, n, duration),
    opts.maxGap ?? 15,
    maxCap
  );
  return {
    duration,
    fps: info.fps,
    width: info.width,
    height: info.height,
    hasVideo: true,
    times,
    frameCount: times.length,
    minFrames: lo,
    maxFrames: hi,
    novelty,
    packets: packets.length,
    buckets: centers.length,
  };
}

/** 按时间点逐点抽帧并等比缩小（不放大）。 */
export async function extractAt(media, video, times, outDir, { maxHeight = 720, quality = 4 } = {}) {
  await mkdir(outDir, { recursive: true });
  const vf = `scale=-2:min(${maxHeight}\\,ih)`;
  const paths = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const out = join(outDir, `f${String(i).padStart(3, "0")}_${t.toFixed(2)}s.jpg`);
    try {
      await media.runText(media.FFMPEG, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-ss", t.toFixed(3), "-i", video,
        "-frames:v", "1", "-vf", vf,
        "-q:v", String(quality), out,
      ], { timeoutMs: 90000 });
    } catch {
      // 单帧失败不影响整体，跳过
      continue;
    }
    try {
      const s = await stat(out);
      if (s.size > 0) paths.push({ path: out, time: t });
    } catch {
      // 没产出就跳过
    }
  }
  return paths;
}

/** 规划 + 抽帧。 */
export async function adaptiveExtract(media, video, outDir, opts = {}) {
  const plan = await planFrames(media, video, opts);
  const frames = await extractAt(media, video, plan.times, outDir, {
    maxHeight: opts.maxHeight ?? 720,
  });
  return { plan, frames };
}
