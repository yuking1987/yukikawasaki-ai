import { useState } from "react";
import { api } from "./api.ts";
import {
  SOURCES,
  AUDIENCES,
  TYPES,
  ASSIGNEE_ROLES,
  IMPORTANCES,
  SOURCE_LABELS,
  AUDIENCE_LABELS,
  TYPE_LABELS,
  ROLE_LABELS,
  IMPORTANCE_LABELS,
} from "../shared/roles.ts";

// 新規下書き登録フォーム。
// AI生成はアプリ外だが、手動投入や動作確認のためにここから提案を作れる。
export function NewDraftModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [source, setSource] = useState<string>("slack");
  const [audience, setAudience] = useState<string>("internal");
  const [type, setType] = useState<string>("reply");
  const [project, setProject] = useState("");
  const [assignee, setAssignee] = useState<string>("");
  const [importance, setImportance] = useState<string>("normal");
  const [original, setOriginal] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const triage = async () => {
    try {
      const r = await api.triage(type, `${title}\n${original}`);
      setAssignee(r.assignee);
      setImportance(r.importance);
    } catch {
      /* noop */
    }
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const id = `${new Date().toISOString().slice(0, 10)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const body = `## 元メッセージ\n${original || "（なし）"}\n\n## ドラフト\n${draft || "（ここに提案を記入）"}\n`;
      await api.createItem({
        id,
        title,
        source,
        audience,
        type,
        project,
        assignee: assignee || undefined,
        importance,
        body,
      });
      onCreated(id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>新規下書き登録</h2>
        {err && <div className="banner error">⚠ {err}</div>}
        <label className="field block">
          <span>タイトル</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: ○○案件の色味確認への打ち返し" />
        </label>
        <div className="grid2">
          <FieldSelect label="入口" value={source} onChange={setSource} options={SOURCES.map((s) => [s, SOURCE_LABELS[s]])} />
          <FieldSelect label="社内/社外" value={audience} onChange={setAudience} options={AUDIENCES.map((a) => [a, AUDIENCE_LABELS[a]])} />
          <FieldSelect label="種類" value={type} onChange={setType} options={TYPES.map((t) => [t, TYPE_LABELS[t]])} />
          <FieldSelect
            label="担当"
            value={assignee}
            onChange={setAssignee}
            options={[["", "（自動振り分け）"], ...ASSIGNEE_ROLES.map((r) => [r, ROLE_LABELS[r]] as [string, string])]}
          />
          <FieldSelect
            label="重要度"
            value={importance}
            onChange={setImportance}
            options={IMPORTANCES.map((i) => [i, IMPORTANCE_LABELS[i]])}
          />
        </div>
        <label className="field block">
          <span>案件名</span>
          <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="例: acme-lp" />
        </label>
        <label className="field block">
          <span>元メッセージ（受信した内容）</span>
          <textarea value={original} onChange={(e) => setOriginal(e.target.value)} onBlur={triage} rows={4} />
        </label>
        <label className="field block">
          <span>ドラフト（打ち返し案）</span>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} />
        </label>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn primary" disabled={busy || !title} onClick={submit}>
            登録
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldSelect({
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
    <label className="field block">
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
