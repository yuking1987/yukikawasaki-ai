import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { VAULT_PATH } from "./vault.ts"; // .env読込も兼ねる
import { saveFromUrl, attachBlock, type AttachMeta } from "./attachments.ts";

// ============================================================
// 既存カードの添付バックフィル（Asana）。
// 取り込み済みカードは添付が入っていないため、Asanaから取得して実ファイルを保存し、
// 「## 元メッセージ」に【添付 N件】ブロックを差し込む。
// - frontmatter と「## ドラフト」は触らない（既存の草案・状態を壊さない）
// - 再実行しても重複しない（既存の【添付】ブロックを差し替え）
// 実行: npm run backfill:attach            （下見・書き込みなし）
//       npm run backfill:attach -- --write （実書き込み）
// ============================================================

const TOKEN = process.env.ASANA_TOKEN || "";
const BASE = "https://app.asana.com/api/1.0";
const WRITE = process.argv.includes("--write");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function asana<T = any>(p: string): Promise<T> {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.status === 429) {
      await sleep((Number(res.headers.get("Retry-After") || "1")) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Asana ${res.status}`);
    return ((await res.json()) as any).data;
  }
  throw new Error("rate limited");
}

/** 既存の【添付 N件】ブロックを取り除く（差し替え用）。 */
function stripAttachBlock(section: string): string {
  return section.replace(/\n*【添付 \d+件】\n(?:- .*\n?)*/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * 「## 元メッセージ」に添付ブロックを差し込む。
 * コメント（【YYYY-MM-DD …】）の直前＝説明欄の直後に置く。コメントが無ければ末尾。
 */
function insertIntoThread(body: string, block: string): string {
  const m = body.match(/(## 元メッセージ\n)([\s\S]*?)(?=\n## |\s*$)/);
  if (!m) return body;
  let section = stripAttachBlock(m[2]);
  if (block) {
    const firstComment = section.search(/\n【\d{4}-\d{2}-\d{2}/);
    if (firstComment >= 0) {
      section = section.slice(0, firstComment) + block + section.slice(firstComment);
    } else {
      section = section.replace(/\s*$/, "") + block + "\n";
    }
  }
  return body.slice(0, m.index! + m[1].length) + section + body.slice(m.index! + m[0].length);
}

async function main() {
  if (!TOKEN) {
    console.error("ASANA_TOKEN が未設定です（.env）。");
    process.exit(1);
  }
  const dir = path.join(VAULT_PATH, "items");
  const files = (await fsp.readdir(dir)).filter(
    (f) => f.endsWith(".md") && f.startsWith("asana-")
  );
  console.log(`対象カード: ${files.length}件（${WRITE ? "書き込みモード" : "下見モード・書き込みなし"}）\n`);

  let withAtt = 0,
    saved = 0,
    changed = 0;
  for (const f of files) {
    const abs = path.join(dir, f);
    const g = matter.read(abs);
    const id = String(g.data.id || f.replace(/\.md$/, ""));
    const gid = String(g.data.thread_key || "").replace(/^asana:/, "") || id.replace(/^asana-/, "");
    if (!/^\d+$/.test(gid)) continue;

    let atts: any[] = [];
    try {
      atts = await asana<any[]>(
        `/tasks/${gid}/attachments?opt_fields=name,resource_subtype,size,download_url,created_at`
      );
    } catch {
      continue; // 消えたタスク等はスキップ
    }
    if (!atts?.length) continue;
    withAtt++;

    const metas: AttachMeta[] = [];
    for (const a of atts) {
      const name = a.name || "(名前なし)";
      const meta: AttachMeta = { name, type: a.resource_subtype || "?", size: a.size || 0 };
      if (WRITE && a.download_url) {
        meta.rel = await saveFromUrl(id, name, a.download_url);
        if (meta.rel) saved++;
      }
      metas.push(meta);
    }
    const block = attachBlock(metas);
    const next = insertIntoThread(g.content, block);
    const title = String(g.data.title || "").slice(0, 34);
    console.log(`  [${atts.length}件] ${title} … ${metas.map((m) => m.name).join(", ").slice(0, 70)}`);
    if (WRITE && next !== g.content) {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(g.data)) if (v !== undefined) clean[k] = v;
      await fsp.writeFile(abs, matter.stringify(next, clean), "utf8");
      changed++;
    }
    await sleep(120); // レート制限に配慮
  }
  console.log(
    `\n添付ありカード: ${withAtt}件 / 本文更新: ${changed}件 / 保存したファイル: ${saved}件`
  );
  if (!WRITE) console.log("※下見モードでした。実行するには --write を付けてください。");
}

main().catch((e) => {
  console.error("エラー:", (e as Error).message);
  process.exit(1);
});
