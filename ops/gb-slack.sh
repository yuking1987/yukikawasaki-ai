#!/bin/bash
# 定期実行されるSlack取り込み（対象chの新着スレッド巡回）。AIは使わない純スクリプト。
# メール取り込み(gb-ingest.sh)とは別枠で、1時間ごとに実行する想定。
# 生成された未対応カードは、次の gb-ingest 巡回で AI下書き(gb-draft) が付く。
cd "$(dirname "$0")/.." || exit 1
# node は Volta 管理（~/.volta/bin）。launchd の最小PATHに各種を補う。
export VOLTA_HOME="$HOME/.volta"
export PATH="$VOLTA_HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# 高頻度巡回なので遡り窓は短め（深い履歴は初回に手動蒸留済み）。
export SLACK_SINCE_DAYS="${SLACK_SINCE_DAYS:-7}"
# ローカル固定の tsx を使う（npx のネット取得・非決定実行を避ける）
TSX="./node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') エラー: $TSX が見つかりません。'npm install' を実行してください。"
  exit 1
fi
# SLACK_BOT_TOKEN が .env にあるときだけ実行（未設定なら黙って終了）。
if ! grep -q "^SLACK_BOT_TOKEN=.\+" .env 2>/dev/null; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') SLACK_BOT_TOKEN 未設定のためスキップ。"
  exit 0
fi
echo "===== $(date '+%Y-%m-%d %H:%M:%S') slack 取り込み開始 ====="
"$TSX" server/ingest-slack.ts
echo "===== $(date '+%Y-%m-%d %H:%M:%S') slack 取り込み完了 ====="
