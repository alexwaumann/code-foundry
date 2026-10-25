import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowUp, Brain, Folder, FolderGit2, FolderOpen, Gauge, GitBranch, GitBranchPlus, GitCommitHorizontal, Layers, Loader2, Paperclip, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { AttachmentPreview } from "./AttachmentPreview";
import { PdfTile } from "./attachmentFaces";
import { attachLabel, useHostFiles } from "./useHostFiles";
import { BranchIndicator } from "./BranchIndicator";
import { ComposerPicker, type PickerGroup } from "./ComposerPicker";
import { CompletionCard } from "./CompletionCard";
import { MemberChips, type MemberChipModel } from "./MemberChips";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { PromptEditor, type EditorTrigger, type PromptEditorHandle } from "./PromptEditor";
import { TagMultiProjectContext } from "./tagContext";
import { useCollisionHints } from "./useCollisionHints";
import { useCompletion, useFileSource, useSkillSource, type CompletionSource } from "./useCompletion";
import { useMentionSource, useProjectSlugs, usePrSource } from "./useRefSources";
import { NoGitBadge } from "@/components/projects/NoGitBadge";
import { useThreadCheckouts } from "@/components/thread/useThreadCheckouts";
import { ATTACHMENT_MIME_TYPES } from "@/api/threads";
import { Backdrop } from "@/components/backdrop/Backdrop";
import { Tip } from "@/components/ui/tooltip";
import { DragBand } from "@/components/window/DragBand";
import { draftCheckouts, mainCheckout, threadCheckouts, type HintProject } from "@/lib/collisionHints";
import {
  choiceLabel,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  defaultWorktree,
  draftKey as keyOf,
  EFFORT_CHOICES,
  NEW_BRANCH,
  previewLabel,
  PERMISSION_CHOICES,
  pickDefault,
  projectChipBranch,
  setWorkIn,
  WORK_IN_SETTING_KEY,
  workInText,
  type ComposePermission,
  type ComposeTarget,
  type WorktreeChoice,
} from "@/lib/compose";
import { fileSources, skillSources, skillSourcesKey, type TriggerChar } from "@/lib/completion";
import { tildify } from "@/lib/path";
import { primaryOptions, resolveSet, setName, WORKSPACE_PRIMARY, type ResolvedSet } from "@/lib/projectSet";
import { NO_PROJECT } from "@/lib/threadRow";
import { formatAttachmentSize, isReferenced } from "@/lib/prompt";
import { cn } from "@/lib/utils";
import {
  addAttachments,
  getDraft,
  isDraftEmpty,
  loadRefs,
  noGitCheckout,
  openPreview,
  removeAttachment,
  sendDraft,
  setPrimary,
  updateDraft,
  useComposeStore,
  useDraft,
  type DraftAttachment,
  type DraftPhase,
} from "@/stores/compose";
import { requestConfirm } from "@/stores/confirm";
import { useProjectsStore } from "@/stores/projects";
import { useModelChoices, useSettingValue } from "@/stores/settings";
import { loadSkills } from "@/stores/skills";
import { useThreadsStore } from "@/stores/threads";
import { DASHBOARD, useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";

const SEP = "\u0001";

/** What starts a completion in the prompt: "/" for skills, "@" for threads and files, "#" for pull requests. */
const TRIGGERS: readonly TriggerChar[] = ["/", "@", "#"];
/**
 * Without a project "/" and "@" for threads only: files would come from the home
 * directory, which is never indexed, and there is no repository for "#".
 */
const HOME_TRIGGERS: readonly TriggerChar[] = ["/", "@"];

/** Model and effort the composer starts with: the settings defaults, else opus / high. */
function useDefaults(): { model: string; effort: string } {
  const model = pickDefault(useModelChoices(), useSettingValue("threads.default_model"), DEFAULT_MODEL);
  const effort = pickDefault(EFFORT_CHOICES, useSettingValue("threads.default_effort"), DEFAULT_EFFORT);
  return useMemo(() => ({ model, effort }), [model, effort]);
}

interface WorktreeOption {
  path: string;
  /** "" when detached. */
  branch: string;
  head: string;
  detached: boolean;
  isMain: boolean;
}

/** The branch name a worktree goes by in the picker: its branch, else its short head. */
function worktreeName(w: WorktreeOption): string {
  return w.branch || w.head.slice(0, 7);
}

/** The project's worktrees (main first), as a shallow-stable list that follows branch changes live. */
function useWorktrees(projectId: string): WorktreeOption[] {
  const keys = useProjectsStore(
    useShallow((s) => (s.byId[projectId]?.worktrees ?? []).map((w) => [w.path, w.branch, w.head, w.detached ? "1" : "", w.isMain ? "1" : ""].join(SEP))),
  );
  return useMemo(
    () =>
      keys.map((k) => {
        const [path = "", branch = "", head = "", detached = "", main = ""] = k.split(SEP);
        return { path, branch, head, detached: detached === "1", isMain: main === "1" };
      }),
    [keys],
  );
}

/** A single project's choice resolved: "current" is its main checkout; a worktree that is gone is a new one. */
function resolveWorktree(choice: WorktreeChoice, worktrees: readonly WorktreeOption[]): WorktreeChoice {
  if (choice.kind === "current") {
    const main = worktrees.find((w) => w.isMain);
    return main ? { kind: "existing", path: main.path } : { kind: "new" };
  }
  return choice.kind === "existing" && !worktrees.some((w) => w.path === choice.path) ? { kind: "new" } : choice;
}

/** What the send button says while busy: new worktrees (one per git project of a set), or starting. */
function phaseText(phase: DraftPhase, newWorktrees: number): string {
  if (phase === "attaching") return "Attaching files…";
  if (newWorktrees > 1) return "Creating worktrees…";
  return newWorktrees === 1 ? "Creating worktree…" : "Starting Claude…";
}

/**
 * A draft's set (lib/projectSet resolveSet) from narrow selectors: the draft's picks, the
 * registered project ids, and the referenced (and the target's) workspace's members and
 * default primary. Its workspace's name too.
 */
function useDraftSet(target: ComposeTarget, key: string): { set: ResolvedSet; workspaceName: string } {
  const projects = useDraft(key, "projects");
  const workspace = useDraft(key, "workspace");
  const primary = useDraft(key, "primary");
  const known = useProjectsStore(useShallow((s) => s.order));
  const targetWs = target.kind === "workspace" ? target.workspaceId : "";
  const wsId = workspace ?? targetWs;
  const wsKey = useWorkspacesStore(
    useShallow((s) => {
      const w = s.byId[wsId];
      return w ? [w.name, w.defaultPrimary ?? "", ...w.members.map((m) => m.projectId)] : [];
    }),
  );
  const targetMembers = useWorkspacesStore(useShallow((s) => (targetWs ? (s.byId[targetWs]?.members ?? []).map((m) => m.projectId) : [])));
  return useMemo(() => {
    const [name = "", defaultPrimary = "", ...members] = wsKey;
    const defaults = target.kind === "project" ? { projects: [target.projectId], workspace: "" } : target.kind === "workspace" ? { projects: targetMembers, workspace: targetWs } : { projects: [], workspace: "" };
    const set = resolveSet({ projects, workspace, primary }, defaults, {
      known: (id) => known.includes(id),
      workspace: (id) => (id === wsId && wsKey.length > 0 ? { members, defaultPrimary } : undefined),
    });
    return { set, workspaceName: name };
  }, [target, projects, workspace, primary, known, wsId, wsKey, targetMembers, targetWs]);
}

/** A project's name (its id when the store does not know it), for labels built in hooks. */
function useProjectNames(ids: readonly string[]): (id: string) => string {
  const names = useProjectsStore(useShallow((s) => ids.map((id) => s.byId[id]?.name ?? id)));
  return useCallback((id: string) => names[ids.indexOf(id)] ?? id, [ids, names]);
}

/**
 * The chips of a set: one per project by id. New worktrees: "cf/…" on every git project,
 * the No git badge on a plain folder. In place: each project's own checkout's branch (the
 * primary's chosen worktree for a lone project). `branchOf` overrides the branch (a like
 * draft's: the thread's branch, or its checkouts').
 */
function useSetChips(projectIds: readonly string[], newWorktrees: boolean, removable: boolean, branchOf?: (id: string) => string | undefined): MemberChipModel[] {
  const keys = useProjectsStore(
    useShallow((s) =>
      projectIds.map((id) => {
        const p = s.byId[id];
        const main = p?.worktrees.find((w) => w.isMain);
        return [p?.git === false ? "1" : "", main ? main.branch || main.head.slice(0, 7) : ""].join(SEP);
      }),
    ),
  );
  return useMemo(
    () =>
      projectIds.map((projectId, i) => {
        const [noGit = "", mainBranch = ""] = (keys[i] ?? "").split(SEP);
        if (noGit === "1") return { projectId, branch: "", noGit: true, removable };
        const branch = branchOf?.(projectId) ?? (newWorktrees ? NEW_BRANCH : mainBranch);
        return { projectId, branch, removable };
      }),
    [projectIds, keys, newWorktrees, removable, branchOf],
  );
}

/** The collision hints under the chips (lib/collisionHints): muted, never a blocker. */
function Hints({ hints }: { hints: readonly string[] }) {
  if (hints.length === 0) return null;
  return (
    <ul className="mb-2 flex flex-col gap-0.5 px-1" aria-label="Shared checkouts" data-testid="composer-hints">
      {hints.map((h) => (
        <li key={h} className="flex items-start gap-1.5 text-caption text-cf-text-muted" data-testid="composer-hint">
          <TriangleAlert className="mt-0.5 size-3 shrink-0 text-cf-warning-text" aria-hidden />
          <span className="min-w-0">{h}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The like draft's thread ("New thread on this branch"): its set (primary first for "/"
 * and "@"), the checkout of each, its branch, mode, workspace and own primary.
 */
function useLikeSource(threadId: string) {
  const { projectIds, paths } = useThreadCheckouts(threadId);
  const ids = useThreadsStore(useShallow((s) => s.byId[threadId]?.projectIds ?? []));
  const branch = useThreadsStore((s) => s.byId[threadId]?.branch ?? "");
  const worktreeMode = useThreadsStore((s) => s.byId[threadId]?.createdWorktree ?? false);
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.workspaceId ?? "");
  const projectId = useThreadsStore((s) => s.byId[threadId]?.projectId ?? "");
  const name = useThreadsStore((s) => s.byId[threadId]?.name ?? "");
  const own = projectId || (workspaceId ? WORKSPACE_PRIMARY : "");
  return { projectIds, sorted: ids, paths, branch, worktreeMode, workspaceId, own, name };
}

/**
 * Removes an attachment from the draft. Still referenced by a chip in the text: asks
 * first, then removes the attachment and every reference; unreferenced: removes it at once.
 */
async function removeWithConfirm(key: string, a: DraftAttachment, refocus: () => void): Promise<void> {
  if (isReferenced(getDraft(key).text, a.id)) {
    const yes = await requestConfirm({
      title: `Remove ${a.file.name} from the message?`,
      message: "It is referenced in your text; removing it also removes every reference.",
      confirmLabel: "Confirm",
      centered: true,
    });
    if (!yes) return;
  }
  removeAttachment(key, a.id);
  refocus();
}

/** What the composers' file pickers offer: the accepted types, and any file named .pdf. */
export const ATTACHMENT_ACCEPT = `image/*,${ATTACHMENT_MIME_TYPES.join(",")},.pdf`;


/** A draft's attachment tiles (preview on click, × to remove); also a thread's follow-up composer's. */
export function Attachments({ draftKey, disabled, refocus }: { draftKey: string; disabled: boolean; refocus: () => void }) {
  const attachments = useDraft(draftKey, "attachments");
  if (attachments.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attachments">
      {attachments.map((a) => (
        <li
          key={a.id}
          className="group relative size-16 overflow-hidden rounded-md border bg-cf-surface-sunken/40"
          data-testid="attachment"
          data-attachment-id={a.id}
          data-kind={a.kind}
          data-pages={a.pages ?? undefined}
        >
          <button
            type="button"
            aria-label={previewLabel(a.file.name, a.kind, a.pages, formatAttachmentSize(a.file.size))}
            aria-haspopup="dialog"
            data-testid="attachment-open"
            className="block size-full cursor-pointer rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 focus-visible:ring-inset"
            onClick={(e) => {
              openPreview(draftKey, a.id, e.currentTarget);
            }}
          >
            {a.kind === "pdf" ? <PdfTile thumb={a.thumb} /> : <img src={a.url} alt={a.file.name} draggable={false} className="size-full object-cover" />}
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove ${a.file.name}`}
            className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-black/70 text-white opacity-80 hover:opacity-100 focus-visible:opacity-100 disabled:hidden"
            onClick={() => {
              void removeWithConfirm(draftKey, a, refocus);
            }}
          >
            <X className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function filesOf(list: FileList | null | undefined): File[] {
  return list ? Array.from(list) : [];
}

/**
 * Tab and Shift+Tab between the composer's stops (prompt, pickers, attach, send). WebKit
 * on macOS skips buttons on Tab unless "Keyboard navigation" is on in System Settings,
 * which would leave the pickers unreachable from the keyboard in the Wails window.
 * Past either end, Tab behaves normally.
 */
function cycleStops(e: React.KeyboardEvent<HTMLElement>): void {
  if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
  const stops = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-compose-stop]")).filter((el) => !(el as HTMLButtonElement).disabled);
  const i = stops.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  const next = stops[i + (e.shiftKey ? -1 : 1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

/** Work in: where a project's thread runs. The picker's copy (docs/notes/onboarding-3-work-in.md). */
const FRESH_COPY = "A fresh copy of the project";
const FRESH_COPY_DETAIL = "Its own folder and branch (cf/…, named from your prompt). Run several threads at once; keep or discard each one.";
const IN_PLACE = "The project folder itself";
const WORK_IN_FOOTER = "Default for new threads: Settings › Threads › New threads work in";
/** A set's Work in choices: one new branch with a worktree in every repository, or every project's own folder. */
const FRESH_COPIES = "A fresh copy of every project";
const FRESH_COPIES_DETAIL = "One new branch (cf/…, named from your prompt) with a worktree in every repository; folders are shared.";
const ALL_IN_PLACE = "Each project's own folder";
const ALL_IN_PLACE_DETAIL = "Edits land in every project's checkout directly. One thread at a time is safest.";

function inPlaceDetail(path: string): string {
  return `Edits land in ${tildify(path)} directly. One thread at a time is safest.`;
}

/**
 * The project chips (MemberChips) and the collision hints above the card. The card:
 * attachments, the prompt, the model/effort/permission pickers, attach and send; below it
 * the Work in picker (where the thread runs), the Runs in picker for a set (its primary:
 * a project, or the workspace's folder) and the base-ref picker for new worktrees, or the
 * chosen worktree's branch (read-only, not a Tab stop). Grid placement keeps the send
 * button inside the card while Tab goes textarea → pickers → send; the chips come before
 * the prompt.
 *
 * A lone project (no workspace): a fresh copy, the project folder itself, or an existing
 * worktree (the default from stores/compose projectWorktree). A set (several projects, or
 * a workspace): fresh copies on one new branch, or every project's own checkout; the base
 * picker lists the primary's refs and applies to it, the others branch from their
 * defaults. A like draft ("New thread on this branch") shows what thread.new-like copies
 * (the set, branch, workspace and mode, read-only) and lets only the primary change.
 */
function ComposerCard({ target, set, workspaceName }: { target: ComposeTarget; set: ResolvedSet; workspaceName: string }) {
  const draftKey = keyOf(target);
  const defaults = useDefaults();
  const modelChoices = useModelChoices();
  const modelGroups = useMemo(() => [{ options: modelChoices }], [modelChoices]);
  const text = useDraft(draftKey, "text");
  const hasAttachments = useDraft(draftKey, "attachments").length > 0;
  const model = useDraft(draftKey, "model") ?? defaults.model;
  const effort = useDraft(draftKey, "effort") ?? defaults.effort;
  const permission = useDraft(draftKey, "permission");
  const choice = useDraft(draftKey, "worktree");
  const baseChoice = useDraft(draftKey, "base");
  const primaryChoice = useDraft(draftKey, "primary");
  const phase = useDraft(draftKey, "phase");
  const error = useDraft(draftKey, "error");
  const notice = useDraft(draftKey, "notice");
  const workInSetting = useSettingValue(WORK_IN_SETTING_KEY);
  const focusSeq = useUiStore((s) => s.composerFocusSeq);
  const editorRef = useRef<PromptEditorHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const busy = phase !== "idle";
  // No project: no worktree, base, branch or chips; "/" completes, "@" does not.
  const home = target.kind === "home";
  const like = target.kind === "like";
  const likeSrc = useLikeSource(like ? target.threadId : "");
  // Where the thread runs: the set's primary, or a like draft's pick over its thread's own.
  const primary = like ? (primaryChoice && (primaryChoice === likeSrc.own || likeSrc.sorted.includes(primaryChoice) || (primaryChoice === WORKSPACE_PRIMARY && likeSrc.workspaceId)) ? primaryChoice : likeSrc.own) : set.primary;
  const primaryProject = primary === WORKSPACE_PRIMARY ? "" : primary;
  const isSet = !like && set.isSet;
  const single = !like && !home && !set.isSet ? (set.projectIds[0] ?? "") : "";
  const worktrees = useWorktrees(single);
  const mainPath = worktrees.find((w) => w.isMain)?.path;
  // A project without git runs threads in its folder only: In place, no base.
  const noGitPath = useProjectsStore((s) => noGitCheckout(s.byId[single]));
  const primaryGit = useProjectsStore((s) => s.byId[primaryProject]?.git === true);
  const refsStatus = useComposeStore((s) => s.refs[primaryProject]?.status ?? "loading");
  const refsError = useComposeStore((s) => s.refs[primaryProject]?.error ?? null);
  const refsOutdated = useComposeStore((s) => s.refs[primaryProject]?.outdated ?? false);
  const refs = useComposeStore((s) => s.refs[primaryProject]?.refs);
  const defaultRef = useComposeStore((s) => s.refs[primaryProject]?.defaultRef ?? "");

  const setMode = setWorkIn(choice, workInSetting);
  const worktree: WorktreeChoice = like
    ? likeSrc.worktreeMode
      ? { kind: "new" }
      : { kind: "current" }
    : isSet
      ? { kind: setMode }
      : noGitPath !== undefined
        ? { kind: "existing", path: noGitPath }
        : resolveWorktree(choice ?? defaultWorktree({ setting: workInSetting, mainPath }), worktrees);
  const chosen = !isSet && worktree.kind === "existing" ? worktrees.find((w) => w.path === worktree.path) : undefined;
  const projectNames = useProjectNames(like ? likeSrc.sorted : set.projectIds);
  const gitCount = useProjectsStore((s) => (isSet && worktree.kind === "new" ? set.projectIds.filter((id) => s.byId[id]?.git === true).length : 0));
  const newWorktrees = home || like || worktree.kind !== "new" ? 0 : isSet ? gitCount : 1;
  const base = baseChoice ?? defaultRef;
  const canSend = !busy && (text.trim() !== "" || hasAttachments);
  const showBase = !like && worktree.kind === "new" && (isSet ? primaryGit : noGitPath === undefined);

  // "/" and "@": the set's projects (the primary first), each read from the checkout the
  // thread will see: a lone project's chosen worktree, a like draft's thread's checkouts,
  // else the main worktree (new worktrees start from it).
  const existingPath = !isSet && worktree.kind === "existing" ? worktree.path : "";
  const sourceIds = useMemo(() => {
    const ids = like ? likeSrc.sorted : set.projectIds;
    return primaryProject && ids.includes(primaryProject) ? [primaryProject, ...ids.filter((id) => id !== primaryProject)] : [...ids];
  }, [like, likeSrc.sorted, set.projectIds, primaryProject]);
  const sourcePaths = useMemo<Readonly<Record<string, string>>>(
    () => (like ? likeSrc.paths : single && existingPath ? { [single]: existingPath } : {}),
    [like, likeSrc.paths, single, existingPath],
  );
  const sources = useMemo(() => skillSources({ projectIds: sourceIds, paths: sourcePaths }), [sourceIds, sourcePaths]);
  useEffect(() => {
    void loadSkills(sources);
  }, [sources]);
  const fileSrcs = useMemo(() => fileSources({ projectIds: sourceIds, paths: sourcePaths }), [sourceIds, sourcePaths]);
  const primaryMain = useProjectsStore((s) => {
    const p = s.byId[primaryProject];
    return p ? mainCheckout(p) : "";
  });
  // Native drops and the native open panel (in the Wails host); the panel opens in the
  // checkout the thread will work in, the primary's main checkout for new worktrees, else home.
  const hostFiles = useHostFiles({ draftKey, editorRef, disabled: busy, startDir: existingPath || sourcePaths[primaryProject] || primaryMain || "" });
  const [trigger, setTrigger] = useState<EditorTrigger | null>(null);
  const skillSource = useSkillSource(trigger, skillSourcesKey(sources), sourceIds);
  const fileSource = useFileSource(trigger, fileSrcs, sourceIds, primaryProject);
  const mentionSource = useMentionSource(trigger, home ? null : fileSource, "");
  const prSource = usePrSource(trigger, useProjectSlugs(sourceIds));
  const bySource: Record<TriggerChar, CompletionSource> = { "/": skillSource, "@": mentionSource, "#": prSource };
  const completion = useCompletion(trigger, setTrigger, bySource[trigger?.char ?? "/"], editorRef);

  useEffect(() => {
    if (primaryProject && primaryGit && !like) void loadRefs(primaryProject);
  }, [primaryProject, primaryGit, like]);

  // Focus on mount and on request (the picker, the sidebar "+"). Deferred a frame so the
  // closing palette dialog has released focus.
  useEffect(() => {
    const raf = requestAnimationFrame(() => editorRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [focusSeq]);

  // Back to editable after a failed send: the prompt takes focus again.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) editorRef.current?.focus();
    wasBusy.current = busy;
  }, [busy]);

  // The collision hints: the checkouts this thread would share with another thread.
  const hintSetIds = like ? likeSrc.sorted : set.projectIds;
  const likeThreadId = like ? target.threadId : "";
  const likeKey = like ? [likeSrc.own, likeSrc.branch, likeSrc.worktreeMode ? "1" : ""].join(SEP) : "";
  const mine = useCallback(
    (projects: Readonly<Record<string, HintProject>>) => {
      if (home) return { checkouts: [], worktreeMode: false };
      if (likeThreadId) {
        const [own = "", branch = "", wt = ""] = likeKey.split(SEP);
        const t = { id: likeThreadId, name: "", projectId: own === WORKSPACE_PRIMARY ? "" : own, projectIds: hintSetIds, worktreePath: likeSrc.paths[own] ?? "", createdWorktree: wt === "1", branch, archived: false };
        return { checkouts: threadCheckouts(t, projects), worktreeMode: wt === "1" };
      }
      if (single) return { checkouts: draftCheckouts({ projectIds: [single], primary: single, worktreeMode: worktree.kind === "new", primaryPath: existingPath }, projects), worktreeMode: worktree.kind === "new" };
      return { checkouts: draftCheckouts({ projectIds: hintSetIds, primary, worktreeMode: worktree.kind === "new" }, projects), worktreeMode: worktree.kind === "new" };
    },
    [home, likeThreadId, likeKey, hintSetIds, likeSrc.paths, single, worktree.kind, existingPath, primary],
  );
  const hints = useCollisionHints(mine);

  const send = () => {
    if (canSend) void sendDraft(target, defaults);
  };

  /** Pasted, dropped or picked files: thumbnails, and chips at the caret. */
  const attach = (files: File[]) => {
    const added = addAttachments(draftKey, files);
    editorRef.current?.insertChips(added.map((a) => ({ id: a.id, name: a.file.name })));
  };
  const refocus = () => editorRef.current?.focus();

  const worktreeGroups = useMemo<PickerGroup[]>(() => {
    if (isSet) {
      return [
        {
          heading: "Work in",
          options: [
            { value: "new", label: FRESH_COPIES, tag: "new worktrees", detail: FRESH_COPIES_DETAIL, wrap: true },
            { value: "current", label: ALL_IN_PLACE, tag: "in place", detail: ALL_IN_PLACE_DETAIL, wrap: true },
          ],
        },
      ];
    }
    if (noGitPath !== undefined) {
      return [{ heading: "Work in", options: [{ value: noGitPath, label: IN_PLACE, tag: "no git", detail: inPlaceDetail(noGitPath), wrap: true }] }];
    }
    const main = worktrees.find((w) => w.isMain);
    return [
      {
        heading: "Work in",
        options: [
          { value: "new", label: FRESH_COPY, tag: "new worktree", detail: FRESH_COPY_DETAIL, wrap: true },
          ...(main ? [{ value: main.path, label: IN_PLACE, tag: worktreeName(main), detail: inPlaceDetail(main.path), wrap: true }] : []),
        ],
      },
      {
        heading: "An existing copy",
        separated: true,
        options: worktrees.filter((w) => !w.isMain).map((w) => ({ value: w.path, label: worktreeName(w), detail: tildify(w.path) })),
      },
    ];
  }, [isSet, worktrees, noGitPath]);

  // A like draft: the thread's branch on every git project in worktree mode, else each checkout's.
  const likeBranches = useProjectsStore(
    useShallow((s) =>
      likeSrc.sorted.map((id) => {
        const path = likeSrc.paths[id] ?? "";
        const w = s.byId[id]?.worktrees.find((x) => x.path === path);
        return w ? w.branch || w.head.slice(0, 7) : "";
      }),
    ),
  );
  const likeBranchOf = useCallback(
    (id: string) => (likeSrc.worktreeMode && likeSrc.branch ? likeSrc.branch : likeBranches[likeSrc.sorted.indexOf(id)]),
    [likeSrc.worktreeMode, likeSrc.branch, likeBranches, likeSrc.sorted],
  );
  const setChips = useSetChips(like ? likeSrc.sorted : set.projectIds, worktree.kind === "new", !like && (set.projectIds.length > 1 || set.workspaceId !== ""), like ? likeBranchOf : undefined);
  const singleChip = projectChipBranch({ noGit: noGitPath !== undefined, newWorktree: worktree.kind === "new", checkout: chosen });
  const chips: MemberChipModel[] = isSet || like ? setChips : single ? [{ projectId: single, branch: singleChip.branch, noGit: singleChip.noGit, removable: false }] : [];
  const worktreeText = like
    ? likeSrc.worktreeMode
      ? likeSrc.branch
        ? `On ${likeSrc.branch}`
        : "Its worktrees"
      : "In place"
    : workInText({ set: isSet, noGit: noGitPath !== undefined, worktree, chosen });
  const worktreeIcon = like ? (likeSrc.worktreeMode ? GitBranch : FolderGit2) : noGitPath !== undefined ? Folder : isSet ? (worktree.kind === "new" ? GitBranchPlus : FolderGit2) : !chosen ? GitBranchPlus : chosen.isMain ? FolderGit2 : GitBranch;

  // The primary picker: "Workspace" (its folder) first when there is one, then the projects by id.
  const primaryGroups = useMemo<PickerGroup[]>(() => {
    const s = like ? { projectIds: likeSrc.sorted, workspaceId: likeSrc.workspaceId } : set;
    return [{ heading: "Runs in", options: primaryOptions(s, workspaceName, projectNames) }];
  }, [like, likeSrc.sorted, likeSrc.workspaceId, set, workspaceName, projectNames]);
  const showPrimary = (isSet && (set.projectIds.length > 1 || set.workspaceId !== "")) || (like && (likeSrc.sorted.length > 1 || likeSrc.workspaceId !== ""));
  const primaryText = primary === WORKSPACE_PRIMARY ? "Workspace" : projectNames(primary);

  // ListRefs order (local branches, then remote-tracking refs), the default first.
  const refGroups = useMemo<PickerGroup[]>(() => {
    const list = refs ?? [];
    const ordered = defaultRef && list.includes(defaultRef) ? [defaultRef, ...list.filter((r) => r !== defaultRef)] : list;
    return [{ options: ordered.map((r) => ({ value: r, label: r, detail: r === defaultRef ? "default" : undefined })) }];
  }, [refs, defaultRef]);

  return (
    <div>
      {!home && <MemberChips target={target} members={chips} primary={primaryProject} workspaceId={like ? likeSrc.workspaceId : set.workspaceId} readOnly={like} disabled={busy} />}
      <Hints hints={hints} />
      <div
        // isolate: the surface's backdrop-filter makes it a stacking context, which would
        // paint over the in-flow prompt and toolbar; -z-10 inside this context keeps it under them.
        className="isolate grid grid-cols-[minmax(0,1fr)_auto]"
        data-testid="composer-card"
        data-dragging={dragging || undefined}
        // A native drop (Wails host) lands here by this id; the runtime marks the card
        // file-drop-target-active while a drag from the OS is over it.
        {...hostFiles.dropTarget}
        onDragOver={(e) => {
          if (busy || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setDragging(false);
        }}
        onDrop={(e) => {
          setDragging(false);
          if (busy) return;
          const files = filesOf(e.dataTransfer.files);
          if (files.length === 0) return;
          e.preventDefault();
          attach(files);
        }}
      >
        {/* The card's surface, behind the prompt and its toolbar (rows 1–2). */}
        <div
          aria-hidden
          className={cn(
            // Translucent over the backdrop, frosted so the prompt stays readable.
            "-z-10 col-span-2 col-start-1 row-span-2 row-start-1 rounded-lg border shadow-sm backdrop-blur-xl transition-colors",
            dragging ? "border-cf-info/70 bg-cf-info/5" : "border-cf-border bg-cf-surface-raised/85 in-[.file-drop-target-active]:border-cf-info/70 in-[.file-drop-target-active]:bg-cf-info/5",
          )}
        />
        <div className="col-span-2 col-start-1 row-start-1 flex min-w-0 flex-col">
          <Attachments draftKey={draftKey} disabled={busy} refocus={refocus} />
          <AttachmentPreview draftKey={draftKey} />
          <TagMultiProjectContext.Provider value={sourceIds.length > 1}>
            <PromptEditor
              handleRef={editorRef}
              draftKey={draftKey}
              value={text}
              disabled={busy}
              placeholder={like ? "What's next on this branch…" : "Describe what to build…"}
              onChange={(t) => {
                updateDraft(draftKey, { text: t, error: null });
              }}
              onSubmit={send}
              onEscape={() => {
                if (!isDraftEmpty(getDraft(draftKey))) return false;
                // Back where the composer came from: the thread for a like draft, the
                // Projects page for a project (the worktree overview is a panel tab there,
                // not a page); the dashboard when the composer has no project at all.
                const ui = useUiStore.getState();
                if (target.kind === "like") ui.select({ kind: "thread", id: target.threadId });
                else ui.select(primaryProject || set.workspaceId ? { kind: "view", name: "projects" } : DASHBOARD);
                return true;
              }}
              onPasteFiles={attach}
              onPreviewChip={(id, el) => openPreview(draftKey, id, el)}
              triggers={home ? HOME_TRIGGERS : TRIGGERS}
              onTrigger={completion.onTrigger}
              onCompletionKey={completion.onKey}
              completionAria={completion.aria}
            />
          </TagMultiProjectContext.Provider>
        </div>
        <div className="col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-0.5 px-2 pb-2">
          <ComposerPicker
            label="Model"
            icon={Brain}
            text={choiceLabel(modelChoices, model)}
            value={model}
            groups={modelGroups}
            onChange={(v) => {
              updateDraft(draftKey, { model: v });
            }}
            disabled={busy}
            contentClassName="w-44"
            data-testid="composer-model"
          />
          <ComposerPicker
            label="Effort"
            icon={Gauge}
            text={choiceLabel(EFFORT_CHOICES, effort)}
            value={effort}
            groups={[{ options: EFFORT_CHOICES }]}
            onChange={(v) => {
              updateDraft(draftKey, { effort: v });
            }}
            disabled={busy}
            contentClassName="w-40"
            data-testid="composer-effort"
          />
          <ComposerPicker
            label="Permissions"
            icon={ShieldCheck}
            text={choiceLabel(PERMISSION_CHOICES, permission)}
            value={permission}
            groups={[{ options: PERMISSION_CHOICES.map((p) => ({ value: p.value, label: p.label, detail: p.hint })) }]}
            onChange={(v) => {
              updateDraft(draftKey, { permission: v as ComposePermission });
            }}
            disabled={busy}
            contentClassName="w-60"
            data-testid="composer-permission"
          />
          {/* The span carries the tooltip while the button is disabled (no pointer events). */}
          <Tip label={attachLabel(hostFiles.hosted)}>
            <span className="ml-auto flex">
              <button
                type="button"
                disabled={busy}
                aria-label={attachLabel(hostFiles.hosted)}
                data-compose-stop
                data-testid="composer-attach"
                className="flex size-7 items-center justify-center rounded-md text-cf-text-muted outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 disabled:pointer-events-none disabled:opacity-50"
                onClick={() => {
                  if (hostFiles.hosted) hostFiles.pick();
                  else fileRef.current?.click();
                }}
              >
                <Paperclip className="size-4" />
              </button>
            </span>
          </Tip>
          <input
            ref={fileRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            hidden
            data-testid="composer-file-input"
            onChange={(e) => {
              attach(filesOf(e.target.files));
              e.target.value = "";
            }}
          />
        </div>
        {(error ?? notice) && (
          <div className="col-span-2 col-start-1 row-start-3 flex flex-col gap-1 px-2 pt-2 text-body">
            {error && (
              <p role="alert" className="text-cf-error-text" data-testid="composer-error">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="text-cf-warning-text" data-testid="composer-notice">
                {notice}
              </p>
            )}
          </div>
        )}
        {/* relative: the completion card hangs under this row, out of flow (CompletionCard). */}
        <div className="relative col-span-2 col-start-1 row-start-4 flex flex-wrap items-center gap-0.5 px-1 pt-2" data-testid="composer-worktree-row">
          {/* No project: no worktree, branch or base to pick. */}
          {!home && (
            <>
              {like ? (
                // What thread.new-like copies: read-only, not a Tab stop.
                <div
                  role="note"
                  aria-label={`Work in: ${worktreeText}`}
                  data-testid="composer-like-mode"
                  className="inline-flex h-6 max-w-64 min-w-0 shrink-0 cursor-default items-center gap-1 rounded-md bg-cf-surface-sunken/50 px-1.5 text-caption font-medium whitespace-nowrap select-none"
                >
                  {(() => {
                    const Icon = worktreeIcon;
                    return <Icon className="size-3 shrink-0" aria-hidden />;
                  })()}
                  <span className="truncate font-mono">{worktreeText}</span>
                </div>
              ) : (
                <ComposerPicker
                  label="Work in"
                  icon={worktreeIcon}
                  text={worktreeText}
                  value={isSet ? worktree.kind : worktree.kind === "existing" ? worktree.path : worktree.kind}
                  groups={worktreeGroups}
                  onChange={(v) => {
                    const next: WorktreeChoice = v === "new" || v === "current" ? { kind: v } : { kind: "existing", path: v };
                    // The pick is this draft's alone; the next draft starts from the setting again.
                    updateDraft(draftKey, { worktree: next });
                  }}
                  footer={noGitPath === undefined ? WORK_IN_FOOTER : undefined}
                  disabled={busy}
                  contentClassName="w-90"
                  listClassName="max-h-96"
                  data-testid="composer-worktree"
                />
              )}
              {showPrimary && (
                <ComposerPicker
                  label="Runs in"
                  icon={primary === WORKSPACE_PRIMARY ? Layers : FolderOpen}
                  text={primaryText}
                  value={primary}
                  groups={primaryGroups}
                  onChange={(v) => {
                    setPrimary(draftKey, v);
                  }}
                  disabled={busy}
                  contentClassName="w-64"
                  data-testid="composer-primary"
                />
              )}
              {!like && !isSet && (noGitPath !== undefined ? <NoGitBadge className="mx-1 h-6 rounded-md px-1.5 text-caption" /> : chosen && <BranchIndicator worktree={chosen} />)}
              {showBase && (
                <ComposerPicker
                  label="Base"
                  icon={GitCommitHorizontal}
                  text={base ? `From ${base}` : "From the default branch"}
                  value={base}
                  groups={refGroups}
                  onChange={(v) => {
                    updateDraft(draftKey, { base: v });
                  }}
                  filterPlaceholder="Filter refs…"
                  status={
                    refsStatus === "loading"
                      ? "Loading refs…"
                      : refsStatus === "error"
                        ? refsOutdated
                          ? refsError
                          : `Cannot list refs: ${refsError ?? "unknown error"}. The default branch is used.`
                        : null
                  }
                  disabled={busy}
                  contentClassName="w-72"
                  data-testid="composer-base"
                />
              )}
            </>
          )}
          <CompletionCard completion={completion} />
        </div>
        <div className="col-start-2 row-start-2 flex items-end pr-2 pb-2">
          {/* Icon-only until it sends; the span carries the tooltip while it is disabled. */}
          <Tip label={busy ? null : "Start thread"}>
            <span className="flex">
              <button
                type="button"
                disabled={!canSend}
                aria-label={busy ? phaseText(phase, newWorktrees) : "Start thread"}
                data-compose-stop
                data-testid="composer-send"
                data-phase={phase}
                className={cn(
                  "flex h-8 items-center justify-center gap-1.5 rounded-full bg-cf-accent text-cf-accent-foreground outline-none transition-all hover:bg-cf-accent/90 focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 disabled:pointer-events-none",
                  busy ? "px-3 text-body-sm font-medium" : "w-8 disabled:opacity-40",
                )}
                onClick={send}
              >
                {busy ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    {phaseText(phase, newWorktrees)}
                  </>
                ) : (
                  <ArrowUp className="size-4" aria-hidden />
                )}
              </button>
            </span>
          </Tip>
        </div>
      </div>
    </div>
  );
}

/**
 * The new-thread composer for a project (and whatever the user adds to its set), a
 * workspace with workspaceId, no project with noProject, or "New thread on this branch"
 * with likeThreadId (Selection kind "compose").
 */
export function Composer({ projectId, workspaceId, noProject = false, likeThreadId }: { projectId: string; workspaceId?: string; noProject?: boolean; likeThreadId?: string }) {
  const target = useMemo<ComposeTarget>(
    () => (likeThreadId ? { kind: "like", threadId: likeThreadId } : workspaceId ? { kind: "workspace", workspaceId } : noProject ? { kind: "home" } : { kind: "project", projectId }),
    [projectId, workspaceId, noProject, likeThreadId],
  );
  const key = keyOf(target);
  const { set, workspaceName } = useDraftSet(target, key);
  const names = useProjectNames(set.projectIds);
  const projectsLoaded = useProjectsStore((s) => s.loaded);
  const workspacesLoaded = useWorkspacesStore((s) => s.loaded);
  const threadsLoaded = useThreadsStore((s) => s.loaded);
  const likeKnown = useThreadsStore((s) => (likeThreadId ? likeThreadId in s.byId : false));
  const likeBranch = useThreadsStore((s) => (likeThreadId ? (s.byId[likeThreadId]?.branch ?? "") : ""));
  const likeName = useThreadsStore((s) => (likeThreadId ? s.byId[likeThreadId]?.name || likeThreadId : ""));
  const workspaceGone = useWorkspacesStore((s) => (workspaceId ? !(workspaceId in s.byId) : false));
  const busy = useDraft(key, "phase") !== "idle";
  let name: string | null;
  if (likeThreadId) name = likeKnown ? likeName : null;
  else if (noProject) name = NO_PROJECT;
  else if (workspaceId && workspaceGone) name = null;
  else name = set.projectIds.length === 0 && !set.workspaceId ? null : setName(set, workspaceName, names);
  const loaded = likeThreadId ? threadsLoaded : workspaceId ? workspacesLoaded : projectsLoaded;
  const gone = likeThreadId ? "This thread no longer exists." : workspaceId ? "This workspace no longer exists." : "This project is no longer registered.";
  return (
    // Centered in the pane both ways at any size: auto margins in a column flexbox center
    // the block and, unlike justify-center, fall back to 0 (scrollable from the top) when
    // the draft outgrows the pane.
    // The backdrop sits behind the scrolling section, so it stays put when a long draft scrolls.
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <Backdrop />
      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-10" data-region="content" aria-label="New thread" data-testid="composer" data-like={likeThreadId || undefined}>
        {name === null ? (
          <p className="m-auto text-body text-cf-text-muted">{loaded ? gone : "Loading…"}</p>
        ) : (
          // The heading's name is the first composer Tab stop, then the chips, the prompt…
          <div className="m-auto w-full max-w-2xl" data-testid="composer-body" onKeyDown={cycleStops}>
            <h1 className="mb-6 text-center text-title" data-testid="composer-heading">
              {likeThreadId ? (
                // "New thread on this branch": the set is the thread's; nothing to switch.
                likeBranch ? (
                  <>
                    What&apos;s next on <span className="font-mono" data-testid="composer-like-branch">{likeBranch}</span>?
                  </>
                ) : (
                  <>
                    What&apos;s next beside <span data-testid="composer-like-name">{name}</span>?
                  </>
                )
              ) : (
                <>
                  {/* "build with No project" reads as "with no project"; "in" would not. */}
                  What should we build {noProject ? "with" : "in"} <ProjectSwitcher target={target} name={name} set={set} disabled={busy} />?
                </>
              )}
            </h1>
            <ComposerCard target={target} set={set} workspaceName={workspaceName} />
          </div>
        )}
      </section>
      <DragBand />
    </div>
  );
}
