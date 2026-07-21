import fs from "node:fs";
import path from "node:path";
import { VAULT_PATH } from "./vault.ts";

// ============================================================
// クライアント照合（案件名の自動判定）
// vault/70_references/clients-index.md の照合表を読み、
// 「メールの送信元ドメイン」または「本文中に出てくる相手のドメイン/URL」から
// 正式なクライアント名を引く。届いた内容を "未分類/保守/GB" のままにせず、
// 実際のクライアント名（project_label）に置き換えるために使う。
// 照合表に載っていない相手は null（＝従来どおりのまま）。
// ============================================================

const INDEX_PATH = path.join(
  VAULT_PATH,
  "70_references",
  "clients-index.md"
);

type ClientEntry = { name: string; domains: string[] };

let cache: ClientEntry[] | null = null;

// 表示名を整える。⚠印・**強調**・前後の空白を落とし、
// 名称ズレ訂正で **正しい社名** が強調されている行はその社名を優先採用する。
function cleanName(col: string): string {
  const bold = col.match(/\*\*(.+?)\*\*/);
  if (bold) return bold[1].trim();
  return col.replace(/^⚠\s*/, "").replace(/\*\*/g, "").trim();
}

// 文字列からドメインらしき語（x.y / x.y.z …）をすべて拾う。
function extractDomains(text: string): string[] {
  const re = /[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+/gi;
  const out = new Set<string>();
  for (const m of text.match(re) ?? []) {
    const d = m.toLowerCase();
    // 末尾がTLDらしい（2文字以上のアルファベット）ものだけ採用
    if (/\.[a-z]{2,}$/.test(d) && d !== "gb-jp.com") out.add(d);
  }
  return [...out];
}

function load(): ClientEntry[] {
  if (cache) return cache;
  let text = "";
  try {
    text = fs.readFileSync(INDEX_PATH, "utf8");
  } catch {
    return (cache = []);
  }
  const entries: ClientEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // | slug | 正式名称 | 主ドメイン | 別ドメイン | 注意 |
    const slug = cells[1] ?? "";
    if (!slug || slug.startsWith("slug") || slug.startsWith("---")) continue;
    const name = cleanName(cells[2] ?? "");
    const domains = extractDomains(`${cells[3] ?? ""} ${cells[4] ?? ""}`);
    if (name && domains.length) entries.push({ name, domains });
  }
  return (cache = entries);
}

// あるドメインが照合表のドメインに一致するか（サブドメインも許容）。
function domainHit(domain: string): string | null {
  const d = domain.toLowerCase().replace(/^.*@/, "").trim();
  if (!d) return null;
  for (const e of load()) {
    for (const id of e.domains) {
      if (d === id || d.endsWith("." + id)) return e.name;
    }
  }
  return null;
}

// 本文中に照合表のドメインが現れていれば、その社名を返す。
function textHit(text: string): string | null {
  const t = text.toLowerCase();
  for (const e of load()) {
    for (const id of e.domains) {
      if (t.includes(id)) return e.name;
    }
  }
  return null;
}

/**
 * カード1件ぶんの手がかりから、クライアントの正式名称を引く。
 * まず送信元メールのドメインで照合し、無ければ本文中のドメイン/URLで照合する。
 * どちらも当たらなければ null（案件名は従来どおり）。
 */
export function matchClientLabel(opts: {
  email?: string;
  text?: string;
}): string | null {
  if (opts.email) {
    const byMail = domainHit(opts.email);
    if (byMail) return byMail;
  }
  if (opts.text) {
    const byText = textHit(opts.text);
    if (byText) return byText;
  }
  return null;
}
