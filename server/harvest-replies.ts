import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { ensureWritableForCli } from "./vault.ts"; // .env読込＋安全/初期化検査
import { appendReplyExample } from "./items.ts";

// ============================================================
// 複数アカウント（kawasaki@ / creative@ 等）の全フォルダを走査し、
// 「from: 川崎さん本人」のメッセージを"正例"として _memory/replies.md に収穫する。
// 人格再蒸留のための教師データを最大化する用途。messageIdで重複防止。
// 実行: npm run harvest:replies
// ============================================================

const HOST = process.env.IMAP_HOST || "pop3.heteml.jp";
const PORT = Number(process.env.IMAP_PORT || 993);
const ME = (process.env.KAWASAKI_GMAIL || process.env.IMAP_USER || "").toLowerCase();
const DAYS = Number(process.env.IMAP_HARVEST_DAYS || 365);
const SKIP_BOXES = /(Trash|Junk|Spam|Blocked|Drafts|ゴミ箱|迷惑)/i;

// 収穫対象アカウント（.env）。creative@ は任意。
const ACCOUNTS = [
  { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
  { user: process.env.CREATIVE_IMAP_USER, pass: process.env.CREATIVE_IMAP_PASSWORD },
].filter((a): a is { user: string; pass: string } => !!a.user && !!a.pass);

// 収穫用の緩いクリーナー：末尾のGB署名/広告ブロック以降だけ落とし、
// 引用＋インライン回答（→で答えるスタイル）や短文は残す。長すぎる場合のみ2500字で打ち切り。
const SIG_CUT_RE =
  /^(【人材の定着|={4,}|-{4,}|▲▽|[┏┗]|＊{4,}|プライバシーマーク|--\s*$)/;
function cleanBody(text: string): string {
  const lines = text.split(/\r?\n/);
  let cut = lines.findIndex((l) => SIG_CUT_RE.test(l.trim()));
  if (cut === -1) cut = lines.length;
  const kept = lines
    .slice(0, cut)
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return kept.length > 2500 ? kept.slice(0, 2500) + "\n…（以下略）" : kept;
}

async function harvestAccount(user: string, pass: string): Promise<number> {
  const client = new ImapFlow({ host: HOST, port: PORT, secure: true, auth: { user, pass }, logger: false });
  let recorded = 0;
  try {
    await client.connect();
  } catch (e) {
    console.error(`  [${user}] 接続失敗: ${(e as Error).message}`);
    return 0;
  }
  const boxes = (await client.list()).map((b) => b.path).filter((p) => !SKIP_BOXES.test(p));
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  let scanned = 0,
    mine = 0;
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
        if (from !== ME) continue; // 本人発信のみ
        mine++;
        const rawDate = p.date || m.internalDate || new Date();
        const reply = cleanBody(p.text || "");
        if (!reply) continue;
        // 宛先（社内=gb-jp.com を除いた外部クライアントを優先）。to は単体/配列両対応。
        const toObj = p.to;
        const addrObjs = Array.isArray(toObj) ? toObj : toObj ? [toObj] : [];
        const toList = addrObjs
          .flatMap((o) => o.value.map((v) => v.address || ""))
          .filter(Boolean);
        const ext = toList.find((a) => !/gb-jp\.com$/i.test(a)) || toList[0] || "";
        const domain = ext.split("@")[1]?.toLowerCase() || "";
        const rec = await appendReplyExample({
          messageId: p.messageId || "",
          when: (rawDate instanceof Date ? rawDate : new Date(rawDate)).toISOString().slice(0, 16).replace("T", " "),
          subject: p.subject || "(件名なし)",
          audience: /gb-jp\.com$/i.test(ext) ? "internal" : "external",
          reply,
          to: toList.join(", "),
          domain,
        });
        if (rec.recorded) recorded++;
      }
    } finally {
      lock.release();
    }
  }
  await client.logout();
  console.log(`  [${user}] 走査 ${scanned} / 本人発信 ${mine} / 新規正例 ${recorded}`);
  return recorded;
}

async function main() {
  if (!ME) {
    console.error("KAWASAKI_GMAIL / IMAP_USER が未設定です。");
    process.exit(1);
  }
  if (ACCOUNTS.length === 0) {
    console.error("収穫対象アカウントが .env にありません（IMAP_USER/PASSWORD 等）。");
    process.exit(1);
  }
  const ready = ensureWritableForCli();
  if (!ready.ok) {
    console.error(`[harvest] ${ready.msg}。中止します。`);
    process.exit(1);
  }
  console.log(`[harvest] from:${ME} を過去${DAYS}日・${ACCOUNTS.length}アカウントから収穫します`);
  let total = 0;
  for (const a of ACCOUNTS) total += await harvestAccount(a.user, a.pass);
  console.log(`\n[harvest] 新規に正例 ${total} 件を _memory/replies.md へ追加しました。`);
}

main().catch((e) => {
  console.error("[harvest] エラー:", (e as Error).message);
  process.exit(1);
});
