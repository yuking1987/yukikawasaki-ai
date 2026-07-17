import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import matter from "gray-matter";
import {
  VAULT_PATH,
  REQUIRED_DIRS,
  resolveContextRef,
  resolveReferenceRef,
  isValidSlug,
  checkWritableDirsSafe,
  readSyncStatus,
  readAvatars,
} from "./vault.ts";
import {
  listItems,
  readItem,
  createItem,
  updateItemBody,
  updateStatus,
  saveRuleCandidate,
  setSnooze,
  answerAsk,
  canTransition,
  appendMemory,
  extractDraft,
  applyProposalOnApprove,
  PROPOSAL_TYPES,
  readGlobalRules,
  appendGlobalRule,
  listIgnoreKeywords,
  addIgnoreKeyword,
} from "./items.ts";
import {
  SOURCES,
  AUDIENCES,
  TYPES,
  STATUSES,
  IMPORTANCES,
  ASSIGNEE_ROLES,
  REVIEWED_BY,
  REVIEW_STATUSES,
  HIGH_IMPORTANCE_KEYWORDS,
  routeAssignee,
  type ItemFrontmatter,
  type Ask,
} from "../shared/roles.ts";

/** asks(AI→人間の依頼)を型・長さ込みで正規化。不正な要素は捨てる。 */
function normalizeAsks(raw: unknown): Ask[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Ask[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.slice(0, 64) : "";
    const kind =
      o.kind === "decision" || o.kind === "investigation" ? o.kind : null;
    const question = typeof o.question === "string" ? o.question.slice(0, 2000) : "";
    if (!id || !kind || !question) continue;
    const ask: Ask = { id, kind, question };
    if (Array.isArray(o.options)) {
      const opts = o.options
        .filter((x): x is string => typeof x === "string")
        .slice(0, 6)
        .map((x) => x.slice(0, 200));
      if (opts.length) ask.options = opts;
    }
    if (typeof o.answer === "string") ask.answer = o.answer.slice(0, 8000);
    if (o.resolved === true) ask.resolved = true;
    out.push(ask);
  }
  return out.length ? out.slice(0, 20) : undefined;
}

const PORT = Number(process.env.PORT || 8787);
const HOST = "127.0.0.1"; // localhost限定。外部公開しない。
const REFRESH_ALERT_DAYS = Number(process.env.REFRESH_ALERT_DAYS || 7);

// Vaultが書き込み可能に初期化済みか（外部Vaultで必要フォルダ欠如時はfalse）。
let vaultWritable = true;

const app = express();
app.use(express.json({ limit: "2mb" }));

// 書き込み系メソッドは、Vault未初期化なら503（確認付きsetupを飛ばして作らせない）。
app.use((req, res, next) => {
  const mutating = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method);
  if (mutating && !vaultWritable) {
    return res.status(503).json({
      error:
        "Vaultが初期化されていません。`npm run setup` で確認付き初期化を実行してください。",
    });
  }
  next();
});

// Express4はasyncルートのthrowをレスポンス化しない。全asyncルートをこれで包む。
type AsyncHandler = (
  req: express.Request,
  res: express.Response
) => Promise<unknown>;
const h =
  (fn: AsyncHandler) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

// サーバ起動ごとに変わるID。フロントはこれを監視し、変わったら自動リロードする
// （＝コード更新後にブラウザを手動再読み込みしなくても新機能が反映される）。
const BOOT_ID = String(Date.now());

// --- ヘルスチェック ---
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, vault: VAULT_PATH, bootId: BOOT_ID });
});

// --- 定数（GUIの選択肢用） ---
app.get("/api/meta", (_req, res) => {
  res.json({
    sources: SOURCES,
    audiences: AUDIENCES,
    types: TYPES,
    statuses: STATUSES,
    importances: IMPORTANCES,
    assignees: ASSIGNEE_ROLES,
  });
});

// --- アイテム一覧（frontmatterのみ・items/直下） ---
app.get(
  "/api/items",
  h(async (req, res) => {
    let items = await listItems();
    const { status, source, project, audience, assignee, type, q } = req.query;
    const eq = (v: unknown, qq: unknown) => !qq || String(v ?? "") === String(qq);
    items = items.filter(
      (it) =>
        eq(it.status, status) &&
        eq(it.source, source) &&
        eq(it.project, project) &&
        eq(it.audience, audience) &&
        eq(it.assignee, assignee) &&
        eq(it.type, type)
    );
    // キーワード検索：タイトル・案件名で先に判定し、当たらなければ本文（スレッド）も見る
    const needle = String(q ?? "").trim().toLowerCase();
    if (needle) {
      const matched: typeof items = [];
      for (const it of items) {
        const meta = `${it.title ?? ""} ${it.project_label ?? ""} ${it.project ?? ""}`.toLowerCase();
        if (meta.includes(needle)) {
          matched.push(it);
          continue;
        }
        const full = await readItem(it.id);
        if (full && full.body.toLowerCase().includes(needle)) matched.push(it);
      }
      items = matched;
    }
    res.json({ items });
  })
);

// --- 1件取得（本文含む） ---
app.get(
  "/api/items/:id",
  h(async (req, res) => {
    const item = await readItem(req.params.id);
    if (!item) return res.status(404).json({ error: "見つかりません" });
    res.json({ item });
  })
);

// --- 新規下書き登録（保存役） ---
app.post(
  "/api/items",
  h(async (req, res) => {
    const b = req.body ?? {};
    const fm = buildFrontmatter(b);
    if (!fm.ok) return res.status(400).json({ error: fm.msg });
    const result = await createItem(fm.value, String(b.body ?? ""));
    if (!result.ok) return res.status(result.code).json({ error: result.msg });
    res.status(201).json({ id: result.id });
  })
);

// --- 本文修正（バックアップ後に保存） ---
app.patch(
  "/api/items/:id",
  h(async (req, res) => {
    const body = String(req.body?.body ?? "");
    const before = await readItem(req.params.id);
    const patch: Partial<ItemFrontmatter> = {};
    if (typeof req.body?.title === "string") patch.title = req.body.title;
    // レビュー結果・蒸留メタも保存役APIで更新できるようにする
    applyReviewPatch(req.body, patch);
    const r = await updateItemBody(req.params.id, body, patch);
    if (!r.ok) return res.status(r.code).json({ error: r.msg });
    // 修正を記憶へ蓄積（本文が実際に変わったときだけ）。修正前→修正後のドラフトを残す。
    if (before && before.body.trim() !== body.trim()) {
      const dBefore = extractDraft(before.body);
      const dAfter = extractDraft(body);
      const note =
        dBefore || dAfter
          ? `修正前:\n${dBefore || "（なし）"}\n\n修正後:\n${dAfter || "（なし）"}`
          : undefined;
      await appendMemory({
        action: "revised",
        id: before.id,
        project: before.project,
        audience: before.audience,
        type: before.type,
        assignee: before.assignee,
        note,
      });
    }
    res.json({ ok: true });
  })
);

// --- status更新（承認/却下/差し戻し。遷移はupdateStatusで検証） ---
app.patch(
  "/api/items/:id/status",
  h(async (req, res) => {
    const status = req.body?.status;
    if (!STATUSES.includes(status))
      return res.status(400).json({ error: "不正なstatusです" });
    const item = await readItem(req.params.id);
    if (!item) return res.status(404).json({ error: "見つかりません" });
    // 遷移チェックを先に行う（不許可なら本文を一切変更しない）
    if (!canTransition(item.status, status))
      return res.status(409).json({
        error: `許可されない状態遷移です（${item.status}→${status}）`,
      });
    // stale draft承認ガード: クライアントが見ていたスレッド最終IDと現行がズレていたら承認させない。
    // （cronでスレッドが更新された直後の古い草案の承認を防ぐ。GUIは再取得して最新で承認し直す）
    if (status === "approved" && "expected_thread_last_id" in (req.body ?? {})) {
      const exp = String(req.body.expected_thread_last_id ?? "");
      const cur = String(item.thread_last_id ?? "");
      if (exp !== cur)
        return res.status(409).json({
          error: "スレッドに新着があります。最新を確認してから承認してください。",
          stale: true,
        });
    }
    // 却下理由/再考コメント/メモは該当ドラフト本文へ（恒久ルールとは別扱い）
    if (typeof req.body?.note === "string" && req.body.note.trim()) {
      const label =
        status === "rejected" ? "却下理由" : status === "revision" ? "再考依頼" : "メモ";
      const newBody =
        item.body.trimEnd() +
        `\n\n## ${label}（${new Date().toISOString().slice(0, 10)}）\n${req.body.note}\n`;
      await updateItemBody(req.params.id, newBody);
    }
    // 蒸留提案の承認は「反映成功時のみ approved」にする（反映失敗ならpending維持）。
    // 反映は status 更新の前に行う（applyProposalOnApprove側も applied_at で冪等化）。
    let applied:
      | { applied: boolean; already?: boolean; target?: string; msg?: string }
      | undefined;
    const isProposalApproving =
      status === "approved" &&
      PROPOSAL_TYPES.includes(item.type) &&
      item.status !== "approved";
    if (isProposalApproving) {
      applied = await applyProposalOnApprove(req.params.id);
      // 「既に反映済み(already)」は失敗ではない → 承認は通す。本物の失敗のみ422でpending維持。
      if (!applied.applied && !applied.already)
        return res.status(422).json({
          error: `承認できません（自動反映に失敗）: ${applied.msg ?? ""}`,
          applied,
        });
    }
    const r = await updateStatus(req.params.id, status, req.body?.note);
    if (!r.ok) return res.status(r.code).json({ error: r.msg });
    // 却下・再考依頼を記憶へ蓄積（理由/コメントが無くても事実は残す）
    if (status === "rejected" || status === "revision") {
      await appendMemory({
        action: status === "rejected" ? "rejected" : "revision",
        id: item.id,
        project: item.project,
        audience: item.audience,
        type: item.type,
        assignee: item.assignee,
        note: typeof req.body?.note === "string" ? req.body.note : undefined,
      });
    }
    res.json({ ok: true, applied });
  })
);

// --- AI→人間への依頼(ask)へ回答 ---
app.patch(
  "/api/items/:id/asks/:askId",
  h(async (req, res) => {
    const answer = String(req.body?.answer ?? "").trim();
    if (!answer) return res.status(400).json({ error: "回答が空です" });
    const r = await answerAsk(req.params.id, req.params.askId, answer);
    if (!r.ok) return res.status(r.code).json({ error: r.msg });
    res.json({ ok: true });
  })
);

// --- スルー（後で）: snooze_until の設定/解除 ---
app.patch(
  "/api/items/:id/snooze",
  h(async (req, res) => {
    const until = req.body?.until;
    const val = until === null || until === "" ? null : String(until);
    const r = await setSnooze(req.params.id, val);
    if (!r.ok) return res.status(r.code).json({ error: r.msg });
    res.json({ ok: true });
  })
);

// --- 学び候補の保存（10_rules/へは書かない） ---
app.post(
  "/api/rule-candidates",
  h(async (req, res) => {
    const id = String(req.body?.id ?? "");
    if (!isValidSlug(id)) return res.status(400).json({ error: "不正なidです" });
    const r = await saveRuleCandidate(
      id,
      String(req.body?.body ?? ""),
      String(req.body?.title ?? "学び候補")
    );
    if (!r.ok) return res.status(r.code).json({ error: r.msg });
    res.status(201).json({ id: r.id });
  })
);

// --- コンテキスト取得（人格/ルール/案件・読み取り専用） ---
app.get(
  "/api/context",
  h(async (req, res) => {
    const refs = toArray(req.query.refs);
    const out: { ref: string; content?: string; error?: string }[] = [];
    for (const ref of refs) {
      const abs = resolveContextRef(ref);
      if (!abs || !fs.existsSync(abs)) {
        out.push({ ref, error: "読み取り不可（許可範囲外）" });
        continue;
      }
      const raw = await fsp.readFile(abs, "utf8");
      out.push({ ref, content: raw });
    }
    res.json({ contexts: out });
  })
);

// --- 参照層 一覧（メタのみ・本文は返さない。安全解決を通す） ---
app.get(
  "/api/references",
  h(async (_req, res) => {
    const dir = path.join(VAULT_PATH, "70_references");
    if (!fs.existsSync(dir)) return res.json({ references: [] });
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const refs = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".md") || e.name.startsWith(".")) continue;
      const slug = e.name.replace(/\.md$/, "");
      if (!isValidSlug(slug)) continue;
      const abs = resolveReferenceRef(`70_references/${e.name}`);
      if (!abs) continue;
      try {
        const parsed = matter(await fsp.readFile(abs, "utf8"));
        const d = parsed.data as Record<string, unknown>;
        // YAMLは `2026-07-16`(クォート無し)をDateにするので、必ずISO(YYYY-MM-DD)へ正規化。
        const fmtDate = (v: unknown): string | undefined =>
          !v
            ? undefined
            : v instanceof Date
            ? v.toISOString().slice(0, 10)
            : String(v).slice(0, 10);
        const lastSynced = fmtDate(d.last_synced);
        // 「ローカル原本」は kind:local を明示条件にする（source_id の有無では判定しない）。
        // これにより、外部種別(notion/gsheet/gdrive)なのに source_id を書き忘れた資料が
        // 「原本（同期不要）」へ誤分類されず、鮮度警告（未取得）として拾える。
        const kind = d.kind ? String(d.kind) : d.source_id ? "unknown" : "local";
        const isLocal = kind === "local";
        // ローカル原本の「更新／蒸留日」を拾う（場所が資料ごとにまちまちなので順に探す）。
        const meta =
          d.metadata && typeof d.metadata === "object"
            ? (d.metadata as Record<string, unknown>)
            : {};
        const updated = fmtDate(
          d.distilled ?? d.updated ?? d.synced ?? meta.distilled ?? meta.updated
        );
        refs.push({
          slug,
          kind,
          title: d.title ?? slug,
          last_synced: lastSynced,
          updated: isLocal ? updated : undefined,
          stale: isLocal
            ? false
            : isStale(lastSynced, Number(d.refresh_days) || REFRESH_ALERT_DAYS),
        });
      } catch {
        /* skip broken */
      }
    }
    res.json({ references: refs });
  })
);

// --- 参照層 詳細（ポインタ＋cache本文） ---
app.get(
  "/api/references/:slug",
  h(async (req, res) => {
    const slug = req.params.slug;
    if (!isValidSlug(slug)) return res.status(400).json({ error: "不正なslugです" });
  const pointerAbs = resolveReferenceRef(`70_references/${slug}.md`);
  if (!pointerAbs || !fs.existsSync(pointerAbs))
    return res.status(404).json({ error: "見つかりません" });
    const pointer = await fsp.readFile(pointerAbs, "utf8");
    // cache本文（_cache/{slug}/ 配下の .md）
    const cacheDir = path.join(VAULT_PATH, "_cache", slug);
    const cache: { file: string; content: string }[] = [];
    if (fs.existsSync(cacheDir)) {
      for (const name of await fsp.readdir(cacheDir)) {
        if (!name.endsWith(".md") || name.startsWith(".")) continue;
        const abs = resolveReferenceRef(`_cache/${slug}/${name}`);
        if (!abs) continue;
        cache.push({ file: name, content: await fsp.readFile(abs, "utf8") });
      }
    }
    res.json({ slug, pointer, cache });
  })
);

// --- 打ち返し草案を「今すぐ生成」。draft_statusをgeneratingにし、1件分の生成を非同期起動。 ---
app.post(
  "/api/items/:id/generate",
  h(async (req, res) => {
    const item = await readItem(req.params.id);
    if (!item) return res.status(404).json({ error: "見つかりません" });
    if (item.draft_status === "generating")
      return res.json({ ok: true, already: true });
    // 生成中フラグを立てる（本文は変えない）。GUIはこれを見て「生成中…」を表示。
    const r = await updateItemBody(item.id, item.body, {
      draft_status: "generating",
      draft_started_at: new Date().toISOString(),
    });
    if (!r.ok) return res.status(r.code).json({ error: r.msg });
    // ローカルの Claude Code を1件分だけヘッドレス起動（送信・実行はしない・草案だけ）。
    // detachedで投げっぱなし。完了/失敗でスクリプト側が draft_status を消す/errorにする。
    try {
      const script = path.join(process.cwd(), "ops", "gb-draft-one.sh");
      const logDir = path.join(process.cwd(), "ops", "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const out = fs.openSync(path.join(logDir, "draft-one.out.log"), "a");
      const child = spawn("bash", [script, item.id], {
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
    } catch (e) {
      // 起動自体に失敗したらフラグをerrorに戻す
      await updateItemBody(item.id, item.body, { draft_status: "error" });
      return res.status(500).json({ error: `生成の起動に失敗: ${(e as Error).message}` });
    }
    res.status(202).json({ ok: true });
  })
);

// --- クライアント（案件コンテキスト）一覧。20_projects 配下で context.md を持つもの。 ---
app.get(
  "/api/projects",
  h(async (_req, res) => {
    const dir = path.join(VAULT_PATH, "20_projects");
    if (!fs.existsSync(dir)) return res.json({ projects: [] });
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const projects: {
      slug: string;
      title: string;
      domain?: string;
      ref: string;
      hasStack: boolean;
      hasPrecedents: boolean;
    }[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const slug = e.name;
      if (!isValidSlug(slug)) continue;
      const ref = `20_projects/${slug}/context.md`;
      const abs = resolveContextRef(ref);
      if (!abs || !fs.existsSync(abs)) continue;
      try {
        const raw = await fsp.readFile(abs, "utf8");
        const parsed = matter(raw);
        const d = parsed.data as Record<string, unknown>;
        projects.push({
          slug,
          title: d.title ? String(d.title) : slug,
          domain: d.client_domain ? String(d.client_domain) : undefined,
          ref,
          hasStack: raw.includes("tech-stack:start"),
          hasPrecedents: raw.includes("maint-precedents:start"),
        });
      } catch {
        /* skip broken */
      }
    }
    projects.sort((a, b) => a.title.localeCompare(b.title, "ja"));
    res.json({ projects });
  })
);

// --- 受付の仮判定（振り分け・重要度）。GUIの補助。実行はしない。 ---
app.post("/api/triage", (req, res) => {
  const type = req.body?.type;
  const text = String(req.body?.text ?? "");
  const hints = {
    maintenance: /障害|保守|定期運用|メンテ/.test(text),
    ciy: /CIY|ciy/.test(text),
  };
  const assignee = ASSIGNEE_ROLES.includes(req.body?.assignee)
    ? req.body.assignee
    : routeAssignee(type, hints);
  const high = HIGH_IMPORTANCE_KEYWORDS.some((k) => text.includes(k));
  res.json({ assignee, importance: high ? "high" : "normal" });
});

// --- 各ツールの最終取り込み時刻 ---
app.get(
  "/api/sync-status",
  h(async (_req, res) => {
    res.json({ status: readSyncStatus() });
  })
);

// --- メンバーのプロフィール画像（表示名→URL） ---
app.get(
  "/api/avatars",
  h(async (_req, res) => {
    res.json({ avatars: readAvatars() });
  })
);

// --- 全体ルール（ダッシュボードから追加できる共通ルール） ---
app.get(
  "/api/rules",
  h(async (_req, res) => {
    const [text, ignore] = await Promise.all([
      readGlobalRules(),
      listIgnoreKeywords(),
    ]);
    res.json({ text, ignore });
  })
);
app.post(
  "/api/rules",
  h(async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const ignoreKeyword =
      typeof req.body?.ignoreKeyword === "string" ? req.body.ignoreKeyword : "";
    if (!text.trim() && !ignoreKeyword.trim())
      return res.status(400).json({ error: "ルールかキーワードを入力してください。" });
    if (text.trim()) {
      const r = await appendGlobalRule(text);
      if (!r.ok) return res.status(400).json({ error: r.msg });
    }
    if (ignoreKeyword.trim()) {
      const r = await addIgnoreKeyword(ignoreKeyword);
      if (!r.ok) return res.status(400).json({ error: r.msg });
    }
    const [ruleText, ignore] = await Promise.all([
      readGlobalRules(),
      listIgnoreKeywords(),
    ]);
    res.json({ ok: true, text: ruleText, ignore });
  })
);

// 本番/安定モード: ビルド済みフロント(dist/)を配信。
// これで `npm start` / `npm run app` は単一プロセス・単一ポートで動き、
// 開発サーバ(vite+watch)のような再起動・巻き添え終了が起きない。
const distDir = path.join(process.cwd(), "dist");
app.use(express.static(distDir));
app.use((req, res, next) => {
  // /api 以外のGETは SPA の index.html を返す（フロントのルーティング用）。
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    const idx = path.join(distDir, "index.html");
    if (fs.existsSync(idx)) return res.sendFile(idx);
  }
  next();
});

// エラーミドルウェア（全ルートの後）。本文は出さず、汎用メッセージを返す。
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    logErr("route", err);
    if (!res.headersSent) res.status(500).json({ error: "サーバ内部エラー" });
  }
);

// --- 起動 ---
async function start() {
  // 重要: mkdir より前にリンク検査する。既存の items 等がリンクだと、
  // 後続の mkdir がリンク先（人間所有領域や外部）へ書き込んでしまうため。
  verifyWritableDirsInsideVault();
  await ensureVaultReady();
  // 作成後の最終確認（冪等）。
  verifyWritableDirsInsideVault();
  const server = app.listen(PORT, HOST, () => {
    console.log(`[server] http://${HOST}:${PORT} （Vault: ${VAULT_PATH}）`);
  });

  // 再起動/終了シグナルで即座に閉じる（tsx watchの「Force killing」警告を避ける）。
  const shutdown = () => {
    server.closeAllConnections?.(); // keep-alive接続も強制クローズ（Node 18.2+）
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/**
 * 書き込み先（items/ 周辺・_history）の realpath が「期待するアプリ所有の実位置」と
 * 一致することを起動時に検証。単に「Vault内」ではなく、items→00_persona のような
 * Vault内リンクによる人間所有領域への書き込みも防ぐ。反していれば起動中止。
 */
function verifyWritableDirsInsideVault(): void {
  const r = checkWritableDirsSafe();
  if (!r.ok) {
    console.error(
      `[server] 起動中止: 書き込み先 ${r.rel} が期待しない場所を指しています` +
        `（realpath=${r.real}, 期待=${r.expected}）。シンボリックリンク等を解消してください。`
    );
    process.exit(1);
  }
}

/**
 * 既定Vault(./vault)なら不足フォルダを自動作成（アプリ所有）。
 * 既存Vaultを VAULT_PATH で指定している場合は自動作成せず、`npm run setup` を促す。
 */
async function ensureVaultReady() {
  // 既定の ./vault はアプリ所有なので自動作成OK。外部Vault指定時は setup を促す。
  const isDefault = VAULT_PATH === path.resolve(process.cwd(), "vault");
  const missing = REQUIRED_DIRS.filter(
    (d) => !fs.existsSync(path.join(VAULT_PATH, d))
  );
  if (missing.length === 0) return;
  if (isDefault) {
    for (const d of missing) await fsp.mkdir(path.join(VAULT_PATH, d), { recursive: true });
    console.log(`[server] 既定Vaultに不足フォルダを作成しました: ${missing.join(", ")}`);
  } else {
    // 外部Vaultは自動作成せず、書き込みを止めて setup を促す。
    vaultWritable = false;
    console.warn(
      `[server] 警告: Vaultに必要なフォルダがありません: ${missing.join(", ")}\n` +
        `        書き込みは停止中(503)。確認付き初期化を実行してください:  npm run setup`
    );
  }
}

// --- helpers ---
function buildFrontmatter(
  b: Record<string, unknown>
): { ok: true; value: ItemFrontmatter } | { ok: false; msg: string } {
  const id = String(b.id ?? "").trim();
  if (!id) return { ok: false, msg: "idは必須です" };
  const type = b.type;
  if (!TYPES.includes(type as never)) return { ok: false, msg: "不正なtypeです" };
  const source = SOURCES.includes(b.source as never) ? b.source : "other";
  const audience = AUDIENCES.includes(b.audience as never) ? b.audience : "internal";
  const value: ItemFrontmatter = {
    id,
    source: source as ItemFrontmatter["source"],
    project: String(b.project ?? "").trim() || "未分類",
    project_label:
      typeof b.project_label === "string" ? b.project_label : undefined,
    due_on: typeof b.due_on === "string" ? b.due_on : undefined,
    audience: audience as ItemFrontmatter["audience"],
    type: type as ItemFrontmatter["type"],
    // 新規作成は必ず pending（承認済み/却下済みをGUI外から直接作らせない）
    status: "pending",
    title: String(b.title ?? "").trim() || "（無題）",
    createdAt: new Date().toISOString(),
    assignee: ASSIGNEE_ROLES.includes(b.assignee as never)
      ? (b.assignee as ItemFrontmatter["assignee"])
      : undefined,
    importance: IMPORTANCES.includes(b.importance as never)
      ? (b.importance as ItemFrontmatter["importance"])
      : "normal",
    contextRefs: Array.isArray(b.contextRefs)
      ? (b.contextRefs as string[]).map(String)
      : undefined,
    apply_target:
      typeof b.apply_target === "string" ? b.apply_target : undefined,
    source_ref: typeof b.source_ref === "string" ? b.source_ref : undefined,
    thread_key: typeof b.thread_key === "string" ? b.thread_key : undefined,
    thread_last_id:
      typeof b.thread_last_id === "string" ? b.thread_last_id : undefined,
    thread_updated: b.thread_updated === true ? true : undefined,
    asks: normalizeAsks(b.asks),
    reviewed_by: REVIEWED_BY.includes(b.reviewed_by as never)
      ? (b.reviewed_by as ItemFrontmatter["reviewed_by"])
      : undefined,
    review_status: REVIEW_STATUSES.includes(b.review_status as never)
      ? (b.review_status as ItemFrontmatter["review_status"])
      : undefined,
    review_notes:
      typeof b.review_notes === "string" ? b.review_notes : undefined,
    // 蒸留提案の出典メタ（persona_proposal等で使用）
    distill_source: SOURCES.includes(b.distill_source as never)
      ? (b.distill_source as ItemFrontmatter["distill_source"])
      : undefined,
    distill_date_range:
      typeof b.distill_date_range === "string" ? b.distill_date_range : undefined,
    distill_sample_count:
      typeof b.distill_sample_count === "number"
        ? b.distill_sample_count
        : undefined,
    distill_account_id:
      typeof b.distill_account_id === "string" ? b.distill_account_id : undefined,
    distill_uncertainty:
      typeof b.distill_uncertainty === "boolean"
        ? b.distill_uncertainty
        : undefined,
  };
  return { ok: true, value };
}

/** レビュー結果メタ（reviewed_by/review_status/review_notes）をpatchに反映。 */
function applyReviewPatch(
  b: Record<string, unknown>,
  patch: Partial<ItemFrontmatter>
): void {
  if (REVIEWED_BY.includes(b?.reviewed_by as never))
    patch.reviewed_by = b.reviewed_by as ItemFrontmatter["reviewed_by"];
  if (REVIEW_STATUSES.includes(b?.review_status as never))
    patch.review_status = b.review_status as ItemFrontmatter["review_status"];
  if (typeof b?.review_notes === "string") patch.review_notes = b.review_notes;
}

function toArray(q: unknown): string[] {
  if (Array.isArray(q)) return q.map(String);
  if (typeof q === "string") return q.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function isStale(lastSynced: string | undefined, days: number): boolean {
  if (!lastSynced) return true;
  const t = Date.parse(lastSynced);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > days * 24 * 60 * 60 * 1000;
}

function logErr(where: string, e: unknown): void {
  // 本文は出さない。発生箇所とメッセージのみ。
  console.error(`[error] ${where}: ${(e as Error)?.message ?? e}`);
}

// ルート内の想定外エラーでサーバ全体を落とさない（本文は出さない）。
process.on("unhandledRejection", (e) => {
  console.error(`[error] unhandledRejection: ${(e as Error)?.message ?? e}`);
});
process.on("uncaughtException", (e) => {
  console.error(`[error] uncaughtException: ${(e as Error)?.message ?? e}`);
});

start();
