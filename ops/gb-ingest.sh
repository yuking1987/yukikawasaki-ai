#!/bin/bash
# 定期実行される取り込み（リビング・カード巡回）。AIは使わない純スクリプト。
cd "$(dirname "$0")/.." || exit 1
# node は Volta 管理（~/.volta/bin）。launchd の最小PATHに各種を補う。
export VOLTA_HOME="$HOME/.volta"
export PATH="$VOLTA_HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# 高頻度cron向けにメール走査窓を短く（最近分だけ＝軽い）。深い履歴は harvest 側で取得済み。
export IMAP_SINCE_DAYS="${IMAP_SINCE_DAYS:-3}"
# ローカル固定の tsx を使う（npx のネット取得・非決定実行を避ける）
TSX="./node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') エラー: $TSX が見つかりません。'npm install' を実行してください。"
  exit 1
fi
echo "===== $(date '+%Y-%m-%d %H:%M:%S') ingest 開始 ====="
echo "--- mail ---"
"$TSX" server/ingest-imap.ts -- --write
# Asana（ASANA_TOKEN が .env にあるときだけ）
if grep -q "^ASANA_TOKEN=.\+" .env 2>/dev/null; then
  echo "--- asana ---"
  "$TSX" server/ingest-asana.ts
fi
# 取り込み直後に、草案が必要なカードがあれば自動で下書きを付ける（AIを使う）。
# gb-draft.sh 側で「対象ゼロなら即終了」するので、新着が無い巡回では起動しない＝ムダなコストなし。
# AI自動下書きを止めたいときは launchd の環境変数 GB_AUTO_DRAFT=0 にする。
if [ "${GB_AUTO_DRAFT:-1}" != "0" ]; then
  echo "--- draft ---"
  bash ops/gb-draft.sh
fi
echo "===== $(date '+%Y-%m-%d %H:%M:%S') ingest 完了 ====="
