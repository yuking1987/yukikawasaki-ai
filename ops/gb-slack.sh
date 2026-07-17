#!/bin/bash
# 定期実行されるSlack取り込み（対象chの新着スレッド巡回）。AIは使わない純スクリプト。
# メール取り込み(gb-ingest.sh)とは別枠で、1時間ごとに実行する想定。
# 生成された未対応カードは、次の gb-ingest 巡回で AI下書き(gb-draft) が付く。
cd "$(dirname "$0")/.." || exit 1
# 多重起動防止：mkdir はアトミックなのでロックに使う（macOSに flock は無い）。
LOCKDIR="/tmp/gb-slack.lock.d"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  OLDPID="$(cat "$LOCKDIR/pid" 2>/dev/null)"
  if [ -n "$OLDPID" ] && kill -0 "$OLDPID" 2>/dev/null; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') 前回の取り込みが継続中のためスキップ。"
    exit 0
  fi
  # pid が生存でなくても、ロックが最近取得(=別プロセスが初期化中の可能性)なら奪わない。
  # 10分以上経過したロックだけを stale とみなして回収する（取得〜pid書込み間の競合で二重起動しないため）。
  if [ -z "$(find "$LOCKDIR" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') ロックが最近取得済み（初期化中の可能性）のためスキップ。"
    exit 0
  fi
  # 前回プロセスが異常終了して残った古い stale ロックを回収して取り直す
  rm -f "$LOCKDIR/pid"; rmdir "$LOCKDIR" 2>/dev/null
  mkdir "$LOCKDIR" 2>/dev/null || { echo "$(date '+%Y-%m-%d %H:%M:%S') ロック取得に失敗。スキップ。"; exit 0; }
fi
if ! echo $$ > "$LOCKDIR/pid"; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') pid 書込みに失敗。スキップ。"
  rmdir "$LOCKDIR" 2>/dev/null
  exit 0
fi
# trap は自分が保持するロック($$)のときだけ解放（奪われた他プロセスのロックは消さない）
trap '[ "$(cat "$LOCKDIR/pid" 2>/dev/null)" = "$$" ] && { rm -f "$LOCKDIR/pid"; rmdir "$LOCKDIR" 2>/dev/null; }' EXIT
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
