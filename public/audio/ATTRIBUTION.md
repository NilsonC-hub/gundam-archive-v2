# 射击与玻璃音效来源

资源确认日期：2026-09-29。以下文件来自 Freesound 公开提供的高质量 MP3 预览，用于本项目声音播放。没有生成声音，没有振荡器、程序噪声或变调合成。

## 枪声

`rifle-shot.mp3` — **gun lee enfield 303 rifle clean shot.wav**，作者 **kyles**。

- 来源：https://freesound.org/people/kyles/sounds/450853/
- 音频：https://cdn.freesound.org/previews/450/450853_612689-hq.mp3
- 许可：[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- 长度：2.669 秒，48 kHz，单声道。
- 选用原因：单发步枪录音，单次明确的瞬态后连续衰减。比另一份 AR15 候选的过高电平更容易控制。
- 文件未改动；播放器可跳过开头 0.024 秒，使枪口闪光与声音冲击对齐。

## 逐发玻璃撞击

**Glass Hit (29).wav** by **JohanDeecke**, licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

- 本地文件：`glass-impact.mp3`
- 来源：https://freesound.org/people/JohanDeecke/sounds/368339/
- 音频：https://cdn.freesound.org/previews/368/368339_6758928-hq.mp3
- 长度：0.193 秒，48 kHz，单声道。
- 作者说明：玻璃破碎的录音室采样，麦克风 Shure SM7B / Sennheiser MHK416，未处理。
- 选用原因：声音很短，适合每发中弹的小碎屑，不会提前播放整面玻璃崩塌的长尾。
- 文件未改动；只调整播放音量。分发项目时请保留本署名及源链接。

## 最终玻璃破碎

`glass-shatter.mp3` — **glass-shattering_01.ogg**，作者 **C_Rogers**。

- 来源：https://freesound.org/people/C_Rogers/sounds/203375/
- 音频：https://cdn.freesound.org/previews/203/203375_3569783-hq.mp3
- 许可：[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- 长度：1.413 秒，44.1 kHz，立体声。
- 选用原因：主体冲击后有约 0.7 秒碎片余响，适合最后碎片离开屏幕的过程。
- 文件未改动；播放器可跳过开头 0.008 秒。

## 验证口径

已核对来源页、作者、许可、采样率、时长、电平与起音位置。三个文件均可由 FFmpeg 解码，未发现文件损坏；所选文件的各声道峰值低于 0 dBFS。

当前工具环境无法将音频送入模型进行听觉复核，所以此文档不声称已完成主观试听。最终整体响度应结合页面播放复核。`sources.json` 内音量为集成起点；`attackSeconds` 以单声道分析中首次超过峰值 -20 dB 的位置估计，不代表人耳阈值。
