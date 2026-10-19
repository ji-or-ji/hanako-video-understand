/**
 * 端到端自测：不经过 Hana 宿主，直接调工具的 execute。
 *
 * 用法：
 *   node test/e2e.mjs "D:\path\to\video.mp4"
 *
 * key 从 ~/.hanako/provider-catalog.json 读，避免在源码里落明文。
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execute } from "../tools/understand-video.js";

const catalogPath = join(homedir(), ".hanako", "provider-catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const visionKey = catalog.providers?.deepseek?.api_key || "";
const asrKey = catalog.providers?.siliconflow?.api_key || "";

if (!visionKey) throw new Error("provider-catalog.json 里没有 deepseek key");
if (!asrKey) throw new Error("provider-catalog.json 里没有 siliconflow key");

const video = process.argv[2];
if (!video) throw new Error("用法: node test/e2e.mjs <video path>");

const logs = [];
const ctx = {
  config: {
    visionApiKey: visionKey,
    visionApiUrl: "https://api.deepseek.com/chat/completions",
    visionModel: "deepseek-flash",
    asrMode: "api",
    asrApiKey: asrKey,
    asrApiUrl: "https://api.siliconflow.cn/v1/audio/transcriptions",
    asrModel: "FunAudioLLM/SenseVoiceSmall",
    maxHeight: 720,
    keepTimeline: false,
  },
  dataDir: join(process.cwd(), "test", "_data"),
  log: {
    info: (...a) => logs.push(["INFO", a.join(" ")]),
    warn: (...a) => logs.push(["WARN", a.join(" ")]),
    error: (...a) => logs.push(["ERR ", a.join(" ")]),
  },
  network: { fetch: globalThis.fetch.bind(globalThis) },
  resources: {
    async materialize(ref) {
      return ref.kind === "local-file" ? ref.path : ref.path;
    },
  },
};

const t0 = Date.now();
const out = await execute({ video, detail: process.argv.includes("--timeline") ? "timeline" : "summary" }, ctx);
const dt = ((Date.now() - t0) / 1000).toFixed(1);

console.log(out);
console.log("\n--- logs ---");
for (const [lvl, msg] of logs) console.log(`${lvl} ${msg}`);
console.log(`\n总耗时 ${dt}s`);
