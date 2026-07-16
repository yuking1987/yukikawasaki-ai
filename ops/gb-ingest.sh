#!/bin/bash
# 定期実行される取り込み（リビング・カード巡回）。AIは使わない純スクリプト。
cd "$(dirname "$0")/.." || exit 1
# node は Volta 管理（~/.volta/bin）。launchd の最小PATHに各種を補う。
export VOLTA_HOME="$HOME/.volta"
export PATH="$VOLTA_HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# ローカル固定の tsx を使う（npx のネット取得・非決定実行を避ける）
TSX="./node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') エラー: $TSX が見つかりません。'npm install' を実行してください。"
  exit 1
fi
echo "===== $(date '+%Y-%m-%d %H:%M:%S') ingest 開始 ====="
"$TSX" server/ingest-imap.ts -- --write
echo "===== $(date '+%Y-%m-%d %H:%M:%S') ingest 完了 ====="
