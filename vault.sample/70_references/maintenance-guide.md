---
slug: maintenance-guide
kind: gsheet
source_id: "<Google SheetsのID（実Vaultにのみ記入。ここはプレースホルダ）>"
sa_required: true
cache_dir: _cache/maintenance-guide
refresh_days: 7
last_synced: ""
title: 保守運用ガイドライン
owner: human
---

# 保守運用ガイドライン ポインタ

> 外部（Google Sheets）が正。実IDは Git追跡外の実Vaultにのみ記入。

## 何が書いてあるか
- 保守運用の全般ガイドライン。

## 参照タイミング
- 保守管理エージェントの提案、障害対応・定期運用のとき。

## 取得方法
- Googleサービスアカウント（forclaude@forclaude-495000.iam.gserviceaccount.com・読み取りのみ）で取得。
- `_cache/maintenance-guide/` にスナップショット保存（last_synced付き）。
- 鍵ファイルはリポジトリ/Vault外に置く。取得はClaude Codeが承認を得てから実行。
