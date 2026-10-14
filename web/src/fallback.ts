// 不支持 File System Access API 的浏览器的降级路径。
//
//   Tier 2  <input webkitdirectory>  一次选中整棵子树，用 webkitRelativePath 重建目录树
//   Tier 3  <input multiple>         平铺文件列表（iPhone 相册、安卓 Firefox 141 等无路径场景）
//
// 本模块刻意不 import i18n 的运行时 —— 它要能在 Node 里被单独跑测试（buildTree 是纯函数）。
// 下面的 MsgKey 是 type-only import，编译时被整个擦掉，不会把读 window 的 i18n 拖进来。

import { byName, classify, isVirtualDir, type DirListing, type FSEntry, type FileLike, type VirtualDir } from "./fs";
import type { MsgKey } from "./i18n";

// 安卓上选文件夹在 Chromium M132 之前会崩掉浏览器（递归扫描没实现，M132 才修）。
// 低于此版本连按钮都不发，只给"选择照片/视频"。判定偏保守：错了只会少一个按钮。
const MIN_ANDROID_FOLDER_CHROME = 132;

export type Mode = "full" | "compat" | "none";

export interface Caps {
  fsa: boolean;
  folderInput: boolean;
  multiInput: boolean;
  android: boolean;
  androidChromium: number | null;
  // iOS / iPadOS。见 isIosUA —— 起始页据此只给「选择照片 / 视频」一个入口。
  ios: boolean;
}

// iOS / iPadOS 判定。
//
// 坑：iPadOS 13 起 Safari 的 UA 和桌面 Mac 一模一样（"Macintosh; Intel Mac OS X"），
// 光看 UA 字符串会把 iPad 当成 Mac。只能靠 maxTouchPoints > 1 认出来。
//
// 认出来有两处用途：
//   1. 触屏交互 —— 单击打开、不给视频抽帧缩略图（见 Browser.tsx 的 detectTouchUI）；
//   2. 起始页只给「选择照片 / 视频」 —— iOS 的文件夹选择器只能看到「文件」App 里的位置，
//      「照片」图库根本不是文件系统的一部分，选文件夹永远翻不到它（见 detectCaps）。
export function isIosUA(ua: string, maxTouchPoints: number): boolean {
  if (/iPad|iPhone|iPod/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && maxTouchPoints > 1;
}

export function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return isIosUA(navigator.userAgent || "", navigator.maxTouchPoints || 0);
}

// 调试用：?compat=1 强制走降级路径，好在桌面 Chrome 上测整条链路。
export function forceCompat(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("compat") === "1";
  } catch {
    return false;
  }
}

// 调试用：?ios=1 在桌面上模拟 iOS 的起始页（两个入口 + 那条图库提示），
// 省得为了看一眼这版界面去找台 iPad。和 ?compat=1 一样只在调试时用。
export function forceIos(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("ios") === "1";
  } catch {
    return false;
  }
}

export function detectCaps(): Caps {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  const android = /Android/i.test(ua);
  const chromeVer = ua.match(/Chrome\/(\d+)/);
  const androidChromium = android ? (chromeVer ? Number(chromeVer[1]) : 0) : null;

  const hasFsa = typeof window !== "undefined" && "showDirectoryPicker" in window;
  const hasFolderProp =
    typeof document !== "undefined" && "webkitdirectory" in document.createElement("input");

  // 华为/鸿蒙浏览器（UA 带 HuaweiBrowser 或 ArkWeb）暴露了 showDirectoryPicker 属性
  // 但假实现：调用瞬间就 AbortError（用户已实测）。这里直接判为无 FSA，
  // 让它走 folder/webkitdirectory 或 photos 降级，别让用户先点失败一次。
  const fakeFsa = /HuaweiBrowser|ArkWeb/i.test(ua);

  const ios = forceIos() || isIosDevice();

  // 华为/鸿蒙：showDirectoryPicker 和 webkitdirectory 的目录选择器都弹不出来
  //（宿主没实现 MODE_OPEN_FOLDER，用户实测确认），只能走 multiple 相册多选。
  //
  // iOS 同理不发这个按钮，但原因不同：webkitdirectory 从 18.4 起确实是能用的，
  // 那个选择器也没有坏 —— 它只是「文件」App 的选择器，而用户自己拍的照片和视频都在
  // 「照片」图库里，图库不是文件系统里的目录，进去一个都翻不到。2026-09-22 iPad 实测：
  // 这个按钮"没啥作用"。同一个平台上摆两个按钮、其中一个点了白点，不如只给一个。
  const folderInput =
    fakeFsa || ios
      ? false
      : hasFolderProp && (!android || (androidChromium ?? 0) >= MIN_ANDROID_FOLDER_CHROME);

  return {
    fsa: hasFsa && !fakeFsa && !forceCompat(),
    folderInput,
    multiInput: true, // <input multiple> 到处都有
    android,
    androidChromium,
    ios,
  };
}

export function modeFor(caps: Caps): Mode {
  if (caps.fsa) return "full";
  if (caps.folderInput || caps.multiInput) return "compat";
  return "none";
}

// 只用于首页那行"你当前使用的是 …"，纯展示，不参与任何逻辑分支。
// 返回文案 key 而不是成品的字符串：浏览器名里有国产套壳和「未知」，
// 拼死在代码里会让英文站出现中英混排（调用方 t(browserName()) 即可）。
export function browserName(): MsgKey {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  // 顺序有讲究：国产套壳的 UA 里同时带着 Chrome/ Safari/，必须先判它们。
  if (/MicroMessenger/i.test(ua)) return "browsers.name.wechat";
  if (/QQBrowser/i.test(ua)) return "browsers.name.qq";
  if (/UCBrowser|UBrowser/i.test(ua)) return "browsers.name.uc";
  if (/Quark/i.test(ua)) return "browsers.name.quark";
  if (/HuaweiBrowser|HarmonyOS/i.test(ua)) return "browsers.name.huawei";
  if (/EdgiOS/i.test(ua)) return "browsers.name.edgeIos";
  if (/CriOS/i.test(ua)) return "browsers.name.chromeIos";
  if (/FxiOS/i.test(ua)) return "browsers.name.firefoxIos";
  if (/Edg\//i.test(ua)) return "browsers.name.edge";
  if (/OPR\//i.test(ua)) return "browsers.name.opera";
  if (/Firefox\//i.test(ua)) return "browsers.name.firefox";
  if (/Safari\//i.test(ua) && /Version\//i.test(ua)) return "browsers.name.safari";
  if (/Chrome\//i.test(ua)) return "browsers.name.chrome";
  return "browsers.name.unknown";
}

// ---------- 取文件 ----------

export type PickResult =
  | { kind: "files"; files: File[] }
  | { kind: "cancelled" }
  | { kind: "noop" }; // 选择器压根没打开（浏览器假实现）

// 保活：input.files 是绑在元素上的活 FileList，元素被回收后个别浏览器读不回文件。
const heldInputs: HTMLInputElement[] = [];

export function pickViaInput(directory: boolean): Promise<PickResult> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("tabindex", "-1");
    input.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";

    if (directory) {
      // 坑：Firefox 只要看到 webkitdirectory 属性存在就强制目录模式，设成 false 无效。
      // 所以目录/非目录必须分别建元素，不能靠改属性复用。
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("directory", "");
    } else {
      input.setAttribute("accept", "image/*,video/*");
    }

    document.body.appendChild(input);
    heldInputs.push(input);

    let settled = false;
    const finish = (r: PickResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const takeFiles = () => {
      const f = input.files;
      return f && f.length ? { kind: "files" as const, files: Array.from(f) } : null;
    };

    input.addEventListener("change", () => finish(takeFiles() ?? { kind: "cancelled" }));
    // 用户取消（Baseline 2023）。老内核不派发，下面 focus 兜底还会再查一次 files。
    input.addEventListener("cancel", () => finish({ kind: "cancelled" }));

    // 兜底：选择器关掉后窗口重新获得焦点。先看 files 再下结论 —— 有的内核
    // 是先填 files 后派发 change，直接按取消处理会丢掉用户的真实选择。
    // 注意：不能靠「窗口没失焦 = 选择器没弹出」判 noop。QQ/华为等移动浏览器的
    // 选择器是内嵌的、弹出时不触发 window blur，那样会在用户选照片途中误判成失败。
    window.addEventListener(
      "focus",
      () => {
        window.setTimeout(() => {
          if (settled) return;
          finish(takeFiles() ?? { kind: "cancelled" });
        }, 600);
      },
      { once: true }
    );

    input.click();
  });
}

// ---------- 建树 ----------

interface Node {
  name: string;
  dirs: Map<string, Node>;
  files: File[];
}

function newNode(name: string): Node {
  return { name, dirs: new Map(), files: [] };
}

function relPathOf(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || "";
}

// 所有文件都没有相对路径 → 平铺模式（安卓 Firefox 141、iPhone 相册多选）。
export function isFlat(files: File[]): boolean {
  return files.every((f) => !relPathOf(f));
}

function wrap(file: File): FileLike {
  return { getFile: async () => file };
}

function finalize(node: Node): VirtualDir {
  const dirs = [...node.dirs.values()]
    .sort(byName)
    .map((c) => ({ name: c.name, dir: finalize(c) }));

  const images: FSEntry[] = [];
  const videos: FSEntry[] = [];
  for (const f of node.files) {
    const kind = classify(f.name);
    if (kind === "image") images.push({ name: f.name, handle: wrap(f) });
    else if (kind === "video") videos.push({ name: f.name, handle: wrap(f) });
    // 其余扩展名丢弃，与 FSA 路径的可见集合保持一致
  }
  images.sort(byName);
  videos.sort(byName);

  const listing: DirListing = { dirs, images, videos };
  return { __virtual: true, name: node.name, listing };
}

// 纯函数：只读 name 与 webkitRelativePath 两个字段，可在 Node 里直接测。
// flatRootName 用于无路径场景下根目录的显示名。
export function buildTree(files: File[], flatRootName: string): VirtualDir {
  const withPath = files.filter((f) => relPathOf(f));

  // relativePath 形如 "照片20250120/03_摄像/a.mp4"，第一段就是用户选的那个文件夹。
  // 把它当作根名并剥掉，免得进去还得多点一层同名目录。
  let rootName = flatRootName;
  let stripFirst = false;
  if (withPath.length) {
    const firsts = new Set(
      withPath.map((f) => relPathOf(f).split("/").filter(Boolean)[0] ?? "")
    );
    if (firsts.size === 1) {
      const only = [...firsts][0];
      if (only) {
        rootName = only;
        stripFirst = true;
      }
    }
  }

  const root = newNode(rootName);

  for (const file of files) {
    const segs = relPathOf(file).split("/").filter(Boolean);
    if (!segs.length) {
      root.files.push(file); // 无路径的散文件，直接挂根下
      continue;
    }
    const dirs = (stripFirst ? segs.slice(1) : segs).slice(0, -1);
    let node = root;
    for (const seg of dirs) {
      let child = node.dirs.get(seg);
      if (!child) {
        child = newNode(seg);
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.push(file);
  }

  return finalize(root);
}

// 供 UI 判断当前展示的是不是虚拟树（决定要不要显示"兼容模式"提示条）。
export { isVirtualDir };
