#!/bin/bash
# B: 定期AI処理（打ち返し草案の自動生成）を launchd に登録。既定は 60秒ごと。
# 対象カードが0件のときはClaudeを起動せず即終了する設計なので、短間隔でも無駄打ちしない
# （新しい依頼が来たら約1分以内に自動で草案が付く）。実際に草案を作る回だけAIが動く。
# ⚠️ ヘッドレスClaude Codeを起動＝AI稼働。取り込み(gb-ingest)とは別ジョブ。
# 間隔は第1引数（秒）で変更可。例: install-draft-cron.sh 300  → 5分ごと
set -e
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.greatbeans.draft"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INTERVAL="${1:-60}"
mkdir -p "$HOME/Library/LaunchAgents" "$PROJ/ops/logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$PROJ/ops/gb-draft.sh</string></array>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>StandardOutPath</key><string>$PROJ/ops/logs/draft.out.log</string>
  <key>StandardErrorPath</key><string>$PROJ/ops/logs/draft.err.log</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✅ 登録: $LABEL（${INTERVAL}秒ごとに草案生成をチェック。0件ならAIは起動しません）"
echo "   ⚠️ 草案を作る回だけAIが動きます。停止: launchctl unload \"$PLIST\" && rm \"$PLIST\""
