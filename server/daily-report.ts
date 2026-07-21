import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { VAULT_PATH, WRITABLE_DIRS } from "./vault.ts";

// ============================================================
// 「学びの日報」データ生成（読み取り専用）。
// 食い違い帳(draft-vs-sent.md)・学んだルール(learned-rules.md)・正例(replies.md)・
// 昇華台帳(_distilled-mids.txt) を読み、ダッシュボードのパネル用に構造化して返す。
// - ファイルが無ければ空の日報を返す（初日でもエラーにしない）。
// - 本文の値はそのまま返す（機微情報は各生成元で除外済み。ここでは新たな判定はしない）。
// ============================================================

/** 1件の食い違い（AIの草案 vs 実際に送った返信）。 */
export interface Divergence {
  when: string; // "2026-07-21 10:00"
  date: string; // "2026-07-21"
  subject: string;
  meta?: string; // ドメイン/案件/audience
  tag: string; // 要学習 / 微修正
  similarity?: number; // 0〜100
  incoming?: string;
  draft: string;
  sent: string;
}

/** 一度の昇華でまとめて追記されたルール群。 */
export interface LearnedRuleBatch {
  when: string; // 昇華の日時
  date: string; // "2026-07-21"
  from: string; // "要学習 2件から"
  rules: string[];
}

export interface DailyReport {
  date: string;
  today: Divergence[];
  newRules: LearnedRuleBatch[];
  counts: {
    repliesTotal: number;
    repliesToday: number;
    divergTotal: number;
    requireLearnTotal: number;
    minorTotal: number;
    requireLearnToday: number;
    untilDistill: number; // 次の自動昇華まであと何件の「要学習」が必要か
    threshold: number;
    rulesTotal: number;
  };
  week: {
    from: string;
    to: string;
    divergences: number;
    requireLearn: number;
    rulesAdded: number;
    examples: Divergence[]; // 直近7日の「要学習」から代表例（最大5件）
  };
}

const memDir = () => path.join(VAULT_PATH, WRITABLE_DIRS.memory);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function readIf(file: string): Promise<string> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return "";
  }
}

/** "## " 見出しで本文をブロックに割る（各ブロックは "## " で始まる）。 */
function splitBlocks(md: string): string[] {
  if (!md.trim()) return [];
  return md
    .split(/\n(?=## )/)
    .map((b) => b.trim())
    .filter((b) => b.startsWith("## "));
}

/** ブロック内の "### 見出し" セクションの本文を取り出す（次の ### か終端まで）。 */
function section(block: string, head: string): string {
  const lines = block.split("\n");
  const buf: string[] = [];
  let cap = false;
  for (const line of lines) {
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (m) {
      cap = m[1].trim().startsWith(head);
      continue;
    }
    if (cap) buf.push(line);
  }
  return buf.join("\n").trim();
}

/** 食い違い帳の1ブロックを Divergence に。分類行が無ければ null（対象外）。 */
function parseDivergence(block: string): Divergence | null {
  const head = block.split("\n")[0].replace(/^##\s+/, "");
  const parts = head.split("|").map((s) => s.trim());
  const when = parts[0] || "";
  const subject = parts[1] || "(件名なし)";
  const meta = parts.slice(2).join(" | ") || undefined;
  const cls = block.match(/分類:\s*(\S+?)（類似度\s*(\d+)%）/);
  if (!cls) return null;
  return {
    when,
    date: when.slice(0, 10),
    subject,
    meta,
    tag: cls[1],
    similarity: Number(cls[2]),
    incoming: section(block, "相手からの直前メッセージ") || undefined,
    draft: section(block, "AIの草案"),
    sent: section(block, "川崎さんが実際に送った返信"),
  };
}

/** 学んだルール(learned-rules.md)を昇華バッチ単位に。 */
function parseRuleBatches(md: string): LearnedRuleBatch[] {
  const out: LearnedRuleBatch[] = [];
  for (const block of splitBlocks(md)) {
    const head = block.split("\n")[0];
    const m = head.match(/^##\s+昇華（([^）]+)）(?:\s*—\s*(.+))?/);
    if (!m) continue;
    const when = m[1].trim();
    const rules = block
      .split("\n")
      .slice(1)
      .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
      .filter(Boolean);
    out.push({ when, date: when.slice(0, 10), from: (m[2] || "").trim(), rules });
  }
  return out;
}

export async function buildDailyReport(): Promise<DailyReport> {
  const dir = memDir();
  const [divMd, rulesMd, repliesMd, ledgerTxt] = await Promise.all([
    readIf(path.join(dir, "draft-vs-sent.md")),
    readIf(path.join(dir, "learned-rules.md")),
    readIf(path.join(dir, "replies.md")),
    readIf(path.join(dir, "_distilled-mids.txt")),
  ]);

  const today = ymd(new Date());
  const weekFrom = ymd(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
  const threshold = Number(process.env.GB_DISTILL_MIN || 3);

  // 食い違い
  const divergences = splitBlocks(divMd)
    .map(parseDivergence)
    .filter((d): d is Divergence => !!d);
  const requireLearn = divergences.filter((d) => d.tag === "要学習");
  const minor = divergences.filter((d) => d.tag === "微修正");

  // 昇華済みの messageId（未昇華の要学習を数えるのに使う）
  const distilledMids = new Set(
    ledgerTxt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  );
  // 各要学習ブロックの mid を拾って、台帳に無い＝未昇華の件数を出す
  let unDistilled = 0;
  for (const block of splitBlocks(divMd)) {
    if (!/分類:\s*要学習/.test(block)) continue;
    // メールのMessage-IDは <...@host> と山括弧を含むため [^>] では切れる。行末の -->まで貪欲でなく拾う。
    const mid = block.match(/<!--\s*mid:\s*(.+?)\s*-->/);
    const id = mid?.[1]?.trim();
    if (id && !distilledMids.has(id)) unDistilled++;
  }

  // ルール
  const ruleBatches = parseRuleBatches(rulesMd);
  const rulesTotal = ruleBatches.reduce((n, b) => n + b.rules.length, 0);

  // 正例（実返信）件数：mid マーカーの数で数える
  const repliesTotal = (repliesMd.match(/<!--\s*mid:/g) || []).length;
  const repliesToday = splitBlocks(repliesMd).filter((b) => {
    const head = b.split("\n")[0].replace(/^##\s+/, "");
    return (head.split("|")[0] || "").trim().startsWith(today);
  }).length;

  const inWeek = (d: string) => d >= weekFrom && d <= today;

  return {
    date: today,
    today: divergences.filter((d) => d.date === today),
    newRules: ruleBatches.filter((b) => b.date === today),
    counts: {
      repliesTotal,
      repliesToday,
      divergTotal: divergences.length,
      requireLearnTotal: requireLearn.length,
      minorTotal: minor.length,
      requireLearnToday: requireLearn.filter((d) => d.date === today).length,
      untilDistill: Math.max(0, threshold - unDistilled),
      threshold,
      rulesTotal,
    },
    week: {
      from: weekFrom,
      to: today,
      divergences: divergences.filter((d) => inWeek(d.date)).length,
      requireLearn: requireLearn.filter((d) => inWeek(d.date)).length,
      rulesAdded: ruleBatches
        .filter((b) => inWeek(b.date))
        .reduce((n, b) => n + b.rules.length, 0),
      examples: requireLearn.filter((d) => inWeek(d.date)).slice(-5).reverse(),
    },
  };
}

/** ファイル存在の軽い確認（初期化前でも落ちないように）。 */
export function memoryDirExists(): boolean {
  return fs.existsSync(memDir());
}
