import { ensureWritableForCli, recordSync, mergeAvatars } from "./vault.ts"; // .env読込＋安全検査
import {
  createItem,
  listItems,
  updateStatus,
  updateThread,
  appendReplyExample,
  appendDraftVsSent,
  readItem,
  extractDraft,
} from "./items.ts";
import {
  routeAssignee,
  HIGH_IMPORTANCE_KEYWORDS,
  type ItemType,
  type ItemFrontmatter,
} from "../shared/roles.ts";
import { saveFromUrl, attachBlock, detailOf, type AttachMeta } from "./attachments.ts";
import { matchClientLabel } from "./clients.ts";

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

// Slackの添付ファイル（conversations.history/replies が messages[].files で返す）。
// 実体のダウンロードは url_private_download に Bearer トークンを付けて取得する。
type SlackFile = {
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
  mode?: string; // "hosted"=通常ファイル。"tombstone"(削除済)等は落とせない
};

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
  latest_reply?: string; // スレッド最新返信のts（差分判定に使う）
  files?: SlackFile[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function slack(
  method: string,
  params: Record<string, string> = {}
): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  // 429/ratelimited は Retry-After に従って待機・再試行（最大4回）。
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${BASE}/${method}?${qs}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") || "2");
      await sleep((wait + 1) * 1000);
      continue;
    }
    const json = (await res.json()) as any;
    if (!json.ok) {
      if (json.error === "ratelimited") {
        await sleep(3000);
        continue;
      }
      throw new Error(`Slack ${method}: ${json.error}`);
    }
    return json;
  }
  throw new Error(`Slack ${method}: レート制限で再試行上限に達しました`);
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

// 実際に落とせる添付があるか（削除済み tombstone やURLの無いものは除外）。
function hasFiles(m: SlackMsg | undefined): boolean {
  return !!m?.files?.some(
    (f) => f && f.mode !== "tombstone" && !!(f.url_private_download || f.url_private)
  );
}

// 実体のある人間メッセージか（join通知・bot(電話代行等)・システムは除外）。
// 文章が空でも「添付だけの投稿」（画像で修正指示が来るケース）は拾う。
// ファイル添付は subtype="file_share" が付くことがあるため、その場合だけは許可する。
function isReal(m: SlackMsg | undefined): boolean {
  if (!m || m.type !== "message" || m.bot_id) return false;
  if (m.subtype && m.subtype !== "file_share") return false;
  const hasText = typeof m.text === "string" && m.text.trim().length > 0;
  return hasText || hasFiles(m);
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
/**
 * メッセージの添付を実ファイル保存し、本文用のメタ配列を返す。
 * 素材（画像/Excel等）が来ているかは打ち返し判定の段階1の根拠。
 * Slackのファイルは url_private_download に Bearer トークンを付けて取得する。
 * 取得/保存に失敗しても、名前・種類・サイズのメタは本文に残す。
 */
async function saveFiles(itemId: string, files?: SlackFile[]): Promise<AttachMeta[]> {
  const metas: AttachMeta[] = [];
  for (const f of files || []) {
    if (f.mode === "tombstone") continue; // 削除済みは落とせない
    const name = f.name || f.title || "(名前なし)";
    const meta: AttachMeta = { name, type: f.mimetype || f.filetype || "?", size: f.size || 0 };
    const url = f.url_private_download || f.url_private;
    if (url) meta.rel = await saveFromUrl(itemId, name, url, { Authorization: `Bearer ${TOKEN}` });
    // Excelは中身（文字＋貼り込み画像）までほどく。修正指示は画像にあることが多いため。
    if (meta.rel) meta.detail = await detailOf(itemId, name);
    metas.push(meta);
  }
  return metas;
}

// スレッド本文を組み立てる。各メッセージの添付は itemId 配下に保存し、本文にパスを併記する
// （AIがそのパスを開いて画像そのものを確認できるようにするため）。
async function threadOf(msgs: SlackMsg[], itemId: string): Promise<string> {
  const parts: string[] = [];
  for (const m of msgs) {
    const metas = await saveFiles(itemId, m.files);
    parts.push(`【${whenOf(m.ts)} ${who(m)}】\n${clean(m.text || "") || "（本文なし）"}${attachBlock(metas)}`);
  }
  return parts.join("\n\n---\n\n");
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
// 正例に混ぜたくない機微を含む発言は蓄積しない（IP・トークン・メール・電話・コード・機密URL等）。
function looksSecret(t: string): boolean {
  return (
    /\b(\d{1,3}\.){3}\d{1,3}\b/.test(t) || // IPアドレス
    /pass(word)?\s*[:=]\s*\S/i.test(t) || // password= 値
    /\b(xox[baprs]-|sk-|ghp_|gho_|AKIA|ASIA)[A-Za-z0-9._-]{6,}/.test(t) || // APIキー/トークン
    /Bearer\s+[A-Za-z0-9._-]{8,}/.test(t) || // Bearerトークン
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(t) || // メールアドレス（PII）
    /0\d{1,3}[-(]\d{1,4}[-)]\d{3,4}/.test(t) || // 電話番号
    /```/.test(t) || // コードブロック（技術ログ・秘匿設定が混入しやすい）
    /files\.slack\.com|slack-files\.com|drive\.google\.com|docs\.google\.com/.test(t) // ファイル/機密URL
  );
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
    learned = 0,
    diffed = 0;
  let hadError = false;
  const processedKeys = new Set<string>(); // 今回のhistoryで確認したスレッドのthread_key
  const failedChannels = new Set<string>(); // 履歴取得に失敗したch（追従ループでも今回はskip）

  for (const ch of CHANNELS) {
    let msgs: SlackMsg[];
    try {
      msgs = await paged("conversations.history", { channel: ch, oldest, limit: "200" });
    } catch (e) {
      console.error(`[slack] ${ch} 履歴取得に失敗: ${(e as Error).message}`);
      hadError = true;
      failedChannels.add(ch);
      continue;
    }
    // トップレベル（スレッド親 or 単発）だけを対象に（返信・ブロードキャストは親側で拾う）。
    const tops = msgs.filter((m) => !m.thread_ts || m.thread_ts === m.ts);

    for (const top of tops) {
      if (!isReal(top) && !(top.reply_count && top.reply_count > 0)) continue;

      const threadTs = top.thread_ts || top.ts;
      const key = `slack:${ch}:${threadTs}`;
      processedKeys.add(key);
      const match = existing.find((it) => it.thread_key === key);
      // 差分最適化: 既存カードがあり、スレッド最新ts(latest_reply)が記録済みと一致するなら再取得しない。
      // ただし返信ありなのに latest_reply が無い(取りこぼし)場合は skip せず replies を取りに行く。
      const latest = top.latest_reply || threadTs;
      const canSkip = !(top.reply_count && top.reply_count > 0 && !top.latest_reply);
      if (match && canSkip && match.thread_last_id === latest && match.status !== "done")
        continue;

      // スレッド全体を時系列で取得（返信取得に失敗したスレッドは skip＝返信済みを未返信化しない）
      let thread: SlackMsg[];
      if (top.reply_count && top.reply_count > 0) {
        try {
          thread = await paged("conversations.replies", {
            channel: ch,
            ts: threadTs,
            limit: "200",
          });
        } catch (e) {
          console.error(`[slack] ${ch} スレッド取得失敗(skip): ${(e as Error).message}`);
          hadError = true;
          continue;
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
      const id = `slack-${ch}-${threadTs.replace(".", "-")}`;
      const gbReplied = last.user === ME; // 本人が最後＝対応済みの合図
      // 添付は保存先IDが要る。既存カードがあればそのID、無ければ新規IDの配下へ保存する。
      const threadSection = await threadOf(real, match ? match.id : id);

      if (match) {
        if (match.status === "pending" || match.status === "revision") {
          if (match.thread_last_id !== lastId) {
            await updateThread(match.id, threadSection, lastId);
            updated++;
          }
          if (gbReplied) {
            // 【食い違い学習】カードにAIの草案が付いていたら、その草案と本人が実際に
            // 打ち返した最後の発言を突き合わせて _memory/draft-vs-sent.md に残す。
            // ＝草案を無視して別の解釈/言い回しで返したケースをメールと同じ形で学ぶ。
            const full = await readItem(match.id);
            const draft = full ? extractDraft(full.body) : "";
            if (draft && !draft.includes("AIが草案を作成予定")) {
              const prevIn = [...real.slice(0, real.length - 1)]
                .reverse()
                .find((m) => m.user !== ME);
              const d = await appendDraftVsSent({
                messageId: `slack-${ch}-${last.ts}`,
                when: whenOf(last.ts),
                subject: `Slack ${titleOf(top.text || "")}`,
                cardId: match.id,
                project: match.project,
                audience: match.audience,
                incoming: prevIn ? clean(prevIn.text || "") : "",
                draft,
                sent: clean(last.text || ""),
              });
              if (d.recorded) diffed++;
            }
            await updateStatus(match.id, "done"); // 本人が返した→承認待ちから消す
            closed++;
          }
        } else if (match.status === "done") {
          // 対応済みでも、他メンバー/相手から新着が来たら承認待ちへ復活（古い草案は破棄して作り直させる）
          if (match.thread_last_id !== lastId && !gbReplied) {
            await updateThread(match.id, threadSection, lastId, true);
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
      const tsNoDot = threadTs.replace(".", "");
      // スレッド本文に相手のドメイン/URLが出ていればクライアント名を照合。
      const clientLabel = matchClientLabel({ text: threadSection });
      const fm: ItemFrontmatter = {
        id,
        source: "slack",
        project: "未分類",
        project_label: clientLabel || undefined,
        audience: "internal", // Slackは社内チャンネル中心→社内文体で草案
        type,
        status: "pending",
        // 画像だけの投稿（文章なし）は件名が空になるので、添付ファイル名を件名に使う。
        title: titleOf(top.text || "") === "(無題)" && top.files?.[0]
          ? `📎 ${(top.files[0].name || top.files[0].title || "添付ファイル").slice(0, 78)}`
          : titleOf(top.text || ""),
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

  // 履歴(直近7日)に親が出ない古いスレッドでも、既存の未対応Slackカードは直接再確認して追従する。
  for (const it of existing) {
    if (it.source !== "slack") continue;
    if (it.status !== "pending" && it.status !== "revision") continue;
    if (!it.thread_key || processedKeys.has(it.thread_key)) continue;
    const mm = it.thread_key.match(/^slack:([^:]+):(.+)$/);
    if (!mm) continue;
    if (failedChannels.has(mm[1])) continue; // 履歴取得に失敗したchは今回追従しない（429増幅回避）
    let thr: SlackMsg[];
    try {
      thr = await paged("conversations.replies", { channel: mm[1], ts: mm[2], limit: "200" });
    } catch {
      hadError = true;
      continue;
    }
    const real2 = thr.filter(isReal);
    if (!real2.length) continue;
    const last2 = real2[real2.length - 1];
    if (it.thread_last_id === last2.ts) continue;
    await updateThread(it.id, await threadOf(real2, it.id), last2.ts);
    updated++;
    if (last2.user === ME) {
      await updateStatus(it.id, "done");
      closed++;
    }
  }

  console.log(
    `[slack] ${CHANNELS.length}ch → 新規 ${written} / スレッド更新 ${updated} / クローズ ${closed} / 再オープン ${reopened} / 正例 ${learned} / 食い違い ${diffed}`
  );
  if (hadError)
    console.warn("[slack] 一部の取得に失敗しました（次回巡回で再取得されます）。");
  recordSync("slack"); // 最終取り込み(試行)時刻を記録（画面表示用）
}

main().catch((e) => {
  console.error("[slack] エラー:", (e as Error).message);
  process.exit(1);
});
