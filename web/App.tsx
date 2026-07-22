import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  createContext,
  useContext,
  type ReactNode,
} from "react";
import {
  api,
  type ItemFull,
  type ReferenceMeta,
  type ProjectMeta,
  type DailyReport,
  type Divergence,
} from "./api.ts";

// メンバー表示名→プロフィール画像URL。スレッドのアバター表示に使う（無ければ色付きイニシャル）。
const AvatarContext = createContext<Record<string, string>>({});
import {
  STATUS_LABELS,
  SOURCE_LABELS,
  SOURCES,
  isProposalType,
  type ItemFrontmatter,
  type Ask,
} from "../shared/roles.ts";
import { NewDraftModal } from "./NewDraftModal.tsx";

type Filters = {
  status: string;
  source: string;
  assignee: string;
  project: string;
  q: string;
};

const EMPTY: Filters = {
  status: "pending",
  source: "",
  assignee: "",
  project: "",
  q: "",
};

// リロード（自動更新含む）しても「いま見ていた画面」に戻れるよう、
// 表示タブと選択中カードを localStorage に保存・復元する。
type View = "dashboard" | "learning" | "knowledge";
const VIEWS: readonly string[] = ["dashboard", "learning", "knowledge"];
function restoreView(): View {
  try {
    const v = localStorage.getItem("gb.view");
    if (v && VIEWS.includes(v)) return v as View;
  } catch {
    /* localStorageが使えなくても既定で動く */
  }
  return "dashboard";
}
function restoreSelectedId(): string | null {
  try {
    return localStorage.getItem("gb.selectedId");
  } catch {
    return null;
  }
}

export function App() {
  const [items, setItems] = useState<ItemFrontmatter[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [selectedId, setSelectedId] = useState<string | null>(restoreSelectedId);
  const [showNew, setShowNew] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(restoreView);
  const [avatars, setAvatars] = useState<Record<string, string>>({});

  // 画面状態を保存（リロード後に同じタブ・同じカードへ復帰する）
  useEffect(() => {
    try {
      localStorage.setItem("gb.view", view);
    } catch {
      /* 保存できなくても動作に影響しない */
    }
  }, [view]);
  useEffect(() => {
    try {
      if (selectedId) localStorage.setItem("gb.selectedId", selectedId);
      else localStorage.removeItem("gb.selectedId");
    } catch {
      /* 同上 */
    }
  }, [selectedId]);

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
  // ダッシュボード入場時に一度だけ先頭を自動選択するための印（明示的な未選択は尊重する）。
  const didAutoSelectRef = useRef(false);

  const reload = useCallback(async () => {
    try {
      // 擬似ステータス（画面上だけの状態）はサーバに素の値で問い合わせ、クライアントで絞る。
      //   snoozed=再通知待ち / closed=対応済み（approved/rejected/done を束ねたもの）
      const snoozedView = filters.status === "snoozed";
      const closedView = filters.status === "closed";
      const serverStatus =
        snoozedView ? "pending" : closedView ? "" : filters.status;
      const { items } = await api.listItems({ ...filters, status: serverStatus });
      const now = Date.now();
      const isSnoozed = (it: ItemFrontmatter) =>
        !!it.snooze_until && Date.parse(it.snooze_until) > now;
      const isClosed = (it: ItemFrontmatter) =>
        it.status === "approved" || it.status === "rejected" || it.status === "done";
      let list = items;
      if (snoozedView) list = items.filter(isSnoozed);
      else if (closedView) list = items.filter(isClosed); // 対応済み＝処理が終わったもの
      else if (filters.status === "pending") {
        // 対応待ちビューには、再生成中（revision）のカードも一緒に見せる。
        // ＝再生成を依頼した案件が一覧から消えず「今作り直し中」と分かる。
        const { items: regen } = await api.listItems({ ...filters, status: "revision" });
        list = [...items, ...regen]
          .filter((it) => !isSnoozed(it)) // 対応待ちから再通知待ちを隠す
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // 新しい順（サーバと同じ並び）
      } else if (filters.status === "") {
        list = items.filter((it) => !isSnoozed(it)); // すべて表示でも再通知待ちは隠す
      }
      setItems(list);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filters]);

  // 完了/再生成/再通知（後で）/今後カード化しない のあと：今のカードを閉じて次のカードへ送る。
  // 一覧での次を優先、無ければ前、どちらも無ければ null＝空状態（「左の一覧から選択してください。」）。
  const resolveAndAdvance = useCallback(() => {
    setSelectedId((cur) => {
      if (!cur) return null;
      const idx = items.findIndex((it) => it.id === cur);
      if (idx === -1) return null;
      const next = items[idx + 1] ?? items[idx - 1] ?? null;
      return next ? next.id : null;
    });
    reload();
  }, [items, reload]);

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

  // 自動更新: 5秒ごとに一覧を再取得（ダッシュボード表示中のみ）
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

  // ダッシュボード入場時に一度だけ先頭を自動選択する（明示選択は上書きしない）。
  // ×で閉じた／カード処理で次が無く未選択になった後は自動で選び直さず、空状態
  //（「左の一覧から選択してください。」）を尊重する。
  useEffect(() => {
    if (view !== "dashboard") {
      didAutoSelectRef.current = false; // 離れたら次回入場でまた初期選択できるように戻す
      return;
    }
    if (!didAutoSelectRef.current && !selectedId && items.length > 0) {
      didAutoSelectRef.current = true;
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
          <span className="logo">⚡</span>
          <div>
            <h1>YUKI KAWASAKI AI</h1>
            <p className="sub">対応ダッシュボード — 社長は判断・対応だけ</p>
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
              className={view === "learning" ? "on" : ""}
              onClick={() => setView("learning")}
            >
              🧠 学びの日報
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
      ) : view === "learning" ? (
        <DailyReportView />
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
              onResolve={resolveAndAdvance}
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
// 学びの日報ビュー：AIが「どこで賢くなったか」を毎日振り返る。
// 食い違い（AIの草案 vs 川崎さんの実返信）→ 今日の実例・新ルール・数字・週次。
// 読み取り専用。データは /api/daily-report（_memory 配下から生成）。
// ============================================================
function fmtDate(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[2])}/${Number(m[3])}` : ymd;
}

function DivergenceCard({ d }: { d: Divergence }) {
  const learn = d.tag === "要学習";
  return (
    <div className={`dr-diff ${learn ? "learn" : "minor"}`}>
      <div className="dr-diff-head">
        <span className={`dr-tag ${learn ? "learn" : "minor"}`}>{d.tag}</span>
        <span className="dr-diff-title">{d.subject}</span>
        {d.meta && <span className="dr-diff-meta">{d.meta}</span>}
        {typeof d.similarity === "number" && (
          <span className="dr-diff-sim">類似 {d.similarity}%</span>
        )}
      </div>
      <div className="dr-diff-cols">
        <div className="dr-col ai">
          <div className="dr-col-label">私の草案</div>
          <div className="dr-col-body">{d.draft || "（なし）"}</div>
        </div>
        <div className="dr-col me">
          <div className="dr-col-label">あなたが実際に送った返信</div>
          <div className="dr-col-body">{d.sent || "（なし）"}</div>
        </div>
      </div>
    </div>
  );
}

function DailyReportView() {
  const [rep, setRep] = useState<DailyReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api
      .dailyReport()
      .then((r) => alive && setRep(r))
      .catch((e) => alive && setErr(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <div className="dr-wrap"><p className="muted">読み込み中…</p></div>;
  if (err) return <div className="dr-wrap"><div className="banner error">⚠ {err}</div></div>;
  if (!rep) return null;

  const c = rep.counts;
  const learnedToday = rep.today.filter((d) => d.tag === "要学習").length;
  const distillPct = Math.min(
    100,
    Math.round(((c.threshold - c.untilDistill) / c.threshold) * 100)
  );

  return (
    <div className="dr-wrap">
      <div className="dr-header">
        <h2>🧠 学びの日報 <span className="dr-date">{fmtDate(rep.date)}</span></h2>
        <p className="dr-lead">
          {learnedToday > 0
            ? `今日は ${learnedToday} 件、あなたの打ち返しから学びました。`
            : rep.today.length > 0
            ? `今日は言い回しの微修正が ${rep.today.length} 件（大きなズレはなし）。`
            : "今日はまだ学びの記録はありません。返信を送ると自動でここに溜まります。"}
        </p>
      </div>

      {/* 数字サマリー */}
      <div className="dr-stats">
        <div className="dr-stat">
          <div className="dr-stat-num">{c.repliesTotal}<span>件</span></div>
          <div className="dr-stat-label">実返信から学習<br /><small>今日 +{c.repliesToday}</small></div>
        </div>
        <div className="dr-stat">
          <div className="dr-stat-num">{c.requireLearnTotal}<span>件</span></div>
          <div className="dr-stat-label">要学習の食い違い<br /><small>今日 +{c.requireLearnToday}</small></div>
        </div>
        <div className="dr-stat">
          <div className="dr-stat-num">{c.minorTotal}<span>件</span></div>
          <div className="dr-stat-label">微修正<br /><small>言い回しだけ</small></div>
        </div>
        <div className="dr-stat">
          <div className="dr-stat-num">{c.rulesTotal}<span>個</span></div>
          <div className="dr-stat-label">身についたルール<br /><small>自動蒸留</small></div>
        </div>
        <div className="dr-stat wide">
          <div className="dr-stat-label">
            学びの“まとめ直し（清書）”まで
            <span className="dr-badge-live">学習は1件目から反映中</span>
          </div>
          <div className="dr-progress">
            <div className="dr-progress-bar" style={{ width: `${distillPct}%` }} />
          </div>
          <div className="dr-stat-sub">
            {c.untilDistill > 0
              ? `あと ${c.untilDistill} 件の「要学習」がたまると、共通ルールに“まとめ直し”ます（それまでも一件ずつ次の草案に反映済み）`
              : "まもなく共通ルールにまとめ直します（それまでも各件は反映済み）"}
          </div>
        </div>
      </div>
      <p className="dr-note">
        ※ このバーは学習の“開始条件”ではありません。あなたが打ち返しを直すと、その学びは
        <b>1件目からすぐ次の草案に反映</b>されます。バーは、たまった学びを1つの共通ルールへ
        <b>まとめ直す（清書する）</b>までの目安です。
      </p>

      {/* 今日の食い違いの実例 */}
      <section className="dr-section">
        <h3>今日、あなたが直したところ（＝私の学び）</h3>
        {rep.today.length === 0 ? (
          <p className="muted">
            今日はまだありません。あなたが草案と違う打ち返しをすると、その差がここに並びます。
          </p>
        ) : (
          rep.today.map((d, i) => <DivergenceCard key={i} d={d} />)
        )}
      </section>

      {/* 新しく身についたルール */}
      <section className="dr-section">
        <h3>新しく身についたルール</h3>
        {rep.newRules.length === 0 ? (
          <p className="muted">
            今日、共通ルールへの“まとめ直し”はまだありません（あと {c.untilDistill} 件で清書されます）。
            ※ここが空でも、個々の食い違いは1件目から次の草案に反映済みです。
          </p>
        ) : (
          rep.newRules.map((b, i) => (
            <div className="dr-rulebatch" key={i}>
              <div className="dr-rulebatch-head">
                {b.from || "食い違いから"} 蒸留 <span className="muted">{b.when}</span>
              </div>
              <ul>
                {b.rules.map((r, j) => (
                  <li key={j}>{r}</li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      {/* 週次のまとめ */}
      <section className="dr-section">
        <h3>今週のまとめ <span className="muted">{fmtDate(rep.week.from)}〜{fmtDate(rep.week.to)}</span></h3>
        <p className="dr-week-line">
          食い違い <b>{rep.week.divergences}</b> 件（うち要学習 <b>{rep.week.requireLearn}</b> 件）／
          新しく身についたルール <b>{rep.week.rulesAdded}</b> 個
        </p>
        {rep.week.examples.length > 0 && (
          <>
            <div className="dr-week-sub muted">今週の代表的な学び</div>
            {rep.week.examples.map((d, i) => (
              <div className="dr-week-ex" key={i}>
                <span className="dr-tag learn">要学習</span>
                <span className="dr-week-ex-title">{fmtDate(d.date)}・{d.subject}</span>
              </div>
            ))}
          </>
        )}
      </section>

      <p className="dr-foot muted">
        この日報は自動で更新されます。ルール化まで含めて全自動で、あなたの操作は不要です。
      </p>
    </div>
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
  // 参照（資料の同期）は「案件の入口」ではないので上部帯から外し、
  // サイドバーの「参照資料」トグル内に表示する（ReferencePanel）。
  const defs: [string, string][] = [
    ["mail", "メール"],
    ["asana", "Asana"],
    ["slack", "Slack"],
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
                <span key={k} className="chip removable">
                  {k}
                  <button
                    className="chip-x"
                    disabled={busy}
                    title="解除する（また取り込むようになります）"
                    onClick={async () => {
                      setBusy(true);
                      setErr(null);
                      try {
                        const r = await api.removeIgnore(k);
                        setIgnoreList(r.ignore);
                      } catch (e) {
                        setErr((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    ×
                  </button>
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
          // 人間向けは2状態に集約。対応待ち=pending（再生成中も混ぜて表示）、
          // 対応済み=approved/rejected/done を束ねた擬似ステータス「closed」。
          ["pending", STATUS_LABELS.pending],
          ["closed", "対応済み"],
          ["snoozed", "再通知待ち"],
        ]}
      />
      <Select
        label="ツール"
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
          className={`card src-${it.source} ${selectedId === it.id ? "sel" : ""} ${it.status === "revision" ? "regen" : ""}`}
          onClick={() => onSelect(it.id)}
        >
          <div className="card-top">
            <SourceBadge source={it.source} />
            {it.status === "revision" ? (
              // 再生成待ち＝定期処理が拾って作り直し中。一覧でも「今このカードを再生成中」と分かるように。
              <span className="badge regen">
                <span className="regen-dot" />再生成中
              </span>
            ) : (
              <StatusBadge status={it.status} />
            )}
            {it.thread_updated && <span className="badge newmsg">🔄 新着</span>}
            {(it.asks || []).some((a) => a && a.question && !a.resolved) && (
              <span className="badge askbadge">🙋 確認</span>
            )}
          </div>
          <div className="card-title">{it.title}</div>
          <div className="card-meta">
            <span>{it.project_label || it.project}</span>
            {it.section && (
              <>
                <span>·</span>
                <span>{it.section}</span>
              </>
            )}
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
  const [lastSync, setLastSync] = useState<string | null>(null); // 資料を最後に取り込んだ時刻
  const [open, setOpen] = useState(false); // 基本は閉じておく（必要なときだけ開く）
  useEffect(() => {
    api.listReferences().then((r) => setRefs(r.references)).catch(() => {});
    api.syncStatus().then((r) => setLastSync(r.status.references ?? null)).catch(() => {});
  }, []);
  // ローカル原本を上、外部同期を下にまとめる（各グループ内はタイトル順）
  const sorted = useMemo(() => {
    const rank = (r: ReferenceMeta) => (r.kind === "local" ? 0 : 1);
    return [...refs].sort(
      (a, b) => rank(a) - rank(b) || String(a.title).localeCompare(String(b.title), "ja")
    );
  }, [refs]);
  if (refs.length === 0) return null;
  const firstExternal = sorted.findIndex((r) => r.kind !== "local");
  return (
    <div className={`ref-panel${open ? "" : " is-collapsed"}`}>
      <button
        type="button"
        className="ref-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ref-caret">{open ? "▾" : "▸"}</span>
        参照資料
        <span className="ref-count">{refs.length}</span>
      </button>
      {open && (
      <>
      {lastSync && (
        <div className="ref-lastsync">最終チェック：{relTime(lastSync)}</div>
      )}
      <ul>
        {sorted.map((r, i) => (
          <Fragment key={r.slug}>
            {i === 0 && r.kind === "local" && (
              <li className="ref-group">ローカル原本（同期不要）</li>
            )}
            {i === firstExternal && firstExternal > 0 && (
              <li className="ref-group">外部同期（外部が正・キャッシュ）</li>
            )}
            <li className="ref-item">
              <span className="ref-title">{r.title}</span>
              <span className="ref-kind">{r.kind === "local" ? "ローカル" : r.kind}</span>
              {r.kind === "local" ? (
                <span className="ref-local">
                  {r.updated ? `更新: ${r.updated}` : "原本"}
                </span>
              ) : r.stale || !r.last_synced ? (
                <span className="ref-stale">
                  ⚠ 要確認{r.last_synced ? `（${r.last_synced.slice(0, 10)}）` : "（未取得）"}
                </span>
              ) : (
                <span className="ref-fresh">最終取得: {r.last_synced.slice(0, 10)}</span>
              )}
            </li>
          </Fragment>
        ))}
      </ul>
      </>
      )}
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

// 「判定サマリ（社内用）」は分析部分（契約形態・経緯・素材・保守内外・影響範囲）を画面に出さない＝AIの解釈用。
// 人間に要るのは「要川崎判断」＝川崎さんが決める点だけなので、そこだけ抜き出す。
// 生成前ゲート（asks）が効かない既存カード／最終対応だけの点(b)のための表示。
function kawasakiDecision(content: string): string | null {
  const lines = content.split("\n");
  // 「要川崎判断」「要・川崎判断」等の行を探す（先頭の -・* や ** 装飾を許容）
  const marker = /^\s*(?:[-*・]\s*)?(?:\*\*)?\s*要\s*[・･]?\s*川崎(?:判断|確認)/;
  const idx = lines.findIndex((l) => marker.test(l));
  if (idx === -1) return null;
  // 見つけた行から節末まで（要川崎判断は通常サマリ最後の項目）。ラベルを外して中身だけ返す。
  const chunk = lines.slice(idx).join("\n").trim();
  const body = chunk
    .replace(/^\s*(?:[-*・]\s*)?(?:\*\*)?\s*要\s*[・･]?\s*川崎(?:判断|確認)(?:\*\*)?\s*[:：]?\s*/, "")
    .trim();
  // 「無」「なし」だけなら判断事項なし＝非表示
  if (/^(無|なし|特になし|無し)[。.]?$/.test(body)) return null;
  return body || chunk;
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

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function inlineMd(text: string, mentionNames: string[] = []): ReactNode {
  // エンティティ復号・絵文字化してから、@メンション・URLリンク・**bold** を組み立てる（HTMLは挿入しない）
  const s = decorate(text);
  // メンバー名（長い順）から @名前 の検出パターンを作る
  const names = mentionNames.filter(Boolean).sort((a, b) => b.length - a.length);
  const mentionAlt = names.length ? `@(?:${names.map(escapeReg).join("|")})` : null;
  const mentionSet = new Set(names.map((n) => "@" + n));
  const pattern = [
    "https?:\\/\\/[^\\s<>\"'（）]+",
    "\\*\\*[^*]+\\*\\*",
    ...(mentionAlt ? [mentionAlt] : []),
  ].join("|");
  const parts = s.split(new RegExp(`(${pattern})`, "g"));
  return parts.map((p, i) => {
    if (!p) return null;
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
    if (mentionSet.has(p))
      return (
        <span key={i} className="mention">
          {p}
        </span>
      );
    return p;
  });
}

function SimpleMarkdown({ text }: { text: string }) {
  const avatars = useContext(AvatarContext);
  const mentionNames = useMemo(() => Object.keys(avatars), [avatars]);
  const blocks = text.trim().split(/\n{2,}/).filter(Boolean);
  return (
    <div className="md">
      {blocks.map((blk, i) => {
        const lines = blk.split("\n").filter((l) => l.length > 0);
        if (lines.length && lines.every((l) => /^\s*[-*]\s+/.test(l)))
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inlineMd(l.replace(/^\s*[-*]\s+/, ""), mentionNames)}</li>
              ))}
            </ul>
          );
        if (lines.length && lines.every((l) => /^\s*\d+\.\s+/.test(l)))
          return (
            <ol key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inlineMd(l.replace(/^\s*\d+\.\s+/, ""), mentionNames)}</li>
              ))}
            </ol>
          );
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <span key={j}>
                {inlineMd(l, mentionNames)}
                {j < lines.length - 1 ? <br /> : null}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
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
      {lead && (
        <div className="thread-lead">
          <SimpleMarkdown text={lead} />
        </div>
      )}
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
  draftStatus,
  startedAt,
  onGenerate,
  busy,
  draftActions,
  draftEditor,
}: {
  body: string;
  draftStatus?: ItemFrontmatter["draft_status"];
  startedAt?: string;
  onGenerate?: () => void;
  busy?: boolean;
  draftActions?: ReactNode; // 「こう返しては？」見出しの右に置く操作（コピー/修正）
  draftEditor?: ReactNode; // 編集中はドラフト本文の代わりに表示する入力欄
}) {
  // 人間には不要なセクションはGUIでは非表示（ファイルには残る＝AIの学習・履歴用）。
  // 「状況分析（AIの読み）」／過去の「却下理由」／「メモ（AIの解釈用スペース）」は画面に出さない。
  const HIDDEN_SECTIONS = ["状況分析", "却下理由", "メモ"];
  const sections = parseSections(body).filter(
    (s) => !HIDDEN_SECTIONS.some((h) => s.rawTitle.startsWith(h))
  );
  return (
    <div className="sections">
      {sections.map((s, i) => {
        const meta = metaFor(s.rawTitle);
        const label = meta.label;
        // 「判定サマリ（社内用）」は分析部分を隠し、川崎さんが決める点＝「要川崎判断」だけを見せる。
        if (s.rawTitle.startsWith("判定サマリ")) {
          const decision = kawasakiDecision(s.content);
          if (!decision) return null; // 判断事項なし＝丸ごと非表示
          return (
            <div key={i} className="section note">
              <div className="section-label">
                <span className="section-icon">⚖️</span>
                あなたの判断が要る点
              </div>
              <SimpleMarkdown text={decision} />
            </div>
          );
        }
        // 届いたスレッド（説明欄・コメント）は囲い・見出しなしで、そのまま吹き出し表示する
        if (meta.kind === "incoming")
          return <ThreadView key={i} content={s.content} />;
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
              {meta.kind === "outgoing" && draftActions ? (
                <span className="section-actions">{draftActions}</span>
              ) : null}
            </div>
            {meta.kind === "outgoing" ? (
              draftEditor ?? (
                <DraftSection
                  content={s.content}
                  draftStatus={draftStatus}
                  startedAt={startedAt}
                  onGenerate={onGenerate}
                  busy={busy}
                />
              )
            ) : (
              <SimpleMarkdown text={s.content} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// 「こう返しては？」（ドラフト）の状態表示：生成待ち／生成中（アニメ）／失敗／生成済み。
function DraftSection({
  content,
  draftStatus,
  startedAt,
  onGenerate,
  busy,
}: {
  content: string;
  draftStatus?: ItemFrontmatter["draft_status"];
  startedAt?: string;
  onGenerate?: () => void;
  busy?: boolean;
}) {
  const isPlaceholder = /AIが草案を作成予定/.test(content);
  // 生成前ゲート：確認への回答待ち（回答が揃うと自動で草案を作り直す）。
  const awaitingInput = /確認の回答後に草案を作成/.test(content);
  const generating = draftStatus === "generating";
  const stalled =
    generating && !!startedAt && Date.now() - Date.parse(startedAt) > 3 * 60 * 1000;

  if (awaitingInput && !generating) {
    return (
      <div className="draft-state waiting">
        <span>✋ この下の「🙋 AIからの確認・依頼」に回答すると、その内容でAIが草案を作ります。</span>
      </div>
    );
  }
  if (generating) {
    return (
      <div className="draft-state generating">
        <div className="gen-row">
          <span className="gen-spinner" />
          <span>{stalled ? "生成に時間がかかっています…" : "生成中… 川崎さんの声で草案を作成しています"}</span>
        </div>
        <div className="gen-skeleton">
          <span />
          <span />
          <span />
        </div>
        {stalled && onGenerate && (
          <button className="btn sm" onClick={onGenerate} disabled={busy}>
            もう一度試す
          </button>
        )}
      </div>
    );
  }
  if (draftStatus === "error") {
    return (
      <div className="draft-state error">
        <span>⚠ 生成に失敗しました。</span>
        {onGenerate && (
          <button className="btn sm" onClick={onGenerate} disabled={busy}>
            ✨ 再生成
          </button>
        )}
      </div>
    );
  }
  if (isPlaceholder) {
    return (
      <div className="draft-state waiting">
        <span>⏳ 生成待ち（自動生成は1日2回。今すぐ作ることもできます）</span>
        {onGenerate && (
          <button className="btn sm primary" onClick={onGenerate} disabled={busy}>
            ✨ 今すぐ生成
          </button>
        )}
      </div>
    );
  }
  return (
    <>
      <SimpleMarkdown text={content} />
      {onGenerate && (
        <div className="draft-actions">
          <button className="btn sm ghost" onClick={onGenerate} disabled={busy}>
            🔄 再生成
          </button>
        </div>
      )}
    </>
  );
}

/** 「ドラフト」セクションのテキストだけ抜き出す（返信文コピー用）。無ければ null。 */
function draftText(body: string): string | null {
  const s = parseSections(body).find((x) => metaFor(x.rawTitle).kind === "outgoing");
  return s ? s.content.trim() : null;
}

/**
 * 「ドラフト（こう返しては？）」セクションの中身だけを差し替えた本文を返す。
 * 見出し行とその他のセクション（元メッセージ等）はそのまま保持する。
 */
function replaceDraftSection(body: string, next: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => {
    const m = l.match(/^##\s+(.+?)\s*$/);
    return !!m && metaFor(m[1].trim()).kind === "outgoing";
  });
  if (start === -1) return body; // ドラフト節が無ければ触らない
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start + 1), next.trim(), "", ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
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
          回答が揃いました。この内容でAIが自動で草案を作ります（少し待つと下に反映されます）。
        </p>
      )}
    </div>
  );
}

function DetailPanel({
  id,
  onChanged,
  onClose,
  onResolve,
}: {
  id: string | null;
  onChanged: () => void;
  onClose: () => void;
  onResolve: () => void; // 完了/再生成/再通知/カード化しない後：閉じて次のカードへ
}) {
  const [item, setItem] = useState<ItemFull | null>(null);
  const [editing, setEditing] = useState(false);
  const [notFound, setNotFound] = useState(false); // 復元した選択カードが存在しないとき
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // ボタン近くに出すインライン入力欄（再生成コメント / 再通知日付 / カード化しないの確認）
  const [panelMode, setPanelMode] = useState<
    "revision" | "snooze" | "ignoreSender" | null
  >(null);
  const [inputText, setInputText] = useState("");

  const load = useCallback(async () => {
    if (!id) return setItem(null);
    try {
      const { item } = await api.getItem(id);
      setItem(item);
      setNotFound(false);
      setDraft(draftText(item.body) ?? ""); // 修正対象は「こう返しては？」の文だけ
      setEditing(false);
      setPanelMode(null);
      setInputText("");
    } catch {
      // リロードで復元した選択カードが既に無い場合など。読み込み中のまま固まらせない。
      setItem(null);
      setNotFound(true);
    }
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
        setDraft(draftText(fresh.body) ?? "");
      } catch {
        /* ネットワーク一時失敗は無視 */
      }
    }, 5000);
    return () => clearInterval(t);
  }, [id, editing, panelMode, busy]);

  if (!id) return <div className="detail empty">左の一覧から選択してください。</div>;
  if (notFound)
    return (
      <div className="detail empty">
        このカードは見つかりませんでした（対応済みで整理された等）。
        <button className="btn ghost sm" onClick={onClose}>
          閉じる
        </button>
      </div>
    );
  if (!item) return <div className="detail">読み込み中…</div>;

  const snoozed =
    !!item.snooze_until && Date.parse(item.snooze_until) > Date.now();

  // fn が文字列を返せばそれを、無ければ fallback をメッセージに（load後に表示して消えないように）。
  // advance=true のときは、成功後にこのカードを閉じて次のカードへ送る（完了/再生成/再通知/カード化しない）。
  const act = async (
    fn: () => Promise<string | void>,
    fallback: string,
    advance = false
  ) => {
    setBusy(true);
    try {
      const custom = await fn();
      if (advance) {
        // 次カードへ切り替わるので、このカードの再読込・メッセージ表示は不要。
        onResolve();
      } else {
        await load();
        onChanged();
        setMsg(typeof custom === "string" ? custom : fallback);
      }
    } catch (e) {
      setMsg("⚠ " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // カードに記録された返信先から送信元アドレスを取り出す（「今後カード化しない」用。メール以外は空）。
  const senderEmail =
    item?.reply_to?.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0]?.toLowerCase() ?? "";
  const openPanel = (mode: "revision" | "snooze" | "ignoreSender") => {
    const opening = panelMode !== mode;
    setPanelMode(opening ? mode : null);
    // 再通知は日付入力。既定は30日後。
    if (opening && mode === "snooze") {
      const d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      setInputText(d.toISOString().slice(0, 10));
    } else {
      setInputText("");
    }
    setMsg(null);
  };
  // 提案カード（人格・文体・案件文脈）だけ「対応＝ファイルへ反映」に実処理がある。
  // 返信カードは対応しても閉じるだけ＝「完了」1つに統合（学習・自動クローズは実返信検知で自動実行）。
  const isProposal = isProposalType(item?.type);
  const approve = () =>
    act(async () => {
      // 見ていたスレッド最終IDを送り、cronでの新着とズレていたらサーバが409
      const r = await api.setStatus(item.id, "approved", undefined, item.thread_last_id ?? "");
      if (r.applied?.applied) return `対応し、${r.applied.target} へ反映しました。`;
      if (r.applied?.msg) return `対応しました（反映スキップ: ${r.applied.msg}）。`;
      return "対応しました。";
    }, "対応しました。");
  const confirmRevision = () =>
    act(async () => {
      await api.setStatus(item.id, "revision", inputText.trim());
    }, "AIに再生成を依頼しました（Claude Codeでの再生成待ち）。", true);
  // 返信カードの「完了」／提案カードの「対応不要」共用。どちらもカードを閉じるだけ。
  const markDone = () =>
    act(async () => {
      await api.setStatus(item.id, "done");
    }, "完了にしました（このカードを閉じました）。", true);
  const confirmIgnoreSender = () =>
    act(async () => {
      const r = await api.ignoreSender(item.id);
      return `今後 ${r.sender} からのメールはカード化しません。このカードは閉じました。`;
    }, "今後カード化しない送信元に登録しました。", true);
  const confirmSnooze = () =>
    act(async () => {
      await api.snooze(item.id, inputText);
    }, `再通知を予約しました（${inputText} に対応待ちへ再表示）。`, true);
  const unsnooze = () =>
    act(async () => {
      await api.snooze(item.id, null);
    }, "再通知の予約を解除しました。");
  const revert = () =>
    act(async () => {
      await api.setStatus(item.id, "pending");
    }, "対応待ちへ差し戻しました。");
  const saveEdit = () =>
    act(async () => {
      // 「こう返しては？」の文だけを差し替える（元メッセージ等の他セクションは保持）
      await api.updateBody(item.id, replaceDraftSection(item.body, draft));
    }, "返信文を修正しました（旧版はバックアップ済み）。");
  const generate = () =>
    act(async () => {
      const r = await api.generateDraft(item.id);
      if (r.already) return "すでに生成中です。";
      return "草案の生成を開始しました（生成中…）。";
    }, "生成を開始しました。");
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
        </div>
        <div className="head-actions">
          {item.spark_url && (
            <a
              className="btn ghost sm spark-open"
              href={item.spark_url}
              title="このスレッドをSparkで開く（返信はSparkで）"
            >
              ⚡ Sparkで開く
            </a>
          )}
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
        {item.section && <Meta k="セクション" v={item.section} />}
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
        <BodySections
          body={item.body}
          draftStatus={item.draft_status}
          startedAt={item.draft_started_at}
          onGenerate={generate}
          busy={busy}
          draftActions={
            !editing ? (
              <>
                {item.source_ref && /^https?:\/\//i.test(item.source_ref) && (
                  <a
                    className="btn ghost sm"
                    href={item.source_ref}
                    target="_blank"
                    rel="noreferrer"
                    title="元のスレッドを開く（原文で確認・そのまま返信できる）"
                  >
                    🔗 {SOURCE_LABELS[item.source]}で開く
                  </a>
                )}
                <button className="btn ghost sm" onClick={copyBody}>
                  返信文をコピー
                </button>
                <button
                  className="btn ghost sm"
                  onClick={() => {
                    setDraft(draftText(item.body) ?? "");
                    setEditing(true);
                  }}
                >
                  修正
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn sm"
                  onClick={() => {
                    setEditing(false);
                    setDraft(draftText(item.body) ?? "");
                  }}
                >
                  取消
                </button>
                <button className="btn primary sm" disabled={busy} onClick={saveEdit}>
                  保存
                </button>
              </>
            )
          }
          draftEditor={
            editing ? (
              <textarea
                className="body-edit draft-edit"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : undefined
          }
        />
      </div>

      {msg && <div className="banner info">{msg}</div>}

      {item.status === "revision" && (
        <div className="banner warn">
          ↩ AIに再生成を依頼済み。Claude Codeに「受信箱の再考ぶんを処理して」と頼むと、
          コメントを踏まえたv2が生成され「対応待ち」に戻ります。
        </div>
      )}

      {snoozed && (
        <div className="banner info">
          ⏰ 再通知待ち（{item.snooze_until?.slice(0, 10)} に対応待ちへ再表示）。
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
            {isProposal ? (
              // 提案カード：対応＝ファイルへ反映。反映する/しないを分けて残す。
              <>
                <button className="btn approve" disabled={busy} onClick={approve} title="この提案を対応し、対象ファイルへ追記で反映します。">
                  ✓ 対応して反映
                </button>
                <button className="btn ghost" disabled={busy} onClick={markDone} title="この提案は反映せず、カードを閉じます。">
                  ✔ 対応不要
                </button>
              </>
            ) : (
              // 返信カード：閉じるだけ＝1つに統合。学習・自動クローズは実返信検知で自動実行。
              <button className="btn approve" disabled={busy} onClick={markDone} title="このカードを閉じます（対応済み／返信不要どちらでも）。返信の下書きは、実際に社長が送った内容との食い違いが自動で学習されます。">
                ✓ 完了
              </button>
            )}
            <button
              className={`btn revision ${panelMode === "revision" ? "on" : ""}`}
              disabled={busy}
              onClick={() => openPanel("revision")}
            >
              ↩ 再生成
            </button>
            {snoozed ? (
              <button className="btn ghost" disabled={busy} onClick={unsnooze} title="予約した再通知を取り消し、いま対応待ちに戻します。">
                ⏰ 再通知を解除
              </button>
            ) : (
              <button
                className={`btn ghost ${panelMode === "snooze" ? "on" : ""}`}
                disabled={busy}
                onClick={() => openPanel("snooze")}
                title="今は保留し、指定した日にもう一度この対応待ちに出します。"
              >
                ⏰ 再通知（後で）
              </button>
            )}
            {senderEmail && (
              <button
                className={`btn ghost ${panelMode === "ignoreSender" ? "on" : ""}`}
                disabled={busy}
                onClick={() => openPanel("ignoreSender")}
                title="この送信元からのメールは今後カードを作りません（返信不要な送信元の整理用。草案は学習しません）"
              >
                🔕 今後カード化しない
              </button>
            )}
          </>
        )}
        {item.status !== "pending" && (
          <button className="btn ghost" disabled={busy} onClick={revert}>
            ↺ 対応待ちへ差し戻し
          </button>
        )}
      </div>

      {panelMode === "ignoreSender" && (
        <div className="inline-panel">
          <label>
            この送信元からのメールは今後カード化しません（返信不要なものの整理用）。よろしいですか？
          </label>
          <p className="ignore-target">🔕 {senderEmail}</p>
          <div className="inline-actions">
            <button className="btn ghost sm" onClick={() => setPanelMode(null)}>
              取消
            </button>
            <button className="btn sm" disabled={busy} onClick={confirmIgnoreSender}>
              今後カード化しない
            </button>
          </div>
        </div>
      )}

      {panelMode === "snooze" && (
        <div className="inline-panel snooze">
          <label>いつ再通知する？（この日にもう一度「対応待ち」へ出します）</label>
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
              この日に再通知
            </button>
          </div>
        </div>
      )}

      {panelMode === "revision" && (
        <div className="inline-panel revision">
          <label>
            AIへの再生成コメント（元メッセージ＋記憶＋文脈と併せてv2を生成します）
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
              再生成を依頼
            </button>
          </div>
        </div>
      )}

      <p className="foot-note">
        「完了」にしても自動送信はしません。実際の送信・実行は社長ご自身が各ツールで行ってください。
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
