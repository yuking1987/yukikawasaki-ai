#!/bin/bash
# launchd（macOSの定期実行）に取り込みを登録。15分ごとに実行。
set -e
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.greatbeans.ingest"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INTERVAL="${1:-900}"  # 既定900秒=15分。引数で変更可
mkdir -p "$HOME/Library/LaunchAgents" "$PROJ/ops/logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$PROJ/ops/gb-ingest.sh</string></array>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$PROJ/ops/logs/ingest.out.log</string>
  <key>StandardErrorPath</key><string>$PROJ/ops/logs/ingest.err.log</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✅ 登録しました: $LABEL（${INTERVAL}秒ごと）"
echo "   ログ: $PROJ/ops/logs/ingest.out.log"
echo "   停止: bash ops/uninstall-cron.sh"
