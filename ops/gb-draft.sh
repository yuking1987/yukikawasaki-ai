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
# ※GUIの「今すぐ生成」で生成中(draft_status: generating)のカードは対象から除外する
#   （オンデマンド生成との二重起動を防ぐ）。
targets=""
# (A) 未作成の草案（pending ＋ プレースホルダ ＋ 生成中でない）
while IFS= read -r f; do
  [ -z "$f" ] && continue
  grep -q "^draft_status: generating" "$f" && continue
  grep -q "^status: pending" "$f" && targets="$targets$f"$'\n'
done < <(grep -l "AIが草案を作成予定" vault/items/*.md 2>/dev/null)
# (B) 未対応の再考依頼（revision ＋ 再考依頼あり ＋ ✅印なし ＋ 生成中でない）
for f in vault/items/*.md; do
  if grep -q "^status: revision" "$f" && grep -q "## 再考依頼" "$f" && ! grep -q "再考依頼.*✅" "$f" && ! grep -q "^draft_status: generating" "$f"; then
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

大原則（すべてのカードに適用）: 要約や実績表だけで機械的に判断しない。まず、そのカードの「## 元メッセージ」を最初から最後まで熟読し、同じ客の過去のやりとり（vault/70_references/asana-maintenance-precedents.md の当該クライアント欄、context.md の「## 保守対応履歴」、あれば関連する過去カード）まで踏まえて、今の状況・関係性・要望を正しく理解してから草案を書く。前回と状況が違えば、実績に引きずられず熟考して判断を変える（変えた理由は判定サマリに記す）。読んでも分からない点は勝手に埋めず「要・川崎確認」または先方への確認事項として残す。

各対象について:
1. そのファイルの「## 元メッセージ」（スレッド全体）を、途中を飛ばさず最初から最後まで読む。(B) の場合は「## 再考依頼」に書かれた社長の指示に必ず従う。
2. vault/00_persona/kawasaki.md（人格）、社外なら vault/10_rules/tone_external.md・社内なら tone_internal.md、あれば該当する vault/20_projects/{client}/context.md（案件の前提・地雷・キーパーソン）と vault/70_references/asana-maintenance-precedents.md の当該クライアント欄を読み、文体・前提・過去の工数判断を合わせる。
3.【サイトの修正・改修依頼のカードのとき】返信を書く前に vault/70_references/maintenance-judgment.md の「大原則（既存のやりとりを熟考）」と3段手順を実行する。
   - 段階0: vault/_cache/maintenance-clients/index.md（保守案件一覧）を依頼サイトのURLまたは案件名で引き、種別を確定する。sumabi＝Elementorで保守枠は月2箇所、CS・S・Web・LP＝通常制作で月3箇所。進捗・備考（社外編集/他社構築 等）も見る。一覧に無い/引けない場合は勝手に通常扱いせず「要・川崎判断」にする。
   - 段階1: 素材・要件が工数を出せる状態か。不足（対象箇所・変更前後・差し替え画像/文言/リンク先など）があれば、工数は出さず不足を確認する打ち返しにする。
   - 段階2: 保守枠内で収まる軽微対応（タグ改変なし）か、保守外なら何時間か。工数は vault/_cache/maintenance-guide/index.md の工数算出表で照合（最低30min・15min刻み。社内外コミュニケーションコストも加味）。工数表に無い/線引きが割れる/金額の確定提示が要る/影響範囲が大きい場合は独断せず「要・川崎判断」と明記。金額の確定提示はしない。
   - 段階3: 影響範囲。有償は影響範囲込みで工数を出す。保守内は着手せず先方相談。sumabi(レポジトリ無し)はコード確認不可＝実機/WP管理画面での人手確認が必要と記す。
4. 川崎さんの声で返信本文を書き、そのファイルの「## ドラフト」節をEditで置き換える。
   - 修正・改修依頼のカードは、ドラフトの前に「## 判定サマリ（社内用・送信しない）」を書き加える（無ければ新設・あれば更新）。内容＝契約形態/技術スタック・素材の充足・保守内 or 有償◯h（≈概算円は目安まで）・影響範囲・要川崎判断の有無。
   - 文体: プレーンテキスト。太字などのMarkdown装飾は使わない。改まって謝りすぎない。簡潔に。
   - 宛名・書き出しは既存の実例に合わせる。本文末尾に署名（「川崎勇樹」等）は付けない（送信時の署名欄に自動で入るため）。
5. スレッドが既に対応済み（最後が川崎さん/GB側）や先方待ちで返信不要なら、草案は書かず「## メモ」に「対応済み/先方待ち：返信不要」とだけ記す。
6. (B) 再考依頼を反映したら、frontmatterの「status: revision」を「status: pending」に戻し、「## 再考依頼」見出しの行末に「 ✅対応済み」を追記する（社長が新しい草案を承認待ちで見られるように）。

やってはいけないこと: メール送信、コマンド実行、FTP/SSH等リモート接続、承認/却下の変更、内部用タスク（SSL把握用カード・GB内部工程・週次オペ等の返信不要なもの）への書き込み。
EOF

echo "===== $(date '+%F %T') draft 開始 ====="
# 編集のみ許可（送信・実行系は与えない）。Bashを付けない＝コマンド実行不可。
claude -p "$PROMPT" --permission-mode acceptEdits --allowedTools "Read,Edit,Grep,Glob" 2>&1
echo "===== $(date '+%F %T') draft 完了 ====="
