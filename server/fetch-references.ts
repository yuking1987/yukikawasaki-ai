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

async function main() {
  const cred = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!cred || !fs.existsSync(cred)) {
    console.error(
      "GOOGLE_APPLICATION_CREDENTIALS が未設定/不在です。\n" +
        "  .env に SA鍵JSONのパスを設定してください（例: GOOGLE_APPLICATION_CREDENTIALS=./forclaude-sa.json）。\n" +
        "  鍵ファイルは Git追跡外に置いてください（*.credentials.json / service-account*.json は gitignore済み）。"
    );
    process.exit(1);
  }
  const auth = new google.auth.GoogleAuth({
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
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
        const list = await drive.files.list({
          q: `'${source_id}' in parents and trashed=false`,
          fields: "files(id,name,mimeType,modifiedTime)",
          pageSize: 200,
          orderBy: "modifiedTime desc",
        });
        const files = list.data.files ?? [];
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
