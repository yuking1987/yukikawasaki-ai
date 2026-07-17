import "./vault.ts"; // .env を読み込む（process.env を参照する前に必要）
import { ImapFlow } from "imapflow";

// ============================================================
// 返信の「下書き」をIMAPの下書きフォルダに作る（送信はしない）。
// In-Reply-To / References を付けるので、メールソフト上で同じスレッドに並び、
// 送信後もスレッドが繋がる。最後の「送信」は人間がメール画面で行う＝取り返しがつく。
// ============================================================

/**
 * IMAP接続情報は「呼ばれた時点」の環境変数から読む。
 * ※トップレベルで読むと、.envを読み込む vault.ts より先にこのモジュールが評価された場合に
 *   空のまま固定され、「IMAP設定が不足」と誤判定される（import順に依存させない）。
 */
function imapEnv() {
  return {
    host: process.env.IMAP_HOST || "",
    port: Number(process.env.IMAP_PORT || 993),
    user: process.env.IMAP_USER || "",
    pass: process.env.IMAP_PASSWORD || "",
  };
}

/** 日本語の件名を MIME encoded-word に。 */
function encodeSubject(s: string): string {
  // ASCIIだけならそのまま
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/** 表示名付きアドレスの表示名部分もエンコード（"名前 <a@b>" 形式に対応）。 */
function encodeAddress(a: string): string {
  const m = a.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!m) return a.trim();
  const name = m[1].replace(/^"|"$/g, "");
  if (!name) return `<${m[2]}>`;
  return `${encodeSubject(name)} <${m[2]}>`;
}

/** RFC822 のメッセージを組み立てる（本文はUTF-8/base64）。 */
export function buildMessage(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  date?: Date;
}): Buffer {
  const brackets = (id?: string) =>
    !id ? "" : id.startsWith("<") ? id : `<${id}>`;
  const headers = [
    `From: ${encodeAddress(opts.from)}`,
    `To: ${encodeAddress(opts.to)}`,
    `Subject: ${encodeSubject(opts.subject)}`,
    `Date: ${(opts.date || new Date()).toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${brackets(opts.inReplyTo)}`);
    headers.push(`References: ${opts.references || brackets(opts.inReplyTo)}`);
  }
  // 本文の改行は CRLF に正規化する。LFのままだとメールソフトによっては
  // 改行として扱われず、全文が1段落に潰れて表示される。
  const normalized = opts.body.replace(/\r?\n/g, "\r\n");
  const b64 = Buffer.from(normalized, "utf8").toString("base64");
  const wrapped = b64.replace(/(.{76})/g, "$1\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${wrapped}\r\n`, "utf8");
}

/** 下書きフォルダを探す（specialUse優先。無ければ名前で推測）。 */
async function findDraftsBox(client: ImapFlow): Promise<string | null> {
  const list = await client.list();
  const special = list.find((b: any) => b.specialUse === "\\Drafts");
  if (special) return special.path;
  const byName = list.find((b: any) =>
    /(^|[./])(drafts?|下書き)$/i.test(String(b.path))
  );
  return byName ? byName.path : null;
}

/**
 * 下書きをIMAPに作成する。成功でフォルダ名を返す。
 * 送信は一切しない（SMTPを使わない）。
 */
export async function appendDraft(opts: {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}): Promise<{ ok: true; box: string } | { ok: false; msg: string }> {
  const { host, port, user, pass } = imapEnv();
  if (!host || !user || !pass)
    return { ok: false, msg: "IMAP設定が不足しています（.env の IMAP_HOST/USER/PASSWORD）。" };
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  try {
    await client.connect();
    const box = (await findDraftsBox(client)) || process.env.IMAP_DRAFTS || "INBOX.Drafts";
    const msg = buildMessage({
      from: user,
      to: opts.to,
      subject: opts.subject,
      body: opts.body,
      inReplyTo: opts.inReplyTo,
    });
    await client.append(box, msg, ["\\Draft", "\\Seen"]);
    return { ok: true, box };
  } catch (e) {
    return { ok: false, msg: (e as Error).message };
  } finally {
    try {
      await client.logout();
    } catch {
      /* 切断失敗は無視 */
    }
  }
}
