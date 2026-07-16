import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { VAULT_PATH, ensureWritableForCli } from "./vault.ts";

// ============================================================
// 案件コンテキスト用の素材集め：社内メンバー全員の「受信・送信すべて」を
// クライアント（外部ドメイン）別にまとめ、_cache/clients/{domain}.md に出力する。
// ※人格(from:本人)とは別。ここは"その客とのやり取り全体"が材料。
// この出力を別セッションのAIが読んで 20_projects/{client}/context.md に蒸留する。
// 実行: npm run harvest:clients
// ============================================================

const HOST = process.env.IMAP_HOST || "pop3.heteml.jp";
const PORT = Number(process.env.IMAP_PORT || 993);
const DAYS = Number(process.env.IMAP_CLIENT_DAYS || 365);
const PER_CLIENT_MAX = Number(process.env.CLIENT_MSG_MAX || 60); // 1客あたり保存する最新件数
const INTERNAL = /(gb-jp\.com|1smallstep\.jp)$/i; // 社内・協力会社（クライアント扱いしない）
const SKIP_BOXES = /(Trash|Junk|Spam|Blocked|Drafts|ゴミ箱|迷惑)/i;

const ACCOUNTS = [
  { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
  { user: process.env.CREATIVE_IMAP_USER, pass: process.env.CREATIVE_IMAP_PASSWORD },
].filter((a): a is { user: string; pass: string } => !!a.user && !!a.pass);

const SIG_CUT =
  /^(【人材の定着|={4,}|-{4,}|▲▽|[┏┗]|＊{4,}|プライバシーマーク|--\s*$)/;
function cleanBody(text: string): string {
  const lines = text.split(/\r?\n/);
  let cut = lines.findIndex((l) => SIG_CUT.test(l.trim()));
  if (cut === -1) cut = lines.length;
  const kept = lines.slice(0, cut).map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return kept.length > 1600 ? kept.slice(0, 1600) + "\n…（略）" : kept;
}
function junk(from: string, headers: Map<string, string>): boolean {
  if (/(no[-_.]?reply|mailer-daemon|postmaster|bounce|newsletter|mailmag|magazine|webinar)/.test(from.toLowerCase()))
    return true;
  if (headers.has("list-unsubscribe")) return true;
  return false;
}
function slug(d: string): string {
  return d.replace(/[^a-z0-9.-]/gi, "").replace(/\./g, "-").slice(0, 50);
}
function addrs(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return (arr as { value?: { address?: string }[] }[])
    .flatMap((o) => (o.value ?? []).map((x) => x.address || ""))
    .filter(Boolean);
}

interface CMsg {
  date: string;
  dir: "受信" | "送信";
  who: string;
  subject: string;
  body: string;
  mid: string;
}

async function main() {
  const ready = ensureWritableForCli();
  if (!ready.ok) {
    console.error(`[clients] ${ready.msg}。中止します。`);
    process.exit(1);
  }
  if (ACCOUNTS.length === 0) {
    console.error("[clients] アカウントが .env にありません。");
    process.exit(1);
  }
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const byClient = new Map<string, CMsg[]>();
  const seen = new Set<string>();

  for (const acc of ACCOUNTS) {
    const client = new ImapFlow({ host: HOST, port: PORT, secure: true, auth: acc, logger: false });
    try {
      await client.connect();
    } catch (e) {
      console.error(`  [${acc.user}] 接続失敗: ${(e as Error).message}`);
      continue;
    }
    const boxes = (await client.list()).map((b) => b.path).filter((p) => !SKIP_BOXES.test(p));
    let scanned = 0;
    for (const box of boxes) {
      let lock;
      try {
        lock = await client.getMailboxLock(box);
      } catch {
        continue;
      }
      try {
        for await (const m of client.fetch({ since }, { source: true, internalDate: true })) {
          scanned++;
          const p: ParsedMail = await simpleParser(m.source as Buffer);
          const from = (p.from?.value?.[0]?.address || "").toLowerCase();
          const headers = new Map<string, string>();
          for (const k of ["list-unsubscribe", "precedence"]) {
            const v = p.headers.get(k);
            if (v) headers.set(k, String(v));
          }
          if (!from || junk(from, headers)) continue;
          const to = [...addrs(p.to), ...addrs(p.cc)].map((a) => a.toLowerCase());
          const fromInternal = INTERNAL.test(from);
          // クライアント＝外部側のドメイン集合
          const clientDomains = new Set<string>();
          if (fromInternal) to.filter((a) => !INTERNAL.test(a)).forEach((a) => clientDomains.add(a.split("@")[1] || ""));
          else clientDomains.add(from.split("@")[1] || "");
          const rawDate = p.date || m.internalDate || new Date();
          const iso = (rawDate instanceof Date ? rawDate : new Date(rawDate)).toISOString();
          const body = cleanBody(p.text || "");
          if (!body) continue;
          for (const dom of clientDomains) {
            if (!dom) continue;
            const key = `${dom}::${p.messageId || iso + from}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const list = byClient.get(dom) ?? byClient.set(dom, []).get(dom)!;
            list.push({
              date: iso.slice(0, 16).replace("T", " "),
              dir: fromInternal ? "送信" : "受信",
              who: `${p.from?.value?.[0]?.name || from}`,
              subject: p.subject || "(件名なし)",
              body,
              mid: p.messageId || "",
            });
          }
        }
      } finally {
        lock.release();
      }
    }
    await client.logout();
    console.log(`  [${acc.user}] 走査 ${scanned} 通`);
  }

  // 出力
  const outDir = path.join(VAULT_PATH, "_cache", "clients");
  fs.mkdirSync(outDir, { recursive: true });
  let files = 0,
    total = 0;
  const summary: { dom: string; n: number }[] = [];
  for (const [dom, msgs] of byClient) {
    if (msgs.length < 3) continue; // ノイズ除去
    msgs.sort((a, b) => (a.date < b.date ? -1 : 1));
    const capped = msgs.slice(-PER_CLIENT_MAX);
    const dropped = msgs.length - capped.length;
    let out = `---\nclient_domain: ${dom}\nmessages_total: ${msgs.length}\nmessages_saved: ${capped.length}\nsynced: ${new Date().toISOString().slice(0, 10)}\n---\n`;
    out += `# ${dom} との全やり取り（社内全員の受発信・素材）\n`;
    if (dropped > 0) out += `> ※古い${dropped}件は省略（最新${PER_CLIENT_MAX}件を保存）\n`;
    out += `\n`;
    for (const m of capped) {
      out += `## ${m.date} [${m.dir}] ${m.who}\n件名: ${m.subject}\n\n${m.body}\n\n---\n\n`;
    }
    fs.writeFileSync(path.join(outDir, `${slug(dom)}.md`), out, "utf8");
    files++;
    total += capped.length;
    summary.push({ dom, n: msgs.length });
  }
  summary.sort((a, b) => b.n - a.n);
  console.log(`\n[clients] ${files}社分を _cache/clients/ に出力（計${total}メッセージ保存）`);
  console.log("--- 上位クライアント（総やり取り数）---");
  summary.slice(0, 20).forEach((s) => console.log(`  ${String(s.n).padStart(4)}  ${s.dom}`));
  console.log(
    `\n次: 別セッションのAIが各 _cache/clients/*.md を読み、20_projects/{client}/context.md に特性を蒸留する。`
  );
}

main().catch((e) => {
  console.error("[clients] エラー:", (e as Error).message);
  process.exit(1);
});
