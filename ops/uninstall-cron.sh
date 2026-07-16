#!/bin/bash
LABEL="com.greatbeans.ingest"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl unload "$PLIST" 2>/dev/null && echo "停止しました: $LABEL" || echo "登録がありません"
rm -f "$PLIST"
