// 视频格式 → 播放策略的判定。
//
// Chrome 原生只认 MP4(H.264/AAC) 和 WebM 两种容器，这是 Chromium 编译期的
// 有意取舍（专利 + MSE 规范偏好 ISO-BMFF/WebM），不是 bug。于是「播不了」分成
// 两类，代价相差一个数量级：
//   容器问题  —— 编码浏览器能解，只是外壳不认识 → 重新封装即可（快、无损）
//   编码问题  —— 浏览器根本没有该解码器     → 必须真解码重编码（慢）
// 这里只做「按扩展名派发」，真正的编码好坏要等 ffmpeg 探明后再定。

export type Strategy =
  | "native" // 先直接交给 <video>，多数 mp4/webm 到这就成了
  | "transmux" // MPEG-TS/FLV：用 mpegts.js 转封装成 fMP4 喂 MSE，硬件解码
  | "ffmpeg"; // 其余：容器解不了，得 ffmpeg.wasm 出手

// .mts 是家用摄像机（AVCHD）的扩展名，和 .m2ts 同源：192 字节包 + 4 字节时间戳
// 前缀的 BDAV 变体，所以它俩走同一条转封装路径、同一个 mpegts.js type。
const TRANSMUX_EXTS = new Set([".ts", ".m2ts", ".mts", ".flv"]);
const FFMPEG_EXTS = new Set([".mkv", ".avi", ".wmv", ".mpg", ".mpeg"]);

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

export function strategyFor(name: string): Strategy {
  const e = extOf(name);
  if (TRANSMUX_EXTS.has(e)) return "transmux";
  if (FFMPEG_EXTS.has(e)) return "ffmpeg";
  return "native";
}

// 给 Blob 一个明确的 MIME，Chrome 据此挑解复用器。
// .mkv 故意标成 video/webm：Chrome 的 WebM 解复用器本身就是完整的 Matroska
// 解析器，装 VP8/VP9/AV1 的 mkv 有机会直接播。装 H.264/H.265 的会失败，
// 失败后自动退到 ffmpeg——只是多花一次尝试，不会更差。
const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/mp4",
  ".3gp": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/webm",
  ".ogv": "video/ogg",
  ".ts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".mts": "video/mp2t",
  ".flv": "video/x-flv",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
};

export function mimeFor(name: string): string {
  return MIME[extOf(name)] ?? "video/mp4";
}

// mpegts.js 的 type 参数。m2ts/mts 是 192/204 字节包的 BDAV 变体，要单独告诉它。
export function transmuxTypeFor(name: string): "mpegts" | "m2ts" | "flv" {
  const e = extOf(name);
  if (e === ".m2ts" || e === ".mts") return "m2ts";
  if (e === ".flv") return "flv";
  return "mpegts";
}

// 浏览器能直接解码的视频编码。hevc 视平台而定（需要硬件支持），单列出来让
// 调用方用 canPlayType 自行确认。
const KNOWN_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);

export function isPlayableVideoCodec(codec: string): boolean {
  const c = codec.toLowerCase();
  if (KNOWN_VIDEO_CODECS.has(c)) return true;
  if (c === "hevc" || c === "h265") {
    // 只有装了 HEVC 解码能力的平台（Windows 硬件解码 + 系统扩展）才回 "probably"
    const v = document.createElement("video");
    return (
      v.canPlayType('video/mp4; codecs="hvc1"') !== "" ||
      v.canPlayType('video/mp4; codecs="hev1"') !== ""
    );
  }
  return false;
}

// 浏览器能直接解码的音频编码。remux（-c copy）只换外壳不重编码，音频会原样
// 保留，所以这里要和视频一样把关：AC-3/DTS/LPCM 等 Chrome 都不解（专利/容器
// 限制），原样塞进 mp4 会「有画面没声音」。
const KNOWN_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

export function isPlayableAudioCodec(codec: string): boolean {
  return KNOWN_AUDIO_CODECS.has(codec.toLowerCase());
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
