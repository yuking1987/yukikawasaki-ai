import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { ensureWritableForCli, recordSync } from "./vault.ts"; // .env読込＋安全/初期化検査
import { saveBuffer, attachBlock, detailOf, type AttachMeta } from "./attachments.ts";
import { matchClientLabel } from "./clients.ts";
import {
  createItem,
  listItems,
  readItem,
  extractDraft,
  updateStatus,
  updateThread,
  appendReplyExample,
  appendDraftVsSent,
  listIgnoreKeywords,
  backfillReplyTo,
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
/** 自社ドメイン（本人アドレスから導出）。社内発の控えメールを見分けるのに使う。 */
const MY_DOMAIN = ME.split("@")[1] || "";
const WRITE = process.argv.includes("--write");
const DAYS = Number(process.env.IMAP_SINCE_DAYS || 30);
const SENT_BOX = process.env.IMAP_SENT || "INBOX.Sent";

/** 取り込む箱。onlyTo が空でなければ、その窓口宛の依頼だけを拾う。 */
interface Account {
  user: string;
  pass: string;
  onlyTo: string[];
  /** 送信箱も読むか。＝本人(kawasaki@)の箱かどうか。正例学習・自動クローズはここだけで行う。 */
  sent: boolean;
}

// creative@ は社内共有の箱で、support@gb-jp.com 宛（GBサポートチーム＝保守依頼の窓口）も届く。
// ただし井上らのやりとりが大半で件数が多いため、丸ごと取り込むと判断すべきカードが埋もれる。
// CREATIVE_ONLY_TO に書いた宛先のメールだけを拾う（カンマ区切りで増やせる）。未設定なら読まない。
const CREATIVE_ONLY_TO = (process.env.CREATIVE_ONLY_TO || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const CREATIVE_USER = process.env.CREATIVE_IMAP_USER || "";
const CREATIVE_PASS = process.env.CREATIVE_IMAP_PASSWORD || "";

// creative@ は受信箱のみ読む。「対応済み」判定は本人(kawasaki@)の送信で行うので、
// creative@ の送信箱を足してもスレッドは閉じられず、重複するだけのため。
const ACCOUNTS: Account[] = [
  { user: USER, pass: PASS, onlyTo: [], sent: true },
  ...(CREATIVE_USER && CREATIVE_PASS && CREATIVE_ONLY_TO.length
    ? [{ user: CREATIVE_USER, pass: CREATIVE_PASS, onlyTo: CREATIVE_ONLY_TO, sent: false }]
    : []),
];
// 社長がダッシュボードから登録した「取り込み無視キーワード」。件名/送信元に含めばカード化しない。
let IGNORE_KEYWORDS: string[] = [];
function matchesIgnore(from: string, subject: string): boolean {
  if (IGNORE_KEYWORDS.length === 0) return false;
  const hay = `${from} ${subject}`.toLowerCase();
  // 空白区切りの各語が「すべて含まれる」ANDマッチ（連続一致でなく語の共起で判定）。
  // 例:「WordPress 更新」→ 件名に WordPress と 更新 の両方があれば無視。
  return IGNORE_KEYWORDS.some((k) => {
    const tokens = k.toLowerCase().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((t) => hay.includes(t));
  });
}

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

// 署名/引用ヘッダの開始行。※「株式会社グレート・ビーンズ」「福岡市中央区薬院」は
// クライアントの宛名(冒頭)にも出るため入れない（誤って全文カットするのを防ぐ）。
// GB署名は直前のCII広告「【人材の定着」/ "===="/"----"/ URL で確実に切れる。
const SIG_RE =
  /^(--\s*$|={3,}|＝{3,}|-{4,}|▲▽|[┏┃┗]|＊{2,}|■{2,}|【人材の定着|・(離職率|活躍する人材)|「?マンガでわかるCIY|https?:\/\/ciy-biz|プライバシーマーク|Tel[ 　]|TEL[：:]|Fax[ 　]|Mobile)/;
const QUOTE_HDR_RE =
  /^(-{5,}$|.*\d{4}年\d{1,2}月\d{1,2}日.*(のメール|：$|:$)|On .*wrote:$|.*<[^>]+>のメール)/;
// HTMLメール（プレーンテキストが無い相互リンク系等）から本文を復元。
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
// 本文取得：プレーンテキスト優先、無ければHTMLから復元。
function bodyText(p: ParsedMail): string {
  if (p.text && p.text.trim()) return p.text.trim();
  if (p.html) return htmlToText(p.html);
  if (typeof p.textAsHtml === "string") return htmlToText(p.textAsHtml);
  return "";
}

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

// 転送の区切り行。「---------- 転送されたメール ----------」「----- Original Message -----」等。
// この下は“引用”ではなく依頼の本体なので、捨てずに本文として残す必要がある。
const FWD_HDR_RE =
  /^\s*-{2,}\s*(転送されたメール|元のメッセージ|Forwarded [Mm]essage|Original Message)\s*-{2,}\s*$/i;

/**
 * 転送メールで送られてきた「元メールの中身」。
 * 転送では依頼の本体が丸ごと引用（>）の中に入るため、cleanBody だけだと
 * 「下記、転送します！」しか残らず、どの案件の何の依頼か分からなくなる。
 * ここでは引用記号を外して本体を復元する。
 */
function forwardedBody(text: string): string {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => FWD_HDR_RE.test(l));
  if (at < 0) return "";
  const body = lines
    .slice(at + 1)
    .map((l) => l.replace(/^\s*>+ ?/, "").replace(/\s+$/, ""));
  const out = body.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out.length > 4000 ? `${out.slice(0, 4000)}\n…（以下略）` : out;
}

// 相手が引用文の中に ⇒/→ で書き込んだ「インライン回答（赤字返信）」を、引用ヘッダ以降も含め全文から拾う。
function inlineAnswers(text: string): string {
  const picked: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (/^[⇒→]/.test(t) && t.replace(/^[⇒→][　\s]*/, "").length > 1) picked.push(t);
  }
  return picked.join("\n");
}
// スレッド表示用の本文。通常はcleanBody。ただし本文が極端に短い（＝実質の回答が
// 引用内インラインにある）場合は、⇒/→ のインライン回答を補って回答内容を可視化する。
function threadBody(text: string): string {
  const fresh = cleanBody(text);
  // 転送なら、転送元の中身こそが依頼の本体。書き添えの一言と併せて必ず残す。
  const fwd = forwardedBody(text);
  if (fwd) return `${fresh}\n\n（転送された元メール）\n${fwd}`.trim();
  if (fresh.replace(/\s/g, "").length >= 140) return fresh;
  const inline = inlineAnswers(text);
  if (!inline) return fresh;
  return `${fresh}\n\n（引用内のインライン回答）\n${inline}`.trim();
}

/** 添付（実体はBuffer。保存はカードIDが決まってから行う）。 */
interface Attach {
  name: string;
  type: string;
  size: number;
  content?: Buffer;
  rel?: string;
}

interface Msg {
  from: string;
  fromName: string;
  subject: string;
  date: string;
  text: string;
  messageId: string;
  attachments: Attach[];
}

/** 返信先文字列 "名前 <addr>"（名前が無ければ addr のみ）を組み立てる。 */
function replyToOf(m: { from: string; fromName: string }): string {
  return m.fromName && m.fromName !== m.from ? `${m.fromName} <${m.from}>` : m.from;
}

// 配信/迷惑として新規カード化はしないが、既存カードの送信元(reply_to)埋め直しに使うため控える。
const junkDropped: { messageId: string; subject: string; from: string; fromName: string }[] = [];

function addressesIn(field: ParsedMail["to"]): string[] {
  const arr = Array.isArray(field) ? field : field ? [field] : [];
  return arr.flatMap((a) => a.value.map((v) => (v.address || "").toLowerCase()));
}

/**
 * support@ のような「窓口」に持ち込まれた依頼かどうか。
 * - 宛先(To)に窓口が入っていれば依頼そのもの（社内からの転送も拾う）
 * - Cc止まりなら社外から届いたものだけ拾う。自社が社外へ送ったメールは記録用に窓口を
 *   Ccしていることがあり、それは「返す相手のいない控え」なので拾わない。
 * ※配送ヘッダ(Delivered-To)は、窓口の配信メンバーである以上どちらにも同じ値が入り
 *   区別に使えないため見ない。
 */
function isForDesk(p: ParsedMail, desks: string[], from: string): boolean {
  if (addressesIn(p.to).some((a) => desks.includes(a))) return true;
  const fromOutside = !!MY_DOMAIN && !from.toLowerCase().endsWith(`@${MY_DOMAIN}`);
  return fromOutside && addressesIn(p.cc).some((a) => desks.includes(a));
}

async function fetchBox(
  client: ImapFlow,
  path: string,
  since: Date,
  onlyTo: string[]
): Promise<Msg[]> {
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
      // 窓口が指定された箱では、その窓口への依頼以外は読み捨てる
      if (onlyTo.length && !isForDesk(p, onlyTo, from)) continue;
      const headers = new Map<string, string>();
      for (const k of ["list-unsubscribe", "precedence", "auto-submitted"]) {
        const v = p.headers.get(k);
        if (v) headers.set(k, String(v));
      }
      // 受信のみジャンク判定＋無視キーワード判定（送信済みは自分の返信なので常に採用）
      if (
        from.toLowerCase() !== ME &&
        (junkReason(from, headers) || matchesIgnore(from, p.subject || ""))
      ) {
        // 迷惑フィルタ導入前に作られた“居残りカード”に送信元を埋めるため、送信元だけ控える。
        if (from)
          junkDropped.push({
            messageId: p.messageId || "",
            subject: p.subject || "",
            from,
            fromName: p.from?.value?.[0]?.name || from,
          });
        continue;
      }
      const rawDate = p.date || m.internalDate || new Date();
      // 添付：素材（画像/PDF/Excel等）が来ているかの判断材料。
      // 署名ロゴ等の埋め込み画像(related)・ファイル名なしのパートは除外。
      const attachments: Attach[] = (p.attachments || [])
        .filter((a) => a.filename && !a.related)
        .map((a) => ({
          name: String(a.filename).slice(0, 120),
          type: a.contentType || "?",
          size: a.size || 0,
          content: a.content as Buffer | undefined,
        }));
      res.push({
        from,
        fromName: p.from?.value?.[0]?.name || from,
        subject: p.subject || "(件名なし)",
        date: (rawDate instanceof Date ? rawDate : new Date(rawDate)).toISOString(),
        text: bodyText(p),
        messageId: p.messageId || "",
        attachments,
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
  console.log(`[imap] 接続: ${HOST}:${PORT}（過去${DAYS}日・${WRITE ? "書き込み" : "ドライラン"}）`);
  IGNORE_KEYWORDS = await listIgnoreKeywords();
  if (IGNORE_KEYWORDS.length)
    console.log(`[imap] 無視キーワード ${IGNORE_KEYWORDS.length} 件を適用`);
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

  const inbox: Msg[] = [];
  const sent: Msg[] = [];
  for (const acc of ACCOUNTS) {
    const scope = acc.onlyTo.length ? `宛先が ${acc.onlyTo.join("/")} のものだけ` : "すべて";
    console.log(`[imap] ${acc.user}（${scope}）`);
    const client = new ImapFlow({
      host: HOST,
      port: PORT,
      secure: true,
      auth: { user: acc.user, pass: acc.pass },
      logger: false,
    });
    try {
      await client.connect();
    } catch (e) {
      console.error(`[imap] ${acc.user} 接続失敗: ${(e as Error).message}`);
      // 本人の箱が読めないなら中断（対応済み判定が狂う）。補助の箱は落ちても続行。
      if (acc.sent) process.exit(1);
      continue;
    }
    try {
      inbox.push(...(await fetchBox(client, "INBOX", since, acc.onlyTo)));
      if (acc.sent) sent.push(...(await fetchBox(client, SENT_BOX, since, acc.onlyTo)));
    } finally {
      await client.logout();
    }
  }

  // 受信＋送信をスレッド化（正規化件名）。同一メッセージ（自分のCC受信＝受信箱と送信済みの
  // 両方に出るもの等）は messageId で重複排除し、スレッドに同じ本文が二重に並ぶのを防ぐ。
  const seenIds = new Set<string>();
  const all = [...inbox, ...sent].filter((m) => {
    if (!m.messageId) return true;
    if (seenIds.has(m.messageId)) return false;
    seenIds.add(m.messageId);
    return true;
  });
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
    diffed = 0,
    closed = 0,
    reopened = 0,
    backfilled = 0;
  const list: { subject: string; last: string; count: number; date: string }[] = [];

  // 迷惑フィルタ導入前の居残りカード救済：送信元(reply_to)が空のメールカードに、
  // 今回控えた配信メールの送信元を messageId／件名で突き合わせて埋める（新規作成はしない）。
  if (WRITE && junkDropped.length) {
    for (const it of existing) {
      if (it.source !== "gmail" || it.reply_to) continue;
      const hit =
        junkDropped.find((j) => j.messageId && j.messageId === it.thread_last_id) ||
        junkDropped.find((j) => normalizeSubject(j.subject) === it.thread_key);
      if (hit && (await backfillReplyTo(it.id, replyToOf(hit)))) backfilled++;
    }
  }

  for (const [key, arr] of threads) {
    arr.sort((a, b) => (a.date < b.date ? -1 : 1));
    const last = arr[arr.length - 1];
    const lastFromMe = last.from.toLowerCase() === ME;

    // どのルート（返信済み/更新/再オープン）でも、送信元(reply_to)が空のメールカードは
    // このスレッドの「最後に相手から来たメッセージ」の差出人で埋める（機能追加前の居残り救済）。
    // 相手のメッセージが窓口内に無い場合は、自分宛にせず空のままにする（誤登録防止）。
    if (WRITE) {
      const inMsg = [...arr].reverse().find((m) => m.from.toLowerCase() !== ME);
      if (inMsg?.from)
        for (const it of existing)
          if (it.thread_key === key && it.source === "gmail" && !it.reply_to)
            if (await backfillReplyTo(it.id, replyToOf(inMsg))) backfilled++;
    }

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
        // 【食い違い学習】このスレッドの既存カードにAIの草案が付いていたら、
        // その草案と「実際に送った返信」を突き合わせて _memory/draft-vs-sent.md に残す。
        // ＝川崎さんが草案を無視して別の解釈/言い回しで打ち返したケースを取りこぼさない。
        const card = existing.find((it) => it.thread_key === key);
        if (card) {
          const full = await readItem(card.id);
          const draft = full ? extractDraft(full.body) : "";
          // 草案が実在（未作成プレースホルダでない）ときだけ記録する
          if (draft && !draft.includes("AIが草案を作成予定")) {
            const d = await appendDraftVsSent({
              messageId: last.messageId,
              when: last.date.slice(0, 16).replace("T", " "),
              subject: normalizeSubject(last.subject) ? last.subject : "(件名なし)",
              cardId: card.id,
              project: card.project,
              audience: card.audience,
              incoming: incoming ? cleanBody(incoming.text) : "",
              draft,
              sent: cleanBody(last.text),
            });
            if (d.recorded) diffed++;
          }
        }
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
      // 添付はカードIDが決まってから保存する（vault/_attachments/{id}/ に置き、本文にパスを併記）。
      // 素材が届いているかは判定の段階1の根拠。画像はAIがパスを開いて実物を確認できる。
      const buildThread = async (itemId: string): Promise<string> => {
        const parts: string[] = [];
        for (const m of arr) {
          const metas: AttachMeta[] = [];
          for (const a of m.attachments) {
            const rel = a.content
              ? await saveBuffer(itemId, a.name, a.content)
              : undefined;
            // Excelは中身（文字＋貼り込み画像）までほどく。修正指示は画像にあることが多いため。
            const detail = rel ? await detailOf(itemId, a.name) : undefined;
            metas.push({ name: a.name, type: a.type, size: a.size, rel, detail });
          }
          parts.push(
            `【${m.date.slice(0, 16).replace("T", " ")} ${m.fromName}】\n${threadBody(m.text) || "（本文なし）"}${attachBlock(metas)}`
          );
        }
        return `件名: ${last.subject}\n\n${parts.join("\n\n---\n\n")}`;
      };
      // アクティブ(pending/revision)カードは新着があれば最新に更新
      const active = existing.find(
        (it) =>
          it.thread_key === key &&
          (it.status === "pending" || it.status === "revision")
      );
      if (active) {
        if (active.thread_last_id !== last.messageId) {
          await updateThread(active.id, await buildThread(active.id), last.messageId);
          updated++;
        }
        continue;
      }
      // 最終状態(done/rejected/approved)のカードがある場合：
      // 相手からの新着（カード最終更新より後のメッセージ）が来たら、同じカードをその場で
      // 承認待ちに復活させ、古い草案は破棄して作り直させる。
      // ※ thread_last_id を持たない旧カードでも、メッセージ日時で新着を判定できる。
      const prior = existing.find((it) => it.thread_key === key);
      if (prior) {
        const already = !!prior.thread_last_id && prior.thread_last_id === last.messageId;
        const lastTime = Date.parse(last.date);
        const cardTime = Date.parse(prior.updatedAt || prior.createdAt || "1970-01-01");
        if (!already && lastTime > cardTime) {
          await updateThread(prior.id, await buildThread(prior.id), last.messageId, true); // 草案リセット
          await updateStatus(prior.id, "pending");
          reopened++;
        }
        continue; // 既存カードがあるので新規は作らない（重複防止）
      }
      const id = `mail-${last.date.slice(0, 10)}-${sanitizeId(last.messageId || last.subject)}`;
      const threadText = await buildThread(id);
      const body = `## 元メッセージ\n${threadText}\n\n## ドラフト\n（AIが草案を作成予定）\n`;
      // 送信元ドメイン→本文中のドメインの順でクライアントを照合。当たれば案件名に採用。
      const clientLabel = matchClientLabel({ email: last.from, text: threadText });
      const fm: ItemFrontmatter = {
        id,
        source: "gmail",
        project: "未分類",
        project_label: clientLabel || undefined,
        audience: "external",
        type: "reply",
        status: "pending",
        title: last.subject.slice(0, 80),
        createdAt: last.date,
        importance: "normal",
        thread_key: key,
        thread_last_id: last.messageId,
        // スレッドに繋がる下書きを作るのに使う（宛先＝最後に送ってきた相手／件名＝Re:を付ける前）
        reply_to: replyToOf(last),
        reply_subject: last.subject,
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
  if (WRITE) {
    console.log(
      `\n[imap] 新規 ${written} / スレッド更新 ${updated} / 再オープン ${reopened} / 送信元埋め直し ${backfilled} / 正例学習 ${learned} / 食い違い記録 ${diffed} / 自動クローズ ${closed} 件`
    );
    recordSync("mail"); // 最終取り込み時刻を記録（画面表示用）
  } else console.log(`\n（ドライラン。項目化＋正例学習するには: npm run ingest:mail -- --write）`);
}

main().catch((e) => {
  console.error("[imap] エラー:", (e as Error).message);
  process.exit(1);
});
