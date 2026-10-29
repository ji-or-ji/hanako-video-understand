# Hanako 假装看视频

HanakoAgent 的视频理解插件：把视频变成可读的文字。按画面变化自适应抽帧，转录音轨，
交给视觉模型产出带时间戳的描述。

移植自 [mai-video-adaptive](https://gitee.com/ji-or-ji/mai-video-adaptive)（麦麦插件），
算法逻辑保持一致，外壳换成 Hana 插件。原项目是 PolyForm Noncommercial 1.0.0，
本仓库继承同一许可，仅限非商业使用。

## 安装（v2 App）

> 仓库的两条线：`main` 是 v1 插件（兼容层，永久可用），`v2`（默认分支）是 v2 App。
> 新装请用 v2。

把 `video-understand/` 整个目录（或打包出的 .zip）装进 HanaAgent
设置 → 扩展 → 已安装 → App 类目的安装入口，首次装载会在确认卡里列出它申请的能力：
访问你指定的文件、跑 ffmpeg/ffprobe、访问两个模型接口域名。

要求宿主版本：1.3.6-beta 及以上。

装完在设置 → 扩展 → 视频理解里填 `visionApiKey`。只处理纯音频的话还需要 `asrApiKey`。
ffmpeg / ffprobe 默认从 PATH 找；找不到就在设置里写绝对路径。

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
| `asrPreset` | `precision` | 切块预设：`economy` 快而粗 / `balanced` 折中 / `precision` 最准 |
| `ffmpegPath` / `ffprobePath` | 空 | 留空用 PATH 里的 |
| `minFrames` / `maxFrames` | 0 | 0 表示自适应，上限 48 |
| `maxHeight` | 720 | 抽帧后最大高度，等比缩小不放大 |
| `keepTimeline` | true | 完整时间轴落盘到插件数据目录 |

配置读取顺序：`contributes.settings` 声明的字段（`ctx.config`，缺省值也由它回填）。
密钥字段在设置页里是掩码显示的，App 自己读到的始终是真实值。

## 成本

单条视频的分账：

- 本地：ffprobe 读包、ffmpeg 抽帧、8×8 指纹算新颖率，全部零 API 成本
- 视觉：一次请求带 N 张帧图
- 语音：按停顿分块，块内合并，多块并发转录

实测数据（56 秒黑底字幕视频，7 句中文语音）：

| 预设 | 块数 | 耗时 | 句级平均误差 | 适用 |
|---|---|---|---|---|
| `economy` | 1 | 5.8s | 23.9s | 只要大概内容 |
| `balanced` | 3 | 6.0s | 4.9s | 折中 |
| `precision`（默认） | 11 | 5.1s | **0.16s** | 要回答「第几秒说了什么」 |

三档耗时差不多，因为块数变多不增加费用（接口按时长计费），多块又并发转录。
差的是时间戳精度，以及块太碎时转写丢上下文的风险。

视觉模型用量 3237 输入 / 216 输出 token。

接口按音频时长计费、不按请求次数，所以拆块并发不增加成本，只把串行等待叠起来。

## 已知边界

**短视频的帧可能挤在变化区。** CDF 撒点按码率密度分配，纯色或静止画面码率极低，
帧会被推到高密度段。13 秒里 3 帧全部落在彩色测试图那段，开头两段纯色没帧。
长视频（几十秒以上、帧数十几张）这个偏差不明显。

**时间轴粒度跟抽帧密度走。** 稀疏区的问题答不细，要精确就传 `detail: "timeline"`
看完整分段，或重新跑一次并调大 `minFrames`。

**黑底字幕类视频会抽不满帧。** 画面几乎不变时码率密度极低，CDF 撒点会把帧数压到
下限。现在有限制补帧（相邻帧间隔超过 15 秒就在中间补点），但补出来的帧仍然只是
「每个字幕块一张」，一段字幕里换了两句话就看不出来。

**语音时间点分两层精度。** 块边界来自 ffmpeg 的静音检测，是真实时间点；块内如果
被切成几句，那几句的分配是按字数比例估算的。所以问「第几秒说了什么」时，块边界
附近最准，块中间靠猜。

**ASR 会对合成语音犯同音错。** 测试里「主洗」被识别成「竹洗」、「预洗」变成「玉洗」。
这是 SenseVoice 对 TTS 音色的适应问题，真人录音通常好一些，但不能保证。

**ASR 有长度上限。** 默认只转前 600 秒，超长视频后面的语音会被截掉。

**视觉模型默认关掉推理。** DeepSeek 的 `thinking` 会把 `max_tokens` 烧在思考上，
content 空着回来，所以请求里显式 `thinking: {type: "disabled"}`。

## 目录

```
video-understand/           App 目录（目录名必须等于 manifest.id）
manifest.json           v2 清单：能力、网络白名单、设置 schema
index.js                defineApp 入口，注册工具
assets/icon.png         App 图标
sdk/                    随包携带的 @hana/app-sdk 运行时闭包
lib/media.js           ffmpeg / ffprobe 封装（execFile 数组参数，中文路径不需要转义）
lib/frames.js          密度、平滑、CDF 撒点、指纹、新颖率、抽帧
lib/audio.js           抽轨、静音检测、分块、转录（multipart 手拼，因为跨进程只搬字节）
lib/timeline.js        提示词、JSON 解析、分段规整、压缩、声画合并
tools/understand-video.js   工具注册与主流程
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
