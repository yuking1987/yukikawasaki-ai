import { ensureWritableForCli, recordSync } from "./vault.ts"; // .env読込＋安全検査
import {
  createItem,
  listItems,
  updateStatus,
  updateThread,
} from "./items.ts";
import {
  routeAssignee,
  HIGH_IMPORTANCE_KEYWORDS,
  type ItemFrontmatter,
} from "../shared/roles.ts";

// ============================================================
// Asana自動取り込み（cronから動かすため MCP でなく REST API を使う）。
// 川崎さんに割当された未完了タスクを取得し、説明欄＋コメントをスレッド化して下書き化。
// メールと同じリビング・カード（新着追従＝新コメントでスレッド更新／完了で自動クローズ）。
// 実行: npm run ingest:asana  ／ 要 .env: ASANA_TOKEN
// ============================================================

const TOKEN = process.env.ASANA_TOKEN || "";
const DAYS = Number(process.env.ASANA_SINCE_DAYS || 30);
const BASE = "https://app.asana.com/api/1.0";

async function asana<T = unknown>(pathq: string): Promise<T> {
  const res = await fetch(`${BASE}${pathq}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Asana ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { data: T }).data;
}

// コメント/説明のノイズ（CIY署名・引用）を除去
const SIG_CUT =
  /^(【人材の定着|={4,}|-{4,}|▲▽|プライバシーマーク|差出人:|送信日時:|宛先:|--\s*$)/;
function clean(text: string): string {
  const lines = (text || "").split(/\r?\n/);
  let cut = lines.findIndex((l) => SIG_CUT.test(l.trim()));
  if (cut === -1) cut = lines.length;
  const out: string[] = [];
  for (const l of lines.slice(0, cut)) {
    if (l.trim().startsWith(">")) continue;
    out.push(l.replace(/\s+$/, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 1600);
}

async function main() {
  if (!TOKEN) {
    console.error("[asana] ASANA_TOKEN が未設定です（.env に Personal Access Token を設定）。");
    process.exit(1);
  }
  const ready = ensureWritableForCli();
  if (!ready.ok) {
    console.error(`[asana] ${ready.msg}。中止します。`);
    process.exit(1);
  }

  const me = await asana<any>("/users/me?opt_fields=gid,name,workspaces.name");
  const ws = me.workspaces?.[0];
  if (!ws) {
    console.error("[asana] ワークスペースが取得できません。");
    process.exit(1);
  }
  console.log(`[asana] ${me.name} / ${ws.name}（過去${DAYS}日の担当タスク）`);

  // 担当者を解決：ASANA_ASSIGNEE 指定 > 川崎さん(email/名前一致) > me
  let assigneeId = process.env.ASANA_ASSIGNEE || "";
  if (!assigneeId) {
    try {
      const users = await asana<any[]>(`/workspaces/${ws.gid}/users?opt_fields=name,email`);
      const email = (process.env.KAWASAKI_GMAIL || "kawasaki@gb-jp.com").toLowerCase();
      const hit = users.find(
        (u) => (u.email || "").toLowerCase() === email || /kawasaki|川崎/i.test(u.name || "")
      );
      if (hit) assigneeId = hit.gid;
    } catch {
      /* email権限が無い等は無視 */
    }
  }
  if (!assigneeId) assigneeId = "me";
  console.log(`[asana] 担当者=${assigneeId}`);

  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
  // 川崎さんに割当・未完了・最近更新のタスク
  const tasks = await asana<any[]>(
    `/tasks?assignee=${assigneeId}&workspace=${ws.gid}&completed_since=now&modified_since=${since}` +
      `&opt_fields=name,notes,due_on,completed,modified_at,permalink_url,projects.name&limit=100`
  );
  const existing = await listItems();
  let written = 0,
    updated = 0,
    closed = 0,
    reopened = 0;

  for (const t of tasks) {
    const key = `asana:${t.gid}`;
    const id = `asana-${t.gid}`;
    const proj = t.projects?.[0]?.name || "未分類";
    const match = existing.find((it) => it.thread_key === key);

    // 完了タスクは自動クローズ
    if (t.completed) {
      if (match && (match.status === "pending" || match.status === "revision")) {
        await updateStatus(match.id, "done");
        closed++;
      }
      continue;
    }

    // コメント履歴（stories）取得 → 説明欄＋コメントでスレッド化
    const stories = await asana<any[]>(
      `/tasks/${t.gid}/stories?opt_fields=created_at,created_by.name,type,text,resource_subtype`
    );
    const comments = stories.filter((s) => s.type === "comment" && s.text);
    const notesClean = clean(t.notes);
    // 情報ゼロ（説明欄なし＆コメントなし）のタスクはカード化しない。
    // ※後で説明やコメントが付けば、その時の取り込みで拾う（match無し→情報あり→新規作成）。
    if (!notesClean && comments.length === 0 && !match) continue;
    const lastId = comments.length ? comments[comments.length - 1].gid : t.gid;
    const thread =
      `件名: ${t.name}\n\n【説明欄】\n${notesClean || "（説明なし）"}\n\n` +
      comments
        .map(
          (c) =>
            `【${(c.created_at || "").slice(0, 16).replace("T", " ")} ${c.created_by?.name || "?"}】\n${clean(c.text)}`
        )
        .join("\n\n---\n\n");
    const threadSection = thread;

    // 「サポートGB / 川崎さん」が最後のコメント＝クライアントへ返信済みの合図（対応済み）。
    // 井上さん等の社内メンバーの最後コメントは"未対応"扱い（社内フォローが必要なため）。
    const lastComment = comments[comments.length - 1];
    const gbReplied =
      !!lastComment &&
      /サポートGB|川崎|kawasaki|yuki kawasaki/i.test(lastComment.created_by?.name || "");

    if (match) {
      if (match.status === "pending" || match.status === "revision") {
        if (match.thread_last_id !== lastId) {
          await updateThread(match.id, threadSection, lastId);
          updated++;
        }
        if (gbReplied) {
          // GB側が最後に返信 → 対応済みに自動クローズ（承認待ちから消える）
          await updateStatus(match.id, "done");
          closed++;
        }
      } else if (match.status === "done") {
        // 対応済みでも、先方(非GB)から新着コメントが来たら承認待ちへ自動復活
        if (match.thread_last_id !== lastId && !gbReplied) {
          await updateThread(match.id, threadSection, lastId);
          await updateStatus(match.id, "pending");
          reopened++;
        }
      }
      continue;
    }

    // 新規タスク：GBが既に最後に返信済みなら作らない（対応済みなので）
    if (gbReplied) continue;

    const text = `${t.name}\n${t.notes || ""}`;
    const maintenance = /保守|障害|サーバ|SSL|移行|ドメイン|メンテ|バックアップ/.test(text);
    const ciy = /CIY|シーアイワイ|ciy-biz|assessment/i.test(text);
    const body = `## 元メッセージ\n${threadSection}\n\n## ドラフト\n（AIが草案を作成予定）\n`;
    const fm: ItemFrontmatter = {
      id,
      source: "asana",
      project: proj,
      audience: "external",
      type: "reply",
      status: "pending",
      title: (t.name || "(無題)").slice(0, 80),
      createdAt: new Date().toISOString(),
      importance: HIGH_IMPORTANCE_KEYWORDS.some((k) => text.includes(k))
        ? "high"
        : "normal",
      assignee: routeAssignee("reply", { maintenance, ciy }),
      due_on: t.due_on || undefined,
      source_ref: t.permalink_url || undefined,
      thread_key: key,
      thread_last_id: lastId,
    };
    const r = await createItem(fm, body);
    if (r.ok) written++;
  }

  console.log(
    `[asana] 対象 ${tasks.length} タスク → 新規 ${written} / スレッド更新 ${updated} / 対応済みクローズ ${closed} / 再オープン ${reopened}`
  );
  recordSync("asana"); // 最終取り込み時刻を記録（画面表示用）
}

main().catch((e) => {
  console.error("[asana] エラー:", (e as Error).message);
  process.exit(1);
});
