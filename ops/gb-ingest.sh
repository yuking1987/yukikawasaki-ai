#!/bin/bash
# 定期実行される取り込み（リビング・カード巡回）。AIは使わない純スクリプト。
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
echo "===== $(date '+%Y-%m-%d %H:%M:%S') ingest 開始 ====="
npx tsx server/ingest-imap.ts -- --write
echo "===== $(date '+%Y-%m-%d %H:%M:%S') ingest 完了 ====="
