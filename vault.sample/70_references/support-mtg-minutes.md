---
slug: support-mtg-minutes
kind: gdrive
source_id: "<Google DriveフォルダのID（実Vaultにのみ記入。ここはプレースホルダ）>"
sa_required: true
cache_dir: _cache/support-mtg-minutes
refresh_days: 30
last_synced: ""
title: 月次サポートチームMTG 議事録
owner: human
---

# 月次サポートチームMTG 議事録 ポインタ

> 外部（Google Drive フォルダ）が正。実フォルダIDは Git追跡外の実Vaultにのみ記入。

## 何が書いてあるか
- 月次のサポートチームMTGの議事録（複数ファイル）。

## 参照タイミング
- 保守管理・サポート方針・繰り返し発生する問い合わせへの打ち返しのとき。

## 取得方法
- Googleサービスアカウント（forclaude@forclaude-495000.iam.gserviceaccount.com・読み取りのみ）でフォルダ内ファイルを取得。
- `_cache/support-mtg-minutes/` にスナップショット保存（last_synced付き）。
- 月次更新のため refresh_days=30。取得はClaude Codeが承認を得てから実行。
