// File System Access API helpers. Requires a Chromium browser (Chrome/Edge)
// and a secure context (https or localhost).
//
// 除了真·FSA，本模块还容纳一条降级路径的类型基础（见 fallback.ts）：
// 不支持 showDirectoryPicker 的浏览器改用 <input webkitdirectory>，一次拿到
// 整棵子树的 File，在内存里重建目录树（VirtualDir）。两条路径共用 DirRef。

// lib.dom.d.ts is missing the async-iteration members that exist at runtime.
declare global {
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemHandle>;
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    keys(): AsyncIterableIterator<string>;
    [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]>;
  }
}

// 一个文件的最小接口。真 FSA 句柄和降级模式的包装对象都满足它，
// 消费方（FileImage / Viewer / VideoModal）只调用 getFile()。
export interface FileLike {
  getFile(): Promise<File>;
}

export interface FSEntry {
  name: string;
  handle: FileLike;
}

export interface DirEntry {
  name: string;
  dir: DirRef;
}

export interface DirListing {
  dirs: DirEntry[];
  images: FSEntry[];
  videos: FSEntry[];
}

// 降级模式预先算好的目录节点：树在选定文件夹时一次性建好，
// 之后每次导航都是 O(1) 取现成的 listing。
export interface VirtualDir {
  __virtual: true;
  name: string;
  listing: DirListing;
}

// 多个根文件夹的合并视图。用户依次选了 DCIM、Pictures、Movies……每个 pick
// 是这里的 parts 中的一项。
//
// 合并是**惰性**的：每次列目录才去列各 part 再按名字并起来，所以磁盘上新加的
// 文件照样能看到，不需要重新选一遍。存在的理由见 README —— 安卓系统不允许
// 把「内部存储根目录」交给网页，只能靠用户多选几个子文件夹拼出一个"根"。
export interface MergedDir {
  __merged: true;
  name: string;
  parts: DirRef[];
}

export type DirRef = FileSystemDirectoryHandle | VirtualDir | MergedDir;

export function isVirtualDir(d: DirRef): d is VirtualDir {
  return (d as VirtualDir).__virtual === true;
}

export function isMergedDir(d: DirRef): d is MergedDir {
  return (d as MergedDir).__merged === true;
}

// 真·File System Access 句柄 —— 也就是唯一能存进 IndexedDB、下次自动恢复的那种。
export function isRealDir(d: DirRef): d is FileSystemDirectoryHandle {
  return !isVirtualDir(d) && !isMergedDir(d);
}

// 只有一个 part 时原样返回，不套一层 MergedDir：单选时行为和以前一模一样
//（根目录名就是文件夹名），也省掉没意义的嵌套。
export function mergeDirs(name: string, parts: DirRef[]): DirRef {
  if (parts.length === 1) return parts[0];
  return { __merged: true, name, parts };
}

// 把若干份 listing 并成一份：同名子目录递归合并（DCIM 和 Pictures 下都有
// Camera 时，进去能看到两边的照片），图片/视频直接拼起来按名字排序。
export function mergeListings(listings: DirListing[]): DirListing {
  const groups = new Map<string, DirRef[]>();
  const images: FSEntry[] = [];
  const videos: FSEntry[] = [];

  for (const l of listings) {
    for (const d of l.dirs) {
      const g = groups.get(d.name);
      if (g) g.push(d.dir);
      else groups.set(d.name, [d.dir]);
    }
    images.push(...l.images);
    videos.push(...l.videos);
  }

  const dirs = [...groups]
    .map(([name, parts]) => ({ name, dir: mergeDirs(name, parts) }))
    .sort(byName);
  images.sort(byName);
  videos.sort(byName);

  return { dirs, images, videos };
}

// 这棵（子）树是不是降级路径（<input>）建出来的 —— 决定要不要显示"兼容模式"提示条。
// 合并视图要往下钻：合并根本身是 MergedDir，里面装的才是 VirtualDir。
export function isCompatTree(d: DirRef): boolean {
  if (isVirtualDir(d)) return true;
  if (isMergedDir(d)) return d.parts.every(isCompatTree);
  return false;
}

const imageExts = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".avif",
  ".ico", ".tif", ".tiff", ".heic", ".heif",
]);

const videoExts = new Set([
  ".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v", ".mpg", ".mpeg",
  ".wmv", ".flv", ".ts", ".m2ts", ".mts", ".3gp", ".ogv",
]);

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

// 按扩展名归类。降级路径也用这个过滤，保证两条路的可见文件集合一致。
export function classify(name: string): "image" | "video" | null {
  const e = ext(name);
  if (imageExts.has(e)) return "image";
  if (videoExts.has(e)) return "video";
  return null;
}

// 文件名排序：数字按数值比，避免 "10.jpg" 排在 "9.jpg" 前面。两条路径共用。
export function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

export function isSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  const w = window as unknown as {
    showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
  };
  return w.showDirectoryPicker();
}

// 查询目录读权限：不需要用户手势。Chrome 若已记住授权，返回 "granted"，
// 可据此跳过"允许"弹窗直接进入；否则返回 "prompt" / "denied"。
export async function queryPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  try {
    const h = handle as unknown as {
      queryPermission?: (d?: { mode?: string }) => Promise<PermissionState>;
    };
    if (typeof h.queryPermission === "function") {
      return await h.queryPermission({ mode: "read" });
    }
  } catch {
    /* 忽略，按 prompt 处理 */
  }
  return "prompt";
}

const EMPTY_LISTING: DirListing = { dirs: [], images: [], videos: [] };

export async function listDir(dir: DirRef): Promise<DirListing> {
  // 降级模式：树已经建好，直接返回。
  if (isVirtualDir(dir)) return dir.listing;

  // 合并视图：各 part 分别列一层再并起来（都是浅列，代价和选一个文件夹一样）。
  // 单个 part 失败（授权被撤销、SD 卡拔了、目录被删）不该让整棵树白屏，
  // 按空目录算，剩下的照常显示。
  if (isMergedDir(dir)) {
    const listings = await Promise.all(
      dir.parts.map((p) => listDir(p).catch(() => EMPTY_LISTING))
    );
    return mergeListings(listings);
  }

  const dirs: DirEntry[] = [];
  const images: FSEntry[] = [];
  const videos: FSEntry[] = [];

  for await (const entry of dir.values()) {
    if (entry.kind === "directory") {
      dirs.push({ name: entry.name, dir: entry as FileSystemDirectoryHandle });
      continue;
    }
    const kind = classify(entry.name);
    const file = entry as FileSystemFileHandle; // values() 给的是基类，这里已确定是文件
    if (kind === "image") images.push({ name: entry.name, handle: file });
    else if (kind === "video") videos.push({ name: entry.name, handle: file });
  }

  dirs.sort(byName);
  images.sort(byName);
  videos.sort(byName);

  return { dirs, images, videos };
}
