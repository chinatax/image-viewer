import { useCallback, useEffect, useRef, useState } from "react";
import {
  isCompatTree,
  isRealDir,
  listDir,
  mergeDirs,
  pickDirectory,
  queryPermission,
  type DirEntry,
  type DirListing,
  type DirRef,
  type FSEntry,
} from "./fs";
import { browserName, buildTree, detectCaps, isFlat, isIosDevice, modeFor, pickViaInput } from "./fallback";
import { getCachedListing, putCachedListing, clearThumbCache } from "./cache";
import { resetVideoThumbState, setVideoThumbPaused } from "./videoThumb";
import { loadDirHandles, saveDirHandles } from "./handles";
import FileImage from "./FileImage";
import Viewer from "./Viewer";
import VideoModal from "./VideoModal";
import { t, type MsgKey } from "./i18n";

interface Crumb {
  name: string;
  handle: DirRef;
}

// 走哪条路取文件：fsa = File System Access API，另两个是 <input> 降级路径。
type PickVia = "fsa" | "folder" | "photos";

// "选择器瞬间失败"的阈值。用户不可能在 150ms 内看完并关掉一个系统对话框，
// 所以这么快就 reject 的 AbortError 只能是浏览器根本没把选择器接上。
const INSTANT_FAIL_MS = 150;

function fullscreenAvailable(): boolean {
  return typeof document !== "undefined" && document.fullscreenEnabled === true;
}

// 触屏没有"双击"，也没有 hover。命中这条的用单击打开、显示"点击打开"。
function detectTouchUI(): boolean {
  if (typeof window === "undefined") return false;
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: none) and (pointer: coarse)").matches
  ) {
    return true;
  }
  // 兜底：matchMedia 在某些内核（鸿蒙兼容层跑 Chrome 等）不可靠时按 UA 判。
  // iPad 必须走 isIosDevice —— iPadOS 的 UA 是 "Macintosh"，这里的老正则漏掉它。
  const ua = navigator.userAgent || "";
  return /Android.*Mobile|iPhone|iPod/i.test(ua) || isIosDevice();
}

function enterFullscreen() {
  if (!fullscreenAvailable()) return;
  try {
    const p = document.documentElement.requestFullscreen();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* 忽略：无用户手势或浏览器不支持时静默失败 */
  }
}

export default function Browser() {
  const [caps] = useState(detectCaps);
  const [touchUI] = useState(detectTouchUI);
  const [fssOk] = useState(fullscreenAvailable);
  const mode = modeFor(caps);

  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  // 当前合并在一起的根文件夹，按用户添加的顺序。长度为 1 时就是老行为（单个根）。
  const [roots, setRoots] = useState<DirRef[]>([]);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [viewer, setViewer] = useState<{ index: number; auto: boolean } | null>(null);
  const [video, setVideo] = useState<FSEntry | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [thumbVersion, setThumbVersion] = useState(0);
  const [cleared, setCleared] = useState(false);
  // 降级模式下这次选中的是什么（folder = 有目录结构，flat = 只有一堆散文件）
  const [pickInfo, setPickInfo] = useState<{ kind: "folder" | "flat"; count: number } | null>(null);
  const [bannerHidden, setBannerHidden] = useState(false);
  // 假实现兜底：浏览器声称支持 showDirectoryPicker，但调用瞬间就 AbortError
  //（华为 ArkWeb M132+ / 某些 WebView）。触发后把「选择照片/视频」按钮亮出来。
  const [photosFallback, setPhotosFallback] = useState(false);
  // 上次选的根文件夹里，有几个因为授权没被记住而没能自动恢复（0 = 都恢复了）
  const [partialRestore, setPartialRestore] = useState(0);
  // 这次会话用的是哪条取文件的路。「切换文件夹」要沿用同一条 —— iOS 上用照片选择器
  // 进来的用户，不该被丢回那个看不见「照片」图库的文件夹选择器。
  const [lastVia, setLastVia] = useState<PickVia>("folder");
  const keepFullscreenRef = useRef(true); // 保持全屏（kiosk 锁）
  const rootIdRef = useRef(0); // 每次选根文件夹递增，作缓存键前缀，避免不同盘同名文件夹冲突

  const current = crumbs.length ? crumbs[crumbs.length - 1].handle : null;

  const navigate = useCallback(
    (dir: DirRef, stack: Crumb[]): Promise<DirListing | undefined> => {
      setLoading(true);
      setError("");
      const pathKey = rootIdRef.current + "/" + stack.map((c) => c.name).join("/");
      const cached = getCachedListing(pathKey);
      if (cached) {
        setCrumbs(stack);
        setListing(cached);
        setLoading(false);
        return Promise.resolve(cached);
      }
      return listDir(dir)
        .then((l) => {
          putCachedListing(pathKey, l);
          setCrumbs(stack);
          setListing(l);
          return l;
        })
        .catch((e) => {
          setError(String(e));
          return undefined;
        })
        .finally(() => setLoading(false));
    },
    []
  );

  // 打开一组根文件夹：换一个缓存命名空间，把 crumbs 压到根部。
  //
  // autoPlay 只在"用户第一次选文件夹"时为 true。追加文件夹时**不**自动进轮播 ——
  // 否则手机上每加一个文件夹都被弹进全屏轮播，没法接着加下一个。
  const showRoots = useCallback(
    (next: DirRef[], autoPlay: boolean): Promise<DirListing | undefined> => {
      setRoots(next);
      rootIdRef.current += 1;
      setBannerHidden(false);
      // 一个根时根目录名就是文件夹自己的名字；多个根时给个统一的名字。
      const name = next.length === 1 ? next[0].name : t("root.merged", { count: next.length });
      const root = next.length === 1 ? next[0] : mergeDirs(name, next);
      return navigate(root, [{ name, handle: root }]).then((listing) => {
        // 触屏：选完文件夹直接进入自动轮播（跳过网格），此刻播放按钮是"暂停"。
        if (autoPlay && touchUI && listing && listing.images.length) {
          setViewer({ index: 0, auto: true });
        }
        return listing;
      });
    },
    [navigate, touchUI]
  );

  const choose = useCallback(
    async (via: PickVia) => {
      setError("");
      setPartialRestore(0);
      setLastVia(via);

      if (via === "fsa") {
        const t0 = Date.now();
        try {
          const handle = await pickDirectory();
          saveDirHandles([handle]); // 记住，下次打开页面自动恢复
          setPickInfo(null);
          await showRoots([handle], true);
        } catch (e) {
          const elapsed = Date.now() - t0;
          // AbortError 就是"用户没选就关掉了"，属于正常交互，不该报错。
          // 只有瞬间失败才说明这个浏览器是假实现，那才需要提示。
          if ((e as DOMException)?.name === "AbortError") {
            if (elapsed < INSTANT_FAIL_MS) {
              setPhotosFallback(true); // 识别出假实现，亮出「选择照片/视频」
              setError(t("start.pickerMissing"));
            }
            return;
          }
          setError(t("start.pickFailed", { err: String(e) }));
        }
        return;
      }

      // 降级路径：<input webkitdirectory> 或 <input multiple>
      const res = await pickViaInput(via === "folder");
      if (res.kind === "cancelled") return; // 同上：取消不是错误
      if (res.kind === "noop") {
        setPhotosFallback(true); // 连 webkitdirectory 也是假实现，切到相册多选
        setError(t("start.pickerMissing"));
        return;
      }
      if (!res.files.length) return;

      const flat = isFlat(res.files);
      const root = buildTree(res.files, t("compat.flatRoot"));
      setPickInfo({ kind: flat ? "flat" : "folder", count: res.files.length });
      await showRoots([root], true);
    },
    [showRoots]
  );

  // 「添加文件夹」：再选一个文件夹并进来，凑出一个像"根目录"一样的视图。
  // 安卓不让网页读内部存储根目录，这是绕开它的办法（见 fs.ts 的 MergedDir）。
  //
  // **当前没有按钮引用它** —— 用户 2026-09-22 要求把那个按钮从工具栏去掉，逻辑保留，
  // 想恢复就在工具栏里加回一个 onClick={addFolder} 的按钮（i18n 的 top.addFolder 也还在）。
  const addFolder = useCallback(async () => {
    setError("");
    setPartialRestore(0);

    if (caps.fsa) {
      let handle: FileSystemDirectoryHandle;
      try {
        handle = await pickDirectory();
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return; // 取消不是错误
        setError(t("start.pickFailed", { err: String(e) }));
        return;
      }

      // 同一个文件夹加两次，里面的每张图都会出现两遍。拿句柄比一下身份。
      const dup = await Promise.all(
        roots.filter(isRealDir).map(async (r) => {
          try {
            return await r.isSameEntry(handle);
          } catch {
            return false;
          }
        })
      );
      if (dup.some(Boolean)) {
        setError(t("root.duplicate"));
        return;
      }

      const next = [...roots, handle];
      saveDirHandles(next.filter(isRealDir));
      await showRoots(next, false);
      return;
    }

    // 降级路径：再选一次，把新树并进同一份虚拟根
    if (!caps.folderInput) return;
    const res = await pickViaInput(true);
    if (res.kind !== "files" || !res.files.length) return;
    const flat = isFlat(res.files);
    setPickInfo({ kind: flat ? "flat" : "folder", count: res.files.length });
    await showRoots([...roots, buildTree(res.files, t("compat.flatRoot"))], false);
  }, [caps, roots, showRoots]);

  // 移除一个已加进来的根文件夹；都移除了就退回起始页
  const removeRoot = useCallback(
    (i: number) => {
      const next = roots.filter((_, j) => j !== i);
      setPartialRestore(0);
      if (!next.length) {
        setRoots([]);
        setCrumbs([]);
        setListing(null);
        setPickInfo(null);
        return;
      }
      saveDirHandles(next.filter(isRealDir));
      showRoots(next, false);
    },
    [roots, showRoots]
  );

  // 顶部"切换文件夹"：沿用本次会话已经在用的那条路，并**替换**掉当前的根（不是追加）
  const chooseAgain = useCallback(() => {
    if (caps.fsa) choose("fsa");
    else if (!caps.folderInput) choose("photos"); // 只剩照片这一条路
    else choose(lastVia === "photos" ? "photos" : "folder");
  }, [caps, lastVia, choose]);

  const openDir = (entry: DirEntry) => {
    navigate(entry.dir, [...crumbs, { name: entry.name, handle: entry.dir }]);
  };

  const goTo = (i: number) => {
    const stack = crumbs.slice(0, i + 1);
    navigate(stack[i].handle, stack);
  };

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // 自动恢复上次选择的文件夹：若 Chrome 已记住读权限（granted），直接进入，不再弹"允许"。
  // 仅完整模式可用 —— 降级路径没有句柄，也就没有可恢复的东西。
  useEffect(() => {
    if (!caps.fsa) return;
    let cancelled = false;
    (async () => {
      const handles = await loadDirHandles();
      if (cancelled || !handles.length) return;
      const perms = await Promise.all(handles.map(queryPermission));
      if (cancelled) return;
      // 只恢复还留着授权的那些。少恢复的那几个不静默吞掉 —— 提示一句，
      // 否则用户会以为根目录本来就只有这几个文件夹。
      const usable = handles.filter((_, i) => perms[i] === "granted");
      if (!usable.length) return; // 一个都没记住授权：停在起始页，等用户自己选
      if (usable.length < handles.length) setPartialRestore(handles.length - usable.length);
      showRoots(usable, false); // 恢复时不自动轮播，和以前一致
    })();
    return () => {
      cancelled = true;
    };
  }, [caps.fsa, showRoots]);

  // 保持全屏：已选文件夹、想保持全屏但当前不在全屏时，下一次点击/按键就自动进入全屏。
  // iPhone Safari 压根没有 Element.requestFullscreen，这些监听会空转，直接跳过。
  useEffect(() => {
    if (!fssOk || !current || document.fullscreenElement || !keepFullscreenRef.current) return;
    const onEnter = (e: Event) => {
      const el = e.target as HTMLElement | null;
      if (el && el.closest(".actions")) return; // 顶部按钮不抢手势（“切换文件夹”要用）
      if (document.fullscreenElement || !keepFullscreenRef.current) {
        window.removeEventListener("pointerdown", onEnter);
        window.removeEventListener("keydown", onEnter);
        return;
      }
      enterFullscreen();
      window.removeEventListener("pointerdown", onEnter);
      window.removeEventListener("keydown", onEnter);
    };
    window.addEventListener("pointerdown", onEnter);
    window.addEventListener("keydown", onEnter);
    return () => {
      window.removeEventListener("pointerdown", onEnter);
      window.removeEventListener("keydown", onEnter);
    };
  }, [fssOk, current, isFullscreen]);

  // 用户在看大图/播视频时，别再让瓦片抽帧跟播放器抢解码资源。用模块级开关而不是
  // prop —— prop 一变所有瓦片都会重跑 effect，关掉弹窗后还会集体重启。
  useEffect(() => {
    setVideoThumbPaused(!!(viewer || video));
  }, [viewer, video]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      keepFullscreenRef.current = false; // 用户主动退出，不再自动全屏
      document.exitFullscreen();
    } else {
      keepFullscreenRef.current = true; // 用户主动进入，恢复保持全屏
      enterFullscreen();
    }
  };

  const clearCache = async () => {
    await clearThumbCache();
    resetVideoThumbState(); // 视频那边还有模块级的负面缓存/闸门状态，一并清掉
    setThumbVersion((v) => v + 1); // 强制缩略图瓦片重挂载，重新生成
    setCleared(true);
    window.setTimeout(() => setCleared(false), 1500);
  };

  if (!current) {
    // 起始页除了选择文件夹，还带一段正文：介绍用法、隐私、支持格式与常见问题。
    // 它同时是给搜索引擎的落地内容（爬虫渲染后读到的就是这些字），所以文案
    // 里覆盖了 local image viewer / MKV in Chrome / no upload 这类查询用词，
    // 但只写真实能力 —— 不写「在线」「上传」这类与产品相反的词。
    //
    // 注意：这段正文现在对**所有**浏览器都渲染，包括不支持 File System Access 的。
    // 以前不支持就直接 return 掉整页，手机用户连这些字都看不到。
    const modeLabel = photosFallback
      ? t("browsers.modeCompat") // 假实现已被识破，实际走平铺，等同兼容模式
      : mode === "full"
        ? t("browsers.modeFull")
        : mode === "compat"
          ? t("browsers.modeCompat")
          : t("browsers.modeNone");

    return (
      <div className="center landing-wrap">
        <div className="landing">
          <div className="notice">
            <h1>{t("landing.h1")}</h1>
            <p>{t("landing.lede")}</p>

            {mode === "none" ? (
              <>
                <h2>{t("unsupported.title")}</h2>
                <p>{t("unsupported.body")}</p>
              </>
            ) : (
              <>
                {/* 主按钮只显示一个：能选文件夹就「选择文件夹」；拿不到目录结构、
                    或假实现已被识破（photosFallback），就换成「选择照片/视频」。
                    iOS 属于后者 —— 它的文件夹选择器只看得到「文件」App，看不到「照片」
                    图库（见 fallback.ts 的 detectCaps），摆着也是白点。 */}
                {photosFallback || (!caps.fsa && !caps.folderInput) ? (
                  <button className="btn primary" onClick={() => choose("photos")}>
                    {t("start.pickPhotos")}
                  </button>
                ) : (
                  <button className="btn primary" onClick={() => choose(caps.fsa ? "fsa" : "folder")}>
                    {t("start.pick")}
                  </button>
                )}
                <p className="browser-line">
                  {t("browsers.youAreUsing", { name: browserName(), mode: modeLabel })}
                </p>
                {/* iOS 上没给「选择文件夹」，得说清楚图库为什么不叫文件夹 */}
                {caps.ios ? <p className="hint-line">{t("ios.libraryHint")}</p> : null}
                {caps.android && !caps.folderInput ? (
                  <p className="hint-line">{t("compat.crashGuard")}</p>
                ) : null}
                {/* 安卓上选不了「内部存储」根目录（系统限制，见 fs.ts 的 MergedDir）。
                    先说清楚，免得用户点进去撞上「无法使用此文件夹」才发现。 */}
                {caps.android && (caps.fsa || caps.folderInput) ? (
                  <p className="hint-line">{t("android.rootHint")}</p>
                ) : null}
              </>
            )}

            {error && <div className="error">{error}</div>}
          </div>

          <section className="seo-block">
            <h2>{t("landing.how.title")}</h2>
            <ol>
              <li>{t("landing.how.1")}</li>
              <li>{t("landing.how.2")}</li>
              <li>{t("landing.how.3")}</li>
            </ol>
          </section>

          <section className="seo-block">
            <h2>{t("browsers.title")}</h2>
            <dl className="faq">
              <div>
                <dt>{t("browsers.full.title")}</dt>
                <dd>{t("browsers.full.body")}</dd>
              </div>
              <div>
                <dt>{t("browsers.compat.title")}</dt>
                <dd>{t("browsers.compat.body")}</dd>
              </div>
            </dl>
            <p>{t("browsers.auto")}</p>
          </section>

          <section className="seo-block">
            <h2>{t("landing.privacy.title")}</h2>
            <p>{t("landing.privacy.body")}</p>
          </section>

          <section className="seo-block">
            <h2>{t("landing.formats.title")}</h2>
            <p>{t("landing.formats.photos")}</p>
            <p>{t("landing.formats.videos")}</p>
          </section>

          <section className="seo-block">
            <h2>{t("landing.faq.title")}</h2>
            <dl className="faq">
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <div key={n}>
                  <dt>{t(`landing.faq.q${n}` as MsgKey)}</dt>
                  <dd>{t(`landing.faq.a${n}` as MsgKey)}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    );
  }

  // 缩略图持久化键：只用文件夹名（不含盘符/根序号），保证跨会话稳定。
  // 合并根这里用「各根名字相加」，而不是展示用的「所有文件夹 (3)」—— 后者在不同
  // 文件夹组合之间会撞键，把 A 组的缩略图串到 B 组去。单根时和改之前完全一致。
  //
  // 键可能撞（另一个盘上的同名文件夹、被覆盖的同名文件）没关系：cache.ts 会拿记录里
  // 存的 size/mtime 跟真实文件核验，对不上就重新生成。所以这里不用再叠根身份。
  const thumbBase = [
    roots.map((r) => r.name).join(" + "),
    ...crumbs.slice(1).map((c) => c.name),
  ].join("/");
  // 视频缩略图只在桌面端自动生成：抽帧要解码视频，手机上几十个文件会耗电发热
  //（用户明确要求手机保持 ▶ 占位符）。触屏判定沿用上面那套，和单击/双击共用。
  const allowVideoThumb = !touchUI;
  const compatKind = isCompatTree(current) ? (pickInfo?.kind ?? "folder") : null;
  const openTile = (fn: () => void) => (touchUI ? { onClick: fn } : { onDoubleClick: fn });

  return (
    <div className="app">
      <header className="topbar">
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={i} className="crumb-item">
              {i > 0 && <span className="crumb-sep">›</span>}
              <button className="crumb" onClick={() => goTo(i)}>
                {c.name}
              </button>
            </span>
          ))}
        </div>
        <div className="actions">
          {fssOk && (
            <button className="btn" onClick={toggleFullscreen}>
              {isFullscreen ? t("top.exitFullscreen") : t("top.fullscreen")}
            </button>
          )}
          <button className="btn" onClick={chooseAgain}>
            {/* 平铺模式（iOS 照片多选、安卓 Firefox 等）根本没有文件夹，别写「切换文件夹」 */}
            {!caps.fsa && pickInfo?.kind === "flat" ? t("top.switchPhotos") : t("top.switchFolder")}
          </button>
          {/* 「＋ 添加文件夹」按钮 2026-09-22 用户要求下线，addFolder 逻辑与整套合并机制
              （fs.ts 的 MergedDir）都留着没动 —— 恢复入口就是在这里加回一个按钮。
              注意：别把这条注释理解成"这段可以随便删"，合并机制还被自动恢复多个根目录那条路
              用着（见上面的 loadDirHandles effect）。 */}
          <button className="btn" onClick={clearCache}>
            {cleared ? t("top.cleared") : t("top.clearCache")}
          </button>
          <button
            className="btn primary"
            disabled={!listing?.images.length}
            onClick={() => setViewer({ index: 0, auto: true })}
          >
            {t("top.slideshow")}
          </button>
        </div>
      </header>

      {/* 合并了多个根文件夹时列出来，每个带 ✕ 可以单独去掉。只加了一个就不显示，
          免得白占一行。 */}
      {roots.length > 1 && (
        <div className="root-chips">
          <span className="root-chips-label">{t("root.merged", { count: roots.length })}</span>
          {roots.map((r, i) => (
            <span key={`${r.name}#${i}`} className="root-chip">
              {r.name}
              <button
                className="chip-x"
                onClick={() => removeRoot(i)}
                aria-label={t("root.remove")}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {partialRestore > 0 && (
        <div className="compat-banner">
          <span>{t("root.partial", { count: partialRestore })}</span>
          <button
            className="btn"
            onClick={() => setPartialRestore(0)}
            aria-label={t("viewer.close")}
          >
            ✕
          </button>
        </div>
      )}

      {compatKind && !bannerHidden && (
        <div className="compat-banner">
          <span>
            {compatKind === "flat"
              ? t("compat.banner.flat", { count: pickInfo?.count ?? 0 })
              : t("compat.banner.folder")}
          </span>
          <button className="btn" onClick={() => setBannerHidden(true)} aria-label={t("viewer.close")}>
            ✕
          </button>
        </div>
      )}

      <main className="content">
        {error && <div className="error">{error}</div>}
        {loading && <div className="loading-bar" />}

        {listing && (
          <>
            {listing.dirs.length > 0 && (
              <section>
                <h2>{t("list.folders")}</h2>
                <div className="grid dirs">
                  {listing.dirs.map((d) => (
                    <button key={d.name} className="dir" onClick={() => openDir(d)}>
                      <span className="dir-icon">📁</span>
                      <span className="dir-name">{d.name}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {listing.images.length + listing.videos.length > 0 && (
              <section>
                <h2>
                  {touchUI
                    ? t("list.mediaTap", { count: listing.images.length + listing.videos.length })
                    : t("list.media", { count: listing.images.length + listing.videos.length })}
                </h2>
                <div className="grid media">
                  {listing.images.map((img, i) => (
                    <div
                      key={`${thumbVersion}#${i}`}
                      className="tile"
                      {...openTile(() => setViewer({ index: i, auto: true }))}
                    >
                      <FileImage
                        handle={img.handle}
                        cacheKey={`${thumbBase}/${img.name}`}
                        alt={img.name}
                      />
                      <span className="tile-name">{img.name}</span>
                    </div>
                  ))}
                  {listing.videos.map((v, i) => (
                    <div
                      key={`${thumbVersion}#v${i}`}
                      className="tile video"
                      {...openTile(() => setVideo(v))}
                    >
                      {/* 桌面端给视频抽一帧当缩略图；手机端和 mkv/avi 那类保持 ▶ 占位符。
                          缓存键和图片同构（含扩展名，两侧扩展名互斥，不会撞键）。 */}
                      <FileImage
                        handle={v.handle}
                        name={v.name}
                        cacheKey={`${thumbBase}/${v.name}`}
                        alt={v.name}
                        isVideo
                        allowVideoThumb={allowVideoThumb}
                      />
                      <span className="video-badge">▶</span>
                      <span className="tile-name">{v.name}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {!listing.dirs.length && !listing.images.length && !listing.videos.length && (
              <div className="empty">{t("list.empty")}</div>
            )}
          </>
        )}
      </main>

      {viewer && listing && (
        <Viewer
          images={listing.images}
          index={viewer.index}
          auto={viewer.auto}
          onClose={() => setViewer(null)}
        />
      )}
      {video && <VideoModal entry={video} onClose={() => setVideo(null)} />}
    </div>
  );
}
