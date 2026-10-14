import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Pure client-side app (File System Access API). Relative base so the build
// works whether it is served at the root, a subpath, or via file://.
export default defineConfig({
  base: "./",
  plugins: [react()],
  // @ffmpeg/ffmpeg 内部用 new Worker(new URL("./worker.js", import.meta.url)) 起线程。
  // 依赖预打包会把这个包挪进 .vite/deps/，紧邻的 worker.js 却不跟过去，dev 下 404。
  // 排除掉预打包，让 dev 直接按源码 ESM 提供（生产构建本来就由 rollup 正确处理 worker）。
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg"] },
});
