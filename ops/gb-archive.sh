#!/bin/bash
# 【生ログのお掃除（アーカイブ）】第2の脳の憲法③に忠実に:「消さない・奥へ移す・前面は軽く」。
# - 対象: vault/_memory/replies.md（正例・最大）と draft-vs-sent.md（食い違い帳）。
#   ※ learned-rules.md（昇華された前面ルール）と corrections.md は触らない。
# - 直近1年ぶんは前面に残し、それより古いエントリは vault/_memory/_archive/ へ移動（Gitにも残る＝記憶喪失なし）。
# - 奥へ移したエントリの mid は vault/_memory/_archived-mids.txt に集約し、再取り込みで二重登録されないようにする。
# - 送信・実行・リモート接続はしない。ファイルの移動のみ。--dry-run で下見だけできる。
set -e
cd "$(dirname "$0")/.." || exit 1

MEM="vault/_memory"
ARCH="$MEM/_archive"
LEDGER="$MEM/_archived-mids.txt"   # 奥へ移した mid の台帳（追記のみ・重複防止に使う）
KEEP_MONTHS="${GB_ARCHIVE_KEEP_MONTHS:-12}"  # 前面に残す月数（既定12ヶ月＝1年）
DRY=0
[ "$1" = "--dry-run" ] && DRY=1

[ -d "$MEM" ] || { echo "$(date '+%F %T') _memory がありません。"; exit 0; }
mkdir -p "$ARCH"

# 何ヶ月前より古いものを奥へ？ 例: 12ヶ月 → 今日から1年前の日付が境目
CUT="$(date -v-"${KEEP_MONTHS}"m +%F 2>/dev/null || date -d "-${KEEP_MONTHS} months" +%F)"
echo "$(date '+%F %T') お掃除開始（境目=${CUT} より古いエントリを奥へ／前面は直近${KEEP_MONTHS}ヶ月）"
[ "$DRY" = 1 ] && echo "  ※ 下見モード（--dry-run）: 実際には動かしません。"

rotate_one() {
  local base="$1"                       # 例: replies.md
  local src="$MEM/$base"
  [ -f "$src" ] || { echo "  - $base: ありません（スキップ）"; return; }

  local ftmp atmp mtmp
  ftmp="$(mktemp)"; atmp="$(mktemp)"; mtmp="$(mktemp)"

  # エントリ（^## で始まる見出し単位）を、見出し内の YYYY-MM-DD で前面/奥へ振り分ける。
  # 日付が無い見出しや先頭前置きは安全側＝前面に残す。macOS標準awk(2引数match)で動く書き方。
  awk -v cut="$CUT" -v front="$ftmp" -v arch="$atmp" -v mids="$mtmp" '
    function flush() {
      if (nlines==0) return
      out = is_archive ? arch : front
      for (i=1;i<=nlines;i++) print buf[i] > out
      if (is_archive && mid!="") print mid > mids
      nlines=0; mid=""
    }
    BEGIN { nlines=0; is_archive=0; started=0; mid="" }
    /^## / {
      if (started) flush()
      started=1
      if (match($0, /[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]/)) {
        d = substr($0, RSTART, 10)
        is_archive = (d < cut) ? 1 : 0
      } else { is_archive = 0 }
      buf[++nlines]=$0; next
    }
    !started { print > front; next }   # 先頭の前置き行は前面へ
    {
      if ($0 ~ /<!-- mid:/) { t=$0; sub(/.*<!-- mid:/,"",t); sub(/ -->.*/,"",t); mid=t }
      buf[++nlines]=$0
    }
    END { if (started) flush() }
  ' "$src"

  local moved kept
  # grep -c は0件でも終了コード1を返すので、|| は付けず数値だけ受け取る
  moved="$(grep -c '^## ' "$atmp" 2>/dev/null)"; moved="${moved:-0}"
  kept="$(grep -c '^## ' "$ftmp" 2>/dev/null)"; kept="${kept:-0}"

  if [ "${moved:-0}" -eq 0 ]; then
    echo "  - $base: 奥へ移すエントリなし（前面 ${kept}件のまま）"
    rm -f "$ftmp" "$atmp" "$mtmp"; return
  fi

  echo "  - $base: 奥へ ${moved}件 / 前面に ${kept}件を残す"
  if [ "$DRY" = 1 ]; then rm -f "$ftmp" "$atmp" "$mtmp"; return; fi

  # 本番: バックアップ→奥へ追記→台帳追記→前面を差し替え
  cp "$src" "$src.bak"                                   # 変更前バックアップ（安全ルール7）
  cat "$atmp" >> "$ARCH/$base"                           # 奥へは追記（過去分を消さない）
  [ -s "$mtmp" ] && cat "$mtmp" >> "$LEDGER"             # 移した mid を台帳へ追記
  mv "$ftmp" "$src"                                      # 前面を軽い版に差し替え
  rm -f "$atmp" "$mtmp"
  echo "    ✅ 完了（バックアップ: $base.bak／奥: _archive/$base）"
}

rotate_one "replies.md"
rotate_one "draft-vs-sent.md"

echo "$(date '+%F %T') お掃除おわり。"
