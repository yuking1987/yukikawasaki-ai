import fs from "node:fs";
import path from "node:path";
import { VAULT_PATH } from "./vault.ts";
import { matchClientLabel } from "./clients.ts";

// ============================================================
// 既存カードの案件名バックフィル（1回だけ流す用）
// vault/items/*.md を順に見て、案件名(project_label)が未設定のカードについて、
// 送信元メール/本文中のドメイン・URLからクライアントを照合し、
// 当たれば `project_label:` を1行だけ追記する（他の項目の書式は一切変えない）。
// 照合表に無い相手は "未分類/保守/GB" のまま。
//   ドライラン: npx tsx server/backfill-client-labels.ts
//   実書き込み: npx tsx server/backfill-client-labels.ts --write
// ============================================================

const WRITE = process.argv.includes("--write");
const itemsDir = path.join(VAULT_PATH, "items");

// reply_to: "山田太郎 <yamada@example.com>" からメールアドレスを取り出す。
function emailFrom(text: string): string | undefined {
  const m = text.match(/<([^>@\s]+@[^>\s]+)>/) || text.match(/([^\s<>]+@[^\s<>]+)/);
  return m?.[1];
}

// YAMLで安全に1行化（シングルクオート・内側の ' は '' でエスケープ）。
function yamlLine(key: string, value: string): string {
  return `${key}: '${value.replace(/'/g, "''")}'`;
}

let scanned = 0,
  matched = 0,
  skipped = 0;

for (const file of fs.readdirSync(itemsDir).sort()) {
  if (!file.endsWith(".md")) continue;
  const full = path.join(itemsDir, file);
  const raw = fs.readFileSync(full, "utf8");
  const fmEnd = raw.indexOf("\n---", 3);
  if (!raw.startsWith("---") || fmEnd < 0) continue;
  const fm = raw.slice(0, fmEnd);
  scanned++;

  // 既に案件名がある／人格・文体などの内部カードは対象外
  if (/^project_label:/m.test(fm)) {
    skipped++;
    continue;
  }
  const source = fm.match(/^source:\s*(.+)$/m)?.[1]?.trim();
  if (!source || !["gmail", "asana", "slack"].includes(source)) {
    skipped++;
    continue;
  }

  const replyTo = fm.match(/^reply_to:\s*(.+)$/m)?.[1] ?? "";
  const label = matchClientLabel({ email: emailFrom(replyTo), text: raw });
  if (!label) continue;
  matched++;

  const projLine = raw.match(/^project:\s*.+$/m);
  const title = fm.match(/^title:\s*(.+)$/m)?.[1]?.replace(/^['"]|['"]$/g, "") ?? file;
  console.log(`  → ${label}\t${title.slice(0, 40)}`);

  if (WRITE && projLine) {
    // project: 行の直後に project_label: を1行だけ差し込む
    const insertAt = raw.indexOf(projLine[0]) + projLine[0].length;
    const next =
      raw.slice(0, insertAt) +
      "\n" +
      yamlLine("project_label", label) +
      raw.slice(insertAt);
    fs.writeFileSync(full, next);
  }
}

console.log(
  `\n[backfill] 走査 ${scanned} / 照合ヒット ${matched} / 対象外(既設定・内部) ${skipped} 件`
);
if (!WRITE) console.log("（ドライラン。反映するには --write を付けて再実行）");
