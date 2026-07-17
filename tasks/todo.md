# todo: support@gb-jp.com 宛メールの取り込み漏れを直す

## 背景（2026-07-17）

井上さんが support@gb-jp.com へ転送した「HP・WEB予約ページ修正」（九州商船・荒瀬様／XLSX添付1件）が
カード化されなかった。

原因：`server/ingest-imap.ts` は `IMAP_USER`（kawasaki@gb-jp.com）の箱**だけ**を見ている。
該当メールは creative@gb-jp.com の箱に届いていた。creative@ の認証情報は .env にあるが、
使っているのは過去の学習用（harvest-replies / harvest-client-context）だけで、カード化の取り込みは対象外だった。

迷惑メール判定・無視キーワード（現在「WordPress 更新」の1件のみ）は無関係。純粋に「見ていない箱」だった。

## 方針（川崎さん承認済み）

creative@ の箱は見に行くが、**宛先/CC に support@gb-jp.com を含むメールだけ**を取り込む。
直近2日で creative@ は104通（井上さんの案件が大半）あり、丸ごと取り込むと判断すべきカードが埋もれるため。
support@ 宛は同期間で1通＝今回のメールのみ。

社内の方（井上さん等）からのメールも社外文体で草案を作る件は、**そのままでよい**
（クライアントへ返信したいので社外文体が正しい）。今回は触らない。

## 手順

- [x] 原因特定（どちらの箱に届いているかを読み取りのみで確認）
- [x] 取り込み範囲を川崎さんに確認 → 「support@ 宛だけ」
- [x] 計画を todo.md に記載・承認取得
- [ ] `server/ingest-imap.ts`：複数アカウント対応＋宛先フィルタを実装
- [ ] `.env`：`CREATIVE_ONLY_TO=support@gb-jp.com` を追記
- [ ] ドライラン：該当メールが「要返信」に出ることを確認
- [ ] `--write`：カード化＋XLSX添付の保存を確認
- [ ] 定期実行（launchd）でも拾えることをログで確認
- [ ] `tasks/lessons.md` に学びを記録

## 設計メモ

- `CREATIVE_ONLY_TO`（カンマ区切り）。未設定/空なら creative@ は取り込まない＝これまで通り。
  対象を増やしたくなったらこの1行にアドレスを足すだけで済む。
- creative@ は受信箱のみ。送信箱は見ない：
  「対応済み」判定は本人（kawasaki@）の送信を見て行うため、creative@ の送信を足しても閉じられない。
  川崎さんが kawasaki@ から返信すれば、これまで通り自動でクローズされる。
- グループ配信で To に別名しか出ない場合に備え、To/Cc に加えて配送ヘッダ
  （Delivered-To / X-Original-To / Envelope-To）も宛先として見る。

## レビュー

（実装後に記載）
