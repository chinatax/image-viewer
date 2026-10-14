#!/usr/bin/env bash
# 发布「看图」英文站 pic.to3ks.com。
#
# 与中文站的区别：英文站不是纯静态托管，而是 nginx 反代本机 Go 服务
# （systemd `imageviewer`，启动参数 --en 决定界面语言 + 注入英文 SEO 头），
# 前端由 go:embed 打进二进制，所以发版必须「同步 server/dist → 重编 → 传二进制 → 重启」。
#
# 前置：本机已能用 ssh 免密登录 ubuntu@161.153.57.189（见 README）。
#   ssh-copy-id -i ~/.ssh/id_ed25519.pub ubuntu@161.153.57.189
set -euo pipefail
cd "$(dirname "$0")"

HOST=ubuntu@161.153.57.189
REMOTE_DIR=/home/ubuntu/imageviewer
SERVICE=imageviewer

echo "==> 1/5 构建前端（产物中英双语，两站共用一份）"
./build.sh

echo "==> 2/5 同步产物到 server/dist（go:embed 的源）"
rsync -a --delete web/dist/ server/dist/

echo "==> 3/5 编译 Go 二进制（静态链接，linux/amd64）"
(cd server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags "-s -w" -o imageviewer .)

echo "==> 4/5 上传二进制"
scp -o ConnectTimeout=15 server/imageviewer "$HOST:$REMOTE_DIR/imageviewer.new"
ssh -o ConnectTimeout=15 "$HOST" "
  set -e
  cd $REMOTE_DIR
  cp -f imageviewer imageviewer.bak-\$(date +%Y%m%d-%H%M%S)
  mv -f imageviewer.new imageviewer
  chmod +x imageviewer
"

echo "==> 5/5 重启服务并核验"
ssh -o ConnectTimeout=15 "$HOST" "sudo systemctl restart $SERVICE && sleep 2 && systemctl is-active $SERVICE"
sleep 2
curl -s -m 20 https://pic.to3ks.com/ \
  | grep -o 'assets/index-[^\"]*\.\(js\|css\)' | sort -u

echo "==> 完成。请确认上面两个 assets 与 web/dist/assets 里的名字一致。"
