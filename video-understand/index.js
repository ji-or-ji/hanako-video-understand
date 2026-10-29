/**
 * index.js — 视频理解 v2 入口。
 */

import { defineApp } from "./sdk/app-contract/server-client.js";
import { register as registerUnderstandVideo } from "./tools/understand-video.js";

export default defineApp(async (sdk) => {
  await registerUnderstandVideo(sdk);
  await sdk.logger.info("视频理解已加载");
});
