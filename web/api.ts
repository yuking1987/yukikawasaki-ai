import type { ItemFrontmatter, Status } from "../shared/roles.ts";

export interface ItemFull extends ItemFrontmatter {
  body: string;
}

export interface ReferenceMeta {
  slug: string;
  kind: string;
  title: string;
  last_synced?: string;
  updated?: string;
  stale: boolean;
}

export interface ProjectMeta {
  slug: string;
  title: string;
  domain?: string;
  ref: string;
  hasStack: boolean;
  hasPrecedents: boolean;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(msg.error || `エラー (${res.status})`);
  }
  return res.json();
}

export const api = {
  listItems: (params: Record<string, string>) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v)
    ).toString();
    return req<{ items: ItemFrontmatter[] }>(`/api/items${qs ? `?${qs}` : ""}`);
  },
  getItem: (id: string) => req<{ item: ItemFull }>(`/api/items/${id}`),
  createItem: (data: Record<string, unknown>) =>
    req<{ id: string }>(`/api/items`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateBody: (id: string, body: string, patch?: Record<string, unknown>) =>
    req<{ ok: true }>(`/api/items/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ body, ...patch }),
    }),
  setStatus: (
    id: string,
    status: Status,
    note?: string,
    expectedThreadLastId?: string
  ) =>
    req<{
      ok: true;
      applied?: { applied: boolean; already?: boolean; target?: string; msg?: string };
    }>(`/api/items/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify(
        expectedThreadLastId === undefined
          ? { status, note }
          : { status, note, expected_thread_last_id: expectedThreadLastId }
      ),
    }),
  saveRuleCandidate: (id: string, title: string, body: string) =>
    req<{ id: string }>(`/api/rule-candidates`, {
      method: "POST",
      body: JSON.stringify({ id, title, body }),
    }),
  snooze: (id: string, until: string | null) =>
    req<{ ok: true }>(`/api/items/${id}/snooze`, {
      method: "PATCH",
      body: JSON.stringify({ until }),
    }),
  answerAsk: (id: string, askId: string, answer: string) =>
    req<{ ok: true }>(`/api/items/${id}/asks/${askId}`, {
      method: "PATCH",
      body: JSON.stringify({ answer }),
    }),
  getContext: (refs: string[]) =>
    req<{ contexts: { ref: string; content?: string; error?: string }[] }>(
      `/api/context?refs=${encodeURIComponent(refs.join(","))}`
    ),
  listReferences: () => req<{ references: ReferenceMeta[] }>(`/api/references`),
  getReference: (slug: string) =>
    req<{ slug: string; pointer: string; cache: { file: string; content: string }[] }>(
      `/api/references/${encodeURIComponent(slug)}`
    ),
  listProjects: () =>
    req<{ projects: ProjectMeta[] }>(`/api/projects`),
  triage: (type: string, text: string) =>
    req<{ assignee: string; importance: string }>(`/api/triage`, {
      method: "POST",
      body: JSON.stringify({ type, text }),
    }),
  health: () => req<{ ok: boolean; bootId?: string }>(`/api/health`),
  syncStatus: () => req<{ status: Record<string, string> }>(`/api/sync-status`),
  avatars: () => req<{ avatars: Record<string, string> }>(`/api/avatars`),
  getRules: () => req<{ text: string; ignore: string[] }>(`/api/rules`),
  addRule: (text: string, ignoreKeyword: string) =>
    req<{ ok: boolean; text: string; ignore: string[] }>(`/api/rules`, {
      method: "POST",
      body: JSON.stringify({ text, ignoreKeyword }),
    }),
};
