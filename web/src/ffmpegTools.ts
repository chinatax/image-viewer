// ffmpeg.wasm 封装：探测编码 / 重新封装 / 转码预览。
//
// 只在原生播放和 mpegts.js 都失败后才按需加载——core 有 30MB，不该让只看图的人付这个钱。
// 用的是单线程 core（@ffmpeg/core 而非 core-mt），因此不需要 SharedArrayBuffer，
// 也就不需要在服务端加 COOP/COEP 响应头。代价是没有多线程加速。

import { extOf, isPlayableAudioCodec, isPlayableVideoCodec } from "./media";
import { t } from "./i18n";

// wasm32 线性内存上限约 2GB。输入走 WORKERFS 挂载（不进堆），但**输出**要写进
// wasm 堆、readFile 取回时再复制一份到 JS，所以峰值大致是「输出大小 × 2」。
// 大文件不拒绝，而是用 -fs 把重封装输出压到 700MB 以内（只播前 700MB 的内容），
// 这样输入再大也只在 wasm 堆里占 700MB 输出，标签页不会崩。
export const MAX_REMUX_OUTPUT_BYTES = 700 * 1024 * 1024;

// 探测只读文件头就够了：MKV/AVI/MP4 的轨道信息都在开头，传整个文件白占内存。
const PROBE_BYTES = 8 * 1024 * 1024;

type ProgressHandler = (ratio: number) => void;
type LogHandler = (line: string) => void;

interface Mountable {
  mount?: (fsType: string, options: unknown, mountPoint: string) => Promise<unknown>;
  unmount?: (mountPoint: string) => Promise<unknown>;
  createDir?: (path: string) => Promise<unknown>;
  deleteDir?: (path: string) => Promise<unknown>;
}

interface FFmpegLike extends Mountable {
  load(o: { coreURL: string; wasmURL: string }): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array | string>;
  deleteFile(path: string): Promise<void>;
  exec(args: string[]): Promise<number>;
  on(event: string, cb: (arg: never) => void): void;
}

let instance: Promise<FFmpegLike> | null = null;
let progressSink: ProgressHandler | null = null;
let logSink: LogHandler | null = null;

// 单例是一个共享的 wasm 实例，两次调用同时跑会互相踩文件系统 —— 串行化。
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function isFFmpegReady(): boolean {
  return instance !== null;
}

// 上一次喂输入走的是哪条路。workerfs = 流式读原文件（省内存，大文件靠它）；
// memfs = 整个文件复制进 wasm 堆（大文件有 OOM 风险）。诊断用。
let lastInputMode: "workerfs" | "memfs" | null = null;

export function lastInputModeUsed(): "workerfs" | "memfs" | null {
  return lastInputMode;
}

// 转换结果内存缓存：同一个文件反复打开时，直接复用上次的转换产物（object URL），
// 不再重新 probe + remux。浏览器拿不到文件完整路径，所以用「操作 + 名字 + 大小 + 修改时间」
// 拼 key——对同一份文件稳定，改名/改动后自动失配。
//
// op 是「remux」还是「transcode」：两者产物可能一个能播一个不能播（比如 remux 只换
// 外壳、编码没变，浏览器依旧解不了），必须分开存。否则 remux 失败后被当成缓存复用，
// 会死循环：remux 产物播不了 → 强制转码 → 又命中 remux 缓存 → 再播不了……
type ConvertOp = "remux" | "transcode";

interface CachedConvert {
  url: string;
  bytes: number;
}
const convertCache = new Map<string, CachedConvert>();
const MAX_CACHE_ENTRIES = 2;
const MAX_CACHE_FILE_BYTES = 200 * 1024 * 1024; // 单文件超过就不缓存，避免内存压力

function convertCacheKey(file: File, op: ConvertOp): string {
  return `${op}|${file.name}|${file.size}|${file.lastModified}`;
}

export function getCachedConvert(file: File, op: ConvertOp): string | null {
  const key = convertCacheKey(file, op);
  const hit = convertCache.get(key);
  if (!hit) return null;
  convertCache.delete(key);
  convertCache.set(key, hit); // LRU：刚命中，移到队尾
  return hit.url;
}

// 产物播不了时调用：把这份缓存作废，避免下次又复用坏结果。
export function invalidateConvert(file: File, op: ConvertOp): void {
  const key = convertCacheKey(file, op);
  const old = convertCache.get(key);
  if (old) URL.revokeObjectURL(old.url);
  convertCache.delete(key);
}

export function storeConvert(file: File, blob: Blob, op: ConvertOp): string {
  if (blob.size > MAX_CACHE_FILE_BYTES) return URL.createObjectURL(blob);
  while (convertCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = convertCache.keys().next().value;
    if (oldest === undefined) break;
    const old = convertCache.get(oldest);
    if (old) URL.revokeObjectURL(old.url);
    convertCache.delete(oldest);
  }
  const url = URL.createObjectURL(blob);
  convertCache.set(convertCacheKey(file, op), { url, bytes: blob.size });
  return url;
}

async function getFFmpeg(): Promise<FFmpegLike> {
  if (instance) return instance;
  instance = (async () => {
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const ff = new FFmpeg() as unknown as FFmpegLike;
    // 只注册一次：实例是单例，反复 on() 会累积监听器。
    ff.on("progress", (e: { progress?: number }) => {
      progressSink?.(clamp01(e.progress ?? 0));
    });
    ff.on("log", (e: { message?: string }) => {
      logSink?.(e.message ?? "");
    });
    const base = new URL("ffmpeg/", document.baseURI).href;
    await ff.load({
      coreURL: base + "ffmpeg-core.js",
      wasmURL: base + "ffmpeg-core.wasm",
    });
    return ff;
  })().catch((e) => {
    instance = null; // 失败后允许重试
    throw e;
  });
  return instance;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

// 每次挂载用独立的挂载点，避免上一次 unmount 失败残留目录后卡死后续调用。
let mountSeq = 0;

interface InputHandle {
  path: string;
  release: () => Promise<void>;
}

// 优先用 WORKERFS 把 File 挂进 ffmpeg：ffmpeg 直接按需分块读原文件，
// 整个文件不必复制进 wasm 堆——这也是大文件还能跑得动的原因。
// 挂载 API 在 @ffmpeg/ffmpeg 0.12 的 .d.ts 里没有声明（运行时存在），
// 所以这里做了能力探测，缺了就老老实实退回 MEMFS 全量复制。
async function attachInput(ff: FFmpegLike, file: File, name: string): Promise<InputHandle> {
  if (ff.mount && ff.createDir && ff.deleteDir) {
    const point = `/work${mountSeq++}`;
    try {
      await ff.createDir(point);
      // Emscripten WORKERFS 的 blobs 字段接受 {name, data}，data 为 Blob/File。
      // 不能用 files 字段塞 {name, file}——那会让 workerfs 把包装对象当 File 用，
      // 读 size/slice 得 undefined，报 "Cannot convert undefined to a BigInt"。
      await ff.mount("WORKERFS", { blobs: [{ name, data: file }] }, point);
      lastInputMode = "workerfs";
      return {
        path: `${point}/${name}`,
        release: async () => {
          await ff.unmount?.(point).catch(() => undefined);
          await ff.deleteDir?.(point).catch(() => undefined);
        },
      };
    } catch {
      await ff.deleteDir(point).catch(() => undefined);
      // 落到下面走 MEMFS
    }
  }
  lastInputMode = "memfs";
  await ff.writeFile(name, new Uint8Array(await file.arrayBuffer()));
  return {
    path: name,
    release: async () => {
      await ff.deleteFile(name).catch(() => undefined);
    },
  };
}

export interface MediaInfo {
  video: string;
  audio: string;
  // 视频/音频各自能否被浏览器直接解码。playable = 两者都可播（可直接 remux）。
  videoPlayable: boolean;
  audioPlayable: boolean;
  playable: boolean;
}

// 用 -i 只喂输入、不给输出：ffmpeg 会打印流信息后以非零码退出，
// 我们要的就是那段日志。探测只喂文件头，因此这里始终用 MEMFS 的小切片即可。
export function probe(file: File): Promise<MediaInfo> {
  return serialize(async () => {
    const ff = await getFFmpeg();
    const inName = "probe_in" + (extOf(file.name) || ".bin");
    const lines: string[] = [];
    logSink = (l) => lines.push(l);
    try {
      const head = file.slice(0, Math.min(file.size, PROBE_BYTES));
      await ff.writeFile(inName, new Uint8Array(await head.arrayBuffer()));
      try {
        await ff.exec(["-i", inName]);
      } catch {
        /* 预期内：没有指定输出文件，ffmpeg 必然报错退出 */
      }
    } finally {
      logSink = null;
      await ff.deleteFile(inName).catch(() => undefined);
    }
    const text = lines.join("\n");
    const v = /Stream #\d+:\d+.*?: Video: ([A-Za-z0-9_]+)/.exec(text);
    const a = /Stream #\d+:\d+.*?: Audio: ([A-Za-z0-9_]+)/.exec(text);
    const video = v ? v[1].toLowerCase() : "";
    const audio = a ? a[1].toLowerCase() : "";
    const videoPlayable = isPlayableVideoCodec(video);
    // 无音频轨道视为可播（没有就不存在音频解码问题）。
    const audioPlayable = audio === "" || isPlayableAudioCodec(audio);
    return { video, audio, videoPlayable, audioPlayable, playable: videoPlayable && audioPlayable };
  });
}

async function run(
  ff: FFmpegLike,
  input: InputHandle,
  outName: string,
  args: string[],
  onProgress?: ProgressHandler,
): Promise<Blob> {
  progressSink = onProgress ?? null;
  let released = false;
  // 成功路径和异常路径都会走到，但要保证只释放一次——重复 unmount/deleteFile 会抛。
  const releaseOnce = async () => {
    if (released) return;
    released = true;
    await input.release().catch(() => undefined);
  };
  try {
    const code = await ff.exec(args);
    if (code !== 0) throw new Error(t("ffmpeg.exitCode", { code }));
    // 先放开输入（MEMFS 模式下即释放那一整份），再读输出：
    // 输入输出同时在堆里会把内存顶爆，表现为卡在 99% 或直接白屏。
    await releaseOnce();
    const data = toBytes(await ff.readFile(outName));
    // 读出来就立刻删掉 wasm 堆里的输出，别让它在 Blob 构造时还占着一份堆。
    await ff.deleteFile(outName).catch(() => undefined);
    // 某些源（解码器虽在清单里、但实际解不出帧）会让 ffmpeg 静默产出「只有
    // moov 头、没有一帧数据」的空 mp4，退出码仍是 0。这种产物喂给 <video> 会
    // 直接 onError，走到「转码后依然无法播放」的含糊提示。这里挡一道：产物小得
    // 离谱（连一个关键帧都放不下）就直接当失败，把真实原因抛出去。
    if (data.byteLength < 1024) {
      throw new Error(t("ffmpeg.noFrames"));
    }
    return new Blob([data as BlobPart], { type: "video/mp4" });
  } finally {
    progressSink = null;
    await releaseOnce();
    await ff.deleteFile(outName).catch(() => undefined);
  }
}

// 把「挂载输入 → 执行 → 释放输入」这套收在一处，保证任何路径下输入都被释放。
function withInput<T>(
  file: File,
  fn: (ff: FFmpegLike, input: InputHandle) => Promise<T>,
): () => Promise<T> {
  return async () => {
    const ff = await getFFmpeg();
    const input = await attachInput(ff, file, "in" + (extOf(file.name) || ".bin"));
    return fn(ff, input);
  };
}

// 只换外壳、不重编码：秒级完成且无损。前提是编码本身浏览器能解。
// 超过 MAX_REMUX_OUTPUT_BYTES 的大文件不拒绝，而是用 -fs 把输出压到上限以内——
// 只重封装前 700MB 的内容。大文件改用 fragmented MP4（frag_keyframe+empty_moov），
// 边写边落 moof，即使被 -fs 截断也能播到最后一个完整片段；+faststart 依赖末尾的
// moov 重写，截断后很可能拿不到 moov 导致整片无法播放，所以大文件不能用它。
export function remux(file: File, onProgress?: ProgressHandler): Promise<Blob> {
  return serialize(
    withInput(file, (ff, input) => {
      const args = ["-i", input.path, "-c", "copy"];
      if (file.size > MAX_REMUX_OUTPUT_BYTES) {
        args.push("-fs", String(MAX_REMUX_OUTPUT_BYTES), "-movflags", "frag_keyframe+empty_moov");
      } else {
        args.push("-movflags", "+faststart");
      }
      args.push("out.mp4");
      return run(ff, input, "out.mp4", args, onProgress);
    }),
  );
}

// 视频能播、音频不能播（AC-3/DTS/LPCM 等 Chrome 解不了）：视频原样 copy、
// 音频转 AAC。比全转码快得多，视频也零损失。大文件同样只处理前 700MB。
export function remuxWithAudio(file: File, onProgress?: ProgressHandler): Promise<Blob> {
  return serialize(
    withInput(file, (ff, input) => {
      const args = ["-i", input.path, "-c:v", "copy", "-c:a", "aac", "-b:a", "96k"];
      if (file.size > MAX_REMUX_OUTPUT_BYTES) {
        args.push("-fs", String(MAX_REMUX_OUTPUT_BYTES), "-movflags", "frag_keyframe+empty_moov");
      } else {
        args.push("-movflags", "+faststart");
      }
      args.push("out.mp4");
      return run(ff, input, "out.mp4", args, onProgress);
    }),
  );
}

// 真转码。wasm 里 x264 比原生慢好几倍，整片转完不现实，所以只做前 N 秒的预览，
// 顺带降到 480p 进一步压缩耗时。
export function transcodePreview(
  file: File,
  seconds: number,
  onProgress?: ProgressHandler,
): Promise<Blob> {
  return serialize(
    withInput(file, (ff, input) =>
      run(
        ff,
        input,
        "out.mp4",
        [
          "-i", input.path,
          "-t", String(seconds),
          // 用命名参数避开 min()/逗号在 filter 串里的转义坑
          "-vf", "scale=w=854:h=480:force_original_aspect_ratio=decrease:force_divisible_by=2",
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-crf", "28",
          "-pix_fmt", "yuv420p",
          "-c:a", "aac",
          "-b:a", "96k",
          "-movflags", "+faststart",
          "out.mp4",
        ],
        onProgress,
      ),
    ),
  );
}
