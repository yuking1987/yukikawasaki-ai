#!/usr/bin/env node
// 草案担当（ヘッドレスClaude）が本文に書いた「## 確認（生成前）」を、
// frontmatter の asks[] に「安全に」変換する（YAMLはgray-matter経由＝手編集しない）。
//
// なぜ本文経由か: frontmatterをヘッドレスAIに直接編集させるとYAMLを壊し重複カードを生む事故があった
//   （tasks/lessons.md 2026-07-16）。本文の編集は安全なので、AIは本文に質問を書き、変換はこのnodeが担う。
//
// 本文フォーマット（草案担当が書く）:
//   ## 確認（生成前）
//   - [決定] 多要素認証の対象は？ / 選択肢: 公式サイトのみ | 3サイト横展開
//   - [調査] ワンタイムパスワード受信用の担当者様リスト（お名前・メール）
//
// 変換後:
//   - frontmatter asks[] に {id, kind, question, options?} を追記（質問文ハッシュでid＝冪等・回答済みは保持）
//   - 本文の「## 確認（生成前）」節を除去
//   - 「## ドラフト」節を「（確認の回答後に草案を作成します）」に差し替え（＝入力待ちと分かる）
//
// usage:
//   node ops/asks-from-body.mjs [vault/items/<id>.md]   // 省略時は vault/items/*.md を全走査
//
// 冪等: 何度流しても同じ結果。確認節が無ければ何も変えない。送信・実行・リモート接続なし。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import matter from "gray-matter";

const ITEMS_DIR = path.join(process.cwd(), "vault", "items");
const DRAFT_PLACEHOLDER = "（確認の回答後に草案を作成します）";

/** 本文を「## 見出し」単位に分割（各partは見出し行＋次の見出し直前までの生テキストを保持）。 */
function splitSections(body) {
  const re = /^##\s+.+$/gm;
  const indices = [];
  let m;
  while ((m = re.exec(body)) !== null) indices.push({ start: m.index, heading: m[0] });
  if (indices.length === 0) return [{ heading: null, text: body }];
  const parts = [];
  if (indices[0].start > 0) parts.push({ heading: null, text: body.slice(0, indices[0].start) });
  for (let i = 0; i < indices.length; i++) {
    const end = i + 1 < indices.length ? indices[i + 1].start : body.length;
    parts.push({ heading: indices[i].heading, text: body.slice(indices[i].start, end) });
  }
  return parts;
}

const titleOf = (part) =>
  part.heading ? part.heading.replace(/^##\s+/, "").trim() : null;

/** 「## 確認（生成前）」節から質問行を取り出す。パースできた質問だけ返す。 */
function parseQuestions(sectionText) {
  const out = [];
  for (const line of sectionText.split("\n")) {
    const m = line.match(/^\s*[-*・]\s*\[(決定|調査|decision|investigation)\]\s*(.+?)\s*$/);
    if (!m) continue;
    const kind = /決定|decision/.test(m[1]) ? "decision" : "investigation";
    let question = m[2].trim();
    let options;
    // 「質問 / 選択肢: A | B | C」
    const om = question.match(/^(.*?)\s*[／/]\s*選択肢\s*[:：]\s*(.+)$/);
    if (om) {
      question = om[1].trim();
      options = om[2]
        .split(/\s*[|｜]\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (!question) continue;
    const id = "ask-" + crypto.createHash("sha1").update(question).digest("hex").slice(0, 8);
    const ask = { id, kind, question };
    if (options && options.length) ask.options = options;
    out.push(ask);
  }
  return out;
}

function processFile(file) {
  if (!fs.existsSync(file)) return { file, skipped: "no file" };
  const g = matter.read(file);
  const body = g.content;
  const parts = splitSections(body);
  const confirmPart = parts.find((p) => {
    const t = titleOf(p);
    return t && t.startsWith("確認（生成前）");
  });
  if (!confirmPart) return { file, added: 0 }; // 確認節なし＝対象外（何もしない）

  const questions = parseQuestions(confirmPart.text);
  if (questions.length === 0) {
    // 節はあるが質問がパースできない＝落とさず残す（可視のまま人が気付ける）。draftも触らない。
    return { file, added: 0, note: "確認節はあるが質問を解釈できず（本文のまま残置）" };
  }

  // --- frontmatter asks[] にマージ（既存は保持＝回答済みを消さない・重複はidで排除）---
  const existing = Array.isArray(g.data.asks) ? g.data.asks : [];
  const byId = new Map();
  for (const a of existing) if (a && a.id) byId.set(a.id, a);
  let added = 0;
  for (const q of questions) {
    if (!byId.has(q.id)) {
      byId.set(q.id, q);
      added++;
    }
  }
  const asks = [...byId.values()];

  // --- 本文：確認節を除去＋ドラフト節を入力待ちプレースホルダに ---
  const kept = [];
  for (const p of parts) {
    const t = titleOf(p);
    if (t && t.startsWith("確認（生成前）")) continue; // 除去
    if (t && t.startsWith("ドラフト")) {
      kept.push(`## ${t}\n\n${DRAFT_PLACEHOLDER}\n\n`);
      continue;
    }
    kept.push(p.text);
  }
  const nextBody = kept.join("");

  // --- 書き戻し（gray-matter・undefined除去）。変化が無ければ書かない（冪等・mtime保護）---
  const clean = {};
  for (const [k, v] of Object.entries({ ...g.data, asks })) if (v !== undefined) clean[k] = v;
  const nextText = matter.stringify(nextBody, clean);
  const prevText = fs.readFileSync(file, "utf8");
  const wrote = nextText !== prevText;
  if (wrote) fs.writeFileSync(file, nextText);

  return { file, added, total: asks.length, wrote };
}

function main() {
  const arg = process.argv[2];
  let files;
  if (arg) {
    files = [path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg)];
  } else {
    if (!fs.existsSync(ITEMS_DIR)) {
      console.error(`no items dir: ${ITEMS_DIR}`);
      process.exit(1);
    }
    files = fs
      .readdirSync(ITEMS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(ITEMS_DIR, f));
  }
  let touched = 0;
  for (const f of files) {
    const r = processFile(f);
    if (r.added > 0) {
      touched++;
      console.log(`asks-from-body: ${path.basename(r.file)} 確認${r.added}件を追加（計${r.total}）`);
    } else if (r.wrote) {
      touched++;
      console.log(`asks-from-body: ${path.basename(r.file)} 確認節を整理（追加0・重複や回答済みは保持）`);
    } else if (r.note) {
      console.log(`asks-from-body: ${path.basename(r.file)} ${r.note}`);
    }
  }
  if (touched === 0) console.log("asks-from-body: 変換対象なし。");
}

main();
