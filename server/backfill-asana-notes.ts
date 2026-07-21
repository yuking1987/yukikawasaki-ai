import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { VAULT_PATH } from "./vault.ts"; // .env読込も兼ねる
import { clean } from "./ingest-asana.ts";

// ============================================================
// 既存Asanaカードの「説明欄」バックフィル。
// 旧clean()が区切り線(----)で本文を切っていたため、【概要】以降が空になっていたカードを
// Asanaから notes を再取得し、修正後 clean() で作り直して「## 元メッセージ」の説明欄だけ差し替える。
// - frontmatter・コメント・添付ブロック・判定サマリ・ドラフトは触らない（説明欄のみ）
// - 説明欄の中身が変わるカードだけ書き込む（冪等・再実行で重複しない）
// 実行: npx tsx server/backfill-asana-notes.ts            （下見・書き込みなし）
//       npx tsx server/backfill-asana-notes.ts --write    （実書き込み）
// ============================================================

const TOKEN = process.env.ASANA_TOKEN || "";
const BASE = "https://app.asana.com/api/1.0";
const WRITE = process.argv.includes("--write");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function asana<T = any>(p: string): Promise<T> {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.status === 429) {
      await sleep(Number(res.headers.get("Retry-After") || "1") * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Asana ${res.status}`);
    return ((await res.json()) as any).data;
  }
  throw new Error("rate limited");
}

/**
 * 「## 元メッセージ」内の説明欄本文（【説明欄】直後〜 添付/コメント/次セクションの手前）を差し替える。
 * 添付ブロック・コメント・その他セクションはそのまま残す。
 */
function replaceNotes(body: string, newNotes: string): { body: string; changed: boolean } {
  const re = /(【説明欄】\n)([\s\S]*?)(?=\n【添付 |\n【\d{4}-\d{2}-\d{2}|\n## |$)/;
  const m = body.match(re);
  if (!m) return { body, changed: false };
  const oldNotes = m[2].replace(/\s+$/, "");
  const next = (newNotes || "（説明なし）").replace(/\s+$/, "");
  if (oldNotes.trim() === next.trim()) return { body, changed: false };
  const start = m.index! + m[1].length;
  const nb = body.slice(0, start) + next + body.slice(start + m[2].length);
  return { body: nb, changed: true };
}

async function main() {
  if (!TOKEN) {
    console.error("[backfill] ASANA_TOKEN が未設定です（.env）。中止。");
    process.exit(1);
  }
  const itemsDir = path.join(VAULT_PATH, "items");
  const files = fs.readdirSync(itemsDir).filter((f) => f.startsWith("asana-") && f.endsWith(".md"));
  console.log(`[backfill] Asanaカード ${files.length} 件を点検（${WRITE ? "書き込み" : "下見のみ"}）`);

  let updated = 0,
    skipped = 0,
    errors = 0;
  for (const f of files) {
    const gid = f.replace(/^asana-/, "").replace(/\.md$/, "");
    const full = path.join(itemsDir, f);
    const raw = fs.readFileSync(full, "utf8");
    if (!raw.includes("【説明欄】")) {
      skipped++;
      continue;
    }
    let notes = "";
    try {
      const t = await asana<any>(`/tasks/${gid}?opt_fields=notes`);
      notes = clean(t.notes || "");
    } catch (e) {
      console.log(`  ⚠ 取得失敗 ${gid}: ${(e as Error).message}（skip）`);
      errors++;
      await sleep(300);
      continue;
    }
    const { body, changed } = replaceNotes(raw, notes);
    if (!changed) {
      skipped++;
      await sleep(200);
      continue;
    }
    const title = (raw.match(/^title:\s*'?(.+?)'?\s*$/m)?.[1] || "").slice(0, 44);
    if (WRITE) {
      await fsp.writeFile(full, body, "utf8");
      console.log(`  ✅ 更新 ${f} | ${title}`);
    } else {
      const recovered = notes.replace(/^[\s\S]*?【概要】\s*/, "").split("\n").filter(Boolean).slice(0, 2).join(" / ");
      console.log(`  ○ 更新予定 ${f} | ${title}\n      復元: ${recovered.slice(0, 70)}`);
    }
    updated++;
    await sleep(250);
  }
  console.log(
    `[backfill] 完了：更新${WRITE ? "" : "予定"} ${updated} / 変更なし ${skipped} / 取得失敗 ${errors}` +
      (WRITE ? "" : "\n  → 問題なければ  npx tsx server/backfill-asana-notes.ts --write  で反映")
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
