#!/bin/bash
# launchd（macOSの定期実行）に「生ログのお掃除」を月1回で登録する。
# 既定: 毎月1日 午前4時に gb-archive.sh を実行（直近1年より古い記録を奥へ移す）。
set -e
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.greatbeans.archive"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DAY="${1:-1}"    # 毎月の実行日（既定1日）
HOUR="${2:-4}"   # 実行時刻（既定4時）
mkdir -p "$HOME/Library/LaunchAgents" "$PROJ/ops/logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$PROJ/ops/gb-archive.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Day</key><integer>$DAY</integer>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$PROJ/ops/logs/archive.out.log</string>
  <key>StandardErrorPath</key><string>$PROJ/ops/logs/archive.err.log</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✅ 登録しました: $LABEL（毎月${DAY}日 ${HOUR}時にお掃除）"
echo "   ログ: $PROJ/ops/logs/archive.out.log"
echo "   停止: launchctl unload $PLIST"
