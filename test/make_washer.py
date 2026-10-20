# -*- coding: utf-8 -*-
"""生成西门子洗衣机用法测试视频：全黑画面 + 烧录字幕 + 中文语音。

设计目的：验证「画面无信息、内容全在语音」时插件还能不能读懂，
以及按字数估算的时间戳和真实时间差多少。
"""

import io
import json
import os
import subprocess
import sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_data", "washer")
SENTENCES = [
    "今天介绍一下西门子洗衣机的一般用法。",
    "首先打开机门，把衣物放进去。注意不要超过额定容量，一般装到八成满就可以。",
    "然后在洗涤剂盒里加入洗衣液。左边是主洗，中间是柔顺剂，右边是预洗。",
    "接着旋转程序旋钮，选择混合洗。日常衣物用混合洗就够了。",
    "如果衣物比较脏，可以按下加强洗。温度默认四十度，也可以手动调整。",
    "最后按下开始键，机器会自动称重，并显示预计完成时间。",
    "洗完之后记得打开机门通风，把洗涤剂盒抽出来晾干，避免发霉。",
]


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, check=True, **kw)


def duration(path):
    out = run(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", path]).stdout
    return float(json.loads(out.decode("utf-8")).get("format", {}).get("duration") or 0)


def main():
    os.makedirs(OUT, exist_ok=True)
    wavs = []
    print("== TTS ==")
    for i, text in enumerate(SENTENCES, 1):
        wav = os.path.join(OUT, "seg%02d.wav" % i)
        if not os.path.exists(wav):
            ps = (
                "Add-Type -AssemblyName System.Speech;"
                "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
                "$s.SelectVoice('Microsoft Huihui Desktop');"
                "$s.Rate=0;"
                "$s.SetOutputToWaveFile('%s');"
                "$s.Speak('%s');"
                "$s.Dispose()" % (wav.replace("'", "''"), text.replace("'", "''"))
            )
            run(["powershell", "-NoProfile", "-Command", ps])
        d = duration(wav)
        wavs.append((wav, d, text))
        print("  seg%02d  %5.2fs  %s" % (i, d, text[:24]))

    # 拼接：每句之间留 0.35 秒静音，更接近真实说话节奏
    gap = 0.35
    concat = os.path.join(OUT, "concat.txt")
    silence = os.path.join(OUT, "gap.wav")
    if not os.path.exists(silence):
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
             "-i", "anullsrc=r=16000:cl=mono", "-t", str(gap), "-c:a", "pcm_s16le", silence])
    lines = []
    timeline = []
    cursor = 0.0
    for wav, d, text in wavs:
        lines.append("file '%s'" % wav.replace("\\", "/"))
        lines.append("file '%s'" % silence.replace("\\", "/"))
        timeline.append((cursor, cursor + d, text))
        cursor += d + gap
    io.open(concat, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")

    full = os.path.join(OUT, "voice.wav")
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat",
         "-safe", "0", "-i", concat, "-c:a", "pcm_s16le", full])
    total = duration(full)
    print("\n总时长 %.2fs，共 %d 句" % (total, len(timeline)))

    # ASS 字幕：时间点来自每段的真实时长
    def ts(sec):
        h = int(sec // 3600)
        m = int((sec % 3600) // 60)
        s = sec % 60
        return "%d:%02d:%05.2f" % (h, m, s)

    ass = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: 1280",
        "PlayResY: 720",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default,Microsoft YaHei,46,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,"
        "0,0,0,0,100,100,0,0,1,2,0,2,80,80,90,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for start, end, text in timeline:
        ass.append("Dialogue: 0,%s,%s,Default,,0,0,0,,%s" % (ts(start), ts(end), text))
    ass_path = os.path.join(OUT, "subtitle.ass")
    io.open(ass_path, "w", encoding="utf-8-sig", newline="\n").write("\n".join(ass) + "\n")

    # 黑底 + 烧字幕 + 音轨
    video = os.path.join(OUT, "washer.mp4")
    ass_filter = "ass='%s'" % ass_path.replace("\\", "/").replace(":", "\\:")
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=25:d=%.3f" % total,
         "-i", full,
         "-vf", ass_filter,
         "-c:v", "mpeg4", "-q:v", "4", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "96k", "-shortest", video])
    print("输出 %s  (%.2f MB)" % (video, os.path.getsize(video) / 1048576.0))

    # 真值时间点，留给后面比对
    truth = os.path.join(OUT, "truth.json")
    io.open(truth, "w", encoding="utf-8").write(json.dumps(
        [{"start": round(a, 2), "end": round(b, 2), "text": t} for a, b, t in timeline],
        ensure_ascii=False, indent=2))
    print("真值时间点 %s" % truth)


if __name__ == "__main__":
    main()
