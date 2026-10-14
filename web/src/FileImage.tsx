import { useEffect, useRef, useState } from "react";
import type { FileLike } from "./fs";
import {
  getThumb,
  putThumb,
  getStoredThumb,
  putStoredThumb,
  makeThumbnail,
} from "./cache";
import { canThumbVideo, makeVideoThumbnail } from "./videoThumb";

// Renders a local file as a thumbnail <img>. Loads lazily (only when scrolled
// into view), then resolves the thumbnail from: 内存 → IndexedDB → 现生成。
// 生成后回写内存 + IndexedDB，二次进入 / 下次打开页面都是秒开。
//
// 内存命中直接信任（本会话刚生成/核验过，不再摸盘）；IndexedDB 命中先拿真实文件的
// size/mtime 核验 —— 缓存键只用文件夹名拼路径，另一个盘的同名文件夹、被覆盖的同名
// 文件都会落在同一个键上，对不上就重新生成。
//
// 显示出来的那张图，连同"它是为哪个键、哪个文件加载的"一起存（见 Loaded）。
// 瓦片在 Browser 里是按**序号**做 React key 的，所以换目录、并进来一个新根文件夹之后，
// 同一个瓦片位置换成了另一个文件，组件实例和它的 state 却留着 —— 只存一个裸 url 的话，
// 加载 effect 会认为"已经有了"而直接返回，瓦片就一直挂着上一个文件的对象 URL，
// 显示成别人的图（点开大图才发现对不上）。键或文件对不上就当没加载过。
interface Loaded {
  key: string | undefined;
  handle: FileLike;
  url: string;
}

// 视频进视口后延迟这么久才真正开工。IntersectionObserver 的 rootMargin 有 200px，
// 快速滚动时一大批瓦片会同时进视口；延迟一下，划过去的瓦片就完全不产生解码工作
// （视频抽帧比图片贵一个数量级）。图片不加延迟，行为和以前一字不差。
const VIDEO_QUEUE_DELAY_MS = 300;

export default function FileImage({
  handle,
  name = "",
  cacheKey,
  alt = "",
  isVideo = false,
  allowVideoThumb = false,
}: {
  handle: FileLike;
  name?: string;
  cacheKey?: string;
  alt?: string;
  isVideo?: boolean;
  allowVideoThumb?: boolean;
}) {
  // 视频只有「桌面端（调用方门控）+ 原生/mpegts 能解的格式」才走这条加载链路；
  // 其余（mkv/avi/wmv/mpg、手机上的所有视频）保持占位符，和以前一样。
  const canLoad = !!cacheKey && (!isVideo || (allowVideoThumb && canThumbVideo(name)));

  const [loaded, setLoaded] = useState<Loaded | null>(() => {
    if (!canLoad || !cacheKey) return null;
    const mem = getThumb(cacheKey);
    return mem && mem.handle === handle ? { key: cacheKey, handle, url: mem.url } : null;
  });
  const url =
    loaded && loaded.key === cacheKey && loaded.handle === handle ? loaded.url : null;
  const [inView, setInView] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 懒加载：未命中缓存时，进入视口才真正取文件生成缩略图。
  useEffect(() => {
    if (!canLoad || url) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [canLoad, url]);

  // 取缩略图：内存 → IndexedDB（核验后）→ 现生成并持久化。
  useEffect(() => {
    if (!canLoad || url || !inView || !cacheKey) return;
    let cancelled = false;
    // 真取消：换目录/换根/清缓存时不只是丢弃结果，还要把正在跑的解码停掉
    //（视频抽帧很贵，只丢结果等于白烤 CPU）。
    const ac = new AbortController();

    const start = window.setTimeout(
      () => {
        (async () => {
          try {
            // 内存命中就秒开 —— 但得确认这条是**自己这个文件**填的：合并根下两个不同文件夹
            // 里的同名文件共用一个键，内存只留得下先来的那条。不是自己的就往下走核验流程。
            const mem = getThumb(cacheKey);
            if (mem && mem.handle === handle) {
              if (!cancelled) setLoaded({ key: cacheKey, handle, url: mem.url });
              return;
            }

            const file = await handle.getFile();
            if (cancelled) return;
            const meta = { size: file.size, mtime: file.lastModified };

            // 持久层命中还不够，得确认这张缩略图确实是**这个**文件生成的。
            const stored = await getStoredThumb(cacheKey);
            if (cancelled) return;
            if (stored && stored.size === meta.size && stored.mtime === meta.mtime) {
              const objUrl = URL.createObjectURL(stored.blob);
              if (cancelled) {
                URL.revokeObjectURL(objUrl);
                return;
              }
              putThumb(cacheKey, objUrl, meta, handle);
              setLoaded({ key: cacheKey, handle, url: objUrl });
              return;
            }

            // 没命中，或命中的是别的文件/旧内容 —— 重新生成。
            // 图片走 <img> 解码；视频抽一帧（见 videoThumb.ts）。
            const blob = isVideo
              ? await makeVideoThumbnail(file, name, ac.signal)
              : await makeThumbnail(file);
            if (cancelled) return;
            if (!blob) return; // 生成不了（HEIC/TIFF、浏览器解不了的视频编码等），保持占位
            const objUrl = URL.createObjectURL(blob);
            // 用户已经翻页/清缓存了就什么都别写 —— 否则这张图会把刚清掉的缓存复活。
            if (cancelled) {
              URL.revokeObjectURL(objUrl);
              return;
            }
            putThumb(cacheKey, objUrl, meta, handle);
            putStoredThumb(cacheKey, blob, meta); // 后台持久化，不阻塞显示
            setLoaded({ key: cacheKey, handle, url: objUrl });
          } catch {
            /* 读取失败，保持占位 */
          }
        })();
      },
      isVideo ? VIDEO_QUEUE_DELAY_MS : 0
    );

    return () => {
      cancelled = true;
      window.clearTimeout(start);
      ac.abort();
    };
  }, [canLoad, url, inView, handle, cacheKey, isVideo, name]);

  return (
    <div className="tile-img" ref={wrapRef}>
      {url ? <img src={url} alt={alt} /> : <div className="tile-placeholder" />}
    </div>
  );
}
