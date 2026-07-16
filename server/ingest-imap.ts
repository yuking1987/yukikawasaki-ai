import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { ensureWritableForCli } from "./vault.ts"; // .env読込＋安全/初期化検査
import {
  createItem,
  listItems,
  updateStatus,
  updateThread,
  appendReplyExample,
} from "./items.ts";
import type { ItemFrontmatter } from "../shared/roles.ts";

// ============================================================
// heteml等のIMAPメールを取り込む。
// - 受信箱(INBOX)＋送信済み(INBOX.Sent)を読み、スレッド単位にまとめる
// - 最後が相手＝要返信 → pending下書き化
// - 最後が自分(本人)＝対応済み → その返信を「正例」として _memory/replies.md に自動学習
//   ＋ 該当する pending 項目があれば「対応済み(done)」に自動クローズ
// 既定はドライラン。`--write` で書き込み。資格情報は .env、本文はログに出さない。
// ============================================================

const HOST = process.env.IMAP_HOST || "";
const PORT = Number(process.env.IMAP_PORT || 993);
const USER = process.env.IMAP_USER || "";
const PASS = process.env.IMAP_PASSWORD || "";
const ME = (process.env.KAWASAKI_GMAIL || USER).toLowerCase();
const WRITE = process.argv.includes("--write");
const DAYS = Number(process.env.IMAP_SINCE_DAYS || 30);
const SENT_BOX = process.env.IMAP_SENT || "INBOX.Sent";

function junkReason(from: string, headers: Map<string, string>): string | null {
  const f = from.toLowerCase();
  if (/(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounce|notification|newsletter|mailmag|magazine|marketing|webinar|セミナー|ウェビナー)/.test(f))
    return "自動送信/配信っぽい送信元";
  if (headers.has("list-unsubscribe")) return "List-Unsubscribe（メルマガ）";
  const prec = (headers.get("precedence") || "").toLowerCase();
  if (["bulk", "list", "junk"].includes(prec)) return `Precedence: ${prec}`;
  const auto = (headers.get("auto-submitted") || "").toLowerCase();
  if (auto && auto !== "no") return `Auto-Submitted: ${auto}`;
  return null;
}

function normalizeSubject(s: string): string {
  return (s || "")
    .replace(/^(\s*(re|fwd|fw)\s*(\[[^\]]*\])?\s*[:：]\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 50) || "mail";
}

const SIG_RE =
  /^(--\s*$|={3,}|＝{3,}|▲▽|[┏┃┗]|＊{2,}|■|【人材の定着|・(離職率|活躍する人材)|「?マンガでわかるCIY|https?:\/\/ciy-biz|株式会社[　 ]?グレート・ビーンズ|福岡市中央区薬院|プライバシーマーク|Tel[ 　]|TEL[：:]|Fax[ 　]|Mobile)/;
const QUOTE_HDR_RE =
  /^(-{5,}$|.*\d{4}年\d{1,2}月\d{1,2}日.*(のメール|：$|:$)|On .*wrote:$|.*<[^>]+>のメール)/;
function cleanBody(text: string): string {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const t = line.trim();
    if (t.startsWith(">")) continue;
    if (SIG_RE.test(t) || QUOTE_HDR_RE.test(t)) break;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

interface Msg {
  from: string;
  fromName: string;
  subject: string;
  date: string;
  text: string;
  messageId: string;
}

async function fetchBox(client: ImapFlow, path: string, since: Date): Promise<Msg[]> {
  const res: Msg[] = [];
  let lock;
  try {
    lock = await client.getMailboxLock(path);
  } catch {
    return res; // 無いメールボックスはスキップ
  }
  try {
    for await (const m of client.fetch({ since }, { source: true, internalDate: true })) {
      const p: ParsedMail = await simpleParser(m.source as Buffer);
      const from = p.from?.value?.[0]?.address || "";
      const headers = new Map<string, string>();
      for (const k of ["list-unsubscribe", "precedence", "auto-submitted"]) {
        const v = p.headers.get(k);
        if (v) headers.set(k, String(v));
      }
      // 受信のみジャンク判定（送信済みは自分の返信なので常に採用）
      if (from.toLowerCase() !== ME && junkReason(from, headers)) continue;
      const rawDate = p.date || m.internalDate || new Date();
      res.push({
        from,
        fromName: p.from?.value?.[0]?.name || from,
        subject: p.subject || "(件名なし)",
        date: (rawDate instanceof Date ? rawDate : new Date(rawDate)).toISOString(),
        text: (p.text || "").trim(),
        messageId: p.messageId || "",
      });
    }
  } finally {
    lock.release();
  }
  return res;
}

async function main() {
  if (!HOST || !USER || !PASS) {
    console.error("IMAP設定が不足しています（.env の IMAP_HOST/USER/PASSWORD）。");
    process.exit(1);
  }
  // 書き込み時はサーバと同じ安全検査＋初期化検査（symlink/外部リンク/外部Vault未初期化）
  if (WRITE) {
    const ready = ensureWritableForCli();
    if (!ready.ok) {
      console.error(`[imap] ${ready.msg}。書き込みを中止します。`);
      process.exit(1);
    }
  }
  console.log(`[imap] 接続: ${USER}@${HOST}:${PORT}（過去${DAYS}日・${WRITE ? "書き込み" : "ドライラン"}）`);
  const client = new ImapFlow({ host: HOST, port: PORT, secure: true, auth: { user: USER, pass: PASS }, logger: false });
  try {
    await client.connect();
  } catch (e) {
    console.error(`[imap] 接続失敗: ${(e as Error).message}`);
    process.exit(1);
  }

  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const inbox = await fetchBox(client, "INBOX", since);
  const sent = await fetchBox(client, SENT_BOX, since);
  await client.logout();

  // 受信＋送信をスレッド化（正規化件名）
  const all = [...inbox, ...sent];
  const threads = new Map<string, Msg[]>();
  for (const m of all) {
    const key = normalizeSubject(m.subject) || m.messageId;
    (threads.get(key) ?? threads.set(key, []).get(key)!).push(m);
  }

  const existing = WRITE ? await listItems() : [];
  let needReply = 0,
    handled = 0,
    written = 0,
    updated = 0,
    learned = 0,
    closed = 0;
  const list: { subject: string; last: string; count: number; date: string }[] = [];

  for (const [key, arr] of threads) {
    arr.sort((a, b) => (a.date < b.date ? -1 : 1));
    const last = arr[arr.length - 1];
    const lastFromMe = last.from.toLowerCase() === ME;

    if (lastFromMe) {
      handled++;
      if (WRITE) {
        // 直前の相手メッセージ
        const incoming = [...arr].reverse().find((m) => m.from.toLowerCase() !== ME);
        const rec = await appendReplyExample({
          messageId: last.messageId,
          when: last.date.slice(0, 16).replace("T", " "),
          subject: normalizeSubject(last.subject) ? last.subject : "(件名なし)",
          audience: "external",
          incoming: incoming ? cleanBody(incoming.text) : "",
          reply: cleanBody(last.text),
        });
        if (rec.recorded) learned++;
        // 該当pending項目を自動クローズ
        for (const it of existing) {
          if (it.status === "pending" && it.thread_key === key) {
            await updateStatus(it.id, "done");
            closed++;
          }
        }
      }
      continue;
    }

    needReply++;
    list.push({ subject: last.subject, last: `${last.fromName} <${last.from}>`, count: arr.length, date: last.date.slice(0, 10) });
    if (WRITE) {
      const thread = arr
        .map((m) => `【${m.date.slice(0, 16).replace("T", " ")} ${m.fromName}】\n${cleanBody(m.text) || "（本文なし）"}`)
        .join("\n\n---\n\n");
      const threadSection = `件名: ${last.subject}\n\n${thread}`;
      // アクティブ(pending/revision)カードは新着があれば最新に更新
      const active = existing.find(
        (it) =>
          it.thread_key === key &&
          (it.status === "pending" || it.status === "revision")
      );
      if (active) {
        if (active.thread_last_id !== last.messageId) {
          await updateThread(active.id, threadSection, last.messageId);
          updated++;
        }
        continue;
      }
      // 最終状態(done/rejected/approved)のカードのみ存在する場合、
      // 新着が無ければ再作成しない。新着があれば「再オープン」として新規pendingを作る。
      const closed = existing.find((it) => it.thread_key === key);
      if (closed && (!closed.thread_last_id || closed.thread_last_id === last.messageId))
        continue;
      const id = `mail-${last.date.slice(0, 10)}-${sanitizeId(last.messageId || last.subject)}`;
      const body = `## 元メッセージ\n${threadSection}\n\n## ドラフト\n（AIが草案を作成予定）\n`;
      const fm: ItemFrontmatter = {
        id,
        source: "gmail",
        project: "未分類",
        audience: "external",
        type: "reply",
        status: "pending",
        title: last.subject.slice(0, 80),
        createdAt: last.date,
        importance: "normal",
        thread_key: key,
        thread_last_id: last.messageId,
      };
      const r = await createItem(fm, body);
      if (r.ok) written++;
    }
  }

  console.log(`\n[imap] 受信 ${inbox.length} / 送信 ${sent.length} 通 → スレッド ${threads.size} 件`);
  console.log(`  → 要返信 ${needReply} 件 / 対応済み ${handled} 件`);
  console.log("--- 要返信スレッド（先頭20件）---");
  list
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 20)
    .forEach((t, i) => console.log(`${String(i + 1).padStart(2)}. ${t.date} [${t.count}通] ${t.subject}  ← ${t.last}`));
  if (WRITE)
    console.log(
      `\n[imap] 新規 ${written} / スレッド更新 ${updated} / 正例学習 ${learned} / 自動クローズ ${closed} 件`
    );
  else console.log(`\n（ドライラン。項目化＋正例学習するには: npm run ingest:mail -- --write）`);
}

main().catch((e) => {
  console.error("[imap] エラー:", (e as Error).message);
  process.exit(1);
});
