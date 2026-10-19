# 视频理解

HanaAgent 插件：把视频变成可读的文字。按画面变化自适应抽帧，转录音轨，
交给视觉模型产出带时间戳的描述。

移植自 [mai-video-adaptive](https://gitee.com/ji-or-ji/mai-video-adaptive)（麦麦插件），
算法逻辑保持一致，外壳换成 Hana 插件。原项目是 PolyForm Noncommercial 1.0.0，
本仓库继承同一许可，仅限非商业使用。

## 安装

把本目录复制到 Hana 的插件目录，重启 Hana：

```
C:\Users\<你>\.hanako\plugins\video-understand\
```

然后在插件设置里填 `visionApiKey`。只处理纯音频的话还需要 `asrApiKey`。

开发和调试时也可以把本目录装进开发槽，但那套槽位在重启时会被清空，
长期使用请走上面的正式路径。

## 怎么用

对话里把视频拖进来，然后说"看看这个视频"；或者直接给路径：

```
D:\videos\demo.mp4 讲了什么
```

工具会返回一段摘要，带时间戳和声画两条轨：

```
视频：sample.mp4
时长 0:13 · 抽了 3 帧 · 语音 1 段 · 耗时 8.2s

【内容】
00:00 画面：画面为彩色竖条纹测试图… / 语音：大家好，这是一个测试视频…
```

`detail: "timeline"` 时额外返回完整分段，方便追问"第 40 秒发生了什么"。

**纯音频文件也能直接丢进来**（mp3/m4a/wav/ogg）。没有画面时跳过抽帧和视觉，
只出转录稿，按句切分并带上估算的时间点。

## 配置

插件设置里填这几项就能用，其余留默认：

| 字段 | 默认 | 说明 |
|---|---|---|
| `visionApiKey` | 空 | **必填**，视觉模型 key |
| `visionApiUrl` | `https://api.deepseek.com/chat/completions` | OpenAI 兼容接口 |
| `visionModel` | `deepseek-flash` | 视觉模型名 |
| `asrMode` | `api` | `off` 则不读音频 |
| `asrApiKey` | 空 | 走音频时需要 |
| `asrApiUrl` | SiliconFlow | 语音转写接口 |
| `asrModel` | `FunAudioLLM/SenseVoiceSmall` | 转写模型 |
| `ffmpegPath` / `ffprobePath` | 空 | 留空用 PATH 里的 |
| `minFrames` / `maxFrames` | 0 | 0 表示自适应，上限 48 |
| `maxHeight` | 720 | 抽帧后最大高度，等比缩小不放大 |
| `keepTimeline` | true | 完整时间轴落盘到插件数据目录 |

配置读取顺序：宿主注入的 `ctx.config` → 插件 `dataDir/config.json`。
开发槽里如果宿主没注入，直接把配置写成 JSON 放进去也能跑。

## 成本

单条视频的分账：

- 本地：ffprobe 读包、ffmpeg 抽帧、8×8 指纹算新颖率，全部零 API 成本
- 视觉：一次请求带 N 张帧图，几十秒的视频约 800 输入 / 100 输出 token
- 语音：按停顿分块，块内合并，40 秒三段语音通常只调一次转写

13 秒测试片实测 3.9 秒（独立跑）/ 8.2 秒（走宿主，含资源 materialize）。

## 已知边界

**短视频的帧可能挤在变化区。** CDF 撒点按码率密度分配，纯色或静止画面码率极低，
帧会被推到高密度段。13 秒里 3 帧全部落在彩色测试图那段，开头两段纯色没帧。
长视频（几十秒以上、帧数十几张）这个偏差不明显。

**时间轴粒度跟抽帧密度走。** 稀疏区的问题答不细，要精确就传 `detail: "timeline"`
看完整分段，或重新跑一次并调大 `minFrames`。

**语音的时间点是估算的。** SiliconFlow 的转写接口只返回整段文本，不给词级或
句级时间戳。所以块内的时间点按每句字数比例反推：语速均匀时误差小，忽快忽慢会偏。
要真正精确，得换一个支持时间戳的转写服务（如 Whisper 的 verbose_json）。

**ASR 有长度上限。** 默认只转前 600 秒，超长视频后面的语音会被截掉。

**视觉模型默认关掉推理。** DeepSeek 的 `thinking` 会把 `max_tokens` 烧在思考上，
content 空着回来，所以请求里显式 `thinking: {type: "disabled"}`。

## 目录

```
manifest.json          插件声明、配置项、网络白名单
lib/media.js           ffmpeg / ffprobe 封装（execFile 数组参数，中文路径不需要转义）
lib/frames.js          密度、平滑、CDF 撒点、指纹、新颖率、抽帧
lib/audio.js           抽轨、静音检测、分块、转录
lib/timeline.js        提示词、JSON 解析、分段规整、压缩、声画合并
tools/understand-video.js   工具入口
test/e2e.mjs           不经过宿主的端到端自测
```

自测：

```
node test/e2e.mjs "D:\path\to\video.mp4" --timeline
```

key 从 `~/.hanako/provider-catalog.json` 读，源码里不落明文。

## 许可

PolyForm Noncommercial License 1.0.0，仅限非商业用途。衍生自
[mai-video-adaptive](https://gitee.com/ji-or-ji/mai-video-adaptive)，
原项目版权归 ji-or-ji 所有。
