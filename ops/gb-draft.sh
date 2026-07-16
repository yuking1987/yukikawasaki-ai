#!/bin/bash
# 定期AI処理（B）：受信箱(pending)で「## ドラフト」が未作成のアイテムに、
# 川崎さんの声で打ち返し草案を付ける。ローカルでClaude Codeをヘッドレス起動する。
# ⚠️ AIを使う＝稼働コストがかかる。頻度は控えめ推奨（1日1〜2回）。
cd "$(dirname "$0")/.." || exit 1
export VOLTA_HOME="$HOME/.volta"
export PATH="$VOLTA_HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

CLAUDE="$(command -v claude || echo "$HOME/.volta/bin/claude")"
if [ ! -x "$CLAUDE" ] && ! command -v claude >/dev/null; then
  echo "$(date '+%F %T') エラー: claude CLI が見つかりません。"
  exit 1
fi

PROMPT='受信箱を処理して。手順: (1) http://127.0.0.1:8787/api/items?status=pending を見る（または vault/items/ の status: pending を探す）。(2) 本文の「## ドラフト」が「（AIが草案を作成予定）」のままのアイテムだけ対象。(3) 各アイテムの「## 元メッセージ」と、vault/00_persona/kawasaki.md・vault/10_rules/tone_external.md(社外)/tone_internal.md(社内)・該当する vault/20_projects/{client}/context.md を読み、川崎さんの声で打ち返し草案を書き、そのアイテムの「## ドラフト」節を Edit で更新する。(4) プレーンテキスト・太字などのMarkdown装飾なし・謝りすぎない。(5) スレッドが既に対応済み/先方待ちなら草案を書かず「## メモ」に「対応済み/先方待ち：返信不要」とだけ記す。(6) 送信・実行・リモート接続はしない。承認/却下もしない（草案を書くだけ）。内部タスク(SSL把握用/GB内部工程/週次オペ等の返信不要なもの)は触らない。'

echo "===== $(date '+%F %T') draft 開始 ====="
# 編集のみ許可（送信系コマンドはそもそも使わせない）
claude -p "$PROMPT" --permission-mode acceptEdits --allowedTools "Read,Edit,Grep,Glob,Bash(curl:*)" 2>&1
echo "===== $(date '+%F %T') draft 完了 ====="
