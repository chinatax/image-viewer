#!/usr/bin/env bash
# 构建纯前端静态站点（File System Access API，无需后端）
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 构建前端"
(cd web && npm install)

# ffmpeg.wasm 的 core 有 30MB，不放进源码树，构建时从 node_modules 取，
# 交给 vite 的 public/ 原样拷进 dist，由我们自己的站点托管（不依赖外部 CDN）。
# 必须用 esm 版而非 umd 版：@ffmpeg/ffmpeg 起的是 module worker，worker 里
# importScripts 会抛错，然后回退到动态 import(coreURL)——那条路只认 ES 模块，
# 喂 umd 会以 "failed to import ffmpeg-core.js" 失败。
echo "==> 准备 ffmpeg 解码器"
mkdir -p web/public/ffmpeg
cp -f web/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js \
      web/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm \
      web/public/ffmpeg/

(cd web && npm run build)

echo "==> 完成：web/dist（纯静态站点）"
echo "    本地预览：cd web/dist && python3 -m http.server 8000"
echo "    然后用 Chrome/Edge 打开 http://localhost:8000"
