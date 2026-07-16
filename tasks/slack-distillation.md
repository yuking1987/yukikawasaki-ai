# Slack 取り込み＆蒸留 — 別セッション用タスク手順

## 前提
- Slack MCP は接続済み（`claude mcp list` で `slack: ... ✓ Connected`）。
  **新しいセッションで**ツール（`slack_list_channels` / `slack_get_channel_history` /
  `slack_get_thread_replies` / `slack_get_users` / `slack_get_user_profile`）が使える。
- ⚠️ **読み取り専用で使う。** `slack_post_message` / `slack_reply_to_thread` /
  `slack_add_reaction` は**絶対に使わない**（AIは送信・実行しない方針）。

## ゴール
1. **人格**：Slackでの川崎さん本人発言（社内カジュアル）を集めて `10_rules/tone_internal.md` /
   `00_persona/kawasaki.md` を精緻化。正例は `vault/_memory/replies.md`（またはslack節）に追記。
2. **案件コンテキスト**：クライアント名のチャンネル/スレッドから、その客の受発信を
   `vault/20_projects/{client}/context.md`（無ければ作成）へ蒸留。

## 手順（新セッションで実行）
1. **本人特定**：`slack_get_users` で `kawasaki@gb-jp.com` の Slack user ID を取得（例 `U0xxxx`）。
2. **チャンネル一覧**：`slack_list_channels`。社内チーム系（一般/雑談/開発 等）と
   クライアント系（客名がついたチャンネル）に仕分ける。
3. **人格収集**：主要チャンネルで `slack_get_channel_history`（＋必要に応じ `slack_get_thread_replies`）を取得し、
   **user==川崎さんID の発言だけ**抽出。署名/引用ノイズを除き、`_memory/replies.md` に
   「Slack本人発言（正例）」として追記（メールと同じ"金の教師データ"）。
   - 川崎さんのSlackは社内トーン中心 → `10_rules/tone_internal.md` を実データで更新（頻出フレーズ・絵文字・一人称「僕」等）。
   - [[persona-distillation-pipeline]] の tone_external(社外) と対になる社内トーンを厚くする。
4. **案件コンテキスト**：クライアント系チャンネル/スレッドを読み、
   その客の `20_projects/{slug}/context.md` に「Slackでのやり取り・決定事項・地雷」を追記
   （メールの [[client-context-distillation]] と統合。両方が素材）。
5. **蒸留の原則**：素材を鵜呑みにせず事実だけ。不確実は「要確認」。第三者（他メンバー・クライアント）の
   発言は人格には混ぜない（案件コンテキストには含めてよい）。

## 出力先（すべて gitignore の vault/ 内）
- `vault/_memory/replies.md` … 本人発言の正例（追記）
- `vault/10_rules/tone_internal.md` … 社内文体（更新）
- `vault/00_persona/kawasaki.md` … 人格土台（必要に応じ更新）
- `vault/20_projects/{client}/context.md` … 案件コンテキスト（追記/作成）

## 安全
- Slackは読み取りのみ。投稿/リアクション系ツールは使わない。
- 取得データは vault/（gitignore）にのみ保存。コミットしない。

## 関連
- 人格・パイプライン全体: [[persona-distillation-pipeline]]
- 案件コンテキスト（メール素材）: [[client-context-distillation]]
- 開発案件×ローカルGit: [[local-repos-for-dev-replies]]
