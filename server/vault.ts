import fs from "node:fs";
import path from "node:path";

// .env を読み込む（依存を増やさない最小パーサ）。VAULT_PATH算出より前に実行する。
loadDotEnv();
function loadDotEnv(): void {
  const envFile = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envFile)) return;
  try {
    for (const raw of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      )
        val = val.slice(1, -1);
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* .env読み込み失敗は無視（既定値で動く） */
  }
}

// ============================================================
// Vaultのパス解決と安全なパス検証。
// - 書き込みは items/ 周辺（保存役）に固定。
// - 人間所有領域(00/10/20/70)はアプリ読み取り専用。
// - path.resolve + realpath の両方でVaultルート配下を検証（../・シンボリックリンク対策）。
// ============================================================

export const VAULT_PATH = path.resolve(
  process.env.VAULT_PATH || path.join(process.cwd(), "vault")
);

/** 各取り込みツールの「最終取り込み時刻」を記録/読み出しする（_cache/sync-status.json）。 */
export function recordSync(key: string): void {
  try {
    const dir = path.join(VAULT_PATH, "_cache");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "sync-status.json");
    let data: Record<string, string> = {};
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* 初回は空 */
    }
    data[key] = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch {
    /* 記録失敗は握りつぶす（本処理を止めない） */
  }
}
export function readSyncStatus(): Record<string, string> {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(VAULT_PATH, "_cache", "sync-status.json"), "utf8")
    );
  } catch {
    return {};
  }
}

/** アプリが書き込んでよいフォルダ（items配下と履歴）。 */
export const WRITABLE_DIRS = {
  items: "items",
  backups: path.join("items", ".backups"),
  ruleCandidates: path.join("items", "_rule_candidates"),
  history: "_history",
  memory: "_memory", // 却下・修正を全部蓄積する「記憶」層（AIが学びの土台に使う）
} as const;

/** context APIが読み取ってよいトップレベル（人間所有・.mdのみ）。 */
export const CONTEXT_ALLOWED_PREFIXES = ["00_persona", "10_rules", "20_projects"];

/** references APIが読み取ってよいトップレベル（.mdのみ）。 */
export const REFERENCE_ALLOWED_PREFIXES = ["70_references", "_cache"];

/** 初回起動時に不足していれば作成候補になるフォルダ。 */
export const REQUIRED_DIRS = [
  WRITABLE_DIRS.items,
  WRITABLE_DIRS.ruleCandidates,
  WRITABLE_DIRS.backups,
  WRITABLE_DIRS.history,
  WRITABLE_DIRS.memory,
];

/**
 * 書き込み先（WRITABLE_DIRS）の realpath が「期待するアプリ所有の実位置」と完全一致するか検査。
 * items→00_persona のようなVault内リンクや外部リンクを検出する。
 * 起動時・setup時の両方で、作成/コピー前に呼ぶこと。
 */
export function checkWritableDirsSafe():
  | { ok: true }
  | { ok: false; rel: string; real: string; expected: string } {
  let vaultReal: string;
  try {
    vaultReal = fs.realpathSync(VAULT_PATH);
  } catch {
    return { ok: true }; // Vault未作成なら検査対象なし
  }
  for (const rel of Object.values(WRITABLE_DIRS)) {
    const abs = path.join(VAULT_PATH, rel);
    if (!fs.existsSync(abs)) continue;
    const real = fs.realpathSync(abs);
    const expected = path.join(vaultReal, rel);
    if (real !== expected || !isInside(vaultReal, real))
      return { ok: false, rel, real, expected };
  }
  return { ok: true };
}

/**
 * Vaultが書き込み初期化済みか。既定(./vault)はアプリ所有＝欠如は作成OK。
 * 外部Vaultは REQUIRED_DIRS が揃っていなければ「未初期化」とみなす（自動作成しない）。
 */
export function vaultReadiness(): { isDefault: boolean; missing: string[] } {
  const isDefault = VAULT_PATH === path.resolve(process.cwd(), "vault");
  const missing = REQUIRED_DIRS.filter(
    (d) => !fs.existsSync(path.join(VAULT_PATH, d))
  );
  return { isDefault, missing };
}

/**
 * CLI(取り込み/収穫)の書き込み前ガード。安全検査＋初期化検査をまとめて行う。
 * 外部Vault未初期化なら false。既定Vaultの不足フォルダはここで作成する。
 */
export function ensureWritableForCli(): { ok: true } | { ok: false; msg: string } {
  const safe = checkWritableDirsSafe();
  if (!safe.ok)
    return {
      ok: false,
      msg: `Vault安全検査に失敗: ${safe.rel} が想定外の実体(${safe.real})を指しています`,
    };
  const { isDefault, missing } = vaultReadiness();
  if (missing.length > 0) {
    if (!isDefault)
      return {
        ok: false,
        msg: `外部Vaultが未初期化です（不足: ${missing.join(", ")}）。'npm run setup' を実行してください`,
      };
    for (const d of missing)
      fs.mkdirSync(path.join(VAULT_PATH, d), { recursive: true });
  }
  return { ok: true };
}

const ID_RE = /^[A-Za-z0-9_-]+$/;

export function isValidId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && id.length <= 128 && ID_RE.test(id);
}

/** slug も id と同じ規則。 */
export const isValidSlug = isValidId;

/**
 * Vault内の相対パスを安全に絶対パスへ解決する。
 * - resolve後にVaultルート配下であること
 * - 既存なら realpath 後もVaultルート配下であること（リンクでVault外を指すのを拒否）
 * 反する場合は null を返す。
 */
export function safeResolve(relPath: string): string | null {
  const abs = path.resolve(VAULT_PATH, relPath);
  if (!isInside(VAULT_PATH, abs)) return null;
  try {
    if (fs.existsSync(abs)) {
      const real = fs.realpathSync(abs);
      const realRoot = fs.realpathSync(VAULT_PATH);
      if (!isInside(realRoot, real) && real !== realRoot) return null;
    }
  } catch {
    return null;
  }
  return abs;
}

/** child が parent の配下（または一致）か。 */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 隠し要素（ドット/アンダースコア始まり）を含むか。references/contextの拒否条件に使う。 */
export function hasHiddenSegment(relPath: string): boolean {
  return relPath
    .split(/[\\/]/)
    .some((seg) => seg.startsWith(".") || seg.startsWith("_"));
}

/**
 * context読み取り許可判定。
 * 許可プレフィックス(00/10/20)配下・拡張子.md・隠し要素なし・Vault内。
 */
export function resolveContextRef(ref: string): string | null {
  if (!ref.endsWith(".md")) return null;
  const norm = ref.replace(/\\/g, "/").replace(/^\/+/, "");
  const top = norm.split("/")[0];
  if (!CONTEXT_ALLOWED_PREFIXES.includes(top)) return null;
  if (hasHiddenSegment(norm)) return null;
  return safeResolve(norm);
}

/**
 * reference読み取り許可判定。
 * 許可ルートは 70_references/ と _cache/ の2つだけ。
 * その配下で .md のみ、ドット始まりは拒否（_cache自体はホワイトリストで明示許可）。
 */
export function resolveReferenceRef(ref: string): string | null {
  if (!ref.endsWith(".md")) return null;
  const norm = ref.replace(/\\/g, "/").replace(/^\/+/, "");
  const segs = norm.split("/");
  const top = segs[0];
  if (!REFERENCE_ALLOWED_PREFIXES.includes(top)) return null;
  // 先頭(top)以外の各セグメントにドット始まりを許さない（鍵/隠しファイル/.env対策）。
  if (segs.slice(1).some((s) => s.startsWith("."))) return null;
  return safeResolve(norm);
}
