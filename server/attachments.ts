import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { VAULT_PATH } from "./vault.ts";
import { dumpWorkbook } from "./xlsx.ts";

// ============================================================
// 添付ファイルの保存と表記。
// 素材（画像/PDF/Excel等）が届いているかは打ち返し判定の段階1の根拠になる。
// ファイル名・種類・サイズに加え、実ファイルをローカル保存してパスを本文に書く
// （AIがそのパスを開いて画像そのものを見られるようにするため）。
// 保存先 vault/ は .gitignore 済み＝Git追跡されない。
// ============================================================

/** 大きすぎる添付は保存しない（判定にはメタ情報で足りるため）。 */
const MAX_BYTES = Number(process.env.ATTACH_MAX_MB || 20) * 1024 * 1024;

export interface AttachMeta {
  name: string;
  type: string;
  size: number;
  /** リポジトリルートからの相対パス。保存できなかった場合は undefined。 */
  rel?: string;
  /** 中身をほどいた補足（今はExcelのみ）。本文にそのまま差し込む。 */
  detail?: string;
}

/** items配下ではなく専用フォルダに置く（items/*.md の一覧走査に混ざらない）。 */
export function attachDirFor(itemId: string): string {
  return path.join(VAULT_PATH, "_attachments", itemId);
}

/** ファイル名を安全化（パス区切り・先頭ドットを排除。日本語は保持）。 */
export function safeFileName(name: string): string {
  const base = String(name || "file").replace(/[\\/]/g, "_").replace(/^\.+/, "_");
  return base.slice(0, 120) || "file";
}

/** 保存済みファイルのリポジトリ相対パス（vault/_attachments/{id}/{name}）。 */
function relPathFor(itemId: string, fileName: string): string {
  return path.relative(process.cwd(), path.join(attachDirFor(itemId), fileName));
}

/** Bufferを保存（メール添付用）。既に同名・同サイズがあれば再保存しない。 */
export async function saveBuffer(
  itemId: string,
  name: string,
  buf: Buffer
): Promise<string | undefined> {
  if (!buf || buf.length === 0 || buf.length > MAX_BYTES) return undefined;
  const fileName = safeFileName(name);
  const dir = attachDirFor(itemId);
  await fsp.mkdir(dir, { recursive: true });
  const abs = path.join(dir, fileName);
  try {
    const st = await fsp.stat(abs);
    if (st.size === buf.length) return relPathFor(itemId, fileName); // 既存と同じ
  } catch {
    /* 未保存なら書く */
  }
  await fsp.writeFile(abs, buf);
  return relPathFor(itemId, fileName);
}

/** URLからダウンロードして保存（Asana添付用。download_urlは署名付き一時URL）。 */
export async function saveFromUrl(
  itemId: string,
  name: string,
  url: string,
  headers?: Record<string, string>
): Promise<string | undefined> {
  if (!url) return undefined;
  const fileName = safeFileName(name);
  const abs = path.join(attachDirFor(itemId), fileName);
  if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return relPathFor(itemId, fileName);
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return undefined;
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > MAX_BYTES) return undefined;
    // 権限不足だと本体でなくログインHTMLが返ることがある（Slackのurl_private等）。
    // HTMLでない添付を要求しているのにtext/htmlが返ったら、ゴミ保存を避けて諦める。
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (ctype.includes("text/html") && !/\.html?$/i.test(fileName)) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return undefined;
    await fsp.mkdir(attachDirFor(itemId), { recursive: true });
    await fsp.writeFile(abs, buf);
    return relPathFor(itemId, fileName);
  } catch {
    return undefined; // 落とせなくてもメタ情報は本文に残す
  }
}

/**
 * Excel添付なら中身をほどいて、本文に差し込む文を返す。
 * 修正指示は貼り込み画像に描かれていることが多いので、画像も取り出してパスを併記し、
 * AIがそれを開いて実物を見た上で工数を見立てられるようにする。Excel以外・失敗時は undefined。
 */
export async function detailOf(itemId: string, name: string): Promise<string | undefined> {
  if (!/\.(xlsx|xlsm)$/i.test(name)) return undefined; // 旧形式(.xls)は読めないので対象外
  const abs = path.join(attachDirFor(itemId), safeFileName(name));
  if (!fs.existsSync(abs)) return undefined;
  const outDir = path.join(attachDirFor(itemId), `${safeFileName(name)}_中身`);
  const dump = await dumpWorkbook(abs, outDir);
  if (!dump || !dump.sheets.length) return undefined;

  const parts: string[] = [
    `  【Excelの中身】${dump.sheets.length}シート・画像${dump.imageCount}枚${dump.truncated ? "（長いため一部省略）" : ""}`,
  ];
  for (const s of dump.sheets) {
    parts.push(`  ■ シート「${s.name}」`);
    if (s.text) parts.push(s.text.split("\n").map((l) => `    ${l}`).join("\n"));
    for (const img of s.images)
      parts.push(`    - 貼り込み画像（${img.row}行目付近） → ${path.relative(process.cwd(), img.abs)}`);
  }
  return parts.join("\n");
}

/** サイズを読みやすく。 */
export function humanSize(n: number): string {
  if (!n || n < 0) return "?";
  return n >= 1024 * 1024
    ? `${(n / 1048576).toFixed(1)}MB`
    : `${Math.max(1, Math.round(n / 1024))}KB`;
}

/**
 * 本文に入れる添付ブロック。ローカル保存できたものはパスを併記し、
 * AIがそのパスを開いて実物（画像など）を確認できるようにする。
 */
export function attachBlock(list: AttachMeta[]): string {
  if (!list.length) return "";
  const lines = list.map((a) => {
    const meta = `${a.name}（${a.type}・${humanSize(a.size)}）`;
    const head = a.rel ? `- ${meta} → ${a.rel}` : `- ${meta}`;
    return a.detail ? `${head}\n${a.detail}` : head;
  });
  return `\n\n【添付 ${list.length}件】\n${lines.join("\n")}`;
}
