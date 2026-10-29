/**
 * 端到端自测：不经过 Hana 宿主，直接调工具注册出来的 execute。
 *
 * 用法：
 *   node test/e2e.mjs "D:\path\to\video.mp4" [--timeline] [--preset=economy]
 *
 * key 从 ~/.hanako/provider-catalog.json 读，避免在源码里落明文。
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { register } from "../tools/understand-video.js";

const catalogPath = join(homedir(), ".hanako", "provider-catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const visionKey = catalog.providers?.deepseek?.api_key || "";
const asrKey = catalog.providers?.siliconflow?.api_key || "";

if (!visionKey) throw new Error("provider-catalog.json 里没有 deepseek key");
if (!asrKey) throw new Error("provider-catalog.json 里没有 siliconflow key");

const video = process.argv[2];
if (!video) throw new Error("用法: node test/e2e.mjs <video path>");

const presetArg = process.argv.find((a) => a.startsWith("--preset="));
const preset = presetArg ? presetArg.split("=")[1] : "precision";

const logs = [];
const log = {
  info: (...a) => logs.push(["INFO", a.join(" ")]),
  warn: (...a) => logs.push(["WARN", a.join(" ")]),
  error: (...a) => logs.push(["ERR ", a.join(" ")]),
};

let registered = null;

// 模拟宿主给的 sdk：只实现这个工具真正用到的那几个成员。
const sdk = {
  logger: log,
  dataDir: join(process.cwd(), "test", "_data"),
  config: {
    getAll: async () => ({
      visionApiKey: visionKey,
      visionApiUrl: "https://api.deepseek.com/chat/completions",
      visionModel: "deepseek-flash",
      asrMode: "api",
      asrApiKey: asrKey,
      asrApiUrl: "https://api.siliconflow.cn/v1/audio/transcriptions",
      asrModel: "FunAudioLLM/SenseVoiceSmall",
      asrPreset: preset,
      maxHeight: 720,
      keepTimeline: false,
    }),
  },
  network: { fetch: globalThis.fetch.bind(globalThis) },
  process: {
    async resolveExecutable({ candidates }) {
      return { path: candidates[0] };
    },
  },
  resources: {
    async materialize(ref) {
      return { filePath: ref.path };
    },
    async stat() {
      return { size: null };
    },
  },
  tools: {
    async register(tool) {
      registered = tool;
    },
  },
};

await register(sdk);
if (!registered) throw new Error("工具没有注册成功");

const t0 = Date.now();
const out = await registered.execute({
  video,
  detail: process.argv.includes("--timeline") ? "timeline" : "summary",
});
const dt = ((Date.now() - t0) / 1000).toFixed(1);

console.log(out?.content?.[0]?.text ?? out);
console.log("\n--- logs ---");
for (const [lvl, msg] of logs) console.log(`${lvl} ${msg}`);
console.log(`\n总耗时 ${dt}s`);
