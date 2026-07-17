import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  createContext,
  useContext,
  type ReactNode,
} from "react";
import { api, type ItemFull, type ReferenceMeta, type ProjectMeta } from "./api.ts";

// メンバー表示名→プロフィール画像URL。スレッドのアバター表示に使う（無ければ色付きイニシャル）。
const AvatarContext = createContext<Record<string, string>>({});
import {
  TYPE_LABELS,
  STATUS_LABELS,
  SOURCE_LABELS,
  AUDIENCE_LABELS,
  SOURCES,
  AUDIENCES,
  STATUSES,
  type ItemFrontmatter,
  type Ask,
} from "../shared/roles.ts";
import { NewDraftModal } from "./NewDraftModal.tsx";

type Filters = {
  status: string;
  source: string;
  audience: string;
  assignee: string;
  project: string;
  q: string;
};

const EMPTY: Filters = {
  status: "pending",
  source: "",
  audience: "",
  assignee: "",
  project: "",
  q: "",
};

export function App() {
  const [items, setItems] = useState<ItemFrontmatter[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"dashboard" | "office" | "knowledge">("office");
  const [avatars, setAvatars] = useState<Record<string, string>>({});

  // メンバーのプロフィール画像を一度だけ取得（スレッドのアバター表示用）
  useEffect(() => {
    api
      .avatars()
      .then((r) => setAvatars(r.avatars))
      .catch(() => {});
  }, []);

  // メインエリア（一覧）のスクロール枠。初期表示は最下部にしたい。
  const leftColRef = useRef<HTMLDivElement>(null);
  const didInitialScrollRef = useRef(false);

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

  // アプリ更新の自動反映：サーバ起動ID(bootId)を監視し、変わったら自動でページを再読み込み。
  // これでコード更新後に手動リロード(⌘R)しなくても新機能が反映される。
  // ただし入力中（テキスト欄にフォーカス）は中断させないよう次回まで待つ。
  useEffect(() => {
    let boot: string | null = null;
    const check = async () => {
      try {
        const h = await api.health();
        if (!h.bootId) return;
        if (boot === null) boot = h.bootId;
        else if (boot !== h.bootId) {
          const el = document.activeElement;
          const typing =
            !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
          if (!typing) window.location.reload();
        }
      } catch {
        /* サーバ再起動中などの一時的失敗は無視 */
      }
    };
    check();
    const t = setInterval(check, 15000);
    return () => clearInterval(t);
  }, []);

  // 自動更新: 5秒ごとに一覧を再取得（ダッシュボード表示中のみ。
  // オフィス表示中は OfficeView が自前でポーリングするため二重取得を避ける）
  useEffect(() => {
    if (view !== "dashboard") return;
    const t = setInterval(() => reload(), 5000);
    return () => clearInterval(t);
  }, [reload, view]);

  // ダッシュボードを離れたら、次に入ったとき再び最下部へ寄せるためリセット
  useEffect(() => {
    if (view !== "dashboard") didInitialScrollRef.current = false;
  }, [view]);

  // ダッシュボード表示で一覧が読み込まれたら、初回だけ最下部へスクロール（自動更新のたびには動かさない）
  useEffect(() => {
    if (view !== "dashboard" || didInitialScrollRef.current || items.length === 0)
      return;
    const el = leftColRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      didInitialScrollRef.current = true;
    }
  }, [items, view]);

  // 初期未選択のときだけ先頭を自動選択（明示選択は上書きしない＝オフィスから開いた項目を保持）
  useEffect(() => {
    if (view === "dashboard" && !selectedId && items.length > 0) {
      setSelectedId(items[0].id);
    }
  }, [items, selectedId, view]);

  const projects = useMemo(
    () => Array.from(new Set(items.map((i) => i.project))).sort(),
    [items]
  );

  return (
    <AvatarContext.Provider value={avatars}>
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">🏢</span>
          <div>
            <h1>バーチャル制作会社</h1>
            <p className="sub">承認ダッシュボード — 社長は判断・承認だけ</p>
          </div>
        </div>
        <div className="topbar-actions">
          <SyncStatus />
          <div className="view-toggle">
            <button
              className={view === "dashboard" ? "on" : ""}
              onClick={() => setView("dashboard")}
            >
              📋 ダッシュボード
            </button>
            <button
              className={view === "office" ? "on" : ""}
              onClick={() => setView("office")}
            >
              🏢 オフィス
            </button>
            <button
              className={view === "knowledge" ? "on" : ""}
              onClick={() => setView("knowledge")}
            >
              📚 ナレッジ
            </button>
          </div>
          <button className="btn ghost" onClick={() => setShowRules(true)}>
            ⚙ ルール
          </button>
          <button className="btn primary" onClick={() => setShowNew(true)}>
            ＋ 新規下書き
          </button>
        </div>
      </header>

      {error && <div className="banner error">⚠ {error}</div>}

      {view === "knowledge" ? (
        <KnowledgeView />
      ) : view === "office" ? (
        <OfficeView
          onOpenItem={(id) => {
            setSelectedId(id);
            setView("dashboard");
            reload(); // 親リストを最新化（オフィス中は親ポーリングが止まっているため）
          }}
        />
      ) : (
        <>
          <FilterBar
            filters={filters}
            projects={projects}
            onChange={setFilters}
            count={items.length}
          />
          <div className="layout">
            <div className="left-col" ref={leftColRef}>
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
        </>
      )}

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

      {showRules && <RulesModal onClose={() => setShowRules(false)} />}
    </div>
    </AvatarContext.Provider>
  );
}

// ============================================================
// ナレッジビュー：まとめた全体ルール（70_references）とクライアント別コンテキスト（20_projects）を閲覧。
// 読み取り専用。編集・送信はしない。
// ============================================================

// --- 軽量Markdownレンダラ（依存ライブラリなし。見出し/表/リスト/太字/コード/[[link]]/リンク対応） ---
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function mdInline(s: string): string {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">$1</span>');
  t = t.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
  );
  return t;
}
function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  // frontmatter を飛ばす
  if (lines[0] === "---") {
    let j = 1;
    while (j < lines.length && lines[j] !== "---") j++;
    i = j + 1;
  }
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    // 表（次行が区切り行）
    if (
      /^\s*\|.*\|\s*$/.test(line) &&
      i + 1 < lines.length &&
      lines[i + 1].includes("|") &&
      /^\s*\|?[\s:|-]*-{2,}[\s:|-]*$/.test(lines[i + 1])
    ) {
      closeList();
      const header = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
        i++;
      }
      i--;
      let html =
        "<table><thead><tr>" +
        header.map((c) => `<th>${mdInline(c)}</th>`).join("") +
        "</tr></thead><tbody>";
      for (const r of rows)
        html += "<tr>" + r.map((c) => `<td>${mdInline(c)}</td>`).join("") + "</tr>";
      html += "</tbody></table>";
      out.push(html);
      continue;
    }
    const hm = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (hm) {
      closeList();
      const lvl = hm[1].length;
      out.push(`<h${lvl}>${mdInline(hm[2])}</h${lvl}>`);
      continue;
    }
    if (/^\s*---\s*$/.test(line)) {
      closeList();
      out.push("<hr/>");
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${mdInline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${mdInline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      closeList();
      out.push(`<blockquote>${mdInline(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      continue;
    }
    if (line.trim() === "") {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${mdInline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}
function Markdown({ text }: { text: string }) {
  const html = useMemo(() => mdToHtml(text), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function KnowledgeView() {
  const [tab, setTab] = useState<"rules" | "clients">("rules");
  const [refs, setRefs] = useState<ReferenceMeta[]>([]);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [sel, setSel] = useState<{ id: string; title: string } | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    api.listReferences().then((r) => setRefs(r.references)).catch(() => {});
    api.listProjects().then((r) => setProjects(r.projects)).catch(() => {});
  }, []);

  // 重要な全体ルールを上に並べる
  const KEY = [
    "maintenance-judgment",
    "asana-maintenance-precedents",
    "maintenance-guide",
    "maintenance-clients",
  ];
  const sortedRefs = useMemo(() => {
    return [...refs].sort((a, b) => {
      const ia = KEY.indexOf(a.slug);
      const ib = KEY.indexOf(b.slug);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return String(a.title).localeCompare(String(b.title), "ja");
    });
  }, [refs]);

  const openRef = useCallback(async (r: ReferenceMeta) => {
    setSel({ id: r.slug, title: String(r.title) });
    setLoading(true);
    try {
      const d = await api.getReference(r.slug);
      let text = d.pointer;
      if (d.cache?.length)
        text += "\n\n" + d.cache.map((c) => `---\n\n${c.content}`).join("\n\n");
      setContent(text);
    } catch (e) {
      setContent("読み込みに失敗しました: " + (e as Error).message);
    }
    setLoading(false);
  }, []);

  const openProject = useCallback(async (p: ProjectMeta) => {
    setSel({ id: p.slug, title: p.title });
    setLoading(true);
    try {
      const d = await api.getContext([p.ref]);
      const c = d.contexts[0];
      setContent(c?.content ?? "読めません: " + (c?.error || ""));
    } catch (e) {
      setContent("読み込みに失敗しました: " + (e as Error).message);
    }
    setLoading(false);
  }, []);

  // タブ切替時・初期ロード時、未選択なら先頭を自動で開く
  useEffect(() => {
    if (sel) return;
    if (tab === "rules" && sortedRefs.length) openRef(sortedRefs[0]);
    else if (tab === "clients" && projects.length) openProject(projects[0]);
  }, [tab, sortedRefs, projects, sel, openRef, openProject]);

  const filteredProjects = useMemo(
    () =>
      projects.filter(
        (p) =>
          !q ||
          p.title.includes(q) ||
          p.slug.includes(q) ||
          (p.domain || "").includes(q)
      ),
    [projects, q]
  );

  return (
    <div className="knowledge">
      <aside className="kn-sidebar">
        <div className="kn-tabs">
          <button
            className={tab === "rules" ? "on" : ""}
            onClick={() => {
              setTab("rules");
              setSel(null);
            }}
          >
            📖 全体ルール
          </button>
          <button
            className={tab === "clients" ? "on" : ""}
            onClick={() => {
              setTab("clients");
              setSel(null);
            }}
          >
            🏢 クライアント
          </button>
        </div>
        {tab === "clients" && (
          <input
            className="kn-search"
            placeholder="クライアント検索…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        )}
        <div className="kn-list">
          {tab === "rules"
            ? sortedRefs.map((r) => (
                <button
                  key={r.slug}
                  className={"kn-item" + (sel?.id === r.slug ? " on" : "")}
                  onClick={() => openRef(r)}
                >
                  <span className="kn-item-title">{String(r.title)}</span>
                  <span className="kn-item-sub">
                    {r.slug}
                    {r.stale ? " ・要更新" : ""}
                  </span>
                </button>
              ))
            : filteredProjects.map((p) => (
                <button
                  key={p.slug}
                  className={"kn-item" + (sel?.id === p.slug ? " on" : "")}
                  onClick={() => openProject(p)}
                >
                  <span className="kn-item-title">{p.title}</span>
                  <span className="kn-item-sub">
                    {p.domain || p.slug}
                    {p.hasPrecedents ? " ・実績" : ""}
                    {p.hasStack ? " ・技術" : ""}
                  </span>
                </button>
              ))}
          {tab === "clients" && filteredProjects.length === 0 && (
            <div className="kn-empty-sm">該当なし</div>
          )}
        </div>
        <div className="kn-count">
          {tab === "rules"
            ? `ルール ${sortedRefs.length}件`
            : `クライアント ${filteredProjects.length}/${projects.length}件`}
        </div>
      </aside>
      <div className="kn-content">
        {loading ? (
          <div className="kn-empty">読み込み中…</div>
        ) : sel ? (
          <>
            <div className="kn-content-head">
              <h2 className="kn-title">{sel.title}</h2>
              <span className="kn-readonly">閲覧のみ</span>
            </div>
            <Markdown text={content} />
          </>
        ) : (
          <div className="kn-empty">左の一覧から選んでください。</div>
        )}
      </div>
    </div>
  );
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "たった今";
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}

// 各取り込みツールの「最終取り込み時刻」をヘッダに表示（1分ごとに更新）。
function SyncStatus() {
  const [status, setStatus] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .syncStatus()
        .then((r) => alive && setStatus(r.status))
        .catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const defs: [string, string][] = [
    ["mail", "メール"],
    ["asana", "Asana"],
    ["slack", "Slack"],
    ["references", "参照"],
  ];
  const shown = defs.filter(([k]) => status[k]);
  if (shown.length === 0) return null;
  return (
    <div className="sync-status" title="各ツールの最終取り込み時刻">
      {shown.map(([k, label]) => (
        <span key={k} className="sync-item">
          <span className="sync-dot" />
          {label} {relTime(status[k])}
        </span>
      ))}
    </div>
  );
}

// 全体ルール（共通ルール）をダッシュボードから追加するモーダル。
function RulesModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [ignore, setIgnore] = useState("");
  const [rulesText, setRulesText] = useState("");
  const [ignoreList, setIgnoreList] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.getRules();
      setRulesText(r.text);
      setIgnoreList(r.ignore);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    if (!text.trim() && !ignore.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.addRule(text.trim(), ignore.trim());
      setRulesText(r.text);
      setIgnoreList(r.ignore);
      setText("");
      setIgnore("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal rules-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>⚙ 全体ルール</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="hint">
          全役割のAIが草案づくりで従う共通ルールです。ここで足すと、以降の草案に反映されます。
        </p>

        <label className="field block">
          <span>ルールを追加（例：外部への返信では絵文字を使わない）</span>
          <textarea
            rows={2}
            value={text}
            placeholder="AIに守ってほしいことを一言で"
            onChange={(e) => setText(e.target.value)}
          />
        </label>

        <label className="field block">
          <span>取り込まないメールのキーワード（例：WordPress 更新）</span>
          <input
            type="text"
            value={ignore}
            placeholder="件名や送信元にこの語を含むメールはカード化しません"
            onChange={(e) => setIgnore(e.target.value)}
          />
        </label>

        {err && <div className="banner error">⚠ {err}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            閉じる
          </button>
          <button
            className="btn primary"
            disabled={busy || (!text.trim() && !ignore.trim())}
            onClick={submit}
          >
            {busy ? "追加中…" : "追加する"}
          </button>
        </div>

        {ignoreList.length > 0 && (
          <div className="rules-ignore">
            <div className="rules-sub">現在の「取り込まない」キーワード</div>
            <div className="chips">
              {ignoreList.map((k) => (
                <span key={k} className="chip">
                  {k}
                </span>
              ))}
            </div>
          </div>
        )}

        <details className="rules-current">
          <summary>いまの全体ルールを見る</summary>
          <pre className="rules-pre">{rulesText || "（読み込み中…）"}</pre>
        </details>
      </div>
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
      <label className="field search-field">
        <span>検索</span>
        <input
          type="search"
          className="search-input"
          value={filters.q}
          placeholder="案件名・件名・本文でさがす"
          onChange={(e) => set("q", e.target.value)}
        />
      </label>
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
            {it.thread_updated && <span className="badge newmsg">🔄 新着</span>}
            {(it.asks || []).some((a) => a && a.question && !a.resolved) && (
              <span className="badge askbadge">🙋 確認</span>
            )}
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
// 実ブランドロゴ（公式SVG）。Slack/Asana/Gmail はロゴ、他は絵文字にフォールバック。
function SourceIcon({ source }: { source: string }) {
  if (source === "slack")
    return (
      <svg className="src-ico" viewBox="0 0 122.8 122.8" aria-hidden="true">
        <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9z" fill="#E01E5A" />
        <path d="M32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A" />
        <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2z" fill="#36C5F0" />
        <path d="M45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0" />
        <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2z" fill="#2EB67D" />
        <path d="M90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D" />
        <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9z" fill="#ECB22E" />
        <path d="M77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E" />
      </svg>
    );
  if (source === "asana")
    return (
      <svg className="src-ico" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="6.4" r="3.3" fill="#F06A6A" />
        <circle cx="6.1" cy="15.6" r="3.3" fill="#F06A6A" />
        <circle cx="17.9" cy="15.6" r="3.3" fill="#F06A6A" />
      </svg>
    );
  if (source === "gmail")
    return (
      <svg className="src-ico" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#4caf50" d="M45,16.2l-5,2.75l-5,4.75L35,40h7c1.657,0,3-1.343,3-3V16.2z" />
        <path fill="#1e88e5" d="M3,16.2l3.614,1.71L13,23.7V40H6c-1.657,0-3-1.343-3-3V16.2z" />
        <polygon fill="#e53935" points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17" />
        <path fill="#c62828" d="M3,12.298V16.2l10,7.5V11.2L9.876,8.859C9.132,8.301,8.228,8,7.298,8h0C4.924,8,3,9.924,3,12.298z" />
        <path fill="#fbc02d" d="M45,12.298V16.2l-10,7.5V11.2l3.124-2.341C38.868,8.301,39.772,8,40.702,8h0C43.076,8,45,9.924,45,12.298z" />
      </svg>
    );
  return <span className="src-ico">{SOURCE_ICONS[source] ?? "📎"}</span>;
}
function SourceBadge({ source }: { source: ItemFrontmatter["source"] }) {
  return (
    <span className={`badge src src-${source}`}>
      <SourceIcon source={source} />
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

// HTMLエンティティ（&gt; &amp; 数値参照など）を実文字へ
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", copy: "©", reg: "®", trade: "™",
  laquo: "«", raquo: "»", middot: "・", bull: "•",
};
function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1] === "x" || code[1] === "X"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}
// Slack/Asana等の :emoji: ショートコードを実絵文字へ（よく使うものを収録）
const EMOJI_SHORTCODES: Record<string, string> = {
  pray: "🙏", bow: "🙇", folded_hands: "🙏", tada: "🎉", confetti_ball: "🎊",
  "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎", ok_hand: "👌",
  clap: "👏", muscle: "💪", fire: "🔥", eyes: "👀", heart: "❤️", broken_heart: "💔",
  smile: "😄", smiley: "😃", grinning: "😀", grin: "😁", laughing: "😆", joy: "😂",
  rofl: "🤣", sweat_smile: "😅", sweat: "😓", cry: "😢", sob: "😭", wink: "😉",
  blush: "😊", slightly_smiling_face: "🙂", upside_down_face: "🙃", relieved: "😌",
  thinking: "🤔", thinking_face: "🤔", raised_hands: "🙌", wave: "👋", ok: "🆗",
  point_up: "☝️", point_down: "👇", point_right: "👉", point_left: "👈",
  white_check_mark: "✅", heavy_check_mark: "✔️", ballot_box_with_check: "☑️",
  x: "❌", negative_squared_cross_mark: "❎", warning: "⚠️", bulb: "💡",
  rocket: "🚀", sparkles: "✨", star: "⭐", star2: "🌟", zap: "⚡",
  question: "❓", grey_question: "❔", exclamation: "❗", bangbang: "‼️",
  "100": "💯", memo: "📝", pencil: "✏️", pushpin: "📌", paperclip: "📎",
  calendar: "📅", date: "📅", hourglass: "⏳", hourglass_flowing_sand: "⏳",
  alarm_clock: "⏰", clock: "🕐", mag: "🔍", lock: "🔒", key: "🔑",
  email: "📧", envelope: "✉️", phone: "📞", telephone: "📞", bell: "🔔",
  no_good: "🙅", raising_hand: "🙋", sunglasses: "😎", partying_face: "🥳",
  hugging_face: "🤗", pleading_face: "🥺", disappointed: "😞", weary: "😩",
  tired_face: "😫", exploding_head: "🤯", ghost: "👻", skull: "💀", poop: "💩",
  robot: "🤖", gift: "🎁", coffee: "☕", beer: "🍺", cake: "🎂",
  smiling_face_with_tear: "🥲", face_with_rolling_eyes: "🙄", neutral_face: "😐",
  no_mouth: "😶", zipper_mouth_face: "🤐", sleeping: "😴", dizzy_face: "😵",
  handshake: "🤝", writing_hand: "✍️", speech_balloon: "💬", email_: "📩",
  chart_with_upwards_trend: "📈", chart_with_downwards_trend: "📉", bar_chart: "📊",
  heavy_plus_sign: "➕", heavy_minus_sign: "➖", arrow_right: "➡️", arrow_left: "⬅️",
  arrow_up: "⬆️", arrow_down: "⬇️", recycle: "♻️", new: "🆕", up: "🆙",
};
function emojify(s: string): string {
  return s.replace(/:([a-z0-9_+-]+):/gi, (m, name: string) => {
    const e = EMOJI_SHORTCODES[name.toLowerCase()];
    return e ?? m;
  });
}
function decorate(s: string): string {
  return emojify(decodeEntities(s));
}

function inlineMd(text: string): ReactNode {
  // エンティティ復号・絵文字化してから、URLリンク・**bold** を組み立てる（HTMLは挿入しない）
  const s = decorate(text);
  const parts = s.split(/(https?:\/\/[^\s<>"'（）]+|\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (/^https?:\/\//.test(p)) {
      // 末尾の句読点・閉じ括弧はリンクから外す
      const mm = p.match(/^(.*?)([.,!?、。）)\]】]*)$/s);
      const url = mm ? mm[1] : p;
      const tail = mm ? mm[2] : "";
      return (
        <span key={i}>
          <a href={url} target="_blank" rel="noreferrer noopener">
            {url}
          </a>
          {tail}
        </span>
      );
    }
    if (p.startsWith("**") && p.endsWith("**"))
      return <strong key={i}>{p.slice(2, -2)}</strong>;
    return p;
  });
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
  const name = (m?.[3] ?? h).trim();
  if (!m?.[1]) return { when: "", name };
  const time = m[2] ?? "";
  // 取り込み時刻は保存上UTC。表示は日本時間(JST=UTC+9)へ変換して、メールソフトと一致させる。
  if (time) {
    const d = new Date(`${m[1]}T${time.length === 4 ? "0" + time : time}:00Z`);
    if (!isNaN(d.getTime())) {
      const when = new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d); // → "07/15 19:06"
      return { when, name };
    }
  }
  return { when: m[1].slice(5).replace("-", "/"), name };
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
  const avatars = useContext(AvatarContext);
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
        const photo = avatars[name] || avatars[name.trim()];
        const avatar = photo ? (
          <img className="tv-avatar" src={photo} alt={name} loading="lazy" />
        ) : (
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
  // 人間には不要なセクションはGUIでは非表示（ファイルには残る＝AIの学習・履歴用）。
  // 「状況分析（AIの読み）」／過去の「却下理由」は画面に出さない。
  const HIDDEN_SECTIONS = ["状況分析", "却下理由"];
  const sections = parseSections(body).filter(
    (s) => !HIDDEN_SECTIONS.some((h) => s.rawTitle.startsWith(h))
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

// ドット絵キャラ（自己完結SVGスプライト・外部画像なし）。flipで左右反転＝向かい合い表現。
function PixelChar({
  skin = "#f1c27d",
  hair = "#2b2b33",
  shirt = "#5b8def",
  pants = "#33333b",
  size = 40,
  flip = false,
}: {
  skin?: string;
  hair?: string;
  shirt?: string;
  pants?: string;
  size?: number;
  flip?: boolean;
}) {
  // 8x12 のドット絵（H=髪 S=肌 E=目 B=服 P=脚）
  const rows = [
    "..HHHH..",
    ".HHHHHH.",
    ".HSSSSH.",
    ".SEssES.",
    ".SSSSSS.",
    "..SSSS..",
    ".BBBBBB.",
    "SBBBBBBS",
    "SBBBBBBS",
    ".BBBBBB.",
    ".PP..PP.",
    ".PP..PP.",
  ];
  const col: Record<string, string> = {
    H: hair,
    S: skin,
    E: "#20202a",
    B: shirt,
    P: pants,
  };
  const w = 8;
  const h = rows.length;
  return (
    <svg
      width={size}
      height={(size * h) / w}
      viewBox={`0 0 ${w} ${h}`}
      style={{ shapeRendering: "crispEdges" }}
    >
      {/* 反転は内側gに逃がす（svgのtransformはbobアニメ用に空けておく） */}
      <g transform={flip ? `translate(${w},0) scale(-1,1)` : undefined}>
        {rows.flatMap((row, y) =>
          [...row].map((ch, x) => {
            const c = col[ch];
            return c ? (
              <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={c} />
            ) : null;
          })
        )}
      </g>
    </svg>
  );
}

// --- バーチャルオフィス（ゲーム風・俯瞰）：名前付きAIスタッフが働く空間 ---
// x/y はステージ内の%座標。中央上(50,15)が社長デスク。
const STAFF: {
  key: string;
  name: string;
  role: string;
  hair: string;
  color: string; // 服の色
  line: string;
  x: number;
  y: number;
}[] = [
  { key: "reception", name: "アイ", role: "受付", hair: "#8a5a3c", color: "#f6c85f", line: "新しい案件、来てます！", x: 15, y: 46 },
  { key: "direction", name: "ケント", role: "ディレPM", hair: "#2b2b33", color: "#4a9be0", line: "打ち返し案、見てください！", x: 36, y: 54 },
  { key: "design", name: "ミオ", role: "デザイナー", hair: "#b8477e", color: "#e05a9b", line: "デザイン提案できました！", x: 64, y: 54 },
  { key: "coding", name: "リク", role: "エンジニア", hair: "#1f1f26", color: "#3ac0a0", line: "技術の打ち返し案です！", x: 85, y: 46 },
  { key: "maintenance", name: "タク", role: "保守担当", hair: "#4a3520", color: "#e08a3a", line: "保守対応の相談です！", x: 24, y: 82 },
  { key: "ciy-pm", name: "ハル", role: "CIY-PM", hair: "#3a2f5a", color: "#8b7ee0", line: "CIYの改善提案です！", x: 50, y: 86 },
  { key: "reviewer", name: "サト", role: "レビュアー", hair: "#5a4a3a", color: "#5aa0c0", line: "一次レビュー完了です！", x: 76, y: 82 },
];

function OfficeView({ onOpenItem }: { onOpenItem: (id: string) => void }) {
  const [all, setAll] = useState<ItemFrontmatter[]>([]);
  useEffect(() => {
    const load = async () => {
      try {
        const { items } = await api.listItems({});
        setAll(items);
      } catch {
        /* ignore */
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 4000);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  const active = all.filter(
    (i) => !(i.snooze_until && Date.parse(i.snooze_until) > now)
  );
  const pending = active.filter((i) => i.status === "pending");
  // Codex専務＝メンター役。各社員が出した成果物のうち「重要案件(importance:high)」で、
  // まだCodexのクロスチェックを通っていない（passed以外）ものを、
  // 「専務に見てもらう対象」として数える。要再考(revision)とは無関係。
  const codexReview = active.filter(
    (i) =>
      i.importance === "high" &&
      i.status === "pending" &&
      i.review_status !== "passed"
  );
  const byRole = (key: string) =>
    pending.filter((i) => (key === "reception" ? !i.assignee : i.assignee === key));

  // 打ち合わせ中の社員（順番に社長デスクへ来て向かい合う）
  const busyStaff = STAFF.map((s) => ({ s, load: byRole(s.key) })).filter(
    (x) => x.load.length > 0
  );
  const meeting = busyStaff.length ? busyStaff[tick % busyStaff.length] : null;

  return (
    <div className="office-wrap">
      <div className="office">
        {/* おしゃれデザイン会社の内装 */}
        <div className="decor window" />
        <div className="decor rug" />
        <div className="decor prop plant1">🪴</div>
        <div className="decor prop plant2">🪴</div>
        <div className="decor prop monstera">🌿</div>
        <div className="decor prop sofa">🛋️</div>
        <div className="decor prop art1">🖼️</div>
        <div className="decor prop art2">🖼️</div>
        <div className="decor prop books">📚</div>

        {/* 社長デスク（打ち合わせ時は来客の方を向く） */}
        <div className="boss-desk" style={{ left: "50%", top: "14%" }}>
          <div className="ws-desk boss-furniture">
            <span className="monitor">🖥️</span>
          </div>
          <div className={`person boss ${meeting ? "face-left" : ""}`}>
            <PixelChar skin="#e8b98a" hair="#25201a" shirt="#2a3a55" size={46} flip={!!meeting} />
          </div>
          <div className="boss-label">川崎さん（社長）</div>
          <div className={`tray ${pending.length ? "has" : ""}`}>
            📥 <b>{pending.length}</b>
          </div>

          {/* 来客中の社員：社長の前に立って向かい合う */}
          {meeting && (
            <div className="visitor" style={{ "--c": meeting.s.color } as React.CSSProperties}>
              <div className="person face-right">
                <PixelChar hair={meeting.s.hair} shirt={meeting.s.color} size={40} />
              </div>
              <button
                className="meet-bubble"
                onClick={() => onOpenItem(meeting.load[0].id)}
              >
                {meeting.s.name}：{meeting.s.line}
                <span className="speech-sub">
                  {meeting.load[0].project_label || meeting.load[0].project}（
                  {meeting.load.length}件）
                </span>
              </button>
            </div>
          )}
        </div>

        {/* Codex専務 */}
        <div
          className={`exec ${codexReview.length ? "reviewing" : ""}`}
          style={{ left: "89%", top: "13%" }}
          title="Codex専務：各社員の重要案件をレビュー・助言するメンター役"
        >
          <div className="ws-desk" />
          <div className="person">
            <PixelChar skin="#e0b088" hair="#c9c9d2" shirt="#3a2f4a" size={42} flip />
          </div>
          <div className="exec-label">
            Codex専務
            <span className="exec-tag">
              {codexReview.length ? `レビュー中 ${codexReview.length}` : "監査待機"}
            </span>
          </div>
        </div>

        {/* スタッフのデスク（着席して仕事。打ち合わせ中は離席） */}
        {STAFF.map((s) => {
          const load = byRole(s.key);
          const busy = load.length > 0;
          const away = meeting?.s.key === s.key;
          return (
            <div
              key={s.key}
              className="workstation"
              data-busy={busy}
              style={{ "--x": `${s.x}%`, "--y": `${s.y}%`, "--c": s.color } as React.CSSProperties}
            >
              <div className="ws-desk">
                <span className="monitor">💻</span>
              </div>
              {away ? (
                <div className="person chair">🪑</div>
              ) : (
                <div className={`person seated ${busy ? "working" : ""}`}>
                  <PixelChar hair={s.hair} shirt={s.color} size={38} />
                </div>
              )}
              <div className="ws-label">
                {s.name}
                <span className="role-tag">{s.role}</span>
                {busy && <span className="ws-count">{load.length}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <p className="office-foot">
        社員はデスクで下書きを作り、順番に社長デスクへ来て相談します。高リスクはCodex専務がクロスチェック。社長は判断・承認だけ。（更新中）
      </p>
    </div>
  );
}

// AI→人間への依頼(ask)を1件表示。方針を仰ぐ/調査依頼をGUIで受け答え。
function AskItem({
  itemId,
  ask,
  onAnswered,
}: {
  itemId: string;
  ask: Ask;
  onAnswered: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (val: string) => {
    if (!val.trim()) return;
    setBusy(true);
    try {
      await api.answerAsk(itemId, ask.id, val.trim());
      onAnswered();
    } finally {
      setBusy(false);
    }
  };
  const tag = ask.kind === "decision" ? "🧭 方針の確認" : "🔍 調査・作業のお願い";
  if (ask.resolved)
    return (
      <div className="ask resolved">
        <div className="ask-q">
          <span className="ask-tag">{tag}</span>
          {ask.question}
        </div>
        <div className="ask-a">✓ 回答：{ask.answer}</div>
      </div>
    );
  return (
    <div className={`ask ${ask.kind}`}>
      <div className="ask-q">
        <span className="ask-tag">{tag}</span>
        {ask.question}
      </div>
      {ask.options && ask.options.length > 0 && (
        <div className="ask-options">
          {ask.options.map((o) => (
            <button key={o} className="btn sm" disabled={busy} onClick={() => submit(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <div className="ask-input">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={ask.kind === "decision" ? "方針を入力…" : "確認結果・報告を入力…"}
          onKeyDown={(e) => e.key === "Enter" && submit(text)}
        />
        <button className="btn primary sm" disabled={busy || !text.trim()} onClick={() => submit(text)}>
          回答
        </button>
      </div>
    </div>
  );
}

function AsksPanel({
  itemId,
  asks,
  onAnswered,
}: {
  itemId: string;
  asks?: Ask[];
  onAnswered: () => void;
}) {
  const valid = (asks || []).filter(
    (a): a is Ask =>
      !!a &&
      typeof a.id === "string" &&
      typeof a.question === "string" &&
      (a.kind === "decision" || a.kind === "investigation")
  );
  if (valid.length === 0) return null;
  const open = valid.filter((a) => !a.resolved).length;
  return (
    <div className="asks-panel">
      <div className="asks-head">
        🙋 AIからの確認・依頼
        {open > 0 ? (
          <span className="asks-count">未回答 {open}</span>
        ) : (
          <span className="asks-done">すべて回答済み</span>
        )}
      </div>
      {valid.map((a) => (
        <AskItem key={a.id} itemId={itemId} ask={a} onAnswered={onAnswered} />
      ))}
      {open === 0 && (
        <p className="asks-foot">
          回答が揃いました。Claude Codeに「回答ぶんを反映して再ドラフト」とご依頼ください。
        </p>
      )}
    </div>
  );
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

  // 詳細も5秒ごとに再取得（cronで選択中カードに新着が来たらバナーを出す）。
  // 編集中・インライン操作中・処理中は触らない（作業を壊さない）。
  useEffect(() => {
    if (!id) return;
    const t = setInterval(async () => {
      if (editing || panelMode || busy) return;
      try {
        const { item: fresh } = await api.getItem(id);
        setItem(fresh);
        setDraft(fresh.body);
      } catch {
        /* ネットワーク一時失敗は無視 */
      }
    }, 5000);
    return () => clearInterval(t);
  }, [id, editing, panelMode, busy]);

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
      // 見ていたスレッド最終IDを送り、cronでの新着とズレていたらサーバが409
      const r = await api.setStatus(item.id, "approved", undefined, item.thread_last_id ?? "");
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

      {item.thread_updated && (
        <div className="banner warn">
          🔄 スレッドに新着があります。「こう来た」は最新ですが、下の草案は新着前のものかもしれません。
          再作成が必要なら Claude Code に「新着ぶんを再ドラフトして」とご依頼ください。
        </div>
      )}

      <AsksPanel
        itemId={item.id}
        asks={item.asks}
        onAnswered={() => {
          load();
          onChanged();
        }}
      />

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
