#!/bin/bash
# 【食い違いの昇華】草案 vs 実返信の「要学習」がたまったら、共通する一般ルールに蒸留する。
# - 完全自動・声かけ不要。ただし安全枠付き:
#   ① あなたの既存の文体ルール(tone_external等)・案件メモ(context.md)は一切上書きしない。
#      書き込むのは専用の追記ファイル vault/_memory/learned-rules.md だけ（追記のみ）。
#   ② 一定数(既定3件)たまるまでAIを起動しない＝ムダな稼働なし。
#   ③ 蒸留結果は機微情報スイープを通してから追記（IP/パスワード値/トークン等が混じったら追記中止）。
# - 送信・実行・リモート接続はしない（Read/Write/Grep/Glob のみ）。
cd "$(dirname "$0")/.." || exit 1
export VOLTA_HOME="$HOME/.volta"
export PATH="$VOLTA_HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SRC="vault/_memory/draft-vs-sent.md"          # 食い違い帳（取り込みが自動で貯める）
LEDGER="vault/_memory/_distilled-mids.txt"     # 昇華済みのメールID（重複昇華を防ぐ台帳・追記のみ）
OUT="vault/_memory/learned-rules.md"           # 学んだルール（草案づくりが毎回読む・追記のみ）
STAGE="vault/_memory/_distill-staging.md"       # AIの蒸留結果の一時置き場
MIN="${GB_DISTILL_MIN:-3}"                      # この件数たまるまで起動しない（既定3・.envやlaunchdのGB_DISTILL_MINで変更可）

[ -f "$SRC" ] || { echo "$(date '+%F %T') 食い違い帳がまだありません。"; exit 0; }

# --- 未昇華の「要学習」メールIDを洗い出す（台帳に無いものだけ）---
# 各エントリは <!-- mid:XXX --> 行の下に「分類: 要学習…」行がある。要学習ブロックのmidだけ拾う。
new_mids="$(
  awk '
    /^<!-- mid:/ { s=$0; sub(/^<!-- mid:/,"",s); sub(/ -->.*$/,"",s); mid=s }
    /分類:.*要学習/ { if (mid!="") print mid }
  ' "$SRC" | sort -u | comm -23 - <(sort -u "$LEDGER" 2>/dev/null)
)"
count="$(printf '%s\n' "$new_mids" | grep -c .)"

if [ "${count:-0}" -lt "$MIN" ]; then
  echo "$(date '+%F %T') 未昇華の要学習 ${count} 件（閾値 ${MIN} 未満）→ 起動しません。"
  exit 0
fi
echo "$(date '+%F %T') 未昇華の要学習 ${count} 件 → 蒸留します。"

CLAUDE="$(command -v claude || echo "$HOME/.volta/bin/claude")"
if [ ! -x "$CLAUDE" ] && ! command -v claude >/dev/null; then
  echo "$(date '+%F %T') エラー: claude CLI が見つかりません。"
  exit 1
fi

rm -f "$STAGE"
mid_list="$(printf '%s\n' "$new_mids" | sed 's/^/  - /')"

PROMPT="あなたは川崎さんの代筆担当の学習係です。以下だけを行います。メール送信・コマンド実行・リモート接続・他ファイルの変更は一切しません。

1. ${SRC} を Read で開く。
2. 次のメッセージID(mid)の「分類: 要学習」エントリだけを対象に、各エントリの『AIの草案』と『川崎さんが実際に送った返信』の差を読み取る:
${mid_list}
3. それらに共通して次の草案づくりに効く一般ルールを、2〜5個の箇条書きに蒸留する。1回きりの案件固有事情ではなく、繰り返し効く原則にする（例: 相互リンクのお礼は未来形の約束でなく完了報告型にする、余計な条件・お願いを足さない 等）。各ルールは1〜2行で簡潔に。
4. 蒸留したルールの箇条書きだけを、Write で ${STAGE} に書く（前置き・見出し・後書きは不要。「- 」始まりの箇条書きのみ）。

機微情報ルール（厳守）: IPアドレス・パスワードの値・トークン(xox*/sk-/AKIA/Bearer)・認証情報・機密URL/ID・請求書番号(INV…)・commit hash は書かない。会社名や案件が特定される固有名詞も避け、一般化した表現に留める。"

echo "===== $(date '+%F %T') distill 開始 ====="
claude -p "$PROMPT" --permission-mode acceptEdits --allowedTools "Read,Write,Grep,Glob" 2>&1
echo "===== $(date '+%F %T') distill 完了 ====="

# --- 蒸留結果を検査して追記（安全枠）---
if [ ! -s "$STAGE" ]; then
  echo "$(date '+%F %T') 蒸留結果が空でした。追記せず終了（台帳は更新しない＝次回再試行）。"
  exit 0
fi
# 機微情報スイープ: 1つでも当たれば追記を中止（値が混じったまま残さない）
if grep -Eiq '([0-9]{1,3}\.){3}[0-9]{1,3}|xox[baprs]-|sk-[A-Za-z0-9]{6}|AKIA[0-9A-Z]{12}|Bearer |password[[:space:]]*[:=]|INV[0-9]{4}' "$STAGE"; then
  echo "$(date '+%F %T') ⚠️ 蒸留結果に機微情報の疑い→追記を中止しました（要・目視確認: $STAGE）。"
  exit 1
fi

if [ ! -f "$OUT" ]; then
  {
    echo "# 学んだルール（草案 vs 実返信の食い違いから自動蒸留）"
    echo "> gb-distill.sh が自動追記。草案づくり(gb-draft)が毎回参照する。人が手で編集・削除してもよい。"
  } >> "$OUT"
fi
{
  echo ""
  echo "## 昇華（$(date '+%F %T')） — 要学習 ${count}件から"
  cat "$STAGE"
} >> "$OUT"
# 昇華済みとして台帳に記録（次回から対象外＝重複しない）
printf '%s\n' "$new_mids" | grep -v '^$' >> "$LEDGER"
rm -f "$STAGE"
echo "$(date '+%F %T') 学んだルールを ${OUT} に追記し、${count} 件を台帳に記録しました。"
