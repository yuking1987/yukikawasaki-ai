import { ensureWritableForCli, recordSync, mergeAvatars } from "./vault.ts"; // .env読込＋安全検査
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
import { saveFromUrl, attachBlock, type AttachMeta } from "./attachments.ts";

// ============================================================
// Asana自動取り込み（cronから動かすため MCP でなく REST API を使う）。
// 川崎さんに割当された未完了タスクを取得し、説明欄＋コメントをスレッド化して下書き化。
// メールと同じリビング・カード（新着追従＝新コメントでスレッド更新／完了で自動クローズ）。
// 実行: npm run ingest:asana  ／ 要 .env: ASANA_TOKEN
// ============================================================

const TOKEN = process.env.ASANA_TOKEN || "";
const DAYS = Number(process.env.ASANA_SINCE_DAYS || 30);
// メンション取り込みの対象期間（担当外タスクは件数が多くなりがちなので短めに絞る）
const MENTION_DAYS = Number(process.env.ASANA_MENTION_DAYS || 4);
const BASE = "https://app.asana.com/api/1.0";

async function asana<T = unknown>(pathq: string): Promise<T> {
  const res = await fetch(`${BASE}${pathq}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Asana ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { data: T }).data;
}

// Asanaのメンションはプレーンtextだと「プロフィールURL」で入るが、html_textでは
// アンカー内に表示名(@名前)がそのまま入っている（例: <a ...>@sachiko egami</a>）。
// そこで html_text を使い、アンカーは表示テキストだけ残してタグ除去＝メンションが@名前になる。
function htmlToText(html: string): string {
  return (html || "")
    .replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1") // アンカーは表示テキストを残す（メンション=@名前）
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|body|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
// コメント本文：html_textがあれば（メンションを@名前化して）優先、無ければplain text。
function commentBody(c: { text?: string; html_text?: string }): string {
  const raw = c.html_text ? htmlToText(c.html_text) : c.text || "";
  return clean(raw);
}

/**
 * タスクの添付を取得し、実ファイルを保存して本文用ブロックを返す。
 * 素材が届いているかは打ち返し判定の段階1の根拠。取得/保存に失敗してもメタ情報は残す。
 */
export async function collectAsanaAttachments(
  taskGid: string,
  itemId: string
): Promise<string> {
  try {
    const atts = await asana<any[]>(
      `/tasks/${taskGid}/attachments?opt_fields=name,resource_subtype,size,download_url,created_at`
    );
    if (!atts?.length) return "";
    const metas: AttachMeta[] = [];
    for (const a of atts) {
      const name = a.name || "(名前なし)";
      const meta: AttachMeta = {
        name,
        type: a.resource_subtype || "?",
        size: a.size || 0,
      };
      if (a.download_url) meta.rel = await saveFromUrl(itemId, name, a.download_url);
      metas.push(meta);
    }
    return attachBlock(metas);
  } catch {
    return ""; // 添付が取れなくても本文は活かす
  }
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

  // ユーザー一覧を取得：担当者解決＋プロフィール写真（アバター）マップの更新に使う。
  let assigneeId = process.env.ASANA_ASSIGNEE || "";
  try {
    const users = await asana<any[]>(
      `/workspaces/${ws.gid}/users?opt_fields=name,email,photo.image_128x128&limit=100`
    );
    // 表示名→写真URL を保存（スレッドのアバター表示に使う）
    const avatars: Record<string, string> = {};
    for (const u of users) {
      const url = u.photo?.image_128x128;
      if (u.name && url) avatars[u.name] = url;
    }
    if (Object.keys(avatars).length) mergeAvatars(avatars);
    if (!assigneeId) {
      const email = (process.env.KAWASAKI_GMAIL || "kawasaki@gb-jp.com").toLowerCase();
      const hit = users.find(
        (u) => (u.email || "").toLowerCase() === email || /kawasaki|川崎/i.test(u.name || "")
      );
      if (hit) assigneeId = hit.gid;
    }
  } catch {
    /* 権限が無い等は無視 */
  }
  if (!assigneeId) assigneeId = "me";
  console.log(`[asana] 担当者=${assigneeId}`);

  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
  const FIELDS = "name,notes,due_on,completed,modified_at,permalink_url,projects.name";
  // (1) 川崎さんに割当・未完了・最近更新のタスク（本人の担当仕事）
  const assigned = await asana<any[]>(
    `/tasks?assignee=${assigneeId}&workspace=${ws.gid}&completed_since=now&modified_since=${since}` +
      `&opt_fields=${FIELDS}&limit=100`
  );
  // (2) 川崎さんがコラボレーター（＝@メンションされると自動で入る）の未完了タスク。
  //     担当が別の人でも「メンションされた」タスクを拾うため。範囲は最近 MENTION_DAYS 日。
  const mentionSince = new Date(Date.now() - MENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let followed: any[] = [];
  try {
    followed = await asana<any[]>(
      `/workspaces/${ws.gid}/tasks/search?followers.any=${assigneeId}&completed=false` +
        `&modified_at.after=${mentionSince}&opt_fields=${FIELDS}&limit=100`
    );
  } catch (e) {
    console.error(`[asana] メンション検索に失敗（担当タスクのみ継続）: ${(e as Error).message}`);
  }
  // 担当タスクを優先。フォロー分は担当に無いものだけ「メンションのみ」として足す。
  const assignedGids = new Set(assigned.map((t) => t.gid));
  const queue: { t: any; mentionedOnly: boolean }[] = [
    ...assigned.map((t) => ({ t, mentionedOnly: false })),
    ...followed
      .filter((t) => !assignedGids.has(t.gid))
      .map((t) => ({ t, mentionedOnly: true })),
  ];

  const existing = await listItems();
  let written = 0,
    updated = 0,
    closed = 0,
    reopened = 0,
    mentions = 0;

  for (const { t, mentionedOnly } of queue) {
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
      `/tasks/${t.gid}/stories?opt_fields=created_at,created_by.name,type,text,html_text,resource_subtype`
    );
    const comments = stories.filter((s) => s.type === "comment" && s.text);
    // 「メンションのみ」タスク（担当は別人）は、実際に川崎さんが@メンションされている時だけ扱う。
    // Asanaのメンションは html_text に data-asana-gid="<本人ID>" として入る。
    if (mentionedOnly) {
      const mentioned = stories.some((s) =>
        (s.html_text || "").includes(`data-asana-gid="${assigneeId}"`)
      );
      if (!mentioned) continue; // 単にフォローしているだけのタスクは拾わない
    }
    const notesClean = clean(t.notes);
    // 情報ゼロ（説明欄なし＆コメントなし）のタスクはカード化しない。
    // ※後で説明やコメントが付けば、その時の取り込みで拾う（match無し→情報あり→新規作成）。
    if (!notesClean && comments.length === 0 && !match) continue;
    const lastId = comments.length ? comments[comments.length - 1].gid : t.gid;
    // 添付（素材が来ているかの判断材料）。実ファイルも保存し、本文にパスを併記する
    // （AIがそのパスを開いて画像そのものを確認できるようにするため）。取得失敗は無視して続行。
    const attachSection = await collectAsanaAttachments(t.gid, id);
    const thread =
      `件名: ${t.name}\n\n【説明欄】\n${notesClean || "（説明なし）"}${attachSection}\n\n` +
      comments
        .map(
          (c) =>
            `【${(c.created_at || "").slice(0, 16).replace("T", " ")} ${c.created_by?.name || "?"}】\n${commentBody(c)}`
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
    // メンションのみ＝社内メンバーが川崎さんに聞いている想定＝社内文体。担当タスクは従来どおり社外。
    const mentionNote = mentionedOnly
      ? `> ※このカードは「川崎さんがメンションされた」タスクです（担当は別の人）。社内向けの返信・確認として草案します。\n\n`
      : "";
    const body = `## 元メッセージ\n${mentionNote}${threadSection}\n\n## ドラフト\n（AIが草案を作成予定）\n`;
    const fm: ItemFrontmatter = {
      id,
      source: "asana",
      project: proj,
      audience: mentionedOnly ? "internal" : "external",
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
    if (r.ok) {
      written++;
      if (mentionedOnly) mentions++;
    }
  }

  console.log(
    `[asana] 担当 ${assigned.length} / メンション候補 ${followed.length} → 新規 ${written}（うちメンション ${mentions}） / スレッド更新 ${updated} / 対応済みクローズ ${closed} / 再オープン ${reopened}`
  );
  recordSync("asana"); // 最終取り込み時刻を記録（画面表示用）
}

main().catch((e) => {
  console.error("[asana] エラー:", (e as Error).message);
  process.exit(1);
});
