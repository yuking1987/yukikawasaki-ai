#!/bin/bash
# launchd（macOSの定期実行）にSlack取り込みを登録。既定1時間ごと（参照取り込みと同じ間隔）。
set -e
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.greatbeans.slack"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INTERVAL="${1:-3600}"  # 既定3600秒=1時間。引数で変更可
mkdir -p "$HOME/Library/LaunchAgents" "$PROJ/ops/logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$PROJ/ops/gb-slack.sh</string></array>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$PROJ/ops/logs/slack.out.log</string>
  <key>StandardErrorPath</key><string>$PROJ/ops/logs/slack.err.log</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✅ 登録しました: $LABEL（${INTERVAL}秒ごと）"
echo "   ログ: $PROJ/ops/logs/slack.out.log"
echo "   停止: launchctl unload $PLIST"
