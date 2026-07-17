// ============================================================
// 一元管理の定数（frontmatter検証・GUI絞り込み・受付振り分け・
// .claude/agents 名・役割カードのslug が全てここを参照する）。
// ズレを防ぐため、値の追加・変更はこのファイルだけで行うこと。
// ============================================================

/** 役割エージェント（社員）。assignee に使う。 */
export const ROLES = [
  "reception", // 受付（振り分け）
  "direction", // ディレクションPM
  "design", // デザイン
  "coding", // コーディング
  "maintenance", // 保守管理
  "ciy-pm", // CIY-PM
] as const;
export type Role = (typeof ROLES)[number];

/** 実務で担当割り当て対象になる役割（受付を除く）。 */
export const ASSIGNEE_ROLES = ROLES.filter((r) => r !== "reception");

/** 日本語ラベル。 */
export const ROLE_LABELS: Record<Role, string> = {
  reception: "受付",
  direction: "ディレクションPM",
  design: "デザイン",
  coding: "コーディング",
  maintenance: "保守管理",
  "ciy-pm": "CIY-PM",
};

/** アイテムの種類。 */
export const TYPES = [
  "reply", // 打ち返し（返信文）
  "design", // デザイン提案
  "code", // コーディング
  "investigation", // 調査
  // --- 蒸留の提案（人格・ルール・案件文脈） ---
  "persona_proposal",
  "tone_proposal",
  "project_context_proposal",
] as const;
export type ItemType = (typeof TYPES)[number];

export const TYPE_LABELS: Record<ItemType, string> = {
  reply: "打ち返し",
  design: "デザイン",
  code: "コーディング",
  investigation: "調査",
  persona_proposal: "人格ドラフト",
  tone_proposal: "文体ドラフト",
  project_context_proposal: "案件文脈ドラフト",
};

/** 承認ステータス。revision=要再考 / done=対応済み（対応不要・自分で対応した）。 */
export const STATUSES = [
  "pending",
  "approved",
  "rejected",
  "revision",
  "done",
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  pending: "承認待ち",
  approved: "承認済み",
  rejected: "却下",
  revision: "要再考",
  done: "対応済み",
};

/** 情報の入り口（コミュニケーションツール等）。 */
export const SOURCES = [
  "slack",
  "gmail",
  "asana",
  "chatwork",
  "teams",
  "tokoton",
  "other",
] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_LABELS: Record<Source, string> = {
  slack: "Slack",
  gmail: "メール",
  asana: "Asana",
  chatwork: "チャットワーク",
  teams: "Teams",
  tokoton: "トコトン",
  other: "その他",
};

/** 社内/社外（文体切替）。 */
export const AUDIENCES = ["internal", "external"] as const;
export type Audience = (typeof AUDIENCES)[number];

export const AUDIENCE_LABELS: Record<Audience, string> = {
  internal: "社内",
  external: "社外",
};

/** 重要度（クロスチェック出し分けの入力）。 */
export const IMPORTANCES = ["low", "normal", "high"] as const;
export type Importance = (typeof IMPORTANCES)[number];

export const IMPORTANCE_LABELS: Record<Importance, string> = {
  low: "低",
  normal: "通常",
  high: "高",
};

/** クロスチェック実施者。 */
export const REVIEWED_BY = ["none", "claude", "codex"] as const;
export type ReviewedBy = (typeof REVIEWED_BY)[number];

/** クロスチェック結果。 */
export const REVIEW_STATUSES = ["none", "passed", "changes_requested"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** AI→人間への依頼。kind=decision(方針を仰ぐ) / investigation(調査・作業のお願い)。 */
export interface Ask {
  id: string;
  kind: "decision" | "investigation";
  question: string;
  options?: string[]; // decision時の選択肢（任意）。GUIでボタン化。
  answer?: string; // 人間の回答/報告
  resolved?: boolean;
}

/** アイテムのfrontmatter（管理情報）。本文はMarkdown側。 */
export interface ItemFrontmatter {
  id: string;
  source: Source;
  project: string;
  project_label?: string; // 案件の日本語表示名（未指定なら project を表示）
  due_on?: string; // 期限（Asana等）。カードに表示。
  audience: Audience;
  type: ItemType;
  status: Status;
  title: string;
  createdAt: string;
  updatedAt?: string;
  assignee?: Exclude<Role, "reception">;
  importance?: Importance;
  reviewed_by?: ReviewedBy;
  review_status?: ReviewStatus;
  review_notes?: string;
  contextRefs?: string[];
  source_ref?: string; // 元データ（Asana等）へのリンク。原文検証用。
  apply_target?: string; // 蒸留提案の承認時に反映するファイル（00/10/20の.md）。未指定ならtype/audienceから推定。
  applied_at?: string; // 蒸留提案を反映した日時。二重反映を防ぐ冪等マーカー。
  snooze_until?: string; // スルー（後で）。この日時までは承認待ち一覧から隠し、過ぎたら自動復活。
  thread_key?: string; // メールスレッドの識別キー（正規化件名）。送信済み検知での自動クローズに使う。
  thread_last_id?: string; // スレッド最新メッセージのID。新着検知（リビング・カード）に使う。
  thread_updated?: boolean; // 取り込み後にスレッドへ新着があった印。GUIで「🔄新着あり」を表示。
  asks?: Ask[]; // AI→人間への依頼（方針を仰ぐ／調査・作業のお願い）。GUIで回答。
  // 打ち返し草案の生成状態（GUIの「今すぐ生成」用）。generating=生成中／error=失敗。
  // 完了時はフィールド自体を消す（＝未設定＝生成中でない）。
  draft_status?: "generating" | "error";
  draft_started_at?: string; // 生成開始時刻（停滞検知用）。

  // 蒸留提案のときの出典情報
  distill_source?: Source;
  distill_date_range?: string;
  distill_sample_count?: number;
  distill_account_id?: string;
  distill_uncertainty?: boolean; // 「抽出に不確実性あり」
}

/**
 * 受付の振り分け優先順位（上から評価、最初に一致した役割を assignee）。
 * 迷う場合は direction に寄せ、GUIで人間が付け替え可能。
 */
export function routeAssignee(
  type: ItemType,
  hints?: { maintenance?: boolean; ciy?: boolean }
): Exclude<Role, "reception"> {
  if (type === "code") return "coding";
  if (type === "design") return "design";
  if (hints?.maintenance) return "maintenance";
  if (hints?.ciy) return "ciy-pm";
  return "direction";
}

/**
 * 自動で importance=high に寄せる条件のキーワード群。
 * 契約・金額・法務・対外謝罪・納期変更・公開前デザイン・対外公開文面 等。
 */
export const HIGH_IMPORTANCE_KEYWORDS = [
  "契約",
  "見積",
  "金額",
  "請求",
  "法務",
  "謝罪",
  "クレーム",
  "納期変更",
  "リスケ",
  "公開",
  "リリース",
  "プレス",
];
