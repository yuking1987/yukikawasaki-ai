import ExcelJS from "exceljs";
import fsp from "node:fs/promises";
import path from "node:path";

// ============================================================
// Excel添付を「読める形」にほどく。
// クライアントの修正指示（赤シート等）は、セルの文字ではなく貼り込まれた画像に
// 描かれていることが多い。そのため文字を起こすだけでなく画像もファイルに出し、
// AIがそのパスを開いて実物を見て判断できるようにする。
// ============================================================

/** 1シートあたり／全体の文字数上限。長い表でカード本文が埋まるのを防ぐ。 */
const MAX_CHARS_PER_SHEET = 1200;
const MAX_CHARS_TOTAL = 8000;

export interface SheetDump {
  name: string;
  text: string;
  /** 貼り込み画像。保存した絶対パスと、目安になる位置（行番号）。 */
  images: { abs: string; row: number }[];
}
export interface WorkbookDump {
  sheets: SheetDump[];
  imageCount: number;
  /** 文字数上限で打ち切ったか。 */
  truncated: boolean;
}

/** セルの値を文字にする。数式は計算結果、装飾付き文字は連結して拾う。 */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText))
      return (o.richText as { text?: string }[]).map((r) => r.text || "").join("");
    if (o.result !== undefined && o.result !== null) return String(o.result);
    if (typeof o.text === "string") return o.text;
    if (o.hyperlink) return String(o.hyperlink);
    return "";
  }
  return String(v);
}

function safeSheetName(name: string): string {
  return (name || "sheet").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "sheet";
}

/**
 * Excelを読み、シートごとの文字と貼り込み画像を outDir に取り出す。
 * 読めない/壊れている場合は null（添付のメタ情報だけは呼び出し側で活かす）。
 */
export async function dumpWorkbook(
  absPath: string,
  outDir: string
): Promise<WorkbookDump | null> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(absPath);
  } catch {
    return null;
  }

  const sheets: SheetDump[] = [];
  let total = 0;
  let truncated = false;
  let imageCount = 0;

  for (const ws of wb.worksheets) {
    // --- セルの文字 ---
    const lines: string[] = [];
    let chars = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (chars >= MAX_CHARS_PER_SHEET) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const t = cellText(cell.value).replace(/\s+/g, " ").trim();
        if (t) cells.push(t);
      });
      if (!cells.length) return;
      const line = cells.join(" | ");
      lines.push(line);
      chars += line.length;
    });
    if (chars >= MAX_CHARS_PER_SHEET) {
      lines.push("…（このシートは以下略）");
      truncated = true;
    }

    // --- 貼り込み画像 ---
    const images: { abs: string; row: number }[] = [];
    let n = 0;
    for (const img of ws.getImages() || []) {
      const media = wb.getImage(Number(img.imageId)) as
        | { buffer?: Buffer; extension?: string }
        | undefined;
      if (!media?.buffer) continue;
      n += 1;
      const file = `${safeSheetName(ws.name)}-${n}.${media.extension || "png"}`;
      const abs = path.join(outDir, file);
      try {
        await fsp.mkdir(outDir, { recursive: true });
        await fsp.writeFile(abs, media.buffer);
      } catch {
        continue; // 1枚書けなくても他は活かす
      }
      images.push({ abs, row: (img.range?.tl?.nativeRow ?? 0) + 1 });
      imageCount += 1;
    }

    if (!lines.length && !images.length) continue; // 空シートは載せない
    const text = lines.join("\n");
    if (total + text.length > MAX_CHARS_TOTAL) {
      truncated = true;
      sheets.push({ name: ws.name, text: "（文字は省略／画像を参照）", images });
      continue;
    }
    total += text.length;
    sheets.push({ name: ws.name, text, images });
  }

  return { sheets, imageCount, truncated };
}
