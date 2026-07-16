---
slug: meet-transcripts
kind: gdrive
source_id: "<Google DriveフォルダのID（実Vaultにのみ記入。ここはプレースホルダ）>"
sa_required: true
cache_dir: _cache/meet-transcripts
refresh_days: 7
last_synced: ""
title: Google Meet 議事録（文字起こし）
owner: human
---

# Google Meet 議事録（文字起こし）ポインタ

> 外部（Google Drive フォルダ）が正。実フォルダIDは Git追跡外の実Vaultにのみ記入。

## 何が書いてあるか
- Google Meet の会議の文字起こし（複数ファイル）。決定事項・経緯の一次情報。

## 参照タイミング
- 案件の経緯確認、打ち合わせでの決定事項に基づく打ち返しのとき。
- 文字起こしは冗長なので、蒸留・要約して案件文脈(20_projects)へ落とし込む素材にする。

## 取得方法
- Googleサービスアカウント（forclaude@forclaude-495000.iam.gserviceaccount.com・読み取りのみ）で取得。
- `_cache/meet-transcripts/` にスナップショット保存（last_synced付き）。
- 取得はClaude Codeが承認を得てから実行。機密を含む場合は confidential 扱いに留意。
