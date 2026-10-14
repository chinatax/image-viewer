// 视频瓦片缩略图：抽一帧 → canvas → WebP，产出物交给 cache.ts 那条既有的
// 「内存 → IndexedDB 核验 → 现生成」管线，和图片缩略图完全同构。
//
// 只做两类格式（见 media.ts 的 strategyFor）：
//   native   —— mp4/mov/webm/ogv…，<video> 直接解码，seek 到 10% 处抽帧，秒级
//   transmux —— ts/m2ts/mts/flv，先用 mpegts.js 转封装成 fMP4 喂 MSE，再抽帧
//                （AVCHD 那种 AC-3 音轨的 mts 靠 withLenientMSE 只接视频轨，见下）
// mkv/avi/wmv/mpg/mpeg 要 ffmpeg.wasm 真解码，代价高一个数量级，故意不做，
// 由调用方保持 ▶ 占位符。手机端也不生成（解码费电），由 Browser 侧门控。

import { canvasToWebp, thumbCanvas } from "./cache";
import { mimeFor, strategyFor, transmuxTypeFor } from "./media";

// 读 metadata 的预算，对齐 VideoModal 的 NATIVE_TIMEOUT_MS。
const NATIVE_TIMEOUT_MS = 8000;
// 单个任务的总额。分步超时加起来会让一个坏文件占住闸门太久。
const TOTAL_TIMEOUT_MS = 12000;
// 转封装路只读文件头这么多字节。mpegts 探测只需要 ~1.6KB，一个 GOP 最多几 MB，
// 8MB 对 24Mbps 的 AVCHD 约 2.7 秒，足够抽到第一帧。
const TRANSMUX_SLICE_BYTES = 8 * 1024 * 1024;
// 转封装路从文件头开播，先走这么多秒再抽，避开黑场/淡入。
const TRANSMUX_MIN_PLAY_S = 0.5;
// 等不到播放推进时的兜底宽限。
const TRANSMUX_GRACE_MS = 1500;
const MAX_FAILURES = 500;

const OFFSCREEN =
  "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";

// 这个扩展名能不能自动出缩略图。
export function canThumbVideo(name: string): boolean {
  const s = strategyFor(name);
  return s === "native" || s === "transmux";
}

// ---------- 并发闸门 ----------
// 抽帧要解码视频，比图片缩略图贵得多，必须限量。
//
// 两条 lane 各自独立：原生路 ~百毫秒级，转封装路要建 MediaSource + 读几 MB + 解复用，
// 1–3 秒。共用一条 FIFO 的话，DCIM 那种 jpg+mp4+mts 混装的目录里，便宜的 mp4 会排在
// 昂贵的 mts 后面。
//
// 写法上只有一条铁律：release() 必须恰好执行一次。计数一旦泄漏（少还一次），
// 闸门就永久卡死、后面所有缩略图都不再生成，而且不可恢复。
// 所以：acquire() 永不 reject；取消**不参与排队**（排到的任务自己看一眼 signal 就走），
// 于是不可能出现「从等待队列里摘掉一条但计数没对上」的情况。
interface Gate {
  acquire(): Promise<void>;
  release(): void;
}

function makeGate(max: number): Gate {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    acquire(): Promise<void> {
      if (active < max) {
        active++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    release(): void {
      const next = waiters.shift();
      if (next) next(); // 槽位直接转交给下一位，active 不变
      else active--;
    },
  };
}

const nativeGate = makeGate(2);
const transmuxGate = makeGate(1);

// 暂停取新任务（用户在看大图/播视频时别跟播放器抢解码资源）。用模块级开关而不是
// 组件 prop —— prop 一变所有瓦片都会重跑 effect、关掉弹窗后集体重启。
let paused = false;
let unpauseWaiters: Array<() => void> = [];

export function setVideoThumbPaused(next: boolean): void {
  paused = next;
  if (!next) {
    const waiting = unpauseWaiters;
    unpauseWaiters = [];
    for (const w of waiting) w();
  }
}

function waitUnpaused(): Promise<void> {
  if (!paused) return Promise.resolve();
  return new Promise<void>((resolve) => unpauseWaiters.push(resolve));
}

// ---------- 负面缓存 ----------
// 记下「这个文件抽不出帧」，避免每次挂载/每次换目录都重解码一遍。没有它的话，
// H.265 的 .mp4/.mov 在没装 HEVC 扩展的桌面 Chrome 上是 100% 失败，一个文件夹
// 几十个文件会每次进来都白烤一遍 CPU。
const failures = new Map<string, true>();

function failKey(name: string, file: File): string {
  return `${name}|${file.size}|${file.lastModified}`;
}

export function resetVideoThumbState(): void {
  failures.clear();
  paused = false;
  const waiting = unpauseWaiters;
  unpauseWaiters = [];
  for (const w of waiting) w();
}

// 只有「真的试过了、而且不是因为用户走了/标签页在后台」才记账 —— 否则滚出视口、
// 切标签页造成的超时会被记成「这个文件解不了」，一次会话内永久拉黑。
function rememberFailure(key: string): void {
  if (failures.size >= MAX_FAILURES) {
    const oldest = failures.keys().next().value as string | undefined;
    if (oldest !== undefined) failures.delete(oldest);
  }
  failures.set(key, true);
}

// ---------- 主入口 ----------

export async function makeVideoThumbnail(
  file: File,
  name: string,
  signal?: AbortSignal
): Promise<Blob | null> {
  const key = failKey(name, file);
  if (failures.has(key)) return null;

  const transmux = strategyFor(name) === "transmux";
  const gate = transmux ? transmuxGate : nativeGate;

  await waitUnpaused();
  await gate.acquire();
  try {
    if (signal?.aborted) return null; // 排队期间用户已经翻页/关页面：立刻还槽
    if (document.hidden) return null; // 后台标签页里解码会被节流，超时结果不可信

    const blob = transmux
      ? await transmuxThumb(file, name, signal)
      : await nativeThumb(file, name, signal);
    if (blob) return blob;

    if (!signal?.aborted && !document.hidden) rememberFailure(key);
    return null;
  } catch {
    return null;
  } finally {
    gate.release(); // 抛出 / 返回 / 取消都只走这一条路
  }
}

// ---------- 原生路 ----------

async function nativeThumb(
  file: File,
  name: string,
  signal?: AbortSignal
): Promise<Blob | null> {
  // 用 slice 换 MIME 而不是 new Blob：惰性引用，不复制整个文件（VideoModal 同款）。
  const url = URL.createObjectURL(file.slice(0, file.size, mimeFor(name)));
  const v = createOffscreenVideo();
  const st = watchErrors(v);
  const deadline = newDeadline(TOTAL_TIMEOUT_MS);

  try {
    v.src = url;

    // 等时长，好把抽帧点挪开片头。读不出来（NaN/Infinity）就退回取首帧。
    await waitEvent(v, ["loadedmetadata", "loadeddata"], NATIVE_TIMEOUT_MS, signal);
    const at = frameTime(v.duration);
    if (at !== null) v.currentTime = at;

    let canvas = await grabCanvas(v, st, deadline, signal, {});
    if (canvas && isBlankCanvas(canvas)) {
      // 10% 处正好是黑场（片头字幕/夜间场景）。退到 50% 再试一次，
      // 仍然空白就当失败 —— 绝不把一张黑图写进缓存：它带着正确的 size/mtime，
      // 之后每次核验都会通过，用户就永远看不到真正的画面了。
      const alt = altFrameTime(v.duration);
      if (alt !== null) {
        v.currentTime = alt;
        canvas = await grabCanvas(v, st, deadline, signal, {});
      }
    }
    if (!canvas || isBlankCanvas(canvas)) return null;
    return await canvasToWebp(canvas);
  } finally {
    teardownVideo(v, st, url);
  }
}

// ---------- 「没声音也要出图」补丁 ----------
//
// AVCHD 摄像机（Sony/Panasonic 的 .mts/.m2ts）音轨是 AC-3，而 Chrome 的 MSE 没有
// AC-3 解码器：mpegts.js 转封装出 `audio/mp4;codecs=ac-3` 去 addSourceBuffer 会直接抛
// "The type provided is unsupported"，整个 player 走 ERROR —— 于是**恰恰是最典型的那类
// .mts** 一张缩略图都出不来（视频轨本身好得很）。
//
// 我们要的只是一帧画面，音轨有没有解码器根本不影响。所以：在 mpegts 建 MediaSource
// 的那一瞬间，把 window.MediaSource 换成一个「音频轨建不起来就给个空转 SourceBuffer」
// 的版本，建完立刻还原。
//
// 两个刻意的收紧：
//   * 只放行 audio/*。视频轨（如 HEVC 在没有硬解的机器上）建不起来必须照原样抛，
//     让 mpegts 走 ERROR，我们当场收工 —— 否则要白等到 12 秒超时，还占着闸门名额。
//   * 补丁只在 attachMediaElement 那一下生效。MediaSource 实例是在里面**同步**
//     new 出来的（mpegts 的 MSEController.initialize），创建出来之后这个实例就带着
//     自己的 addSourceBuffer 了，全局换回去不影响它 —— 所以窗口小到不会波及
//     同时在播的 VideoModal。
function sinkSourceBuffer(): SourceBuffer {
  const listeners: Record<string, Array<(e: Event) => void>> = {};
  const fire = (type: string) => {
    for (const fn of listeners[type] || []) fn({ type } as Event);
  };
  const sb = {
    updating: false,
    mode: "segments",
    timestampOffset: 0,
    appendWindowStart: 0,
    appendWindowEnd: Infinity,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    // mpegts 靠 updateend 推进它的队列，吞掉不回调会把转封装卡死；数据本身丢掉即可。
    appendBuffer() {
      window.setTimeout(() => fire("updateend"), 0);
    },
    remove() {
      window.setTimeout(() => fire("updateend"), 0);
    },
    abort() {},
    addEventListener(type: string, fn: (e: Event) => void) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type: string, fn: (e: Event) => void) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
  };
  return sb as unknown as SourceBuffer;
}

function withLenientMSE<T>(fn: () => T): T {
  const Native = window.MediaSource;
  if (typeof Native !== "function") return fn(); // 没有 MSE 就没得补，照原样跑

  function LenientMediaSource() {
    const ms = new Native();
    const add = ms.addSourceBuffer.bind(ms);
    ms.addSourceBuffer = (mime: string) => {
      try {
        return add(mime);
      } catch (e) {
        if (!mime.startsWith("audio/")) throw e;
        return sinkSourceBuffer();
      }
    };
    return ms;
  }

  window.MediaSource = LenientMediaSource as unknown as typeof MediaSource;
  try {
    return fn();
  } finally {
    window.MediaSource = Native;
  }
}

async function transmuxThumb(
  file: File,
  name: string,
  signal?: AbortSignal
): Promise<Blob | null> {
  // 动态 import：mpegts.js 约 200KB，别让它进主 chunk（VideoModal 也是这么做的）。
  const mpegts = (await import("mpegts.js")).default;
  if (signal?.aborted) return null;

  const slice = file.slice(0, TRANSMUX_SLICE_BYTES, mimeFor(name));
  const url = URL.createObjectURL(slice);
  const v = createOffscreenVideo();
  const st = watchErrors(v);
  const deadline = newDeadline(TOTAL_TIMEOUT_MS);
  let player: MpegtsPlayer | null = null;

  try {
    // isLive: true 很关键。isLive:false 会打开 lazyLoad / 前向 seek 那条路，
    // 而我们喂的是一个有限的切片，那条路会去重连、找时长，白折腾。
    // 切片截断本身不会报错：FetchStreamLoader 的 EARLY_EOF 判据是
    // receivedLength < contentLength，而 objectURL 是从切片建的，两者自洽。
    player = mpegts.createPlayer(
      { type: transmuxTypeFor(name), url, isLive: true },
      { seekType: "range", lazyLoad: false }
    ) as unknown as MpegtsPlayer;

    // ERROR 回调里只标记，不 destroy —— destroy 撞上 mpegts 自己的事件分发会把
    // 已置空的 _emitter 打爆（VideoModal 踩过）。真正的销毁在 finally 里。
    player.on(mpegts.Events.ERROR, () => {
      st.errored = true;
    });

    const p0 = player;
    withLenientMSE(() => p0.attachMediaElement(v));
    player.load();
    const p = player.play() as unknown;
    if (p && typeof (p as Promise<void>).catch === "function") {
      (p as Promise<void>).catch(() => undefined);
    }

    // 从文件头开播，先走 TRANSMUX_MIN_PLAY_S 秒再抽，避开片头的黑帧。
    // MSE 必须有播放驱动才解码，所以这条路不能像原生路那样只 seek。
    let canvas = await grabCanvas(v, st, deadline, signal, {
      minTime: TRANSMUX_MIN_PLAY_S,
      graceMs: TRANSMUX_GRACE_MS,
    });
    if (canvas && isBlankCanvas(canvas)) {
      // 再往前播一小段试试（黑场淡入、镜头从暗处开始）。
      const from = v.currentTime + 1;
      const sub = newDeadline(3000);
      canvas = await grabCanvas(v, st, sub, signal, { minTime: from, graceMs: 2500 });
    }
    if (!canvas || isBlankCanvas(canvas)) return null;
    return await canvasToWebp(canvas);
  } finally {
    // 先置空引用再 destroy：MSEPlayer.destroy() 之后 _player_engine 为 null，
    // 二次 destroy 会直接抛。
    const dying = player;
    player = null;
    if (dying) {
      // 让出一次事件循环，避开 mpegts 内部 emit 与 destroy 的竞态。
      await new Promise<void>((r) => window.setTimeout(r, 0));
      try {
        dying.destroy();
      } catch {
        /* 库内部状态已乱，销毁失败不影响抽帧结果 */
      }
    }
    teardownVideo(v, st, url);
  }
}

// ---------- 共用工具 ----------

interface MpegtsPlayer {
  on(event: string, fn: (...args: unknown[]) => void): void;
  attachMediaElement(el: HTMLVideoElement): void;
  load(): void;
  play(): Promise<void> | void;
  destroy(): void;
}

interface Budget {
  t0: number;
  total: number;
}

function newDeadline(total: number): Budget {
  return { t0: Date.now(), total };
}

function budgetLeft(b: Budget): number {
  return b.total - (Date.now() - b.t0);
}

function isAborted(signal?: AbortSignal): boolean {
  return !!signal?.aborted;
}

// 离屏但**挂进 DOM**：display:none 会抑制解码/呈现，用定位推出画面外。
function createOffscreenVideo(): HTMLVideoElement {
  const v = document.createElement("video");
  v.muted = true; // 必须在 play() 之前设，否则自动播放策略会拒绝
  v.defaultMuted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.tabIndex = -1;
  v.setAttribute("aria-hidden", "true");
  v.style.cssText = OFFSCREEN;
  document.body.appendChild(v);
  return v;
}

interface Watch {
  errored: boolean;
  onError: () => void;
}

function watchErrors(v: HTMLVideoElement): Watch {
  const st: Watch = { errored: false, onError: () => (st.errored = true) };
  v.addEventListener("error", st.onError);
  return st;
}

function teardownVideo(v: HTMLVideoElement, st: Watch, url: string): void {
  // 顺序要紧：**先摘监听**（下面清 src / 停播放都会造出 error 事件，还挂着的监听
  // 会把「我们自己拆的」当成「这个文件解不了」），再清 src，最后才 revoke ——
  // 先 revoke 同样会造出 error。
  v.removeEventListener("error", st.onError);
  try {
    v.pause();
    v.removeAttribute("src");
    v.load();
    v.remove();
  } catch {
    /* 忽略：元素已经不在文档里也无所谓 */
  }
  URL.revokeObjectURL(url);
}

// 等一个事件，最多 ms 毫秒；信号取消或超时也照常返回（调用方回去重查条件即可）。
// 只当「早点醒」用，不作判据 —— 判据永远是 readyState。
function waitEvent(
  el: EventTarget,
  types: string[],
  ms: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    let timer = 0;
    let done = false;
    const handlers: Array<[string, () => void]> = [];
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      for (const [type, h] of handlers) el.removeEventListener(type, h);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    for (const type of types) handlers.push([type, finish]);
    for (const [type, h] of handlers) el.addEventListener(type, h);
    signal?.addEventListener("abort", finish);
    timer = window.setTimeout(finish, ms);
    if (signal?.aborted) finish();
  });
}

// 抽帧的落点：10% 处、最多 3 秒。片头通常有黑场/台标，10% 一般已经进入正片。
// 拿不到可靠时长（NaN/Infinity，某些流式封装）就返回 null，由调用方取首帧。
function frameTime(duration: number): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return Math.min(duration * 0.1, 3);
}

// 10% 处抽到空白帧时的备选落点。
function altFrameTime(duration: number): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return Math.min(duration * 0.5, 30);
}

// 等「有帧可画」再画：readyState >= 2（HAVE_CURRENT_DATA）就够了，drawImage 不需要
// 合成、不需要播放，也**不能**用 requestAnimationFrame / requestVideoFrameCallback
// 当判据 —— 后台标签页不合成，rAF 根本不触发、rVFC 永不回调，那样任务会一直占到超时，
// 而它占着闸门名额，会把后面所有瓦片一起拖死。
//
// minTime: 要求播放头走到某一时刻再抽（转封装路用，避开片头黑帧）；
// graceMs: 到点还没走到的兜底宽限（有些流播放头不推进），超过就先抽一帧看看。
async function grabCanvas(
  v: HTMLVideoElement,
  st: Watch,
  deadline: Budget,
  signal: AbortSignal | undefined,
  opts: { minTime?: number; graceMs?: number }
): Promise<HTMLCanvasElement | null> {
  const waitedFrom = Date.now();
  while (budgetLeft(deadline) > 0 && !isAborted(signal) && !st.errored) {
    const ready = !v.seeking && v.readyState >= 2 && v.videoWidth > 0;
    const far = opts.minTime === undefined || v.currentTime >= opts.minTime;
    const graced = opts.graceMs !== undefined && Date.now() - waitedFrom >= opts.graceMs;
    if (ready && (far || graced)) {
      const canvas = thumbCanvas(v, v.videoWidth, v.videoHeight);
      if (canvas) return canvas;
    }
    await waitEvent(
      v,
      ["loadeddata", "canplay", "seeked", "timeupdate", "progress", "error"],
      Math.min(250, Math.max(0, budgetLeft(deadline))),
      signal
    );
  }
  return null;
}

// 空白帧判定：又黑又平（片头黑场、解不出的花屏）不算数。
// 缩小到 16×16 再求亮度均值/标准差，几十微秒的事。同源 blob/MSE，canvas 不会被污染。
function isBlankCanvas(canvas: HTMLCanvasElement): boolean {
  try {
    const small = document.createElement("canvas");
    small.width = 16;
    small.height = 16;
    const ctx = small.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(canvas, 0, 0, 16, 16);
    const { data } = ctx.getImageData(0, 0, 16, 16);
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += y;
      sum2 += y * y;
      n++;
    }
    if (!n) return false;
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    return mean < 10 && sd < 6;
  } catch {
    return false; // 判不了就当它是有效帧，别把好帧误杀
  }
}
