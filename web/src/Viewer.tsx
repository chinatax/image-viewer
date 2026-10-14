import { useCallback, useEffect, useRef, useState } from "react";
import type { FSEntry } from "./fs";
import { t } from "./i18n";

interface Props {
  images: FSEntry[];
  index: number;
  auto: boolean;
  onClose: () => void;
}

export default function Viewer({ images, index, auto, onClose }: Props) {
  const [cur, setCur] = useState(index);
  const [playing, setPlaying] = useState(auto);
  const [zoom, setZoom] = useState(false); // false = fit, true = 1:1
  const [intervalSec, setIntervalSec] = useState(1);
  const [url, setUrl] = useState<string | null>(null);

  const next = useCallback(() => setCur((c) => (c + 1) % images.length), [images.length]);
  const prev = useCallback(
    () => setCur((c) => (c - 1 + images.length) % images.length),
    [images.length]
  );

  // 触屏左右滑动翻页。翻页没有按钮，桌面上靠键盘 ← →，手机上靠滑动。
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const justSwiped = useRef(false);

  const onTouchStart = (e: React.TouchEvent) => {
    const p = e.touches[0];
    touchStart.current = { x: p.clientX, y: p.clientY };
    justSwiped.current = false;
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const p = e.changedTouches[0];
    const dx = p.clientX - start.x;
    const dy = p.clientY - start.y;
    // 必须是明确的横向位移才翻页，否则会把"点一下关掉"和竖向滚动误判成翻页
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      justSwiped.current = true;
      if (dx < 0) next();
      else prev();
    }
  };

  // 滑动结束后浏览器还会补一个 click，别让它顺手把查看器关掉
  const onStageClick = () => {
    if (justSwiped.current) {
      justSwiped.current = false;
      return;
    }
    onClose();
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, onClose]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(next, intervalSec * 1000);
    return () => clearInterval(id);
  }, [playing, intervalSec, next]);

  useEffect(() => {
    let cancelled = false;
    let objUrl: string | null = null;
    const h = images[cur]?.handle;
    if (!h) return;
    h.getFile()
      .then((file) => {
        if (cancelled) return;
        objUrl = URL.createObjectURL(file);
        setUrl(objUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [images, cur]);

  if (!images.length) return null;
  const name = images[cur]?.name ?? "";

  return (
    <div className="viewer">
      <div className="viewer-top">
        <span className="counter">
          {cur + 1} / {images.length} — {name}
        </span>
        <div className="viewer-actions">
          {/* 只显示图标；文字放进 title/aria-label 供鼠标悬停与读屏 */}
          <button
            className="btn"
            title={playing ? t("viewer.pause") : t("viewer.play")}
            aria-label={playing ? t("viewer.pause") : t("viewer.play")}
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? "⏸" : "▶"}
          </button>
          <button className="btn" onClick={() => setZoom((z) => !z)}>
            {zoom ? t("viewer.fit") : "1:1"}
          </button>
          <label className="interval">
            {t("viewer.interval")}
            <input
              type="number"
              min={1}
              step={1}
              value={intervalSec}
              onChange={(e) => setIntervalSec(Math.max(1, Number(e.target.value)))}
            />
            {t("viewer.seconds")}
          </label>
          <button className="btn" onClick={onClose}>{t("viewer.close")}</button>
        </div>
      </div>
      <div className="viewer-stage" onClick={onStageClick} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {url ? (
          <img
            src={url}
            className={zoom ? "zoom" : "fit"}
            alt={name}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="tile-placeholder" />
        )}
      </div>
    </div>
  );
}
