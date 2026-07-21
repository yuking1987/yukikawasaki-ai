import { crc32 } from "node:zlib";

// ============================================================
// Spark（メールソフト）でスレッドを直接開くリンクを組み立てる。
// 書式は実物のリンクから解析して確認済み（完全一致を検証済み）:
//   readdle-spark://bl={URLエンコード(base64_64文字折返し(payload))}
//   payload = "A:{アカウント};ID:{Message-ID};{crc32}"
//   crc32   = crc32("A:{アカウント};ID:{Message-ID}")   ※末尾の数値を除いた前半のCRC32
// Message-ID はカードの thread_last_id に保存済みなので、そこから生成できる。
// ※読むだけのリンク。送信も書き込みもしない。
// ============================================================

/** base64を64文字ごとにCRLFで折り返す（Sparkの書式）。 */
function wrap64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return lines.join("\r\n");
}

/**
 * Sparkでそのメールを開くリンク。
 * @param account Sparkに登録しているアカウント（= IMAP_USER）
 * @param messageId メールのMessage-ID（<>は付いていてもよい）
 */
export function sparkUrl(account: string, messageId: string): string | undefined {
  const mid = String(messageId || "").trim().replace(/^</, "").replace(/>$/, "");
  const acct = String(account || "").trim();
  if (!mid || !acct) return undefined;
  const prefix = `A:${acct};ID:${mid}`;
  const sum = crc32(Buffer.from(prefix, "utf8")) >>> 0;
  const payload = `${prefix};${sum}`;
  const b64 = Buffer.from(payload, "utf8").toString("base64");
  return `readdle-spark://bl=${encodeURIComponent(wrap64(b64))}`;
}
