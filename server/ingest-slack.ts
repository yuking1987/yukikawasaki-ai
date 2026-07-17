import { ensureWritableForCli, recordSync, mergeAvatars } from "./vault.ts"; // .env読込＋安全検査
import {
  createItem,
  listItems,
  updateStatus,
  updateThread,
  appendReplyExample,
} from "./items.ts";
import {
  routeAssignee,
  HIGH_IMPORTANCE_KEYWORDS,
  type ItemType,
  type ItemFrontmatter,
} from "../shared/roles.ts";

// ============================================================
// Slack自動取り込み（cronから動かすため MCP でなく Web API を使う）。
// 対象チャンネル(SLACK_CHANNEL_IDS)の直近スレッドを取得し、
// 「川崎さんが関与し、まだ本人が返していない」スレッドを打ち返しカード化。
// メール/Asanaと同じリビング・カード（新着で更新／本人返信で自動クローズ）。
// あわせて本人のSlack発言を人格の正例(_memory/replies.md)へ自動蓄積。
// 実行: npm run ingest:slack ／ 要 .env: SLACK_BOT_TOKEN, SLACK_CHANNEL_IDS, KAWASAKI_SLACK_USER_ID
// ※非公開chは一覧APIに出ないため、対象chのIDを .env に明示する運用。
// ============================================================

const TOKEN = process.env.SLACK_BOT_TOKEN || "";
const CHANNELS = (process.env.SLACK_CHANNEL_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ME = process.env.KAWASAKI_SLACK_USER_ID || "";
const DAYS = Number(process.env.SLACK_SINCE_DAYS || 7);
const WORKSPACE = process.env.SLACK_WORKSPACE || "gbtalk";
const BASE = "https://slack.com/api";

// user ID → 表示名 の対応表（発言者・メンションを実名にするため）。
let USERS = new Map<string, string>();
async function loadUsers(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const avatars: Record<string, string> = {};
  try {
    let cursor = "";
    let pages = 0;
    do {
      const j = await slack("users.list", { limit: "200", ...(cursor ? { cursor } : {}) });
      for (const u of (j.members as any[]) || []) {
        const p = u.profile || {};
        const name = p.display_name || p.real_name || u.real_name || u.name || u.id;
        if (u.id && name) map.set(u.id, name);
        const img = p.image_192 || p.image_72 || p.image_48;
        if (name && img) avatars[name] = img; // 表示名→プロフィール画像
      }
      cursor = j.response_metadata?.next_cursor || "";
      pages++;
    } while (cursor && pages < 5);
    if (Object.keys(avatars).length) mergeAvatars(avatars);
  } catch {
    /* 取得失敗時はID表示にフォールバック */
  }
  return map;
}

type SlackMsg = {
  type?: string;
  subtype?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
};

async function slack(
  method: string,
  params: Record<string, string> = {}
): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const json = (await res.json()) as any;
  if (!json.ok) throw new Error(`Slack ${method}: ${json.error}`);
  return json;
}

// cursorページングで最新分をまとめて取得（暴走防止に最大5ページ）。
async function paged(
  method: string,
  params: Record<string, string>
): Promise<SlackMsg[]> {
  let cursor = "";
  let pages = 0;
  const out: SlackMsg[] = [];
  do {
    const j = await slack(method, { ...params, ...(cursor ? { cursor } : {}) });
    out.push(...((j.messages as SlackMsg[]) || []));
    cursor = j.response_metadata?.next_cursor || "";
    pages++;
  } while (cursor && pages < 5);
  return out;
}

// 実体のある人間メッセージか（join通知・bot(電話代行等)・システムは除外）。
function isReal(m: SlackMsg | undefined): boolean {
  return (
    !!m &&
    m.type === "message" &&
    !m.subtype &&
    !m.bot_id &&
    typeof m.text === "string" &&
    m.text.trim().length > 0
  );
}

// Slack記法をテキスト整形（メンション/リンクを読みやすく、機微ノイズを軽く落とす）。
function clean(text: string): string {
  return (text || "")
    .replace(/<@([UW][A-Z0-9]+)>/g, (_m, id) =>
      id === ME ? "@川崎" : "@" + (USERS.get(id) || "メンバー")
    )
    .replace(/<!channel>|<!here>/g, "@channel")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 1600);
}

function whenOf(ts: string): string {
  return new Date(Number(ts) * 1000).toISOString().slice(0, 16).replace("T", " ");
}
function who(m: SlackMsg): string {
  if (m.user === ME) return "川崎さん";
  return USERS.get(m.user || "") || m.user || m.username || "メンバー";
}
function threadOf(msgs: SlackMsg[]): string {
  return msgs
    .map((m) => `【${whenOf(m.ts)} ${who(m)}】\n${clean(m.text || "")}`)
    .join("\n\n---\n\n");
}
function titleOf(raw: string): string {
  // 生テキストからメンション(<@Uxxx>)・broadcast・リンク記法を確実に外し、最初の実質行を件名に。
  const stripped = (raw || "")
    .replace(/<@[UW][A-Z0-9]+>/g, "")
    .replace(/<!channel>|<!here>/g, "")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1");
  const line =
    stripped
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)[0] || "(無題)";
  const b = line.match(/【([^】]+)】/);
  return ((b ? b[1] : line).replace(/[*`>]/g, "").trim() || "(無題)").slice(0, 80);
}
// 正例に混ぜたくない機微（IP・パスワード値の平文）を含む発言は蓄積しない。
function looksSecret(t: string): boolean {
  return /\b(\d{1,3}\.){3}\d{1,3}\b/.test(t) || /pass(word)?\s*[:=]\s*\S/i.test(t);
}

async function main() {
  if (!TOKEN) {
    console.error("[slack] SLACK_BOT_TOKEN が未設定です（.env に Bot Token を設定）。");
    process.exit(1);
  }
  if (!CHANNELS.length) {
    console.error("[slack] SLACK_CHANNEL_IDS が未設定です（.env にカンマ区切りで対象chのID）。");
    process.exit(1);
  }
  if (!ME) {
    console.error("[slack] KAWASAKI_SLACK_USER_ID が未設定です（.env に本人のSlack user ID）。");
    process.exit(1);
  }
  const ready = ensureWritableForCli();
  if (!ready.ok) {
    console.error(`[slack] ${ready.msg}。中止します。`);
    process.exit(1);
  }

  USERS = await loadUsers();
  console.log(`[slack] ユーザー名 ${USERS.size} 件を取得`);

  const oldest = ((Date.now() - DAYS * 86400000) / 1000).toFixed(6);
  const existing = await listItems();
  let written = 0,
    updated = 0,
    closed = 0,
    reopened = 0,
    learned = 0;

  for (const ch of CHANNELS) {
    let msgs: SlackMsg[];
    try {
      msgs = await paged("conversations.history", { channel: ch, oldest, limit: "200" });
    } catch (e) {
      console.error(`[slack] ${ch} 履歴取得に失敗: ${(e as Error).message}`);
      continue;
    }
    // トップレベル（スレッド親 or 単発）だけを対象に（返信・ブロードキャストは親側で拾う）。
    const tops = msgs.filter((m) => !m.thread_ts || m.thread_ts === m.ts);

    for (const top of tops) {
      if (!isReal(top) && !(top.reply_count && top.reply_count > 0)) continue;

      // スレッド全体を時系列で取得
      let thread: SlackMsg[];
      if (top.reply_count && top.reply_count > 0) {
        try {
          thread = await paged("conversations.replies", {
            channel: ch,
            ts: top.thread_ts || top.ts,
            limit: "200",
          });
        } catch {
          thread = [top];
        }
      } else {
        thread = [top];
      }
      const real = thread.filter(isReal);
      if (!real.length) continue;

      // 「川崎さんが関与」＝本人が発言 or 本人宛メンションがある スレッドだけ扱う
      const involved = real.some(
        (m) => m.user === ME || (m.text || "").includes(`<@${ME}>`)
      );
      if (!involved) continue;

      // 本人発言を人格の正例として蓄積（機微・短文・URLのみは除外）
      for (let i = 0; i < real.length; i++) {
        const m = real[i];
        if (m.user !== ME) continue;
        const body = clean(m.text || "");
        if (body.length < 15 || /^https?:\/\/\S+$/.test(body) || looksSecret(m.text || ""))
          continue;
        const incoming = i > 0 ? clean(real[i - 1].text || "") : "";
        const rec = await appendReplyExample({
          messageId: `slack-${ch}-${m.ts}`,
          when: whenOf(m.ts),
          subject: `Slack ${titleOf(top.text || "")}`,
          audience: "internal",
          incoming,
          reply: body,
        });
        if (rec.recorded) learned++;
      }

      const last = real[real.length - 1];
      const lastId = last.ts;
      const key = `slack:${ch}:${top.thread_ts || top.ts}`;
      const id = `slack-${ch}-${(top.thread_ts || top.ts).replace(".", "-")}`;
      const gbReplied = last.user === ME; // 本人が最後＝対応済みの合図
      const threadSection = threadOf(real);
      const match = existing.find((it) => it.thread_key === key);

      if (match) {
        if (match.status === "pending" || match.status === "revision") {
          if (match.thread_last_id !== lastId) {
            await updateThread(match.id, threadSection, lastId);
            updated++;
          }
          if (gbReplied) {
            await updateStatus(match.id, "done"); // 本人が返した→承認待ちから消す
            closed++;
          }
        } else if (match.status === "done") {
          // 対応済みでも、他メンバー/相手から新着が来たら承認待ちへ復活
          if (match.thread_last_id !== lastId && !gbReplied) {
            await updateThread(match.id, threadSection, lastId);
            await updateStatus(match.id, "pending");
            reopened++;
          }
        }
        continue;
      }

      // 新規：本人が既に最後に返している（対応済み）なら作らない
      if (gbReplied) continue;

      const alltext = real.map((m) => m.text || "").join("\n");
      const maintenance = /保守|障害|サーバ|SSL|移行|ドメイン|メンテ|バックアップ/.test(alltext);
      const ciy = /CIY|シーアイワイ|ciy-biz|ciy-work|才能カルテ|適性検査/i.test(alltext);
      const type: ItemType = /バグ|不具合|エラー|改修|実装|コード|差分|デプロイ/.test(alltext)
        ? "code"
        : "reply";
      const body = `## 元メッセージ\n${threadSection}\n\n## ドラフト\n（AIが草案を作成予定）\n`;
      const tsNoDot = (top.thread_ts || top.ts).replace(".", "");
      const fm: ItemFrontmatter = {
        id,
        source: "slack",
        project: "未分類",
        audience: "internal", // Slackは社内チャンネル中心→社内文体で草案
        type,
        status: "pending",
        title: titleOf(top.text || ""),
        createdAt: new Date(Number(top.ts) * 1000).toISOString(),
        importance: HIGH_IMPORTANCE_KEYWORDS.some((k) => alltext.includes(k))
          ? "high"
          : "normal",
        assignee: routeAssignee(type, { maintenance, ciy }),
        source_ref: `https://${WORKSPACE}.slack.com/archives/${ch}/p${tsNoDot}`,
        thread_key: key,
        thread_last_id: lastId,
      };
      const r = await createItem(fm, body);
      if (r.ok) written++;
    }
  }

  console.log(
    `[slack] ${CHANNELS.length}ch → 新規 ${written} / スレッド更新 ${updated} / クローズ ${closed} / 再オープン ${reopened} / 正例 ${learned}`
  );
  recordSync("slack"); // 最終取り込み時刻を記録（画面表示用）
}

main().catch((e) => {
  console.error("[slack] エラー:", (e as Error).message);
  process.exit(1);
});
