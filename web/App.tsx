import { useEffect, useMemo, useState, useCallback, type ReactNode } from "react";
import { api, type ItemFull, type ReferenceMeta } from "./api.ts";
import {
  TYPE_LABELS,
  STATUS_LABELS,
  SOURCE_LABELS,
  AUDIENCE_LABELS,
  IMPORTANCE_LABELS,
  SOURCES,
  AUDIENCES,
  STATUSES,
  type ItemFrontmatter,
} from "../shared/roles.ts";
import { NewDraftModal } from "./NewDraftModal.tsx";

type Filters = {
  status: string;
  source: string;
  audience: string;
  assignee: string;
  project: string;
};

const EMPTY: Filters = {
  status: "pending",
  source: "",
  audience: "",
  assignee: "",
  project: "",
};

export function App() {
  const [items, setItems] = useState<ItemFrontmatter[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      // 「保留中(スルー中)」は擬似ステータス。サーバにはpendingで問い合わせ、クライアントで絞る。
      const snoozedView = filters.status === "snoozed";
      const serverStatus = snoozedView ? "pending" : filters.status;
      const { items } = await api.listItems({ ...filters, status: serverStatus });
      const now = Date.now();
      const isSnoozed = (it: ItemFrontmatter) =>
        !!it.snooze_until && Date.parse(it.snooze_until) > now;
      let list = items;
      if (snoozedView) list = items.filter(isSnoozed);
      else if (filters.status === "pending" || filters.status === "")
        list = items.filter((it) => !isSnoozed(it)); // 承認待ちからスルー中を隠す
      setItems(list);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filters]);

  useEffect(() => {
    reload();
  }, [reload]);

  // 自動更新: 5秒ごとに一覧を再取得（外部で追加された下書きがリロードなしで出る）
  useEffect(() => {
    const t = setInterval(() => reload(), 5000);
    return () => clearInterval(t);
  }, [reload]);

  // 未選択なら先頭を自動選択（詳細が空のままにしない）
  useEffect(() => {
    if (items.length === 0) return;
    if (!selectedId || !items.some((i) => i.id === selectedId)) {
      setSelectedId(items[0].id);
    }
  }, [items, selectedId]);

  const projects = useMemo(
    () => Array.from(new Set(items.map((i) => i.project))).sort(),
    [items]
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">🏢</span>
          <div>
            <h1>バーチャル制作会社</h1>
            <p className="sub">承認ダッシュボード — 社長は判断・承認だけ</p>
          </div>
        </div>
        <button className="btn primary" onClick={() => setShowNew(true)}>
          ＋ 新規下書き
        </button>
      </header>

      {error && <div className="banner error">⚠ {error}</div>}

      <FilterBar
        filters={filters}
        projects={projects}
        onChange={setFilters}
        count={items.length}
      />

      <div className="layout">
        <div className="left-col">
          <ItemList
            items={items}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          <ReferencePanel />
        </div>
        <DetailPanel
          id={selectedId}
          onChanged={reload}
          onClose={() => setSelectedId(null)}
        />
      </div>

      {showNew && (
        <NewDraftModal
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            setSelectedId(id);
            reload();
          }}
        />
      )}
    </div>
  );
}

function FilterBar({
  filters,
  projects,
  onChange,
  count,
}: {
  filters: Filters;
  projects: string[];
  onChange: (f: Filters) => void;
  count: number;
}) {
  const set = (k: keyof Filters, v: string) => onChange({ ...filters, [k]: v });
  return (
    <div className="filterbar">
      <Select
        label="状態"
        value={filters.status}
        onChange={(v) => set("status", v)}
        options={[
          ["", "すべて"],
          ...STATUSES.map((s) => [s, STATUS_LABELS[s]] as [string, string]),
          ["snoozed", "保留中（スルー中）"],
        ]}
      />
      <Select
        label="社内/社外"
        value={filters.audience}
        onChange={(v) => set("audience", v)}
        options={[["", "すべて"], ...AUDIENCES.map((a) => [a, AUDIENCE_LABELS[a]] as [string, string])]}
      />
      <Select
        label="入口"
        value={filters.source}
        onChange={(v) => set("source", v)}
        options={[["", "すべて"], ...SOURCES.map((s) => [s, SOURCE_LABELS[s]] as [string, string])]}
      />
      <Select
        label="案件"
        value={filters.project}
        onChange={(v) => set("project", v)}
        options={[["", "すべて"], ...projects.map((p) => [p, p] as [string, string])]}
      />
      <span className="count">{count}件</span>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function ItemList({
  items,
  selectedId,
  onSelect,
}: {
  items: ItemFrontmatter[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (items.length === 0)
    return (
      <div className="list empty">
        <p>該当する下書きはありません。</p>
        <p className="hint">
          「＋ 新規下書き」から登録するか、Claude Codeに「受信箱を処理して」と頼んでください。
        </p>
      </div>
    );
  return (
    <ul className="list">
      {items.map((it) => (
        <li
          key={it.id}
          className={`card src-${it.source} ${selectedId === it.id ? "sel" : ""}`}
          onClick={() => onSelect(it.id)}
        >
          <div className="card-top">
            <SourceBadge source={it.source} />
            <StatusBadge status={it.status} />
            {it.importance === "high" && <span className="badge high">重要</span>}
            <span className="badge audience">{AUDIENCE_LABELS[it.audience]}</span>
          </div>
          <div className="card-title">{it.title}</div>
          <div className="card-meta">
            <span>{it.project_label || it.project}</span>
            <span>·</span>
            <span className="type">{TYPE_LABELS[it.type]}</span>
            {it.due_on && (
              <>
                <span>·</span>
                <span className="due">期限 {it.due_on}</span>
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function StatusBadge({ status }: { status: ItemFrontmatter["status"] }) {
  return <span className={`badge status ${status}`}>{STATUS_LABELS[status]}</span>;
}

const SOURCE_ICONS: Record<string, string> = {
  slack: "💬",
  gmail: "✉️",
  asana: "📋",
  chatwork: "💭",
  teams: "👥",
  tokoton: "🔧",
  other: "📎",
};
function SourceBadge({ source }: { source: ItemFrontmatter["source"] }) {
  return (
    <span className={`badge src src-${source}`}>
      <span className="src-ico">{SOURCE_ICONS[source] ?? "📎"}</span>
      {SOURCE_LABELS[source]}
    </span>
  );
}

function ReferencePanel() {
  const [refs, setRefs] = useState<ReferenceMeta[]>([]);
  useEffect(() => {
    api.listReferences().then((r) => setRefs(r.references)).catch(() => {});
  }, []);
  if (refs.length === 0) return null;
  return (
    <div className="ref-panel">
      <h3>参照資料（外部が正・キャッシュ）</h3>
      <ul>
        {refs.map((r) => (
          <li key={r.slug} className="ref-item">
            <span className="ref-title">{r.title}</span>
            <span className="ref-kind">{r.kind}</span>
            {r.stale ? (
              <span className="ref-stale">⚠ 要確認{r.last_synced ? "" : "（未取得）"}</span>
            ) : (
              <span className="ref-fresh">最終取得: {r.last_synced?.slice(0, 10)}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- 本文（Markdown）をセクションに分けて整形表示 ---
const SECTION_META: { key: string; label: string; kind: string; icon: string }[] = [
  { key: "元メッセージ", label: "スレッド", kind: "incoming", icon: "🧵" },
  { key: "ドラフト", label: "こう返しては？", kind: "outgoing", icon: "✍️" },
  { key: "スレッド全文", label: "スレッド全文", kind: "thread", icon: "🧵" },
  { key: "状況分析", label: "AIの読み（補足・クリックで開く）", kind: "thread", icon: "🔎" },
  { key: "再考依頼", label: "再考依頼", kind: "note", icon: "↩" },
  { key: "却下理由", label: "却下理由", kind: "note", icon: "✕" },
  { key: "メモ", label: "メモ", kind: "note", icon: "📝" },
];

function metaFor(rawTitle: string) {
  const hit = SECTION_META.find((m) => rawTitle.startsWith(m.key));
  return hit ?? { label: rawTitle || "本文", kind: "plain", icon: "•" };
}

function parseSections(body: string): { rawTitle: string; content: string }[] {
  const out: { rawTitle: string; content: string }[] = [];
  let cur: { rawTitle: string; content: string } | null = null;
  for (const line of body.split("\n")) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      cur = { rawTitle: m[1].trim(), content: "" };
      out.push(cur);
    } else {
      if (!cur) {
        cur = { rawTitle: "", content: "" };
        out.push(cur);
      }
      cur.content += line + "\n";
    }
  }
  return out.filter((s) => s.rawTitle || s.content.trim());
}

function inlineMd(text: string): ReactNode {
  // **bold** のみ対応（安全のためHTMLは挿入しない）
  return text.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : p
  );
}

function SimpleMarkdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/).filter(Boolean);
  return (
    <div className="md">
      {blocks.map((blk, i) => {
        const lines = blk.split("\n").filter((l) => l.length > 0);
        if (lines.length && lines.every((l) => /^\s*[-*]\s+/.test(l)))
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inlineMd(l.replace(/^\s*[-*]\s+/, ""))}</li>
              ))}
            </ul>
          );
        if (lines.length && lines.every((l) => /^\s*\d+\.\s+/.test(l)))
          return (
            <ol key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inlineMd(l.replace(/^\s*\d+\.\s+/, ""))}</li>
              ))}
            </ol>
          );
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <span key={j}>
                {inlineMd(l)}
                {j < lines.length - 1 ? <br /> : null}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

// 入口の内容＝届いたスレッド。入口ごとに補足を変える。
function incomingLabel(source: ItemFrontmatter["source"]): string {
  if (source === "asana") return "スレッド（説明欄・コメント）";
  if (source === "gmail") return "スレッド（メール）";
  if (source === "slack") return "スレッド（Slack）";
  if (source === "chatwork") return "スレッド（チャットワーク）";
  if (source === "teams") return "スレッド（Teams）";
  if (source === "tokoton") return "スレッド（トコトン）";
  return "スレッド（届いた内容）";
}

// スレッド見出し「YYYY-MM-DD HH:MM 名前 <mail>」を分解。
function parseHeader(h: string): { when: string; name: string } {
  const m = h.match(/^(\d{4}-\d{2}-\d{2})\s+([\d:]+)?\s*(.+?)(?:\s*<[^>]*>)?\s*$/);
  const date = m?.[1] ? m[1].slice(5).replace("-", "/") : "";
  const time = m?.[2] ?? "";
  return { when: `${date} ${time}`.trim(), name: (m?.[3] ?? h).trim() };
}
function initials(name: string): string {
  const n = name.replace(/^（株）|株式会社|\/.*$/g, "").trim();
  return n.slice(0, 2);
}
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 45% 42%)`;
}

// スレッド（複数メッセージ）を、最新だけ展開・過去は1行に畳んで表示（Spark風）。
function ThreadView({ content }: { content: string }) {
  // メッセージ見出しは「日付始まりの【…】」だけ（本文中の【…】を誤分割しない）
  const parts = content.split(/^【(\d{4}-\d{2}-\d{2}[^】]*)】$/m);
  const lead = parts[0].trim();
  const msgs: { header: string; body: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    msgs.push({
      header: parts[i],
      body: (parts[i + 1] ?? "").replace(/^\s*---\s*$/gm, "").trim(),
    });
  }
  if (msgs.length === 0) return <SimpleMarkdown text={content} />;
  return (
    <div className="thread-view">
      {lead && <div className="thread-lead">{lead}</div>}
      {msgs.map((m, i) => {
        const { when, name } = parseHeader(m.header);
        const isLast = i === msgs.length - 1;
        const avatar = (
          <span className="tv-avatar" style={{ background: avatarColor(name) }}>
            {initials(name)}
          </span>
        );
        if (isLast)
          return (
            <div key={i} className="tv-msg open">
              <div className="tv-row">
                {avatar}
                <span className="tv-name">{name}</span>
                <span className="tv-when">{when}</span>
              </div>
              <div className="tv-body">
                <SimpleMarkdown text={m.body || "（本文なし）"} />
              </div>
            </div>
          );
        const preview = (m.body || "（本文なし）").replace(/\n+/g, " ").slice(0, 60);
        return (
          <details key={i} className="tv-msg">
            <summary className="tv-row">
              {avatar}
              <span className="tv-name">{name}</span>
              <span className="tv-preview">{preview}</span>
              <span className="tv-when">{when}</span>
            </summary>
            <div className="tv-body">
              <SimpleMarkdown text={m.body || "（本文なし）"} />
            </div>
          </details>
        );
      })}
    </div>
  );
}

function BodySections({
  body,
  source,
}: {
  body: string;
  source: ItemFrontmatter["source"];
}) {
  // 「状況分析（AIの読み）」は人間には不要なのでGUIでは非表示（ファイルには残る）
  const sections = parseSections(body).filter(
    (s) => !s.rawTitle.startsWith("状況分析")
  );
  return (
    <div className="sections">
      {sections.map((s, i) => {
        const meta = metaFor(s.rawTitle);
        const label = meta.kind === "incoming" ? incomingLabel(source) : meta.label;
        // スレッド全文は既定で折りたたむ（要約で速く読み、必要時に原文検証）
        if (meta.kind === "thread")
          return (
            <details key={i} className="section thread">
              <summary className="section-label">
                <span className="section-icon">{meta.icon}</span>
                {meta.label}
                <span className="section-sub">クリックで原文を展開</span>
              </summary>
              <SimpleMarkdown text={s.content} />
            </details>
          );
        return (
          <div key={i} className={`section ${meta.kind}`}>
            <div className="section-label">
              <span className="section-icon">{meta.icon}</span>
              {label}
            </div>
            {meta.kind === "incoming" ? (
              <ThreadView content={s.content} />
            ) : (
              <SimpleMarkdown text={s.content} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 「ドラフト」セクションのテキストだけ抜き出す（返信文コピー用）。無ければ null。 */
function draftText(body: string): string | null {
  const s = parseSections(body).find((x) => metaFor(x.rawTitle).kind === "outgoing");
  return s ? s.content.trim() : null;
}

function DetailPanel({
  id,
  onChanged,
  onClose,
}: {
  id: string | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [item, setItem] = useState<ItemFull | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // ボタン近くに出すインライン入力欄（却下理由 / 再考コメント / 学び候補 / スルー日付）
  const [panelMode, setPanelMode] = useState<
    "reject" | "learn" | "revision" | "snooze" | null
  >(null);
  const [inputText, setInputText] = useState("");

  const load = useCallback(async () => {
    if (!id) return setItem(null);
    const { item } = await api.getItem(id);
    setItem(item);
    setDraft(item.body);
    setEditing(false);
    setPanelMode(null);
    setInputText("");
  }, [id]);

  useEffect(() => {
    setMsg(null); // 別項目に切り替えたらメッセージを消す
    load();
  }, [load]);

  if (!id) return <div className="detail empty">左の一覧から選択してください。</div>;
  if (!item) return <div className="detail">読み込み中…</div>;

  const snoozed =
    !!item.snooze_until && Date.parse(item.snooze_until) > Date.now();

  // fn が文字列を返せばそれを、無ければ fallback をメッセージに（load後に表示して消えないように）
  const act = async (fn: () => Promise<string | void>, fallback: string) => {
    setBusy(true);
    try {
      const custom = await fn();
      await load();
      onChanged();
      setMsg(typeof custom === "string" ? custom : fallback);
    } catch (e) {
      setMsg("⚠ " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openPanel = (mode: "reject" | "learn" | "revision" | "snooze") => {
    const opening = panelMode !== mode;
    setPanelMode(opening ? mode : null);
    // スルーは日付入力。既定は30日後。
    if (opening && mode === "snooze") {
      const d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      setInputText(d.toISOString().slice(0, 10));
    } else {
      setInputText("");
    }
    setMsg(null);
  };
  const approve = () =>
    act(async () => {
      const r = await api.setStatus(item.id, "approved");
      if (r.applied?.applied) return `承認し、${r.applied.target} へ自動反映しました。`;
      if (r.applied?.msg) return `承認しました（反映スキップ: ${r.applied.msg}）。`;
      return "承認しました。送信は手動でお願いします。";
    }, "承認しました。");
  const confirmReject = () =>
    act(async () => {
      await api.setStatus(item.id, "rejected", inputText.trim());
    }, "却下しました。");
  const confirmRevision = () =>
    act(async () => {
      await api.setStatus(item.id, "revision", inputText.trim());
    }, "AIに再考を依頼しました（Claude Codeでの再生成待ち）。");
  const markDone = () =>
    act(async () => {
      await api.setStatus(item.id, "done");
    }, "対応不要（対応済み）にしました。※却下とは別扱い（草案の良し悪しは学習しません）。");
  const confirmSnooze = () =>
    act(async () => {
      await api.snooze(item.id, inputText);
    }, `スルーしました（${inputText} に承認待ちへ復活）。`);
  const unsnooze = () =>
    act(async () => {
      await api.snooze(item.id, null);
    }, "スルーを解除しました。");
  const revert = () =>
    act(async () => {
      await api.setStatus(item.id, "pending");
    }, "承認待ちへ差し戻しました。");
  const saveEdit = () =>
    act(async () => {
      await api.updateBody(item.id, draft);
    }, "本文を修正しました（旧版はバックアップ済み）。");
  const confirmLearn = () => {
    const cid = `${item.id}-learn-${Date.now()}`;
    act(async () => {
      await api.saveRuleCandidate(cid, `${item.title} からの学び`, inputText.trim());
    }, "学び候補を保存しました。");
  };
  const copyBody = async () => {
    const d = draftText(item.body);
    if (!d) {
      setMsg("⚠ ドラフト（返信文）のセクションが見つかりません。本文をご確認ください。");
      return;
    }
    await navigator.clipboard.writeText(d);
    setMsg("返信文（ドラフト）をコピーしました。");
  };

  return (
    <div className="detail">
      <div className="detail-head">
        <div className="badges">
          <SourceBadge source={item.source} />
          <StatusBadge status={item.status} />
          <span className="badge audience">{AUDIENCE_LABELS[item.audience]}</span>
          {item.importance && (
            <span className={`badge imp-${item.importance}`}>
              重要度: {IMPORTANCE_LABELS[item.importance]}
            </span>
          )}
        </div>
        <div className="head-actions">
          {item.source_ref && /^https?:\/\//i.test(item.source_ref) && (
            <a
              className="icon-btn source"
              href={item.source_ref}
              target="_blank"
              rel="noreferrer"
              title="元データを開く（原文で確認）"
            >
              🔗
            </a>
          )}
          <button className="btn ghost sm" onClick={onClose} title="閉じる">
            ✕
          </button>
        </div>
      </div>
      <h2 className="detail-title">{item.title}</h2>
      <div className="detail-meta">
        <Meta k="案件" v={item.project_label || item.project} />
        {item.due_on && <Meta k="期限" v={item.due_on} />}
      </div>


      {item.distill_uncertainty && (
        <div className="banner warn">
          ⚠ これは実データからの蒸留提案です。抽出に不確実性があります。内容を必ずご確認ください。
        </div>
      )}

      {(item.reviewed_by && item.reviewed_by !== "none") && (
        <div className="review-info">
          クロスチェック: {item.reviewed_by} / 結果: {item.review_status ?? "-"}
          {item.review_notes && <div className="review-notes">{item.review_notes}</div>}
        </div>
      )}

      <div className="body-section">
        <div className="body-head">
          <h3>やり取り</h3>
          {!editing ? (
            <div className="body-actions">
              <button className="btn ghost sm" onClick={copyBody}>
                返信文をコピー
              </button>
              <button className="btn ghost sm" onClick={() => setEditing(true)}>
                修正
              </button>
            </div>
          ) : (
            <div className="body-actions">
              <button className="btn sm" onClick={() => { setEditing(false); setDraft(item.body); }}>
                取消
              </button>
              <button className="btn primary sm" disabled={busy} onClick={saveEdit}>
                保存
              </button>
            </div>
          )}
        </div>
        {!editing ? (
          <BodySections body={item.body} source={item.source} />
        ) : (
          <>
            <p className="edit-hint">
              Markdownで編集できます（<code>## 元メッセージ</code> / <code>## ドラフト</code> の見出しで区切ると整形表示されます）。
            </p>
            <textarea
              className="body-edit"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </>
        )}
      </div>

      {msg && <div className="banner info">{msg}</div>}

      {item.status === "revision" && (
        <div className="banner warn">
          ↩ AIに再考を依頼済み。Claude Codeに「受信箱の再考ぶんを処理して」と頼むと、
          コメントを踏まえたv2が生成され「承認待ち」に戻ります。
        </div>
      )}

      {snoozed && (
        <div className="banner info">
          ⏰ スルー中（{item.snooze_until?.slice(0, 10)} に承認待ちへ自動復活）。
        </div>
      )}

      <div className="actions">
        {item.status === "pending" && (
          <>
            <button className="btn approve" disabled={busy} onClick={approve}>
              ✓ 承認
            </button>
            <button
              className={`btn revision ${panelMode === "revision" ? "on" : ""}`}
              disabled={busy}
              onClick={() => openPanel("revision")}
            >
              ↩ AIに再考させる
            </button>
            <button className="btn ghost" disabled={busy} onClick={markDone} title="返信不要・自分で対応済みなど。却下とは別で、草案の良し悪しは学習しません。">
              ✔ 対応不要
            </button>
            <button
              className={`btn reject ${panelMode === "reject" ? "on" : ""}`}
              disabled={busy}
              onClick={() => openPanel("reject")}
            >
              ✕ 却下
            </button>
            {snoozed ? (
              <button className="btn ghost" disabled={busy} onClick={unsnooze}>
                ⏰ スルー解除
              </button>
            ) : (
              <button
                className={`btn ghost ${panelMode === "snooze" ? "on" : ""}`}
                disabled={busy}
                onClick={() => openPanel("snooze")}
              >
                → スルー（後で）
              </button>
            )}
          </>
        )}
        {item.status !== "pending" && (
          <button className="btn ghost" disabled={busy} onClick={revert}>
            ↺ 承認待ちへ差し戻し
          </button>
        )}
        <button
          className={`btn ghost ${panelMode === "learn" ? "on" : ""}`}
          disabled={busy}
          onClick={() => openPanel("learn")}
        >
          ★ 学び候補として保存
        </button>
      </div>

      {panelMode === "reject" && (
        <div className="inline-panel reject">
          <label>却下理由（この下書きに記録され、記憶にも蓄積されます。任意）</label>
          <textarea
            autoFocus
            rows={3}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="例: トーンが固い。社内向けなのでもっと砕けてよい。"
          />
          <div className="inline-actions">
            <button className="btn ghost sm" onClick={() => setPanelMode(null)}>
              取消
            </button>
            <button className="btn reject sm" disabled={busy} onClick={confirmReject}>
              却下を確定
            </button>
          </div>
        </div>
      )}

      {panelMode === "snooze" && (
        <div className="inline-panel snooze">
          <label>いつまでスルーする？（この日に承認待ちへ自動復活します）</label>
          <input
            type="date"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
          />
          <div className="inline-actions">
            <button className="btn ghost sm" onClick={() => setPanelMode(null)}>
              取消
            </button>
            <button
              className="btn sm"
              disabled={busy || !inputText}
              onClick={confirmSnooze}
            >
              この日まで流す
            </button>
          </div>
        </div>
      )}

      {panelMode === "revision" && (
        <div className="inline-panel revision">
          <label>
            AIへの再考コメント（元メッセージ＋記憶＋文脈と併せてv2を生成します）
          </label>
          <textarea
            autoFocus
            rows={3}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="例: もっと簡潔に。見積の話は今回は触れずに。締切だけ確認して。"
          />
          <div className="inline-actions">
            <button className="btn ghost sm" onClick={() => setPanelMode(null)}>
              取消
            </button>
            <button
              className="btn revision sm"
              disabled={busy || !inputText.trim()}
              onClick={confirmRevision}
            >
              再考を依頼
            </button>
          </div>
        </div>
      )}

      {panelMode === "learn" && (
        <div className="inline-panel learn">
          <label>今後ずっと守りたい学び（Obsidianで恒久ルールへ昇格できます）</label>
          <textarea
            autoFocus
            rows={3}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="例: この案件は必ず『当日中に一次返信』と添える。"
          />
          <div className="inline-actions">
            <button className="btn ghost sm" onClick={() => setPanelMode(null)}>
              取消
            </button>
            <button
              className="btn primary sm"
              disabled={busy || !inputText.trim()}
              onClick={confirmLearn}
            >
              学び候補を保存
            </button>
          </div>
        </div>
      )}

      <p className="foot-note">
        承認しても自動送信はしません。実際の送信・実行は社長ご自身が各ツールで行ってください。
      </p>
    </div>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="meta-item">
      <span className="meta-k">{k}</span>
      <span className="meta-v">{v}</span>
    </div>
  );
}
