import type { DirListing, FileLike } from "./fs";

// 纯前端缓存：
// 1) 缩略图：对象 URL 存内存，缩略图 blob 持久化到 IndexedDB（跨会话离线可用）
// 2) 目录列表：内存
// 文件数据只在用户本机浏览器内处理。
//
// 正确性靠「size + lastModified 核验」，不靠缓存键唯一 —— 键只能用文件夹名拼出
// 相对路径（浏览器不给盘符），所以「另一个盘上的同名文件夹」和「被覆盖的同名文件」
// 都会落到同一个键上。持久层记录里存着生成时文件的 size/mtime，取用时跟真实文件
// 比一下：对不上就重新生成，串图/旧图最多活到下一次挂载。
//
// 为什么不把 mtime 拼进键：目录列表（fs.ts 的 listDir）只枚举名字、不读文件元数据，
// 拼进键就意味着**每次**查缓存前都得先 getFile() 一次，内存秒开的那条路也没了。
// 改成事后核验后，只有「滚进视口且内存未命中」的瓦片才摸一次盘。

const MAX_THUMBS = 3000; // 内存缩略图对象 URL 上限（LRU 淘汰并 revoke）
const MAX_LISTINGS = 50; // 目录列表缓存上限
const THUMB_SIZE = 320; // 缩略图最长边像素
const WEBP_QUALITY = 0.72; // 缩略图 WebP 质量

// 持久层条目上限：超过高水位后一次淘汰到低水位，留余量避免每次写入都扫一遍。
// 单张 320px WebP 约 10–40KB，10000 条大致 100–400MB。
const MAX_STORED = 10000;
const PRUNE_TO = 8000;
const PRUNE_EVERY = 200; // 每写这么多条才检查一次
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000; // 半年没被写过的条目直接淘汰

// 生成缩略图时文件的指纹。provider 不保证给，拿不到就退化成"永远算命中"，
// 也就是回到加核验之前的行为，不会更糟。
export interface ThumbMeta {
  size: number;
  mtime: number;
}

interface MemThumb extends ThumbMeta {
  url: string;
  // 生成这张图的那个文件。合并根下两个文件夹里有同名文件时，两个瓦片的键一样、
  // 文件不同，而内存一个键只放得下一条 —— 带上 handle，后来的瓦片一看不是自己的，
  // 就退回去走核验/重新生成，而不是把别人的图挂在身上（合并根下同名文件串图）。
  // 只在内存层有：持久层记录照旧只存 blob/size/mtime/at。
  handle?: FileLike;
}

interface StoredThumb extends ThumbMeta {
  blob: Blob;
  at: number; // 写入时间，用于淘汰
}

const thumbs = new Map<string, MemThumb>(); // cacheKey -> {url, size, mtime}
const listings = new Map<string, DirListing>(); // pathKey -> DirListing

// ---------- 内存：缩略图对象 URL ----------
export function getThumb(key: string): MemThumb | undefined {
  const v = thumbs.get(key);
  if (v !== undefined) {
    thumbs.delete(key);
    thumbs.set(key, v); // 命中刷新为最近使用（LRU）
  }
  return v;
}

export function putThumb(key: string, url: string, meta: ThumbMeta, handle?: FileLike): void {
  if (thumbs.has(key)) return;
  thumbs.set(key, { url, ...meta, handle });
  if (thumbs.size > MAX_THUMBS) {
    const oldest = thumbs.keys().next().value as string | undefined;
    if (oldest !== undefined) {
      const old = thumbs.get(oldest);
      thumbs.delete(oldest);
      if (old) URL.revokeObjectURL(old.url);
    }
  }
}

// ---------- 内存：目录列表 ----------
export function getCachedListing(key: string): DirListing | undefined {
  const v = listings.get(key);
  if (v !== undefined) {
    listings.delete(key);
    listings.set(key, v);
  }
  return v;
}

export function putCachedListing(key: string, l: DirListing): void {
  if (listings.has(key)) return;
  listings.set(key, l);
  if (listings.size > MAX_LISTINGS) {
    const oldest = listings.keys().next().value as string | undefined;
    if (oldest !== undefined) listings.delete(oldest);
  }
}

// ---------- IndexedDB：缩略图 blob 持久化（跨会话） ----------
const DB_NAME = "imageviewer-cache";
const DB_VERSION = 2;
const STORE = "thumbs";
const AT_INDEX = "at";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE)) {
        // v1 存的是裸 Blob：没有 size/mtime 就没法核验（可能串图），也没法按时间
        // 淘汰。缩略图本来就可再生，直接丢掉重建，比写一套迁移+双形状兼容划算。
        // 用户下次进来只是重新生成一遍可见的那几十张。
        db.deleteObjectStore(STORE);
      }
      const store = db.createObjectStore(STORE);
      store.createIndex(AT_INDEX, "at");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function isStored(v: unknown): v is StoredThumb {
  const r = v as Partial<StoredThumb> | undefined;
  return (
    !!r &&
    r.blob instanceof Blob &&
    typeof r.size === "number" &&
    typeof r.mtime === "number"
  );
}

export async function getStoredThumb(key: string): Promise<StoredThumb | undefined> {
  try {
    const db = await openDb();
    const rec = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return isStored(rec) ? rec : undefined;
  } catch {
    return undefined;
  }
}

export async function putStoredThumb(key: string, blob: Blob, meta: ThumbMeta): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ blob, ...meta, at: Date.now() }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    maybePrune(db);
  } catch {
    /* 忽略持久化失败 */
  }
}

let writesSincePrune = 0;

// 淘汰：按写入时间升序走一遍索引（最旧在前），边删边判断，两个条件任一满足就继续删：
// 条目数超过高水位，或条目已过期。剩下的都更新，直接收工。
//
// 事务里不发 await —— 索引游标的 onsuccess 回调里同步调 delete()/continue()，
// 事务才是活的（中间 await 会让它自动提交，游标就断了）。
function maybePrune(db: IDBDatabase): void {
  if (++writesSincePrune < PRUNE_EVERY) return;
  writesSincePrune = 0;

  const cutoff = Date.now() - MAX_AGE_MS;
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const countReq = store.count();
    countReq.onsuccess = () => {
      let toDelete = Math.max(0, countReq.result - PRUNE_TO);
      const cursorReq = store.index(AT_INDEX).openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const at = (cursor.value as StoredThumb).at;
        if (toDelete <= 0 && at >= cutoff) return; // 接下来只会更新
        cursor.delete();
        toDelete -= 1;
        cursor.continue();
      };
    };
  } catch {
    /* 淘汰纯属清理，失败不影响使用 */
  }
}

// 清空所有缩略图缓存（内存 + IndexedDB）
export async function clearThumbCache(): Promise<void> {
  for (const t of thumbs.values()) {
    try {
      URL.revokeObjectURL(t.url);
    } catch {
      /* 忽略 */
    }
  }
  thumbs.clear();
  writesSincePrune = 0;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* 忽略 */
  }
}

// ---------- 缩略图生成 ----------
// 把一帧画面按最长边 THUMB_SIZE 等比缩进一张新 canvas。
// 图片（<img>）和视频抽帧（<video>）共用这一个尺寸契约 —— 两边产出的持久层记录才同质。
export function thumbCanvas(
  src: CanvasImageSource,
  srcW: number,
  srcH: number
): HTMLCanvasElement | null {
  if (!srcW || !srcH) return null;
  try {
    const scale = Math.min(1, THUMB_SIZE / Math.max(srcW, srcH));
    const tw = Math.max(1, Math.round(srcW * scale));
    const th = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0, tw, th);
    return canvas;
  } catch {
    return null; // 画不进去（解码失败、跨源污染等）由调用方保持占位
  }
}

// canvas → WebP。体积小、支持透明。
export function canvasToWebp(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), "image/webp", WEBP_QUALITY);
    } catch {
      resolve(null);
    }
  });
}

// 用 <img> 解码（自动处理 EXIF 方向），再画到 canvas 缩小导出 WebP。
// 浏览器无法解码的格式（HEIC/TIFF 等）返回 null，由调用方保持占位。
// 视频不走这里 —— 见 videoThumb.ts。
export function makeThumbnail(file: File): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = thumbCanvas(img, img.naturalWidth, img.naturalHeight);
      if (!canvas) {
        URL.revokeObjectURL(url);
        resolve(null);
        return;
      }
      canvasToWebp(canvas).then((b) => {
        URL.revokeObjectURL(url);
        resolve(b);
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}
