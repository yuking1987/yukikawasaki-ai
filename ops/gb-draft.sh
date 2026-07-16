#!/bin/bash
# 定期AI処理（自動下書き）：草案が必要なカードにだけ、川崎さんの声で打ち返し草案を付ける。
# 対象は2種類:
#   (A) status: pending で「## ドラフト」が「（AIが草案を作成予定）」のまま = 未作成
#   (B) status: revision で「## 再考依頼」が付いていて、まだ「✅」印が無い = 再考が必要
# 対象が1件も無ければ Claude を起動せず即終了する（＝ムダな稼働コストをかけない）。
# ローカルの Claude Code をヘッドレス起動。送信・実行・リモート接続はしない（草案を書くだけ）。
cd "$(dirname "$0")/.." || exit 1
export VOLTA_HOME="$HOME/.volta"
export PATH="$VOLTA_HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

CLAUDE="$(command -v claude || echo "$HOME/.volta/bin/claude")"
if [ ! -x "$CLAUDE" ] && ! command -v claude >/dev/null; then
  echo "$(date '+%F %T') エラー: claude CLI が見つかりません。"
  exit 1
fi

# --- 草案が必要なカードを洗い出す（無ければ Claude を起動しない）---
targets=""
# (A) 未作成の草案（pending ＋ プレースホルダ）
while IFS= read -r f; do
  [ -z "$f" ] && continue
  grep -q "^status: pending" "$f" && targets="$targets$f"$'\n'
done < <(grep -l "AIが草案を作成予定" vault/items/*.md 2>/dev/null)
# (B) 未対応の再考依頼（revision ＋ 再考依頼あり ＋ ✅印なし）
for f in vault/items/*.md; do
  if grep -q "^status: revision" "$f" && grep -q "## 再考依頼" "$f" && ! grep -q "再考依頼.*✅" "$f"; then
    targets="$targets$f"$'\n'
  fi
done
targets="$(printf '%s' "$targets" | sed '/^$/d' | sort -u)"

count="$(printf '%s' "$targets" | sed '/^$/d' | grep -c . )"
if [ "${count:-0}" -eq 0 ]; then
  echo "$(date '+%F %T') 草案対象なし（AIは起動しません）。"
  exit 0
fi
echo "$(date '+%F %T') 草案対象 ${count} 件 → Claude で草案を作成します。"

read -r -d '' PROMPT <<'EOF'
あなたはグレート・ビーンズCOO 川崎勇樹の代筆担当です。以下の手順で、承認待ちカードに打ち返し草案を付けてください。提案（草案）を書くだけで、送信・実行・承認・リモート接続は一切しません。

対象の探し方（vault/items/ の *.md を Grep で探す）:
(A) 「status: pending」かつ 本文の「## ドラフト」が「（AIが草案を作成予定）」のままのファイル。
(B) 「status: revision」かつ「## 再考依頼」の見出しがあり、その行にまだ「✅」印が無いファイル。

各対象について:
1. そのファイルの「## 元メッセージ」（スレッド全体）を読む。(B) の場合は「## 再考依頼」に書かれた社長の指示に必ず従う。
2. vault/00_persona/kawasaki.md（人格）、社外なら vault/10_rules/tone_external.md・社内なら tone_internal.md、あれば該当する vault/20_projects/{client}/context.md を読み、文体・前提を合わせる。
3. 川崎さんの声で返信本文を書き、そのファイルの「## ドラフト」節をEditで置き換える。
   - 文体: プレーンテキスト。太字などのMarkdown装飾は使わない。改まって謝りすぎない。簡潔に。
   - 宛名・書き出しは既存の実例に合わせる。本文末尾に署名（「川崎勇樹」等）は付けない（送信時の署名欄に自動で入るため）。
4. スレッドが既に対応済み（最後が川崎さん/GB側）や先方待ちで返信不要なら、草案は書かず「## メモ」に「対応済み/先方待ち：返信不要」とだけ記す。
5. (B) 再考依頼を反映したら、frontmatterの「status: revision」を「status: pending」に戻し、「## 再考依頼」見出しの行末に「 ✅対応済み」を追記する（社長が新しい草案を承認待ちで見られるように）。

やってはいけないこと: メール送信、コマンド実行、FTP/SSH等リモート接続、承認/却下の変更、内部用タスク（SSL把握用カード・GB内部工程・週次オペ等の返信不要なもの）への書き込み。
EOF

echo "===== $(date '+%F %T') draft 開始 ====="
# 編集のみ許可（送信・実行系は与えない）。Bashを付けない＝コマンド実行不可。
claude -p "$PROMPT" --permission-mode acceptEdits --allowedTools "Read,Edit,Grep,Glob" 2>&1
echo "===== $(date '+%F %T') draft 完了 ====="
