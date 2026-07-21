import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { VAULT_PATH } from "./vault.ts"; // .env読込も兼ねる

// ============================================================
// 既存Asanaカードの「セクション」バックフィル。
// 取り込み時点ではセクションを取っていなかったカードに対し、Asanaから
// memberships.section.name を再取得して frontmatter に section: を後追いで埋める。
// - frontmatter の project と同じプロジェクトの所属からセクション名を採る
//   （1タスクが複数プロジェクトに属すことがあるため、名前一致の所属だけ見る）
// - 触るのは frontmatter の section 行の追加/更新のみ（本文・コメント・ドラフトは不変）
// - 画面表示は frontmatter の section を見るので、これで既存カードにもセクションが出る
// - 冪等：既に同じ section が入っていれば書き込まない（再実行で重複しない）
// 実行: npx tsx server/backfill-asana-sections.ts            （下見・書き込みなし）
//       npx tsx server/backfill-asana-sections.ts --write    （実書き込み）
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

// YAML値として安全なように単一引用符で包む（内部の ' は '' にエスケープ）。
const yamlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * frontmatter に section: を追加/更新する（本文には触れない）。
 * - project: 行の直後へ挿入（ingest-asana.ts の配置に合わせる）
 * - 既に section: 行があれば値だけ差し替え
 */
function upsertSection(raw: string, section: string): { body: string; changed: boolean } {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return { body: raw, changed: false };
  const fm = fmMatch[1];
  const line = `section: ${yamlStr(section)}`;

  const existing = fm.match(/^section:\s*(.*)$/m);
  if (existing) {
    // 既存値と実質同じなら変更なし（クオート/前後空白を無視して比較）
    const cur = existing[1].trim().replace(/^['"]|['"]$/g, "").replace(/''/g, "'");
    if (cur === section) return { body: raw, changed: false };
    const nextFm = fm.replace(/^section:\s*.*$/m, line);
    return { body: raw.replace(fm, nextFm), changed: true };
  }
  // project: 行（project_label ではない）の直後へ挿入
  const projLine = fm.match(/^project:.*$/m);
  if (!projLine) return { body: raw, changed: false };
  const nextFm = fm.replace(/^(project:.*)$/m, `$1\n${line}`);
  return { body: raw.replace(fm, nextFm), changed: true };
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
    const proj = String((matter(raw).data as any).project || "").trim();

    let section = "";
    try {
      const t = await asana<any>(
        `/tasks/${gid}?opt_fields=memberships.project.name,memberships.section.name`
      );
      section =
        (t.memberships || []).find(
          (m: any) => (proj ? m.project?.name === proj : true) && m.section?.name
        )?.section?.name || "";
    } catch (e) {
      console.log(`  ⚠ 取得失敗 ${gid}: ${(e as Error).message}（skip）`);
      errors++;
      await sleep(300);
      continue;
    }
    if (!section) {
      // プロジェクト未所属 or セクションなし → 埋めるものが無い
      skipped++;
      await sleep(200);
      continue;
    }
    const { body, changed } = upsertSection(raw, section);
    if (!changed) {
      skipped++;
      await sleep(200);
      continue;
    }
    const title = (raw.match(/^title:\s*'?(.+?)'?\s*$/m)?.[1] || "").slice(0, 44);
    if (WRITE) {
      await fsp.writeFile(full, body, "utf8");
      console.log(`  ✅ 更新 ${f} | ${proj} › ${section} | ${title}`);
    } else {
      console.log(`  ○ 更新予定 ${f} | ${proj} › ${section} | ${title}`);
    }
    updated++;
    await sleep(250);
  }
  console.log(
    `[backfill] 完了：更新${WRITE ? "" : "予定"} ${updated} / 変更なし ${skipped} / 取得失敗 ${errors}` +
      (WRITE ? "" : "\n  → 問題なければ  npx tsx server/backfill-asana-sections.ts --write  で反映")
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
