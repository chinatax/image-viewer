import { useEffect, useRef, useState } from "react";
import type { FSEntry } from "./fs";
import { humanSize, mimeFor, strategyFor, transmuxTypeFor } from "./media";
import { t } from "./i18n";
import {
  MAX_REMUX_OUTPUT_BYTES,
  isFFmpegReady,
  probe,
  remux,
  remuxWithAudio,
  transcodePreview,
  getCachedConvert,
  storeConvert,
  invalidateConvert,
} from "./ffmpegTools";

// 播不了的视频靠三级降级救回来，全部自动，用户不需要点任何按钮：
//   1. 原生 <video>          —— mp4/webm 到这就成了
//   2. mpegts.js 转封装      —— ts/m2ts/mts/flv，秒级、硬件解码
//   3. ffmpeg.wasm           —— 容器/编码解不了，自动探测后重封装或转码预览
// 转换结果有内存缓存：同一个文件反复打开直接复用，不重复解码。

const PREVIEW_SECONDS = 60;

// 原生 <video> 有时既不报错也不出元数据——容器认得、内部结构不对，就这么挂着。
// 光等 onError 会永远等下去，所以要配个超时兜底。
const NATIVE_TIMEOUT_MS = 8000;

type Stage = "native" | "transmux" | "converting" | "playing";
type Op = "remux" | "transcode" | null;

interface MpegtsPlayer {
  destroy(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
  attachMediaElement(el: HTMLMediaElement): void;
  detachMediaElement(): void;
  load(): void;
  play(): Promise<void> | void;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export default function VideoModal({ entry, onClose }: { entry: FSEntry; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("native");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<File | null>(null);
  const urlRef = useRef<string | null>(null);
  const playerRef = useRef<MpegtsPlayer | null>(null);
  const timerRef = useRef<number | null>(null);
  // 异步回调里读到的必须是「当前」阶段，state 在闭包里会过期。
  const stageRef = useRef<Stage>("native");
  const opRef = useRef<Op>(null);
  // probe 识别到的视频编码，失败时拼进报错，方便定位（如 VC-1）。
  const codecRef = useRef<string>("");
  // 事件处理器每次渲染都会重建，这里留一个引用给定时器之类的非渲染路径用。
  const fallbackRef = useRef<() => void>(() => undefined);

  function go(s: Stage) {
    stageRef.current = s;
    setStage(s);
  }

  function stopPlayer() {
    const p = playerRef.current;
    playerRef.current = null;
    if (p) {
      try {
        p.destroy();
      } catch {
        /* 已经销毁过就算了 */
      }
    }
  }

  function clearTimer() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function fallbackFromNative() {
    clearTimer();
    if (strategyFor(entry.name) === "transmux") {
      void startTransmux();
    } else {
      // mp4/mkv/avi/wmv/mpg 等原生失败，一律自动交给 ffmpeg 兜底，无需用户确认。
      void startFFmpeg(false);
    }
  }

  async function startTransmux() {
    const f = fileRef.current;
    const v = videoRef.current;
    if (!f || !v) return;
    go("transmux");
    setNote(t("video.remuxing"));
    setError("");
    try {
      const mpegts = (await import("mpegts.js")).default;
      if (!mpegts.getFeatureList().mseLivePlayback) {
        void startFFmpeg(false);
        return;
      }
      const url = urlRef.current;
      if (!url) return;
      // 把 <video> 从原生 src 上摘下来，交给 MSE 接管。
      v.removeAttribute("src");
      v.load();
      const player = mpegts.createPlayer(
        { type: transmuxTypeFor(entry.name), url, isLive: false },
        // 不开 worker：本地文件转封装本来就快，而 worker 打包在 Vite 下更容易出岔子。
        { seekType: "range" },
      ) as unknown as MpegtsPlayer;
      playerRef.current = player;
      // mpegts 也失败（如 AC-3 音轨的 AVCHD、MPEG-2 编码的 ts）→ 落到 ffmpeg 兜底。
      // 延到下一个 tick 再切：ERROR 是在 mpegts 自己的事件分发里抛出来的，当场
      // destroy 会让它随后的内部 emit 撞上已置空的 _emitter，抛
      // "Cannot read properties of null (reading 'emit')"。让出一次事件循环即可。
      // 同时用 stage 挡一道，避免多次 ERROR 触发重复转换。
      player.on(mpegts.Events.ERROR, () => {
        if (stageRef.current !== "transmux") return;
        window.setTimeout(() => {
          if (stageRef.current === "transmux") void startFFmpeg(false);
        }, 0);
      });
      player.attachMediaElement(v);
      player.load();
      const p = player.play() as unknown;
      if (p && typeof (p as Promise<void>).catch === "function") {
        (p as Promise<void>).catch(() => undefined);
      }
      setNote("");
    } catch (e) {
      void startFFmpeg(false);
    }
  }

  async function startFFmpeg(forceTranscode: boolean) {
    const f = fileRef.current;
    if (!f) return;
    stopPlayer();
    clearTimer();
    setError("");

    // forceTranscode 意味着「上次产物播不了」，跳过缓存强制真转码；否则先复用缓存。
    // 优先 transcode（编码层面重编过、更保险），其次 remux。
    if (!forceTranscode) {
      const cached = getCachedConvert(f, "transcode") ?? getCachedConvert(f, "remux");
      if (cached) {
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = cached;
        setSrc(cached);
        setNote(t("video.reused"));
        go("playing");
        return;
      }
    }

    go("converting");
    setProgress(0);
    try {
      let blob: Blob;
      if (forceTranscode) {
        setNote(t("video.transcodePreview", { seconds: PREVIEW_SECONDS }));
        opRef.current = "transcode";
        blob = await transcodePreview(f, PREVIEW_SECONDS, setProgress);
      } else {
        setNote(isFFmpegReady() ? t("video.analyzing") : t("video.loadingDecoder"));
        const info = await probe(f);
        codecRef.current = info.video;
        if (info.playable) {
          // 视频、音频浏览器都能解 → 只换外壳（无损、秒级）。
          const big = f.size > MAX_REMUX_OUTPUT_BYTES;
          setNote(
            big
              ? t("video.remuxLarge", {
                  codec: info.video,
                  size: humanSize(MAX_REMUX_OUTPUT_BYTES),
                })
              : t("video.remux", { codec: info.video }),
          );
          opRef.current = "remux";
          blob = await remux(f, setProgress);
        } else if (info.videoPlayable) {
          // 视频能解、音频不能解（AC-3/DTS/LPCM）→ 只转音频，视频零损失。
          const big = f.size > MAX_REMUX_OUTPUT_BYTES;
          const audio = info.audio || t("video.unknownCodec");
          setNote(
            big
              ? t("video.audioLarge", { audio, size: humanSize(MAX_REMUX_OUTPUT_BYTES) })
              : t("video.audioRecode", { audio }),
          );
          opRef.current = "remux";
          blob = await remuxWithAudio(f, setProgress);
        } else {
          setNote(
            t("video.needTranscode", {
              codec: info.video || t("video.unknownCodec"),
              seconds: PREVIEW_SECONDS,
            }),
          );
          opRef.current = "transcode";
          blob = await transcodePreview(f, PREVIEW_SECONDS, setProgress);
        }
      }
      const url = storeConvert(f, blob, opRef.current === "remux" ? "remux" : "transcode");
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setSrc(url);
      setNote(
        opRef.current === "remux"
          ? f.size > MAX_REMUX_OUTPUT_BYTES
            ? t("video.remuxedPartial", { size: humanSize(MAX_REMUX_OUTPUT_BYTES) })
            : t("video.remuxed")
          : t("video.transcoded", { seconds: PREVIEW_SECONDS }),
      );
      go("playing");
    } catch (e) {
      setError(t("video.failed", { err: errText(e) }));
      go("native");
    }
  }

  // 交给 <video> 的失败处理：按当前处在哪一级决定往哪降。
  function onVideoError() {
    const s = stageRef.current;
    if (s === "native") {
      fallbackFromNative();
    } else if (s === "transmux") {
      void startFFmpeg(false);
    } else if (s === "playing") {
      if (opRef.current === "remux") {
        // 外壳换好了还是播不了 —— 那就是编码层面的问题，只能真转码。
        if (fileRef.current) invalidateConvert(fileRef.current, "remux");
        void startFFmpeg(true);
      } else {
        if (fileRef.current) invalidateConvert(fileRef.current, "transcode");
        setError(
          t("video.stillUnplayable", {
            codec: codecRef.current || t("video.unknownCodec"),
          }),
        );
        go("native");
      }
    }
  }

  fallbackRef.current = fallbackFromNative;

  // 打开一个条目：读文件、挂一个带明确 MIME 的 object URL 交给原生播放试水。
  useEffect(() => {
    let cancelled = false;
    stopPlayer();
    clearTimer();
    stageRef.current = "native";
    opRef.current = null;
    setStage("native");
    setSrc(null);
    setNote("");
    setError("");
    setProgress(0);

    fileRef.current = null;
    entry.handle
      .getFile()
      .then((f) => {
        if (cancelled) return;
        fileRef.current = f;
        // 用 slice 换 MIME 而不是 new Blob([f])：slice 是惰性引用，
        // 不会把整个文件复制进内存，大文件也不怕。
        const url = URL.createObjectURL(f.slice(0, f.size, mimeFor(f.name)));
        urlRef.current = url;
        setSrc(url);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });

    return () => {
      cancelled = true;
      stopPlayer();
      clearTimer();
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry]);

  // 原生播放的超时兜底。
  useEffect(() => {
    if (stage !== "native" || !src) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (stageRef.current === "native") fallbackRef.current();
    }, NATIVE_TIMEOUT_MS);
    return clearTimer;
  }, [stage, src]);

  // 拿到可播的 URL 后主动 load + play()。load() 必须显式调：从上次失败的 src 切到
  // 新 src 时，若不重载，video 可能带着残留的 error 状态，新产物也不触发 loadedmetadata。
  useEffect(() => {
    if (!src) return;
    const v = videoRef.current;
    if (!v) return;
    v.load();
    const p = v.play();
    if (p && typeof p.catch === "function") p.catch(() => undefined);
  }, [src]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // transmux/converting 阶段 <video> 不挂 src：MSE 由 mpegts 自己接管，
  // 交给 React 管会和它抢同一个属性。
  const managedSrc = stage === "native" || stage === "playing" ? (src ?? undefined) : undefined;
  const busy = stage === "converting";

  return (
    <div className="viewer" onClick={onClose}>
      <div className="viewer-top">
        <span className="counter">{entry.name}</span>
        <button className="btn" onClick={onClose}>{t("viewer.close")}</button>
      </div>
      <div className="viewer-stage video-stage" onClick={(e) => e.stopPropagation()}>
        <video
          ref={videoRef}
          src={managedSrc}
          controls
          autoPlay
          playsInline
          onError={onVideoError}
          onLoadedMetadata={clearTimer}
        />
        {busy && (
          <div className="convert-overlay">
            <div className="convert-box">
              <div className="convert-note">{note}</div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <div className="progress-pct">{Math.round(progress * 100)}%</div>
            </div>
          </div>
        )}
        {note && stage !== "converting" && <div className="video-note">{note}</div>}
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
