/**
 * The composer's draft as it travels with a thread through its setup
 * (docs/notes/instant-threads-4-composer.md): sending hands the daemon a snapshot it never
 * reads (CreateThreadRequest.draft_json), and the setup's Edit gets it back to fill the
 * composer again. Pure. Versioned, and read defensively: the daemon keeps it on a row across
 * restarts and updates, and a thread made by the CLI has none. The prompt never depends on
 * it: Discard also returns the first message as sent, which is what a snapshot without one
 * falls back to.
 */
import type { Citation } from "./citation";
import { PERMISSION_CHOICES, type ComposePermission, type ComposeTarget, type WorktreeChoice } from "./compose";
import { parsePrompt, serializePrompt, type PromptPiece } from "./prompt";
import type { SentMessage } from "./failedPrompt";

/** The snapshot format this GUI writes. A snapshot of another version is unreadable: `first` stands in. */
export const SETUP_DRAFT_VERSION = 1;

/** The daemon's cap on draft_json, in bytes (internal/store/thread setup.go MaxDraftJSON). */
export const MAX_DRAFT_JSON_BYTES = 1 << 20;

/** A staged attachment of a snapshot: `id` is the one the text's chips name. */
export interface SetupDraftAttachment {
  id: string;
  path: string;
  name: string;
  kind: "image" | "pdf";
  pages: number | null;
}

/** What restores a draft. */
export interface SetupDraft {
  v: typeof SETUP_DRAFT_VERSION;
  target: ComposeTarget;
  /** The prompt with its tags as tokens; null when it was left out to fit the cap (Discard's `first` has it). */
  text: string | null;
  attachments: readonly SetupDraftAttachment[];
  citations: Readonly<Record<string, Citation>>;
  model: string | null;
  effort: string | null;
  permission: ComposePermission | null;
  worktree: WorktreeChoice | null;
  base: string | null;
  projects: readonly string[] | null;
  workspace: string | null;
  primary: string | null;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * The snapshot as draft_json. Over the cap the prompt and the citations go, which is what
 * makes one large, and Discard's `first` brings the prompt back; what is left is the
 * options. "" if even that does not fit: the send must not fail on it.
 */
export function encodeSetupDraft(d: SetupDraft, cap = MAX_DRAFT_JSON_BYTES): string {
  const whole = JSON.stringify(d);
  if (byteLength(whole) <= cap) return whole;
  const lean = JSON.stringify({ ...d, text: null, citations: {} } satisfies SetupDraft);
  return byteLength(lean) <= cap ? lean : "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function targetOf(v: unknown): ComposeTarget | null {
  if (!isRecord(v)) return null;
  if (v.kind === "project" && typeof v.projectId === "string" && v.projectId) return { kind: "project", projectId: v.projectId };
  if (v.kind === "workspace" && typeof v.workspaceId === "string" && v.workspaceId) return { kind: "workspace", workspaceId: v.workspaceId };
  if (v.kind === "like" && typeof v.threadId === "string" && v.threadId) return { kind: "like", threadId: v.threadId };
  return v.kind === "home" ? { kind: "home" } : null;
}

function worktreeOf(v: unknown): WorktreeChoice | null {
  if (!isRecord(v)) return null;
  if (v.kind === "new" || v.kind === "current") return { kind: v.kind };
  if (v.kind === "branch" && typeof v.name === "string" && v.name) return { kind: "branch", name: v.name };
  if (v.kind === "existing" && typeof v.path === "string" && v.path) return { kind: "existing", path: v.path };
  return null;
}

function attachmentsOf(v: unknown): SetupDraftAttachment[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((a: unknown): SetupDraftAttachment[] => {
    if (!isRecord(a) || typeof a.path !== "string" || !a.path || typeof a.id !== "string") return [];
    return [{ id: a.id, path: a.path, name: typeof a.name === "string" ? a.name : "", kind: a.kind === "pdf" ? "pdf" : "image", pages: typeof a.pages === "number" ? a.pages : null }];
  });
}

function citationsOf(v: unknown): Record<string, Citation> {
  if (!isRecord(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, Citation] => isRecord(e[1]) && e[1].id === e[0] && typeof e[1].text === "string"));
}

/** A draft_json back; null when there is none or it cannot be read. A field that makes no sense reads as not set. */
export function parseSetupDraft(json: string): SetupDraft | null {
  if (!json) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(v) || v.v !== SETUP_DRAFT_VERSION) return null;
  const target = targetOf(v.target);
  if (!target) return null;
  const permission = PERMISSION_CHOICES.find((p) => p.value === v.permission)?.value ?? null;
  return {
    v: SETUP_DRAFT_VERSION,
    target,
    text: stringOrNull(v.text),
    attachments: attachmentsOf(v.attachments),
    citations: citationsOf(v.citations),
    model: stringOrNull(v.model),
    effort: stringOrNull(v.effort),
    permission,
    worktree: worktreeOf(v.worktree),
    base: stringOrNull(v.base),
    projects: Array.isArray(v.projects) ? v.projects.filter((p): p is string => typeof p === "string") : null,
    workspace: stringOrNull(v.workspace),
    primary: stringOrNull(v.primary),
  };
}

/** The draft's text with each attachment chip pointing at idOf(its id); a chip whose attachment did not come back goes. */
export function remapAttachmentChips(text: string, idOf: (id: string) => string | undefined): string {
  const lines = parsePrompt(text).map((line) =>
    line.flatMap((p): PromptPiece[] => {
      if (p.kind !== "tag" || p.tagKind !== "image") return [p];
      const id = idOf(p.id);
      return id === undefined ? [] : [{ ...p, id }];
    }),
  );
  return serializePrompt(lines);
}

/** thread.setup.discard's result. */
export interface DiscardedSetup {
  draftJson: string;
  /** Why the setup failed; "" after a cancel. */
  error: string;
  first: SentMessage | null;
  queued: readonly SentMessage[];
  keptWorktrees: readonly string[];
}

function sentOf(v: unknown): SentMessage | null {
  if (!isRecord(v)) return null;
  const attachments = Array.isArray(v.attachments) ? v.attachments.filter((a): a is string => typeof a === "string") : [];
  return { text: typeof v.text === "string" ? v.text : "", composerText: typeof v.composerText === "string" ? v.composerText : "", attachments };
}

/** thread.setup.discard's result JSON; a result that cannot be read gives nothing back rather than failing the Edit. */
export function parseDiscardedSetup(json: string): DiscardedSetup {
  let v: unknown = null;
  try {
    v = JSON.parse(json || "null");
  } catch {
    // Nothing to read: the caller says the prompt is gone.
  }
  const r = isRecord(v) ? v : {};
  return {
    draftJson: typeof r.draftJson === "string" ? r.draftJson : "",
    error: typeof r.error === "string" ? r.error : "",
    first: sentOf(r.first),
    queued: Array.isArray(r.queued) ? r.queued.flatMap((q) => sentOf(q) ?? []) : [],
    keptWorktrees: Array.isArray(r.keptWorktrees) ? r.keptWorktrees.filter((p): p is string => typeof p === "string") : [],
  };
}
