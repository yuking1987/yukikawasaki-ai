import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import {
  VAULT_PATH,
  WRITABLE_DIRS,
  isValidId,
  isValidSlug,
  resolveContextRef,
} from "./vault.ts";
import type {
  ItemFrontmatter,
  Status,
} from "../shared/roles.ts";
import { STATUSES } from "../shared/roles.ts";

// ============================================================
// 保存役（唯一の書き込み担当）。
// できるのは items/ 周辺の pending 提案の作成・修正・status更新・履歴追記のみ。
// 外部送信・実ツール操作・コマンド実行には一切繋がらない。
// 既存ファイルの上書き/削除/移動はしない（statusで状態管理）。
// ============================================================

const itemsDir = () => path.join(VAULT_PATH, WRITABLE_DIRS.items);
const backupsDir = () => path.join(VAULT_PATH, WRITABLE_DIRS.backups);
const historyFile = () =>
  path.join(VAULT_PATH, WRITABLE_DIRS.history, "log.md");

export interface Item extends ItemFrontmatter {
  body: string;
}

/**
 * 状態遷移の可否。pending→approved/rejected、approved/rejected→pending のみ許可。
 * 同一状態への更新は許可（冪等）。
 */
export function canTransition(from: Status, to: Status): boolean {
  if (from === to) return true;
  const allowed: Record<Status, Status[]> = {
    pending: ["approved", "rejected", "revision", "done"],
    approved: ["pending"],
    rejected: ["pending"],
    revision: ["pending", "rejected", "done"],
    done: ["pending"], // 差し戻し
  };
  return allowed[from]?.includes(to) ?? false;
}

/** items/ 直下の通常ドラフト .md だけを列挙（サブフォルダ・隠し要素は除外）。 */
export async function listItems(): Promise<ItemFrontmatter[]> {
  const dir = itemsDir();
  if (!fs.existsSync(dir)) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out: ItemFrontmatter[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue; // _rule_candidates/ や .backups/ を除外
    if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
    if (!e.name.endsWith(".md")) continue;
    const id = e.name.replace(/\.md$/, "");
    if (!isValidId(id)) continue;
    try {
      const item = await readItem(id);
      if (item) {
        const { body, ...fm } = item;
        void body;
        out.push(fm);
      }
    } catch {
      // 壊れたファイルは一覧から除外（落とさない）
    }
  }
  // 新しい順
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

export async function readItem(id: string): Promise<Item | null> {
  if (!isValidId(id)) return null;
  const file = path.join(itemsDir(), `${id}.md`);
  if (!fs.existsSync(file)) return null;
  if (!assertNotSymlink(file)) return null; // リンクは扱わない
  const raw = await fsp.readFile(file, "utf8");
  const parsed = matter(raw);
  return { ...(parsed.data as ItemFrontmatter), id, body: parsed.content };
}

/** 新規作成。同名idは409（既存を絶対に上書きしない）。 */
export async function createItem(
  fm: ItemFrontmatter,
  body: string
): Promise<{ ok: true; id: string } | { ok: false; code: number; msg: string }> {
  if (!isValidId(fm.id)) return { ok: false, code: 400, msg: "不正なidです" };
  await ensureDir(itemsDir());
  const file = path.join(itemsDir(), `${fm.id}.md`);
  if (fs.existsSync(file))
    return { ok: false, code: 409, msg: "同じidが既に存在します" };
  if (!assertNotSymlink(file))
    return { ok: false, code: 409, msg: "保存先がリンクのため拒否しました" };
  const content = matter.stringify(body ?? "", fmData(fm as unknown as Record<string, unknown>));
  // wx: 既存なら失敗（競合時の上書き防止）
  await fsp.writeFile(file, content, { flag: "wx" });
  await appendHistory(fm.id, "create", `type=${fm.type} status=${fm.status}`);
  return { ok: true, id: fm.id };
}

/** 本文修正。保存前に .backups/ へ退避（同名バックアップは失敗）。 */
export async function updateItemBody(
  id: string,
  newBody: string,
  patch?: Partial<ItemFrontmatter>
): Promise<{ ok: true } | { ok: false; code: number; msg: string }> {
  const current = await readItem(id);
  if (!current) return { ok: false, code: 404, msg: "見つかりません" };
  await backupItem(id, current);
  const { body, ...fm } = current;
  void body;
  const nextFm: ItemFrontmatter = {
    ...fm,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const file = path.join(itemsDir(), `${id}.md`);
  const content = matter.stringify(newBody, fmData(nextFm as unknown as Record<string, unknown>));
  await fsp.writeFile(file, content, "utf8");
  await appendHistory(id, "update-body", "");
  return { ok: true };
}

/** status更新（承認/却下/差し戻し）＋履歴追記。 */
export async function updateStatus(
  id: string,
  status: Status,
  note?: string
): Promise<{ ok: true } | { ok: false; code: number; msg: string }> {
  if (!STATUSES.includes(status))
    return { ok: false, code: 400, msg: "不正なstatusです" };
  const current = await readItem(id);
  if (!current) return { ok: false, code: 404, msg: "見つかりません" };
  if (!canTransition(current.status, status))
    return {
      ok: false,
      code: 409,
      msg: `許可されない状態遷移です（${current.status}→${status}）`,
    };
  const { body, ...fm } = current;
  const nextFm: ItemFrontmatter = {
    ...fm,
    status,
    updatedAt: new Date().toISOString(),
  };
  const file = path.join(itemsDir(), `${id}.md`);
  const content = matter.stringify(body, fmData(nextFm as unknown as Record<string, unknown>));
  await fsp.writeFile(file, content, "utf8");
  await appendHistory(id, `status:${status}`, note ? "（理由/メモ記録あり）" : "");
  return { ok: true };
}

/** スルー（後で）: snooze_until を設定/解除（body・statusは変えない）。 */
export async function setSnooze(
  id: string,
  until: string | null
): Promise<{ ok: true } | { ok: false; code: number; msg: string }> {
  const current = await readItem(id);
  if (!current) return { ok: false, code: 404, msg: "見つかりません" };
  // until は ISO日付/日時、または null（解除）
  if (until !== null && Number.isNaN(Date.parse(until)))
    return { ok: false, code: 400, msg: "不正な日付です" };
  const { body, ...fm } = current;
  const next: ItemFrontmatter = {
    ...fm,
    snooze_until: until ?? undefined,
    updatedAt: new Date().toISOString(),
  };
  const file = path.join(itemsDir(), `${id}.md`);
  await fsp.writeFile(
    file,
    matter.stringify(body, fmData(next as unknown as Record<string, unknown>)),
    "utf8"
  );
  await appendHistory(id, until ? "snooze" : "unsnooze", until ?? "");
  return { ok: true };
}

/** 学び候補を items/_rule_candidates/{id}.md に保存（10_rules/へは書かない）。 */
export async function saveRuleCandidate(
  id: string,
  body: string,
  title: string
): Promise<{ ok: true; id: string } | { ok: false; code: number; msg: string }> {
  if (!isValidSlug(id)) return { ok: false, code: 400, msg: "不正なidです" };
  const dir = path.join(VAULT_PATH, WRITABLE_DIRS.ruleCandidates);
  await ensureDir(dir);
  const file = path.join(dir, `${id}.md`);
  if (fs.existsSync(file))
    return { ok: false, code: 409, msg: "同じidの学び候補が既にあります" };
  if (!assertNotSymlink(file))
    return { ok: false, code: 409, msg: "保存先がリンクのため拒否しました" };
  const content = matter.stringify(body, {
    id,
    title,
    createdAt: new Date().toISOString(),
    note: "人間がObsidianで内容を確認し、必要なものだけ 10_rules/lessons.md へ転記してください。",
  });
  await fsp.writeFile(file, content, { flag: "wx" });
  await appendHistory(id, "rule-candidate", "");
  return { ok: true, id };
}

/**
 * 記憶層への追記。却下・修正を「全部」蓄積し、AIが学びの土台に使う。
 * _history/log.md（本文なしの監査ログ）とは別に、内容つきで残す（Vaultはgitignore済み）。
 * 追記専用。log.md がリンクなら書かない（安全側）。
 */
export interface MemoryRecord {
  action: "rejected" | "revised" | "revision";
  id: string;
  project?: string;
  audience?: string;
  type?: string;
  assignee?: string;
  note?: string;
}
export async function appendMemory(rec: MemoryRecord): Promise<void> {
  const dir = path.join(VAULT_PATH, WRITABLE_DIRS.memory);
  await ensureDir(dir);
  const file = path.join(dir, "corrections.md");
  if (!assertNotSymlink(file)) {
    console.error("[error] 記憶ファイルがリンクのため追記をスキップしました");
    return;
  }
  const ts = new Date().toISOString();
  const label =
    rec.action === "rejected" ? "却下" : rec.action === "revised" ? "修正" : "再考依頼";
  const meta = [rec.project, rec.audience, rec.type, rec.assignee]
    .filter(Boolean)
    .join(" / ");
  let entry = `\n## ${ts} | ${label} | ${rec.id}\n`;
  if (meta) entry += `- 文脈: ${meta}\n`;
  // note は複数行（修正前→修正後など）になり得るのでブロックで残す
  if (rec.note && rec.note.trim()) entry += `内容:\n${rec.note.trim()}\n`;
  await fsp.appendFile(file, entry, "utf8");
}

export const PROPOSAL_TYPES = [
  "persona_proposal",
  "tone_proposal",
  "project_context_proposal",
];

/**
 * Vault相対パス rel の全セグメント（各ancestorディレクトリ＋最終ファイル）が
 * シンボリックリンクでないことを検査。1つでもリンクなら false（ancestorリンク経由の書き込みを拒否）。
 * VAULT_PATH自体は対象外（Vaultルートの指定は許容）。
 */
function noSymlinkInPath(rel: string): boolean {
  const segs = rel.replace(/\\/g, "/").split("/").filter(Boolean);
  let cur = VAULT_PATH;
  for (const seg of segs) {
    cur = path.join(cur, seg);
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) return false;
    } catch {
      return false; // 途中/最終が存在しない
    }
  }
  return true;
}

/** 蒸留提案の反映先ファイル（相対パス）を決定。apply_target優先、無ければtype/audienceから推定。 */
function proposalTarget(item: Item): string | null {
  if (typeof item.apply_target === "string" && item.apply_target.trim())
    return item.apply_target.trim();
  if (item.type === "persona_proposal") return "00_persona/kawasaki.md";
  if (item.type === "tone_proposal")
    return item.audience === "external"
      ? "10_rules/tone_external.md"
      : "10_rules/tone_internal.md";
  if (item.type === "project_context_proposal")
    return `20_projects/${item.project}/context.md`;
  return null;
}

/**
 * 蒸留提案(persona/tone/project_context)の承認時に、対象ファイルへ「追記」で反映する。
 * - 追記のみ（既存を上書き・削除しない）。反映前にバックアップ。
 * - 反映先は 00/10/20 の .md に限定（resolveContextRefで検証）。リンクは拒否。
 * - 提案以外のtypeでは何もしない（返信ドラフトは自動送信しない方針は不変）。
 */
export async function applyProposalOnApprove(
  id: string
): Promise<{ applied: boolean; already?: boolean; target?: string; msg?: string }> {
  const item = await readItem(id);
  if (!item) return { applied: false, msg: "見つかりません" };
  if (!PROPOSAL_TYPES.includes(item.type)) return { applied: false };
  // 冪等: 一度反映済みなら再反映しない（＝失敗ではない。承認自体は通してよい）
  if (item.applied_at) return { applied: false, already: true, msg: "既に反映済み" };
  const rel = proposalTarget(item);
  if (!rel) return { applied: false, msg: "反映先を特定できません" };
  const abs = resolveContextRef(rel); // 00/10/20の.mdのみ許可・resolve+realpath(Vault内)検証
  if (!abs) return { applied: false, msg: `不正な反映先: ${rel}` };
  if (!fs.existsSync(abs)) return { applied: false, msg: `反映先が存在しません: ${rel}` };
  // 反映先までの全ancestor＋最終ファイルにリンクが無いこと（中間リンク経由の書き込みを拒否）
  if (!noSymlinkInPath(rel))
    return { applied: false, msg: "反映先パスにリンクが含まれるため拒否しました" };
  // fail-closed: ドラフトセクションが無ければ反映しない（元メッセージ等の混入を防ぐ）
  const content = extractDraft(item.body).trim();
  if (!content)
    return { applied: false, msg: "ドラフトセクションが無いため反映しません" };
  // 反映前にバックアップ（アプリ所有領域へ・リンク拒否・上書き禁止）
  const bdir = path.join(backupsDir(), "_applied");
  if (!assertNotSymlink(bdir))
    return { applied: false, msg: "バックアップ先がリンクのため拒否しました" };
  await ensureDir(bdir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bfile = path.join(bdir, `${ts}-${path.basename(rel)}`);
  if (!assertNotSymlink(bfile))
    return { applied: false, msg: "バックアップ先がリンクのため拒否しました" };
  await fsp.copyFile(abs, bfile, fs.constants.COPYFILE_EXCL);
  // 追記（既存は保持）
  const entry = `\n\n## 承認反映（${new Date()
    .toISOString()
    .slice(0, 10)}） — from ${item.id}\n${content}\n`;
  await fsp.appendFile(abs, entry, "utf8");
  // 冪等マーカーを記録（applied_at）
  const { body, ...fm } = item;
  await fsp.writeFile(
    path.join(itemsDir(), `${item.id}.md`),
    matter.stringify(
      body,
      fmData({ ...fm, applied_at: new Date().toISOString() } as unknown as Record<
        string,
        unknown
      >)
    ),
    "utf8"
  );
  await appendHistory(id, "applied-proposal", rel);
  return { applied: true, target: rel };
}

/**
 * 正例（あなたが実際に返した打ち返し）を _memory/replies.md に蓄積。
 * これは人格学習の"金の教師データ"（スレッド→本人の実返信のペア）。
 * messageId で重複を防ぐ。
 */
export async function appendReplyExample(rec: {
  messageId: string;
  when: string;
  subject: string;
  project?: string;
  audience?: string;
  incoming?: string;
  reply: string;
  to?: string; // 宛先（表示名<mail>）
  domain?: string; // 宛先ドメイン（クライアント別集計用）
}): Promise<{ recorded: boolean }> {
  const dir = path.join(VAULT_PATH, WRITABLE_DIRS.memory);
  await ensureDir(dir);
  const file = path.join(dir, "replies.md");
  if (!assertNotSymlink(file)) return { recorded: false };
  // 重複チェック（messageIdをマーカーで記録）
  const marker = `<!-- mid:${rec.messageId} -->`;
  if (rec.messageId && fs.existsSync(file)) {
    const existing = await fsp.readFile(file, "utf8");
    if (existing.includes(marker)) return { recorded: false };
  }
  const meta = [rec.domain, rec.project, rec.audience].filter(Boolean).join(" / ");
  let entry = `\n## ${rec.when} | ${rec.subject}${meta ? ` | ${meta}` : ""}\n${marker}\n`;
  if (rec.to) entry += `<!-- to:${rec.to} -->\n`;
  if (rec.incoming && rec.incoming.trim())
    entry += `### 相手からの直前メッセージ\n${rec.incoming.trim()}\n`;
  entry += `### 川崎さんの実際の返信（正例）\n${rec.reply.trim()}\n`;
  await fsp.appendFile(file, entry, "utf8");
  return { recorded: true };
}

/** '## ドラフト' セクションの本文だけを取り出す（記憶の差分記録・コピー用）。無ければ空文字。 */
export function extractDraft(body: string): string {
  const buf: string[] = [];
  let capturing = false;
  for (const line of body.split("\n")) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      capturing = m[1].trim().startsWith("ドラフト");
      continue;
    }
    if (capturing) buf.push(line);
  }
  return buf.join("\n").trim();
}

// --- 内部ヘルパ ---

async function backupItem(id: string, item: Item): Promise<void> {
  const dir = path.join(backupsDir(), id);
  // バックアップ用サブディレクトリがリンクなら拒否（リンク先へ退避させない）。
  if (!assertNotSymlink(dir))
    throw new Error("バックアップ先ディレクトリがリンクのため拒否しました");
  await ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${ts}.md`);
  if (fs.existsSync(file)) throw new Error("同名バックアップが存在します");
  if (!assertNotSymlink(file)) throw new Error("バックアップ先がリンクのため拒否しました");
  const { body, ...fm } = item;
  await fsp.writeFile(file, matter.stringify(body, fmData(fm as unknown as Record<string, unknown>)), {
    flag: "wx",
  });
}

async function appendHistory(
  id: string,
  action: string,
  detail: string
): Promise<void> {
  // 本文は出さない。id・操作種別・時刻のみ。
  await ensureDir(path.dirname(historyFile()));
  // log.md がリンクなら追記しない（リンク先への書き込みを防ぐ）。履歴欠落より安全側を優先。
  if (!assertNotSymlink(historyFile())) {
    console.error("[error] 履歴ファイルがリンクのため追記をスキップしました");
    return;
  }
  const line = `- ${new Date().toISOString()} | ${id} | ${action}${
    detail ? ` | ${detail}` : ""
  }\n`;
  await fsp.appendFile(historyFile(), line, "utf8");
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * 対象パスがシンボリックリンクなら拒否（true=安全に扱える）。
 * 個別ファイル(items/{id}.md等)がリンクだと writeFile がリンク先を書き換えるため。
 * 存在しない場合はOK（新規作成対象）。
 */
function assertNotSymlink(file: string): boolean {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return false;
  } catch {
    // 存在しない → 新規作成対象なのでOK
  }
  return true;
}

/** undefined値を除去（js-yamlはundefinedをダンプできず落ちるため）。 */
function fmData(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
