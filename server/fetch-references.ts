import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { google } from "googleapis";
import { VAULT_PATH } from "./vault.ts"; // .env読込も兼ねる

// ============================================================
// 参照資料（Google Sheets / Drive）をサービスアカウントで取得し _cache へキャッシュ。
// 実行: npm run fetch:refs
// 前提: .env の GOOGLE_APPLICATION_CREDENTIALS にSA鍵JSONのパス。forclaude@ 等に閲覧権限。
// 外部が正・キャッシュは再生成可能（_cache は gitignore）。
// ============================================================

const REFDIR = path.join(VAULT_PATH, "70_references");
const CACHE = path.join(VAULT_PATH, "_cache");

// ============================================================
// Notion 取得（機械用トークンで直接API。新規依存は入れずNode標準fetchを使用）
// 前提: .env の NOTION_TOKEN に内部インテグレーションのシークレット。
//       対象ページ/DBに、そのインテグレーションを「接続」で許可しておくこと。
// ============================================================
const NOTION_VER = "2022-06-28";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function notionAPI(pathname: string, token: string, init?: RequestInit): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.notion.com/v1${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VER,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("Retry-After") || "1") * 1000;
      await sleep(wait);
      continue;
    }
    const json: any = await res.json();
    if (!res.ok) throw new Error(`Notion ${res.status}: ${json?.message || pathname}`);
    return json;
  }
  throw new Error(`Notion: レート制限で諦めました (${pathname})`);
}

const rich = (arr: any[]): string => (arr || []).map((t) => t?.plain_text || "").join("");

// 1ブロックをMarkdown風テキストへ。子がある場合は再帰。
async function renderBlocks(blockId: string, token: string, depth: number): Promise<string> {
  if (depth > 6) return "";
  let out = "";
  let cursor: string | undefined;
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : `?page_size=100`;
    const data = await notionAPI(`/blocks/${blockId}/children${q}`, token);
    for (const b of data.results as any[]) {
      const t = b.type;
      const d = b[t] || {};
      switch (t) {
        case "heading_1": out += `\n# ${rich(d.rich_text)}\n`; break;
        case "heading_2": out += `\n## ${rich(d.rich_text)}\n`; break;
        case "heading_3": out += `\n### ${rich(d.rich_text)}\n`; break;
        case "paragraph": { const s = rich(d.rich_text); if (s) out += `${s}\n`; break; }
        case "bulleted_list_item": out += `- ${rich(d.rich_text)}\n`; break;
        case "numbered_list_item": out += `1. ${rich(d.rich_text)}\n`; break;
        case "to_do": out += `- [${d.checked ? "x" : " "}] ${rich(d.rich_text)}\n`; break;
        case "toggle": out += `- ${rich(d.rich_text)}\n`; break;
        case "quote": out += `> ${rich(d.rich_text)}\n`; break;
        case "callout": out += `> ${rich(d.rich_text)}\n`; break;
        case "code": out += `\n\`\`\`\n${rich(d.rich_text)}\n\`\`\`\n`; break;
        case "divider": out += `\n---\n`; break;
        case "child_page": out += `\n## ${d.title}\n`; break;
        default: break;
      }
      if (b.has_children && t !== "child_page") {
        out += await renderBlocks(b.id, token, depth + 1);
      } else if (t === "child_page") {
        out += await renderBlocks(b.id, token, depth + 1);
      }
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function fetchNotion(rawId: string, token: string, title: string): Promise<string> {
  const id = rawId.replace(/-/g, "");
  let header = `# ${title}（Notion取得 ${new Date().toISOString().slice(0, 10)}）\n`;
  // ページかDBかを判定
  try {
    await notionAPI(`/pages/${id}`, token);
    return header + (await renderBlocks(id, token, 0));
  } catch (_pageErr) {
    // DBとして問い合わせ（各行ページの本文も取得）
    let body = "";
    let cursor: string | undefined;
    do {
      const q: any = { page_size: 100 };
      if (cursor) q.start_cursor = cursor;
      const data = await notionAPI(`/databases/${id}/query`, token, {
        method: "POST",
        body: JSON.stringify(q),
      });
      for (const page of data.results as any[]) {
        const props = page.properties || {};
        const titleProp = Object.values(props).find((p: any) => p?.type === "title") as any;
        const rowTitle = titleProp ? rich(titleProp.title) : "(無題)";
        body += `\n## ${rowTitle}\n`;
        body += await renderBlocks(page.id, token, 1);
      }
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
    return header + body;
  }
}

async function main() {
  const scopes = [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
  ];
  // 認証の指定は3通り（いずれか）:
  //  1) GOOGLE_SA_JSON_B64  … 鍵JSONをbase64にして.envへ（改行入り鍵も安全・推奨の直書き）
  //  2) GOOGLE_SA_JSON      … 鍵JSONを1行(minify)で.envへ直書き
  //  3) GOOGLE_APPLICATION_CREDENTIALS … 鍵ファイルのパス
  // googleapisの型は generic 差異でsheets/driveに直接渡すと衝突するため any で受ける
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let auth: any;
  const b64 = process.env.GOOGLE_SA_JSON_B64;
  const raw = process.env.GOOGLE_SA_JSON || process.env.GOOGLE_SERVICE_ACCOUNT;
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    if (b64) {
      const creds = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      auth = new google.auth.GoogleAuth({ credentials: creds, scopes });
    } else if (raw) {
      auth = new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes });
    } else if (keyPath && fs.existsSync(keyPath)) {
      auth = new google.auth.GoogleAuth({ scopes });
    } else {
      console.error(
        "Google認証が未設定です。.env に次のいずれかを設定してください：\n" +
          "  GOOGLE_SA_JSON_B64=<鍵JSONのbase64>   （推奨・直書き。`base64 -i service-account.json` の出力を貼る）\n" +
          "  GOOGLE_SA_JSON={...}                   （鍵JSONを1行minifyで直書き）\n" +
          "  GOOGLE_APPLICATION_CREDENTIALS=./service-account.json （鍵ファイルのパス）"
      );
      process.exit(1);
    }
  } catch (e) {
    console.error(`Google認証情報の解析に失敗: ${(e as Error).message}`);
    process.exit(1);
  }
  const sheets = google.sheets({ version: "v4", auth });
  const drive = google.drive({ version: "v3", auth });

  const pointers = fs
    .readdirSync(REFDIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ file: path.join(REFDIR, f), ...matter.read(path.join(REFDIR, f)) }));

  for (const p of pointers) {
    const { slug, kind, source_id, title } = p.data as Record<string, string>;
    if (!source_id || source_id.startsWith("<")) {
      console.log(`- ${slug}: source_id 未設定のためスキップ`);
      continue;
    }
    const outDir = path.join(CACHE, slug);
    fs.mkdirSync(outDir, { recursive: true });
    try {
      if (kind === "gsheet") {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: source_id });
        const tabs = meta.data.sheets?.map((s) => s.properties?.title || "") ?? [];
        let out = `# ${title}（Sheets取得 ${new Date().toISOString().slice(0, 10)}）\n\n`;
        for (const tab of tabs) {
          const vals = await sheets.spreadsheets.values.get({
            spreadsheetId: source_id,
            range: tab,
          });
          const rows = vals.data.values ?? [];
          out += `## ${tab}\n\n`;
          out += rows.map((r) => r.join(" | ")).join("\n") + "\n\n";
        }
        fs.writeFileSync(path.join(outDir, "index.md"), out, "utf8");
        console.log(`✅ ${slug}: シート${tabs.length}枚を取得`);
      } else if (kind === "gdrive") {
        // アクセス確認（フォルダ名が取れれば権限OK）
        try {
          const fmeta = await drive.files.get({
            fileId: source_id,
            fields: "id,name",
            supportsAllDrives: true,
          });
          console.log(`  フォルダ「${fmeta.data.name}」にアクセスOK`);
        } catch (e) {
          console.error(
            `✗ ${slug}: フォルダにアクセスできません（SAに閲覧共有されているか確認）: ${(e as Error).message}`
          );
          continue;
        }
        // 共有ドライブ対応＋サブフォルダ再帰で全ファイル収集
        const walk = async (fid: string, depth: number): Promise<
          { id?: string | null; name?: string | null; mimeType?: string | null; modifiedTime?: string | null }[]
        > => {
          const res = await drive.files.list({
            q: `'${fid}' in parents and trashed=false`,
            fields: "files(id,name,mimeType,modifiedTime)",
            pageSize: 1000,
            orderBy: "modifiedTime desc",
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
          });
          const items = res.data.files ?? [];
          const out: typeof items = [];
          for (const it of items) {
            if (it.mimeType === "application/vnd.google-apps.folder" && depth < 3)
              out.push(...(await walk(it.id!, depth + 1)));
            else out.push(it);
          }
          return out;
        };
        const files = await walk(source_id, 0);
        let idx = `# ${title}（Drive取得 ${new Date().toISOString().slice(0, 10)}・${files.length}件）\n\n`;
        for (const f of files) {
          idx += `- ${f.name}（${f.mimeType?.split(".").pop()}・${f.modifiedTime?.slice(0, 10)}）\n`;
          // Googleドキュメント(議事録)はテキスト書き出し
          if (f.mimeType === "application/vnd.google-apps.document") {
            try {
              const doc = await drive.files.export(
                { fileId: f.id!, mimeType: "text/plain" },
                { responseType: "text" }
              );
              const safe = (f.name || f.id!).replace(/[^\w぀-ヿ一-龯ー-]/g, "_").slice(0, 60);
              fs.writeFileSync(path.join(outDir, `${safe}.txt`), String(doc.data), "utf8");
            } catch {
              /* 個別失敗は無視 */
            }
          }
        }
        fs.writeFileSync(path.join(outDir, "index.md"), idx, "utf8");
        console.log(`✅ ${slug}: Drive ${files.length}件を取得（Docは文字起こしも保存）`);
      } else if (kind === "notion") {
        const token = process.env.NOTION_TOKEN;
        if (!token) {
          console.log(`- ${slug}: NOTION_TOKEN 未設定のためスキップ（.env に設定してください）`);
          continue;
        }
        const text = await fetchNotion(source_id, token, title);
        fs.writeFileSync(path.join(outDir, "index.md"), text, "utf8");
        const chars = text.length;
        console.log(`✅ ${slug}: Notionを取得（約${chars}文字を保存）`);
      } else {
        console.log(`- ${slug}: 未対応kind(${kind})`);
        continue;
      }
      // last_synced 更新
      const fresh = matter.read(p.file);
      fresh.data.last_synced = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(p.file, matter.stringify(fresh.content, fresh.data), "utf8");
    } catch (e) {
      console.error(`✗ ${slug}: 取得失敗 - ${(e as Error).message}`);
    }
  }
  console.log("\n完了。GUIの参照一覧が「最終取得」に変わります。");
}

main().catch((e) => {
  console.error("エラー:", (e as Error).message);
  process.exit(1);
});
