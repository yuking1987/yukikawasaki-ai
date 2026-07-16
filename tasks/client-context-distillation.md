# 案件コンテキスト蒸留（社内全員の受発信から）— 別セッション用タスク手順

## ゴール
クライアント（案件）ごとの特性を、**社内メンバー全員の受信・送信すべてのやり取り**から蒸留し、
`vault/20_projects/{client}/context.md` に落とす。
※これは「人格（from:川崎さん本人）」とは別。ここは"その客との関係・履歴・地雷・キーパーソン・依頼傾向"が材料。

## 前提（済）
- `.env` に IMAP（heteml）: kawasaki@ / creative@ の認証情報あり。
- 取得スクリプト `server/harvest-client-context.ts`（`npm run harvest:clients`）実装済み。
  - 全フォルダ×両アカウントを走査し、外部ドメイン（=クライアント）別に受発信をまとめて
    `vault/_cache/clients/{domain}.md` に出力（社内=gb-jp.com/1smallstep.jp は除外）。
  - 期間は `.env` の `IMAP_CLIENT_DAYS`(既定365)、1客あたり保存上限 `CLIENT_MSG_MAX`(既定60)。

## 手順（別セッションで実行）
1. `npm run harvest:clients` を実行 → `vault/_cache/clients/*.md` が生成される（客ごとの全やり取り素材）。
2. 上位クライアント（出力ログの件数順）から、各 `_cache/clients/{domain}.md` を読み、
   次の観点で **`vault/20_projects/{slug}/context.md`** に蒸留する（既存があれば追記/更新）:
   - キーパーソン（担当者名・役割・宛先）
   - 案件の性質（サイト種別・保守/制作・使用サーバやCMS）
   - 依頼の傾向（よく来る依頼・締切感・見積の要否ライン）
   - 地雷・注意点（過去のトラブル・NG・こだわり）
   - 進行中/未決の論点
   - `repos:` ローカルリポジトリのパス（`/Users/yukikawasaki/github` から部分一致で当たりを確認して明記）※[[local-repos-for-dev-replies]]
3. `project_label`（日本語名）も frontmatter に付ける。ドメイン→日本語名の対応は
   既存 `20_projects/*/context.md` と GB-Wiki「先方独自」ページを参照。
4. 蒸留は「素材（_cache/clients）を鵜呑みにせず、事実だけ」。不確実は「要確認」と明記。

## 注意
- `_cache/` と `vault/` は gitignore。実データはコミットしない。
- AIは送信・実行・リモート接続をしない（読むだけ・context.md を書くだけ）。
- スパム/メルマガはスクリプトが除外済みだが、混じっていたら蒸留対象から外す。

## 関連
- 人格・パイプライン全体: [[persona-distillation-pipeline]]
- 開発案件×ローカルGit: [[local-repos-for-dev-replies]]
