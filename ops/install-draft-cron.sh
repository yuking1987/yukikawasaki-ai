#!/bin/bash
# B: 定期AI処理（打ち返し草案の自動生成）を launchd に登録。既定は 1日2回（8:00 / 18:00）。
# ⚠️ ヘッドレスClaude Codeを起動＝AI稼働コストがかかる。取り込み(gb-ingest)とは別ジョブ。
set -e
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.greatbeans.draft"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$PROJ/ops/logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$PROJ/ops/gb-draft.sh</string></array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$PROJ/ops/logs/draft.out.log</string>
  <key>StandardErrorPath</key><string>$PROJ/ops/logs/draft.err.log</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✅ 登録: $LABEL（毎日 8:00 / 18:00 に草案生成）"
echo "   ⚠️ AI稼働コストがかかります。停止: launchctl unload \"$PLIST\" && rm \"$PLIST\""
