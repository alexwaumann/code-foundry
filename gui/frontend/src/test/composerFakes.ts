/**
 * The daemon reads the new-thread composer makes, faked the way the mock answers them:
 * ListRefs (mock/world.ts listRefs over projectsWorld's projects), ListSkills (every
 * project has deploy and review, the user has commit), SearchFiles (nothing), and
 * StageAttachment (a path per staged file, recorded). Wire them in with vi.mock, spreading
 * over the real modules:
 *
 *   vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), ...(await import("@/test/composerFakes")).projectFakes }));
 *   vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), ...(await import("@/test/composerFakes")).filesystemFakes }));
 *   vi.mock("@/api/threads", async (orig) => ({ ...(await orig<typeof import("@/api/threads")>()), ...(await import("@/test/composerFakes")).stageFakes }));
 *
 * Nothing here imports a store or a mocked module, so the factories may import it.
 */
import type { RefsView } from "@/api/project";
import type { SkillSourceView, SkillView } from "@/api/filesystem";

/** One StageAttachment the composer made (a picked or pasted file: its name, type, size and pages). */
export interface StagedFile {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  pages: number;
}

export const composerDaemon = {
  /** ListRefs per project id (mock/world.ts: local branches plus origin's, the default first). */
  refs: new Map<string, RefsView>(),
  staged: [] as StagedFile[],
  /** ListSkills calls: "<project ids> <includeUser>". */
  skillCalls: [] as string[],
};

const ORIGIN = ["main", "release/v0.3", "feat/sidebar"];

function refs(defaultBranch: string, local: readonly string[], origin: readonly string[]): RefsView {
  const names = [...new Set([...local, ...origin])].sort();
  const branches = names.includes(defaultBranch) ? [defaultBranch, ...names.filter((n) => n !== defaultBranch)] : names;
  return { refs: [...local, ...origin.map((b) => `origin/${b}`)], defaultRef: defaultBranch, branches, defaultBranch };
}

/** Resets to the mock's refs: code-foundry with its worktrees and origin's release/v0.3, sketches local only. */
export function resetComposerDaemon(): void {
  composerDaemon.refs.clear();
  composerDaemon.refs.set("repo-cf", refs("main", ["main", "feat/sidebar", "fix/resize"], ORIGIN));
  composerDaemon.refs.set("repo-gp", refs("main", ["main"], ORIGIN));
  composerDaemon.refs.set("repo-dot", refs("main", ["main"], ["main"]));
  composerDaemon.refs.set("repo-sk", refs("main", ["main", "experiment/shaders"], []));
  composerDaemon.staged.length = 0;
  composerDaemon.skillCalls.length = 0;
}
resetComposerDaemon();

export const projectFakes = {
  listRefs: (projectId: string): Promise<RefsView> => {
    const r = composerDaemon.refs.get(projectId);
    return r ? Promise.resolve(r) : Promise.reject(new Error(`project ${projectId} not found`));
  },
};

const PROJECT_SKILLS = [
  { name: "deploy", description: "Ship the current branch to staging." },
  { name: "review", description: "Review the current diff." },
];

export const filesystemFakes = {
  listSkills: (sources: readonly SkillSourceView[], includeUser: boolean): Promise<SkillView[]> => {
    composerDaemon.skillCalls.push(`${sources.map((s) => s.projectId).join(",")} ${String(includeUser)}`);
    const project = sources.flatMap((s) => PROJECT_SKILLS.map<SkillView>((k) => ({ ...k, scope: "project", projectId: s.projectId, path: `/p/${s.projectId}/.claude/skills/${k.name}/SKILL.md` })));
    const user: SkillView[] = includeUser ? [{ name: "commit", description: "Write a commit message and commit.", scope: "user", projectId: "", path: "/Users/dev/.claude/skills/commit/SKILL.md" }] : [];
    return Promise.resolve([...project, ...user]);
  },
  searchFiles: () => Promise.resolve({ matches: [], truncated: false }),
};

export const stageFakes = {
  stageAttachment: async (file: { name: string; type: string; arrayBuffer(): Promise<ArrayBuffer> }, pages: number | null = null): Promise<string> => {
    const size = (await file.arrayBuffer()).byteLength;
    const path = `/mock/attachments/${String(composerDaemon.staged.length + 1)}-${file.name}`;
    composerDaemon.staged.push({ path, name: file.name, mimeType: file.type, size, pages: pages ?? 0 });
    return path;
  },
};

/** The mock's prompts (mock/prompts.ts PROMPT_FIXTURES plus s-r1's two), newest first: thread, its name and project, text, composer text, minutes ago. */
const PROMPTS: readonly [string, string, string, string, string, number][] = [
  ["s-r1", "Fix stale PR badge", "repo-cf", "Looks good. Run the full suite, then push the branch.", "", 5],
  ["s-1", "Refactor sidebar tree", "repo-cf", "Keep the keyboard navigation from Fix resize race", "Keep the keyboard navigation from [Fix resize race](cf-thread://s-3)", 10],
  ["s-r1", "Fix stale PR badge", "repo-cf", "The PR badge in the sidebar stays green after a force-push, see the screenshot", "", 30],
  ["s-1", "Refactor sidebar tree", "repo-cf", "Refactor the sidebar tree into one virtualized list", "", 40],
  ["s-6", "Tidy zshrc", "repo-dot", "Tidy my zshrc: drop the unused aliases", "", 50],
  ["s-3", "Fix resize race", "repo-cf", "Add a test for the resize race and open a PR", "", 100],
  ["s-4", "Investigate flaky e2e", "repo-cf", "Retry with --workers=1", "", 120],
  ["s-3", "Fix resize race", "repo-cf", "Look at src/lib/useResize.ts again", "Look at [useResize.ts](cf-file://repo-cf/src/lib/useResize.ts) again", 180],
  ["s-4", "Investigate flaky e2e", "repo-cf", "Run the e2e suite 20 times and list the specs that fail.", "", 190],
  ["s-3", "Fix resize race", "repo-cf", "The sidebar flickers when the window resizes. Find the race.", "", 290],
];

/** ListPrompts calls: "<scope> <thread or projects> <query>". */
export const promptCalls: string[] = [];

export const promptFakes = {
  /** ThreadService.ListPrompts as the daemon scopes it: one thread, the threads sharing a project (with a thread, or the projects), or all; a case-insensitive substring. */
  listPrompts: (opts: { scope: "thread" | "project" | "all"; threadId?: string; projectIds?: readonly string[]; query?: string; limit?: number }) => {
    promptCalls.push(`${opts.scope} ${opts.threadId ?? (opts.projectIds ?? []).join(",")} ${opts.query ?? ""}`);
    const projectOf = (id: string) => PROMPTS.find((p) => p[0] === id)?.[2] ?? "";
    const projects = opts.scope === "project" ? (opts.threadId ? [projectOf(opts.threadId)] : [...(opts.projectIds ?? [])]) : [];
    const q = (opts.query ?? "").toLowerCase();
    const now = Date.now();
    return Promise.resolve(
      PROMPTS.filter(([threadId, , project, text]) => {
        if (opts.scope === "thread" && threadId !== opts.threadId) return false;
        if (opts.scope === "project" && !projects.includes(project)) return false;
        return text.toLowerCase().includes(q);
      })
        .slice(0, opts.limit ?? 50)
        .map(([threadId, threadName, , text, composerText, ago]) => ({ threadId, threadName, itemId: `u-${String(ago)}`, text, composerText, sentAt: new Date(now - ago * 60_000) })),
    );
  },
};
