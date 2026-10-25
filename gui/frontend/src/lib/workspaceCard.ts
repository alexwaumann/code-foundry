/**
 * The Projects page's workspace cards (docs/notes/workspaces-v2-4-projects-page.md):
 * what a card says about a workspace, the projects it can add, and what "Edit
 * instructions" does. Pure; inputs are the workspaces, projects and threads slices'
 * shapes.
 */
import type { ThreadView } from "@/api/threads";
import type { WorkspaceView } from "@/api/workspace";

/** The default primary that runs new threads in the workspace's own folder. */
export const PRIMARY_WORKSPACE = "workspace";

export type CardWorkspace = Pick<WorkspaceView, "id" | "name" | "members" | "rootPath" | "defaultPrimary" | "managedDir" | "instructions" | "skills">;

/** Where a thread whose primary is the workspace runs: its root when it has one, else its own (managed) folder. */
export function workspaceFolder(ws: Pick<WorkspaceView, "rootPath" | "managedDir">): string {
  return ws.rootPath || ws.managedDir || "";
}

/** The instructions file's name ("CLAUDE.md", "AGENTS.md"), "" when there is none yet. */
export function instructionsName(ws: Pick<WorkspaceView, "instructions">): string {
  const p = ws.instructions ?? "";
  return p ? (p.split("/").pop() ?? p) : "";
}

/**
 * The file "Edit instructions" points the thread at: the instructions file, else
 * CLAUDE.md in the workspace's folder (where Claude Code loads it natively from that cwd).
 */
export function instructionsTarget(ws: Pick<WorkspaceView, "instructions" | "rootPath" | "managedDir">): string {
  if (ws.instructions) return ws.instructions;
  const dir = workspaceFolder(ws);
  return dir ? `${dir.replace(/\/+$/, "")}/CLAUDE.md` : "CLAUDE.md";
}

/**
 * The first message of an "Edit instructions" thread, or the steer sent to one: the
 * file as context, and what the instructions are for. The thread asks the user what to
 * change; it changes nothing on its own.
 */
export function editInstructionsPrompt(ws: Pick<WorkspaceView, "name" | "instructions" | "rootPath" | "managedDir">): string {
  const file = instructionsTarget(ws);
  const skills = `${workspaceFolder(ws).replace(/\/+$/, "")}/.claude/skills`;
  const what = ws.instructions
    ? `Workspace ${ws.name}'s instructions are in ${file}. Read it, then ask me what to change.`
    : `Workspace ${ws.name} has no instructions yet; they go in ${file}. Ask me what they should say, then write it.`;
  return `${what} They reach every thread in the workspace, so keep them to what spans its projects. Its skills go in ${skills}/<name>/SKILL.md.`;
}

/** The two spellings of a path under /tmp or /var on macOS (a symlink to /private/…). */
function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\/+$/, "").replace(/^\/private(?=\/(tmp|var)\/)/, "");
  return norm(a) === norm(b);
}

/**
 * The thread "Edit instructions" steers instead of starting one: the user's most recent
 * thread that references the workspace, runs in its folder (where Claude Code loads the
 * instructions itself) and is not archived. Null: start a new one. One rule only (no
 * "busy" or "connected" check): the steer queues behind a running turn.
 */
export function instructionsThread(threads: { order: readonly string[]; byId: Readonly<Record<string, Pick<ThreadView, "id" | "workspaceId" | "worktreePath" | "archivedAtMs" | "createdBy" | "lastActivityAtMs" | "createdAtMs"> | undefined>> }, ws: Pick<WorkspaceView, "id" | "rootPath" | "managedDir">): string | null {
  const dir = workspaceFolder(ws);
  let best: { id: string; at: number } | null = null;
  for (const id of threads.order) {
    const t = threads.byId[id];
    if (!t || t.workspaceId !== ws.id || t.archivedAtMs !== null || t.createdBy || !samePath(t.worktreePath, dir)) continue;
    const at = t.lastActivityAtMs ?? t.createdAtMs ?? 0;
    if (!best || at > best.at) best = { id: t.id, at };
  }
  return best?.id ?? null;
}

/** Projects a card can add: registered and not yet members, in the projects slice's order (by name). */
export function addableProjects(members: readonly string[], projects: { order: readonly string[]; byId: Readonly<Record<string, unknown>> }): string[] {
  const inWs = new Set(members);
  return projects.order.filter((id) => !inWs.has(id) && projects.byId[id] !== undefined);
}

/** A workspace name as the daemon takes it: trimmed, at most 100 bytes, not "workspace" (the primary keyword); "" when fine. */
export function workspaceNameError(name: string, others: readonly string[] = []): string {
  const n = name.trim();
  if (!n) return "Name it.";
  if (new TextEncoder().encode(n).length > 100) return "At most 100 bytes.";
  if (n.toLowerCase() === PRIMARY_WORKSPACE) return "“workspace” is reserved.";
  if (others.some((o) => o.toLowerCase() === n.toLowerCase())) return `A workspace named “${n}” exists.`;
  return "";
}

/** The card's collapsed summary: "2 projects · 1 skill". */
export function workspaceSummary(ws: Pick<WorkspaceView, "members" | "skills">): string {
  const n = ws.members.length;
  const k = ws.skills?.length ?? 0;
  const head = `${String(n)} ${n === 1 ? "project" : "projects"}`;
  return k === 0 ? head : `${head} · ${String(k)} ${k === 1 ? "skill" : "skills"}`;
}
