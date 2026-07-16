import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { VAULT_PATH, REQUIRED_DIRS, checkWritableDirsSafe } from "./vault.ts";

// ============================================================
// 初回セットアップ（コンソール確認に一本化）。
// - 不足フォルダを確認してから作成。
// - vault.sample のテンプレートを、実Vaultに「存在しないものだけ」コピー。
// - 既存の同名ファイルは絶対に上書きしない。
// ============================================================

const SAMPLE = path.resolve(process.cwd(), "vault.sample");

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log(`\nVaultの場所: ${VAULT_PATH}`);
  console.log(`テンプレート: ${SAMPLE}\n`);

  const missing = REQUIRED_DIRS.filter(
    (d) => !fs.existsSync(path.join(VAULT_PATH, d))
  );
  const sampleExists = fs.existsSync(SAMPLE);

  if (missing.length === 0 && !sampleExists) {
    console.log("必要なフォルダは揃っています。セットアップ不要です。");
    rl.close();
    return;
  }

  if (missing.length > 0) {
    console.log("不足しているフォルダ:");
    missing.forEach((d) => console.log(`  - ${d}`));
  }
  if (sampleExists) {
    console.log(
      "\nテンプレート(vault.sample)を、Vaultに存在しないファイルだけコピーします（既存は上書きしません）。"
    );
  }

  // 作成・コピー前にリンク検査（items→00_persona 等を検出したら何も作らず中止）。
  const safe = checkWritableDirsSafe();
  if (!safe.ok) {
    console.error(
      `\n中止: 書き込み先 ${safe.rel} が期待しない場所を指しています` +
        `（realpath=${safe.real}, 期待=${safe.expected}）。\n` +
        `シンボリックリンク等を解消してから再実行してください。何も変更していません。`
    );
    rl.close();
    return;
  }

  const ans = (await rl.question("\n作成・コピーを実行してよいですか？ (y/N): "))
    .trim()
    .toLowerCase();
  if (ans !== "y" && ans !== "yes") {
    console.log("中止しました。何も変更していません。");
    rl.close();
    return;
  }

  for (const d of missing) {
    await fsp.mkdir(path.join(VAULT_PATH, d), { recursive: true });
    console.log(`作成: ${d}`);
  }
  if (sampleExists) {
    const copied = await copyMissing(SAMPLE, VAULT_PATH);
    console.log(`\nテンプレートをコピー: ${copied}件（既存はスキップ）`);
  }
  console.log("\nセットアップ完了。`npm run dev` で起動できます。");
  rl.close();
}

/** src配下を dest配下へ、存在しないファイルだけコピー（上書きしない）。件数を返す。 */
async function copyMissing(src: string, dest: string): Promise<number> {
  let count = 0;
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      await fsp.mkdir(d, { recursive: true });
      count += await copyMissing(s, d);
    } else if (e.isFile()) {
      if (fs.existsSync(d)) continue; // 既存は絶対に上書きしない
      await fsp.mkdir(path.dirname(d), { recursive: true });
      await fsp.copyFile(s, d);
      count++;
    }
  }
  return count;
}

main().catch((e) => {
  console.error("セットアップ中にエラー:", (e as Error).message);
  process.exitCode = 1;
});
