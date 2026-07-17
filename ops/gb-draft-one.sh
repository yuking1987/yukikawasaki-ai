#!/bin/bash
# 単一カードの打ち返し草案を「今すぐ」生成する（GUIの「✨今すぐ生成」ボタンから、サーバが起動）。
# usage: gb-draft-one.sh <itemId>
# ローカルの Claude Code をヘッドレスで1件だけ回す。送信・実行・リモート接続はしない（草案を書くだけ）。
# 完了で frontmatter の draft_status を消す（＝生成中でない）。失敗時は draft_status: error を残す。
cd "$(dirname "$0")/.." || exit 1
export VOLTA_HOME="$HOME/.volta"
export PATH="$VOLTA_HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

ID="$1"
FILE="vault/items/${ID}.md"
[ -n "$ID" ] || { echo "usage: gb-draft-one.sh <itemId>"; exit 1; }
[ -f "$FILE" ] || { echo "no file: $FILE"; exit 1; }

# frontmatter の draft_status を安全に更新（gray-matterでYAMLを壊さない）。
setstatus() {
  node -e '
const fs=require("fs"), matter=require("gray-matter");
const f=process.argv[1], s=process.argv[2];
const g=matter.read(f);
if(s==="clear"){ delete g.data.draft_status; delete g.data.draft_started_at; }
else { g.data.draft_status=s; }
const clean={}; for(const [k,v] of Object.entries(g.data)) if(v!==undefined) clean[k]=v;
fs.writeFileSync(f, matter.stringify(g.content, clean));
' "$FILE" "$1"
}

CLAUDE="$(command -v claude || echo "$HOME/.volta/bin/claude")"
if [ ! -x "$CLAUDE" ] && ! command -v claude >/dev/null; then
  echo "$(date '+%F %T') エラー: claude CLI が見つかりません。"
  setstatus error
  exit 1
fi

read -r -d '' PROMPT <<EOF
あなたはグレート・ビーンズCOO 川崎勇樹の代筆担当です。対象は1件だけ: ${FILE}
このカードに打ち返し草案を付けてください。提案（草案）を書くだけで、送信・実行・承認・リモート接続は一切しません。

大原則: 要約や実績表だけで機械的に判断しない。まず ${FILE} の「## 元メッセージ」を最初から最後まで熟読し、同じ客の過去のやりとり（vault/70_references/asana-maintenance-precedents.md の当該クライアント欄、context.md の「## 保守対応履歴」）まで踏まえてから草案を書く。前回と状況が違えば実績に引きずられず熟考して判断を変える。分からない点は勝手に埋めず「要・川崎確認」または先方への確認事項として残す。

手順:
1. ${FILE} の「## 元メッセージ」（スレッド全体）を熟読する。本文に「【添付 N件】…→ vault/_attachments/…」があれば、それが先方から届いた素材の実ファイル。素材が揃っているかは文言でなく添付で判断し、画像の見た目（バナー/ロゴの比率・既存とのバランス、スクショの指摘箇所、PDFの中身）が判断に関わるときは、そのパスを Read で開いて実物を確認する。
2. vault/00_persona/kawasaki.md（人格）、社外なら vault/10_rules/tone_external.md・社内なら tone_internal.md、あれば該当する vault/20_projects/{client}/context.md と vault/70_references/asana-maintenance-precedents.md の当該クライアント欄を読み、文体・前提・過去の工数判断を合わせる。
3.【サイトの修正・改修依頼のとき】返信を書く前に vault/70_references/maintenance-judgment.md の3段手順を実行する（段階0=保守案件一覧で種別sumabi=月2/通常=月3を確定、段階1=素材充足、段階2=保守内か有償◯hか＝工数表と過去実績で照合、段階3=影響範囲）。工数表に無い/線引きが割れる/金額の確定提示/影響範囲大は独断せず「要・川崎判断」。金額の確定提示はしない。
4. 川崎さんの声で返信本文を書き、${FILE} の「## ドラフト」節をEditで置き換える。修正・改修依頼のカードは、ドラフトの前に「## 判定サマリ（社内用・送信しない）」を書き加える（契約形態/技術スタック・素材充足・保守内 or 有償◯h・影響範囲・要川崎判断の有無）。文体はプレーンテキスト（Markdown装飾なし）、宛名・書き出しは既存の実例に合わせ、末尾に署名は付けない。
5. スレッドが既に対応済み（最後が川崎さん/GB側）や先方待ちで返信不要なら、草案は書かず「## メモ」に「対応済み/先方待ち：返信不要」とだけ記す。

やってはいけないこと: メール送信、コマンド実行、FTP/SSH等リモート接続、frontmatterの status 変更。
EOF

echo "===== $(date '+%F %T') draft-one ${ID} 開始 ====="
if "$CLAUDE" -p "$PROMPT" --permission-mode acceptEdits --allowedTools "Read,Edit,Grep,Glob" 2>&1; then
  setstatus clear
  echo "===== $(date '+%F %T') draft-one ${ID} 完了 ====="
else
  setstatus error
  echo "===== $(date '+%F %T') draft-one ${ID} 失敗 ====="
fi
