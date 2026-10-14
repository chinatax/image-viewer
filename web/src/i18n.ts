// 界面文案字典。默认中文；服务端以 --en 启动时会在 index.html 里注入
// window.__KANTU_LANG__ = "en"，前端据此整体切到英文。
//
// 语言在模块加载时定下来，之后不再变（页面上没有切换入口），所以这里不需要
// React context，一个 t() 就够，任何模块（包括非组件的 ffmpegTools.ts）都能用。

export type Lang = "zh" | "en";

declare global {
  interface Window {
    __KANTU_LANG__?: string;
    // 英文站由服务端注入的 SEO 标题：比界面标题长、带关键词，给爬虫看的。
    // 中文站不注入，走字典里的 app.title。
    __KANTU_TITLE__?: string;
  }
}

// 中文是基准字典：键以它为准，en 用 Record<MsgKey, string> 约束，
// 漏翻或写错键名都会在 tsc 阶段报错。
const zh = {
  "app.title": "看图",

  "unsupported.title": "当前浏览器无法读取文件夹",
  "unsupported.body":
    "这个浏览器既不支持 File System Access API，也不支持文件夹选择。请换用 Chrome、Edge、Firefox 或 Safari 打开本页面（需 https 或 localhost）。",

  // 降级路径（见 fallback.ts）：不支持 File System Access API 时改走 <input>，
  // 因此没有授权记忆 —— "兼容模式"提示条的主要任务就是把这件事说清楚。
  "compat.banner.folder":
    "兼容模式：能按文件夹浏览，但当前浏览器不支持记住授权，每次打开页面都要重新选一次。图片和视频不会被上传。",
  "compat.banner.flat":
    "兼容模式：已选择 {count} 个文件。当前浏览器没有提供目录结构，所以平铺显示。图片和视频不会被上传。",
  "compat.crashGuard":
    "当前安卓浏览器的内核版本过旧 —— 这类内核在选择文件夹时会直接崩溃，所以这里只提供「选择照片 / 视频」。换成较新的 Chrome 打开即可按文件夹浏览。",
  "compat.flatRoot": "已选择的文件",

  // 安卓不让网页读「内部存储」根目录（系统层面的限制，见 fs.ts 的 MergedDir）。
  // 起始页先说清楚，免得用户点进去撞上「无法使用此文件夹」才发现。
  "android.rootHint":
    "安卓系统不允许网页直接读取「内部存储」根目录 —— 选中它时系统会提示「无法使用此文件夹」，换浏览器也一样。请进入 DCIM、Pictures 等子文件夹来看（受这个限制，一次只能看一个文件夹）。",

  // iOS 专用：iPhone / iPad 上「照片」图库和「文件」App 是两套东西，文件夹选择器
  // 里根本没有图库这个位置，所以 iOS 上只给一个按钮（见 fallback.ts 的 detectCaps）。
  "ios.libraryHint":
    "iPhone / iPad 上，相机拍的照片和视频都在「照片」图库里 —— 图库不是「文件」App 里的文件夹，所以这里只给一个按钮：点它，直接进图库多选就行。存在「文件」App、iCloud Drive 或 U 盘里的图片视频，在弹窗里选「选取文件」也能挑（平铺显示，不按文件夹）。",

  "start.tagline": "选择本机的一个文件夹，浏览其中的图片和视频。",
  "start.pick": "选择文件夹",
  "start.pickPhotos": "选择照片 / 视频",
  "start.pickFailed": "选择文件夹失败：{err}",
  // 属性存在但调用瞬间失败 —— 多半是安卓 WebView/内嵌浏览器没把选择器接上，
  // 用户其实什么都没点。必须与"用户自己取消"区分开（代码里按耗时判定）。
  "start.pickerMissing":
    "这个浏览器没有真正打开选择器。请改用下面的「选择照片 / 视频」，或换 Chrome / Edge 打开。",

  // 起始页的正文（渲染后才出现在 DOM 里，给用户看，也给搜索引擎看）。
  // 措辞只写真实能力：不上传、需 Chrome/Edge、超大视频只给预览。
  "landing.h1": "浏览电脑上任意文件夹里的图片和视频",
  "landing.lede": "不用上传、不用安装 —— 打开网页，选一个文件夹就能看。",

  "landing.how.title": "怎么用",
  "landing.how.1": "点「选择文件夹」，挑一个文件夹 —— 图片、视频，或者两者混着都行。",
  "landing.how.2": "子文件夹会列在左侧，里面的图片和视频以缩略图展示。",
  "landing.how.3": "双击缩略图即可全屏查看、播放视频，或者开启自动播放。",

  // 首页要写清楚"该用哪种浏览器"，所以这一段既是给用户看的，也是给爬虫吃的
  // （Chrome 看图 / Firefox 本地图片 / Safari 不支持 这类检索词）。
  "browsers.title": "浏览器支持",
  "browsers.youAreUsing": "你当前使用的是 {name} — {mode}",
  "browsers.modeFull": "完整模式",
  "browsers.modeCompat": "兼容模式",
  "browsers.modeNone": "不支持",
  "browsers.full.title": "完整模式（推荐）",
  "browsers.full.body":
    "能直接读取文件夹，并记住授权，下次打开不用重选：电脑上的 Chrome、Edge、Opera、Brave 等 Chromium 内核浏览器，以及安卓 Chrome 132 及以上。",
  "browsers.compat.title": "兼容模式",
  "browsers.compat.body":
    "同样能按文件夹看图，文件也不会上传，只是浏览器不支持记住授权，每次打开要重选一次：Firefox、Safari、iPhone（iOS 18.4 及以上）、大部分安卓浏览器和 App 内置浏览器。",
  "browsers.auto": "页面会自动选用当前浏览器可用的模式，不需要你手动切换。",

  "landing.privacy.title": "文件不上传，全部在浏览器里完成",
  "landing.privacy.body":
    "这是本机看图工具，不是在线相册：文件由浏览器通过 File System Access API 直接读取，没有上传、没有服务器、不用账号、没有广告。图片和视频不会离开你的电脑，页面加载完之后断网也能继续浏览。",

  "landing.formats.title": "能打开 Chrome 自己打不开的格式",
  "landing.formats.photos":
    "图片：JPG、PNG、GIF、WebP、BMP、SVG、AVIF，以及浏览器能解码的其他格式。",
  "landing.formats.videos":
    "视频：MP4、WebM、MOV 直接播放；MKV、AVI、WMV、MPG、TS、M2TS、FLV 在浏览器里重新封装（画质无损）或用 ffmpeg.wasm 解码。遇到 Chrome 完全解不了的编码，给出的是前几秒的 480p 预览，而不是一个打不开的文件。磁盘上的原文件不会被修改，也不会被上传。",

  "landing.faq.title": "常见问题",
  "landing.faq.q1": "在线图片浏览工具会不会把我的图片传走？",
  "landing.faq.a1":
    "不会。这里既没有上传按钮，也没有存你文件的服务器，图片和视频全部由你自己的浏览器在本机读取。",
  "landing.faq.q2": "要收费吗？要注册吗？",
  "landing.faq.a2": "免费，不用注册、不用安装，打开网页选一个文件夹就能用。",
  "landing.faq.q3": "支持哪些浏览器？",
  "landing.faq.a3":
    "分两种模式。桌面版 Chrome、Edge 等 Chromium 内核浏览器是「完整模式」，能直接读文件夹并记住授权；Firefox、Safari、iPhone 和大部分安卓浏览器会自动进入「兼容模式」，一样能按文件夹看图，只是每次打开要重选一次。模式由页面自己判断，不用手动切换。",
  "landing.faq.q4": "Chrome 里能播 MKV 吗？",
  "landing.faq.a4":
    "能，这也正是它存在的主要理由。Chrome 自己认不了 MKV、AVI、WMV、TS，这里会在浏览器里重新封装或解码，再交给标准播放器播放。",
  "landing.faq.q5": "断网还能用吗？",
  "landing.faq.a5":
    "页面加载完之后可以，读文件不需要联网。唯一要下载的是约 31MB 的解码器，只在第一次碰到需要转码的视频时下载一次，之后由浏览器缓存复用。",
  "landing.faq.q6": "文件大小有限制吗？",
  "landing.faq.a6":
    "没有 —— 因为不上传，能开多大的文件只取决于你自己的硬盘。特别大的视频会先给一段预览，而不是让你等上几分钟的完整转码。",
  "landing.faq.q7": "手机上为什么选不了「内部存储」根目录？",
  "landing.faq.a7":
    "因为安卓系统不允许，和本网页无关。从安卓 11 起，系统规定任何应用（包括所有浏览器）都不能取得「内部存储根目录」「SD 卡根目录」和「Download 目录」的访问权，选中它们时系统自己会提示「无法使用此文件夹」，换浏览器、换文件管理器都一样。所以安卓上一次只能看一个文件夹，进根目录下的 DCIM、Pictures 等子文件夹来看即可。电脑上（Chrome、Edge）没有这个限制，选哪个文件夹都行。",
  "landing.faq.q8": "iPad / iPhone 上为什么只能选照片，不能选文件夹？",
  "landing.faq.a8":
    "因为「照片」图库不是「文件」App 里的文件夹 —— iOS 没有把它作为普通目录开放给网页，任何浏览器都一样，选文件夹也翻不到图库里的照片和视频。iOS 18.4 起网页确实能选文件夹了，但那只能覆盖「文件」App 里的内容，而多数人的照片、视频都在图库里；多一个点了没用的按钮不如不给，所以 iOS 上只留「选择照片 / 视频」这一个入口。点它会弹出「照片图库 / 拍照或录像 / 选取文件」三选一：从图库可以一次多选；存在「文件」App、iCloud Drive、U 盘里的图片视频就选「选取文件」。两者选进来都是平铺列表，因为系统没有提供目录结构 —— 要按文件夹浏览，请用电脑上的 Chrome、Edge 或 Firefox。",

  "top.fullscreen": "⛶ 全屏",
  "top.exitFullscreen": "退出全屏",
  "top.switchFolder": "切换文件夹",
  "top.switchPhotos": "重新选照片",
  // 「＋ 添加文件夹」按钮 2026-09-22 已从工具栏下线，逻辑与文案都留着，恢复只需加回按钮
  "top.addFolder": "＋ 添加文件夹",
  "top.clearCache": "清空缓存",
  "top.cleared": "✓ 已清空",
  "top.slideshow": "▶ 自动播放",

  // 多根合并（原先由「添加文件夹」把几个文件夹拼成一个根；按钮下线后，只剩自动恢复
  // 多个根目录那条路还会用到这几条文案 —— chips 和「移除这个文件夹」也都是给那条路用的）
  "root.merged": "所有文件夹 ({count})",
  "root.remove": "移除这个文件夹",
  "root.duplicate": "这个文件夹已经添加过了。",
  "root.partial":
    "上次选的文件夹里，有 {count} 个没能自动恢复（浏览器没记住授权），点「切换文件夹」可以重新选。",

  "list.folders": "文件夹",
  "list.media": "媒体 ({count}) · 双击打开",
  // 触屏没有双击，这条替代上面那条（见 Browser.tsx 的 touchUI 判定）
  "list.mediaTap": "媒体 ({count}) · 点击打开",
  "list.empty": "此文件夹没有图片或视频",

  "viewer.pause": "⏸ 暂停",
  "viewer.play": "▶ 播放",
  "viewer.fit": "适应屏幕",
  "viewer.interval": "间隔",
  "viewer.seconds": "秒",
  "viewer.close": "✕ 关闭",

  "video.remuxing": "正在重新封装…",
  "video.reused": "已复用之前的转换结果",
  "video.transcodePreview": "正在转码前 {seconds} 秒…",
  "video.analyzing": "正在分析编码…",
  "video.loadingDecoder": "正在加载解码器（约 31MB，仅首次，之后复用）…",
  "video.remuxLarge": "编码 {codec}，文件较大，重新封装前 {size}…",
  "video.remux": "编码 {codec}，重新封装中（无损）…",
  "video.audioLarge": "音频 {audio} 浏览器无法解码，转 AAC（视频无损）并封装前 {size}…",
  "video.audioRecode": "音频 {audio} 浏览器无法解码，转成 AAC（视频无损）…",
  "video.needTranscode": "编码 {codec} 浏览器无法解码，转前 {seconds} 秒预览…",
  "video.remuxedPartial": "已重新封装前 {size}（末尾可能不完整）",
  "video.remuxed": "已重新封装（画质无损）",
  "video.transcoded": "已转码：仅前 {seconds} 秒，480p 预览",
  "video.failed": "转换失败：{err}",
  "video.stillUnplayable": "转码后依然无法播放：编码 {codec} 连 ffmpeg 也解不出画面，浏览器确实没辙",
  "video.unknownCodec": "未知",

  "ffmpeg.noFrames": "解码器无法从该视频提取出画面（源可能使用了浏览器与 ffmpeg 都不支持的编码）",
  "ffmpeg.exitCode": "ffmpeg 退出码 {code}",
};

export type MsgKey = keyof typeof zh;

const en: Record<MsgKey, string> = {
  "app.title": "Image Viewer",

  "unsupported.title": "This browser can't read folders",
  "unsupported.body":
    "This browser supports neither the File System Access API nor folder selection. Please open this page in Chrome, Edge, Firefox or Safari, over https or localhost.",

  "compat.banner.folder":
    "Compatibility mode: you can browse by folder, but this browser can't remember the permission, so you'll need to pick the folder again each time you open the page. Nothing is ever uploaded.",
  "compat.banner.flat":
    "Compatibility mode: {count} files selected. This browser gives no folder structure, so they're shown as a flat list. Nothing is ever uploaded.",
  "compat.crashGuard":
    "This Android browser's engine is too old — picking a folder with it crashes the browser outright, so only Choose photos / videos is offered here. Open the page in a newer Chrome to browse by folder.",
  "compat.flatRoot": "Selected files",

  "android.rootHint":
    "Android does not let a web page read the root of internal storage — selecting it makes the system say \"Can't use this folder\", in every browser. Open a subfolder such as DCIM or Pictures instead (because of that restriction, one folder at a time).",

  // iOS only: on iPhone and iPad the Photos library and the Files app are two separate
  // worlds — the folder picker has no Photos location at all, so iOS gets one button.
  "ios.libraryHint":
    "On iPhone and iPad, the photos and videos your camera takes all live in the Photos library — and the library is not a folder in the Files app. That's why there's a single button here: tap it and multi-select straight from the library. For media stored in the Files app, iCloud Drive or a USB drive, pick \"Choose File\" in that sheet (it comes in as a flat list, with no folder structure).",

  "start.tagline": "Pick a folder on this computer to browse its images and videos.",
  "start.pick": "Choose folder",
  "start.pickPhotos": "Choose photos / videos",
  "start.pickFailed": "Could not open the folder: {err}",
  "start.pickerMissing":
    "This browser never actually opened a picker. Use Choose photos / videos below, or open the page in Chrome or Edge.",

  // 英文起始页正文：面向 "local image viewer / MKV player in Chrome / no upload"
  // 这类搜索意图。刻意不写 "online viewer"——英文里 online 意味着传到远端。
  "landing.h1": "Browse photos and videos from any folder on your computer",
  "landing.lede": "No upload, no install — open the page, pick a folder, and start looking.",

  "browsers.title": "Browser support",
  "browsers.youAreUsing": "You're using {name} — {mode}",
  "browsers.modeFull": "full mode",
  "browsers.modeCompat": "compatibility mode",
  "browsers.modeNone": "not supported",
  "browsers.full.title": "Full mode (recommended)",
  "browsers.full.body":
    "Reads folders directly and remembers the permission, so you don't have to pick again next time: Chrome, Edge, Opera and Brave on desktop (all Chromium-based), and Chrome for Android 132 or newer.",
  "browsers.compat.title": "Compatibility mode",
  "browsers.compat.body":
    "Still browses by folder and still never uploads anything, but the browser can't remember the permission, so you pick the folder again each visit: Firefox, Safari, iPhone (iOS 18.4 or newer), most Android browsers and in-app browsers.",
  "browsers.auto": "The page picks whichever mode your browser supports — there's nothing to switch manually.",

  "landing.how.title": "How it works",
  "landing.how.1": "Click Choose folder and pick any folder on your computer — photos, videos, or both.",
  "landing.how.2": "Subfolders appear in the sidebar, and what's inside them shows up as thumbnails.",
  "landing.how.3": "Double-click a thumbnail to view it full screen, play a video, or start a slideshow.",

  "landing.privacy.title": "Nothing is uploaded — it all happens in your browser",
  "landing.privacy.body":
    "This is a local viewer, not an online one. Your files are read directly by the browser through the File System Access API: no upload, no server, no account, no ads. Your photos and videos never leave your computer, and browsing keeps working offline once the page has loaded.",

  "landing.formats.title": "Opens formats Chrome can't handle by itself",
  "landing.formats.photos":
    "Photos: JPG, PNG, GIF, WebP, BMP, SVG, AVIF, plus any other format your browser can decode.",
  "landing.formats.videos":
    "Video: MP4, WebM and MOV play as they are; MKV, AVI, WMV, MPG, TS, M2TS and FLV are repackaged in the browser (lossless) or decoded with ffmpeg.wasm. When Chrome has no decoder for a codec at all, you get a 480p preview of the first few seconds instead of a file that refuses to open. The originals on disk are never modified and never uploaded.",

  "landing.faq.title": "Frequently asked questions",
  "landing.faq.q1": "Do I have to upload my photos?",
  "landing.faq.a1":
    "No. There is no upload button and no server that stores your files — everything is read locally by your own browser.",
  "landing.faq.q2": "Is it free? Do I need an account?",
  "landing.faq.a2": "It's free, with no sign-up and nothing to install. Open the page and pick a folder.",
  "landing.faq.q3": "Which browsers does it work in?",
  "landing.faq.a3":
    "It depends on the browser. Chrome, Edge and other Chromium browsers on desktop run in full mode: they read folders directly and remember the permission. Firefox, Safari, iPhone and most Android browsers fall back to compatibility mode, which still browses by folder but asks you to pick it again each visit. The page picks the mode itself — there's nothing to switch.",
  "landing.faq.q4": "Can it play MKV files in Chrome?",
  "landing.faq.a4":
    "Yes — that's the main reason it exists. Chrome can't open MKV, AVI, WMV or TS on its own, so the file is repackaged or decoded inside the browser and handed to a standard video player.",
  "landing.faq.q5": "Does it work offline?",
  "landing.faq.a5":
    "After the page has loaded, yes — reading your files needs no network. The one thing it downloads is a ~31 MB decoder, fetched the first time a video needs transcoding and then reused from the browser cache.",
  "landing.faq.q6": "Is there a file size limit?",
  "landing.faq.a6":
    "No — since nothing is uploaded, the only limit is your own disk. Very large videos get a preview first rather than making you wait minutes for a full transcode.",
  "landing.faq.q7": "On Android, why can't I pick the root of internal storage?",
  "landing.faq.a7":
    "Because Android forbids it — it has nothing to do with this page. Since Android 11, no app (browsers included) may be granted the root of internal storage, the root of an SD card, or the Download folder itself; the system shows \"Can't use this folder\" and every browser behaves the same. So on Android you browse one folder at a time — open a subfolder such as DCIM or Pictures. On desktop (Chrome, Edge) there is no such restriction.",
  "landing.faq.q8": "On iPad or iPhone, why can I only pick photos, not a folder?",
  "landing.faq.a8":
    "Because the Photos library is not a folder in the Files app — iOS never exposes it to web pages as a directory, and every browser behaves the same way, so a folder picker can't reach the photos and videos in your library. Directory picking did reach the web in iOS 18.4, but it only covers what's inside the Files app, and most people's photos live in the library; an extra button that leads nowhere is worse than none, so iOS gets a single entry point. Tapping it offers Photo Library / Take Photo or Video / Choose File: multi-select from the library, or Choose File for media in the Files app, iCloud Drive or a USB drive. Either way it arrives as a flat list, since the system provides no folder structure — to browse by folder, use Chrome, Edge or Firefox on a computer.",

  "top.fullscreen": "⛶ Fullscreen",
  "top.exitFullscreen": "Exit fullscreen",
  "top.switchFolder": "Switch folder",
  "top.switchPhotos": "Switch photos",
  // The "＋ Add folder" button was retired from the toolbar on 2026-09-22; logic and copy kept
  "top.addFolder": "＋ Add folder",
  "top.clearCache": "Clear cache",
  "top.cleared": "✓ Cleared",
  "top.slideshow": "▶ Slideshow",

  "root.merged": "All folders ({count})",
  "root.remove": "Remove this folder",
  "root.duplicate": "That folder has already been added.",
  "root.partial":
    "{count} of the folders you picked last time could not be restored (the browser didn't keep the permission). Use Switch folder to pick them again.",

  "list.folders": "Folders",
  "list.media": "Media ({count}) · double-click to open",
  "list.mediaTap": "Media ({count}) · tap to open",
  "list.empty": "No images or videos in this folder",

  "viewer.pause": "⏸ Pause",
  "viewer.play": "▶ Play",
  "viewer.fit": "Fit screen",
  "viewer.interval": "Interval",
  "viewer.seconds": "s",
  "viewer.close": "✕ Close",

  "video.remuxing": "Remuxing…",
  "video.reused": "Reused the earlier conversion",
  "video.transcodePreview": "Transcoding the first {seconds} seconds…",
  "video.analyzing": "Analyzing codecs…",
  "video.loadingDecoder": "Loading decoder (~31 MB, first time only, reused afterwards)…",
  "video.remuxLarge": "Codec {codec}; large file — remuxing the first {size}…",
  "video.remux": "Codec {codec} — remuxing (lossless)…",
  "video.audioLarge":
    "Audio {audio} can't be decoded by the browser — converting to AAC (video untouched) and remuxing the first {size}…",
  "video.audioRecode": "Audio {audio} can't be decoded by the browser — converting to AAC (video untouched)…",
  "video.needTranscode":
    "Codec {codec} can't be decoded by the browser — transcoding the first {seconds} seconds…",
  "video.remuxedPartial": "Remuxed the first {size} (the end may be incomplete)",
  "video.remuxed": "Remuxed (no quality loss)",
  "video.transcoded": "Transcoded: first {seconds} seconds only, 480p preview",
  "video.failed": "Conversion failed: {err}",
  "video.stillUnplayable":
    "Still unplayable after transcoding: even ffmpeg can't decode {codec}, so the browser has no way to play it",
  "video.unknownCodec": "unknown",

  "ffmpeg.noFrames":
    "The decoder could not extract any picture from this video (the source may use a codec that neither the browser nor ffmpeg supports)",
  "ffmpeg.exitCode": "ffmpeg exited with code {code}",
};

const dicts: Record<Lang, Record<MsgKey, string>> = { zh, en };

function detectLang(): Lang {
  // 只有服务端显式注入 "en" 才切英文，其余（没注入、注入别的值）一律中文。
  if (typeof window !== "undefined" && window.__KANTU_LANG__ === "en") return "en";
  return "zh";
}

export const lang: Lang = detectLang();

const active = dicts[lang];

// 取文案。vars 里的 {name} 占位会被替换；用 split/join 而不是 replaceAll，
// 因为 tsconfig 的 target 是 ES2020（replaceAll 要 ES2021）。
export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  const s = active[key];
  if (!vars) return s;
  let out = s;
  for (const k of Object.keys(vars)) {
    out = out.split(`{${k}}`).join(String(vars[k]));
  }
  return out;
}

// <html lang> 和 <title> 是 index.html 里的静态内容，得跟着语言走。
// 在 main.tsx 里、挂载 React 之前调用，避免看到中文标题一闪。
// 注意：英文站这两项服务端已经改好了（SEO 要的是原始 HTML 就正确），这里只是
// 兜底——万一有人只手工加了 __KANTU_LANG__ 而没改标题（静态托管场景），标题也不会错。
export function applyLangToDocument(): void {
  document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
  document.title = window.__KANTU_TITLE__ || t("app.title");
}
