import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowUp, Brain, Folder, FolderGit2, Gauge, GitBranch, GitBranchPlus, GitCommitHorizontal, Layers, Loader2, Paperclip, ShieldCheck, X } from "lucide-react";
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
import { useCompletion, useFileSource, useSkillSource, type CompletionSource } from "./useCompletion";
import { useMentionSource, useProjectSlugs, usePrSource } from "./useRefSources";
import { NoGitBadge } from "@/components/projects/NoGitBadge";
import { ATTACHMENT_MIME_TYPES } from "@/api/threads";
import { Backdrop } from "@/components/backdrop/Backdrop";
import { Tip } from "@/components/ui/tooltip";
import { DragBand } from "@/components/window/DragBand";
import {
  choiceLabel,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  defaultWorktree,
  draftKey as keyOf,
  draftMembers,
  EFFORT_CHOICES,
  NEW_BRANCH,
  previewLabel,
  PERMISSION_CHOICES,
  pickDefault,
  projectChipBranch,
  WORK_IN_SETTING_KEY,
  workInText,
  type ComposePermission,
  type ComposeTarget,
  type WorktreeChoice,
} from "@/lib/compose";
import { fileSources, skillSources, skillSourcesKey, type TriggerChar } from "@/lib/completion";
import { tildify } from "@/lib/path";
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

/** The chosen worktree, or a new one when the chosen one no longer exists. */
function resolveWorktree(choice: WorktreeChoice, worktrees: readonly WorktreeOption[]): WorktreeChoice {
  return choice.kind === "existing" && !worktrees.some((w) => w.path === choice.path) ? { kind: "new" } : choice;
}

/** What the send button says while busy: new worktrees (one per project for a workspace), or starting. */
function phaseText(phase: DraftPhase, newWorktrees: number): string {
  if (phase === "attaching") return "Attaching files…";
  if (newWorktrees > 1) return "Creating worktrees…";
  return newWorktrees === 1 ? "Creating worktree…" : "Starting Claude…";
}

/** A workspace's members (project id + worktree path), shallow-stable. */
function useWorkspaceMembers(workspaceId: string | null): { projectId: string; worktreePath: string }[] {
  const keys = useWorkspacesStore(useShallow((s) => (workspaceId ? (s.byId[workspaceId]?.members ?? []).map((m) => m.projectId + SEP + m.worktreePath) : [])));
  return useMemo(
    () =>
      keys.map((k) => {
        const [projectId = "", worktreePath = ""] = k.split(SEP);
        return { projectId, worktreePath };
      }),
    [keys],
  );
}

/** The branch a member worktree has checked out now ("" when the project store does not list it). */
function useCheckout(projectId: string, path: string): WorktreeOption | undefined {
  const key = useProjectsStore((s) => {
    const w = s.byId[projectId]?.worktrees.find((x) => x.path === path);
    return w ? [w.path, w.branch, w.head, w.detached ? "1" : "", w.isMain ? "1" : ""].join(SEP) : "";
  });
  return useMemo(() => {
    if (!key) return undefined;
    const [p = "", branch = "", head = "", detached = "", main = ""] = key.split(SEP);
    return { path: p, branch, head, detached: detached === "1", isMain: main === "1" };
  }, [key]);
}

/**
 * The projects a draft's thread works in (lib/compose draftMembers), from narrow
 * selectors: the project and its "Also in" projects, or the workspace's members.
 */
function useMembers(target: ComposeTarget, key: string) {
  const alsoIn = useDraft(key, "alsoIn");
  const primaryChoice = useDraft(key, "primary");
  // Git projects only: a project without git is never an Also in project.
  const known = useProjectsStore(useShallow((s) => s.order.filter((id) => s.byId[id]?.git === true)));
  const wsMembers = useWorkspaceMembers(target.kind === "workspace" ? target.workspaceId : null);
  return useMemo(() => {
    const workspace = target.kind === "workspace" ? { id: target.workspaceId, members: wsMembers } : undefined;
    const { projectIds, primary } = draftMembers({ target, alsoIn, primary: primaryChoice }, workspace, (id) => known.includes(id));
    return { projectIds, primary, wsMembers };
  }, [target, alsoIn, primaryChoice, known, wsMembers]);
}

/**
 * The member chips. A workspace member's: the branch its worktree has checked out (else the
 * workspace branch), "cf/…" in new-worktree mode. A project's: `projectChip`
 * (projectChipBranch), the same for every project of the draft (with Also in projects the
 * mode is always new worktrees).
 */
function useMemberChips(
  target: ComposeTarget,
  projectIds: readonly string[],
  wsMembers: readonly { projectId: string; worktreePath: string }[],
  newWorktrees: boolean,
  projectChip: { branch: string; noGit: boolean },
): MemberChipModel[] {
  const wsId = target.kind === "workspace" ? target.workspaceId : "";
  const branches = useProjectsStore(
    useShallow((s) =>
      wsMembers.map((m) => {
        const w = s.byId[m.projectId]?.worktrees.find((x) => x.path === m.worktreePath);
        return w ? w.branch || w.head.slice(0, 7) : "";
      }),
    ),
  );
  const wsBranch = useWorkspacesStore((s) => (wsId ? (s.byId[wsId]?.branch ?? "") : ""));
  return useMemo(
    () =>
      projectIds.map((projectId, i) => {
        if (target.kind === "project") return { projectId, branch: projectChip.branch, noGit: projectChip.noGit, removable: i > 0 };
        const j = wsMembers.findIndex((m) => m.projectId === projectId);
        return { projectId, branch: newWorktrees ? NEW_BRANCH : branches[j] || wsBranch, removable: false };
      }),
    [target, projectIds, wsMembers, branches, wsBranch, newWorktrees, projectChip.branch, projectChip.noGit],
  );
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
          className="group relative size-16 overflow-hidden rounded-md border bg-muted/40"
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
            className="block size-full cursor-pointer rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
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

const NEW_IN_EVERY = "A cf/… branch in every project (a new workspace)";

/** Work in: where a project's thread runs. The picker's copy (docs/notes/onboarding-3-work-in.md). */
const FRESH_COPY = "A fresh copy of the project";
const FRESH_COPY_DETAIL = "Its own folder and branch (cf/…, named from your prompt). Run several threads at once; keep or discard each one.";
const IN_PLACE = "The project folder itself";
const WORK_IN_FOOTER = "Default for new threads: Settings › Threads › New threads work in";

function inPlaceDetail(path: string): string {
  return `Edits land in ${tildify(path)} directly. One thread at a time is safest.`;
}

/**
 * The member chips (MemberChips) above the card. The card: attachments, the prompt, the
 * model/effort/permission/view pickers, attach and send; below it the Work in picker
 * (where the thread runs: a fresh copy, the project folder itself, or an existing
 * worktree; a project draft starts from stores/compose projectWorktree) and, beside it, the base-ref picker for new worktrees or the chosen worktree's branch
 * (read-only, not a Tab stop) otherwise. Grid placement keeps the send button inside the
 * card while Tab goes textarea → pickers (worktree and base included) → send; the chips
 * come before the prompt.
 *
 * A project with "Also in" projects always gets new worktrees (a new workspace). A
 * workspace runs in its own worktrees ("Workspace worktrees") or, in new-worktree mode,
 * gets a new workspace with the same projects. The base picker lists the primary
 * project's refs and applies to it; the other projects branch from their defaults.
 */
function ComposerCard({ target }: { target: ComposeTarget }) {
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
  const phase = useDraft(draftKey, "phase");
  const error = useDraft(draftKey, "error");
  const notice = useDraft(draftKey, "notice");
  const { projectIds, primary, wsMembers } = useMembers(target, draftKey);
  const refsStatus = useComposeStore((s) => s.refs[primary]?.status ?? "loading");
  const refsError = useComposeStore((s) => s.refs[primary]?.error ?? null);
  const refsOutdated = useComposeStore((s) => s.refs[primary]?.outdated ?? false);
  const refs = useComposeStore((s) => s.refs[primary]?.refs);
  const defaultRef = useComposeStore((s) => s.refs[primary]?.defaultRef ?? "");
  const projectId = target.kind === "project" ? target.projectId : "";
  const worktrees = useWorktrees(projectId);
  const mainPath = worktrees.find((w) => w.isMain)?.path;
  const workInSetting = useSettingValue(WORK_IN_SETTING_KEY);
  // A project without git runs threads in its folder only: Current checkout, no base.
  const noGitPath = useProjectsStore((s) => noGitCheckout(s.byId[projectId]));
  const wsBranch = useWorkspacesStore((s) => (target.kind === "workspace" ? (s.byId[target.workspaceId]?.branch ?? "") : ""));
  const primaryCheckout = useCheckout(primary, wsMembers.find((m) => m.projectId === primary)?.worktreePath ?? "");
  const focusSeq = useUiStore((s) => s.composerFocusSeq);
  const editorRef = useRef<PromptEditorHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const busy = phase !== "idle";
  // No project: no worktree, base, branch or member chips; "/" completes, "@" does not.
  const home = target.kind === "home";
  const sourceTarget = target.kind === "workspace" ? "workspace" : "project";
  const multi = target.kind === "project" && projectIds.length > 1;
  const worktree: WorktreeChoice =
    target.kind === "workspace"
      ? choice?.kind === "new"
        ? choice
        : { kind: "members" }
      : noGitPath !== undefined
        ? { kind: "existing", path: noGitPath }
        : multi
          ? { kind: "new" }
          : resolveWorktree(choice ?? defaultWorktree({ setting: workInSetting, mainPath }), worktrees);
  const newWorktrees = home || worktree.kind !== "new" ? 0 : target.kind === "workspace" || multi ? projectIds.length : 1;
  const base = baseChoice ?? defaultRef;
  const canSend = !busy && (text.trim() !== "" || hasAttachments);

  // "/" completion: the skills of the draft's projects (where the thread would run) and
  // the user's, reloaded on mount and whenever those change.
  const existingPath = worktree.kind === "existing" ? worktree.path : "";
  const sources = useMemo(
    () => skillSources({ target: sourceTarget, projectIds, worktree: existingPath ? { kind: "existing", path: existingPath } : { kind: "new" }, wsMembers }),
    [sourceTarget, projectIds, existingPath, wsMembers],
  );
  useEffect(() => {
    void loadSkills(sources);
  }, [sources]);
  // Native drops and the native open panel (in the Wails host); the panel opens in the
  // checkout the thread will work in, the main checkout for a new worktree, else home.
  const hostFiles = useHostFiles({ draftKey, editorRef, disabled: busy, startDir: existingPath || primaryCheckout?.path || mainPath || "" });
  // "@" completion: files of the checkouts the thread will see (lib/completion fileSources;
  // a new worktree's come from the main checkout it starts from).
  const worktreeKind = worktree.kind;
  const fileSrcs = useMemo(
    () =>
      fileSources({
        target: sourceTarget,
        projectIds,
        worktree: worktreeKind === "existing" ? { kind: "existing", path: existingPath } : { kind: worktreeKind },
        wsMembers,
      }),
    [sourceTarget, projectIds, worktreeKind, existingPath, wsMembers],
  );
  const [trigger, setTrigger] = useState<EditorTrigger | null>(null);
  const skillSource = useSkillSource(trigger, skillSourcesKey(sources), projectIds);
  const fileSource = useFileSource(trigger, fileSrcs, projectIds, primary);
  const mentionSource = useMentionSource(trigger, home ? null : fileSource, "");
  const prSource = usePrSource(trigger, useProjectSlugs(projectIds));
  const bySource: Record<TriggerChar, CompletionSource> = { "/": skillSource, "@": mentionSource, "#": prSource };
  const completion = useCompletion(trigger, setTrigger, bySource[trigger?.char ?? "/"], editorRef);

  useEffect(() => {
    if (primary && noGitPath === undefined) void loadRefs(primary);
  }, [primary, noGitPath]);

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

  const send = () => {
    if (canSend) void sendDraft(target, defaults);
  };

  /** Pasted, dropped or picked files: thumbnails, and chips at the caret. */
  const attach = (files: File[]) => {
    const added = addAttachments(draftKey, files);
    editorRef.current?.insertChips(added.map((a) => ({ id: a.id, name: a.file.name })));
  };
  const refocus = () => editorRef.current?.focus();

  const projects = projectIds.length;
  const worktreeGroups = useMemo<PickerGroup[]>(() => {
    if (target.kind === "workspace") {
      return [
        {
          options: [
            { value: "members", label: "Workspace worktrees", detail: `${wsBranch} in ${String(projects)} ${projects === 1 ? "project" : "projects"}` },
            { value: "new", label: "New worktree", detail: NEW_IN_EVERY },
          ],
        },
      ];
    }
    if (noGitPath !== undefined) {
      return [{ heading: "Work in", options: [{ value: noGitPath, label: IN_PLACE, tag: "no git", detail: inPlaceDetail(noGitPath), wrap: true }] }];
    }
    if (multi) return [{ heading: "Work in", options: [{ value: "new", label: "A fresh copy of every project", tag: "new worktrees", detail: NEW_IN_EVERY, wrap: true }] }];
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
  }, [target.kind, multi, wsBranch, projects, worktrees, noGitPath]);
  const chosen = worktree.kind === "existing" ? worktrees.find((w) => w.path === worktree.path) : undefined;
  const chips = useMemberChips(
    target,
    projectIds,
    wsMembers,
    worktree.kind === "new",
    projectChipBranch({ noGit: noGitPath !== undefined, newWorktree: worktree.kind === "new", checkout: chosen }),
  );
  const worktreeText = workInText({ workspace: target.kind === "workspace", noGit: noGitPath !== undefined, worktree, chosen });
  const worktreeIcon = noGitPath !== undefined ? Folder : worktree.kind === "members" ? Layers : !chosen ? GitBranchPlus : chosen.isMain ? FolderGit2 : GitBranch;

  // ListRefs order (local branches, then remote-tracking refs), the default first.
  const refGroups = useMemo<PickerGroup[]>(() => {
    const list = refs ?? [];
    const ordered = defaultRef && list.includes(defaultRef) ? [defaultRef, ...list.filter((r) => r !== defaultRef)] : list;
    return [{ options: ordered.map((r) => ({ value: r, label: r, detail: r === defaultRef ? "default" : undefined })) }];
  }, [refs, defaultRef]);

  return (
    <div>
      {!home && <MemberChips draftKey={draftKey} members={chips} primary={primary} canAdd={target.kind === "project" && noGitPath === undefined} disabled={busy} />}
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
            dragging ? "border-info/70 bg-info/5" : "border-border bg-card/85 in-[.file-drop-target-active]:border-info/70 in-[.file-drop-target-active]:bg-info/5",
          )}
        />
        <div className="col-span-2 col-start-1 row-start-1 flex min-w-0 flex-col">
          <Attachments draftKey={draftKey} disabled={busy} refocus={refocus} />
          <AttachmentPreview draftKey={draftKey} />
          <TagMultiProjectContext.Provider value={projectIds.length > 1}>
            <PromptEditor
              handleRef={editorRef}
              draftKey={draftKey}
              value={text}
              disabled={busy}
              placeholder="Describe what to build…"
              onChange={(t) => {
                updateDraft(draftKey, { text: t, error: null });
              }}
              onSubmit={send}
              onEscape={() => {
                if (!isDraftEmpty(getDraft(draftKey))) return false;
                // Back to the Projects page (the worktree overview is a panel tab there,
                // not a page); the dashboard when the composer has no project at all.
                const back = target.kind === "project" ? target.projectId : primary;
                useUiStore.getState().select(back ? { kind: "view", name: "projects" } : DASHBOARD);
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
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
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
              <p role="alert" className="text-destructive" data-testid="composer-error">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="text-warning" data-testid="composer-notice">
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
              <ComposerPicker
                label="Work in"
                icon={worktreeIcon}
                text={worktreeText}
                value={worktree.kind === "existing" ? worktree.path : worktree.kind}
                groups={worktreeGroups}
                onChange={(v) => {
                  const next: WorktreeChoice = v === "new" || v === "members" ? { kind: v } : { kind: "existing", path: v };
                  // The pick is this draft's alone; the next draft starts from the setting again.
                  updateDraft(draftKey, { worktree: next });
                }}
                footer={target.kind === "project" && noGitPath === undefined && !multi ? WORK_IN_FOOTER : undefined}
                disabled={busy}
                contentClassName={target.kind === "workspace" ? "w-80" : "w-90"}
                listClassName="max-h-96"
                data-testid="composer-worktree"
              />
              {noGitPath !== undefined ? <NoGitBadge className="mx-1 h-6 rounded-md px-1.5 text-caption" /> : chosen && <BranchIndicator worktree={chosen} />}
              {worktree.kind === "members" && primaryCheckout && <BranchIndicator worktree={primaryCheckout} />}
              {worktree.kind === "new" && (
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
                  "flex h-8 items-center justify-center gap-1.5 rounded-full bg-primary text-primary-foreground outline-none transition-all hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none",
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
 * The new-thread composer for a project, a workspace with workspaceId, or no project with
 * noProject (Selection kind "compose").
 */
export function Composer({ projectId, workspaceId, noProject = false }: { projectId: string; workspaceId?: string; noProject?: boolean }) {
  const target = useMemo<ComposeTarget>(
    () => (workspaceId ? { kind: "workspace", workspaceId } : noProject ? { kind: "home" } : { kind: "project", projectId }),
    [projectId, workspaceId, noProject],
  );
  const projectName = useProjectsStore((s) => s.byId[projectId]?.name ?? null);
  const workspaceName = useWorkspacesStore((s) => (workspaceId ? (s.byId[workspaceId]?.name ?? null) : null));
  const projectsLoaded = useProjectsStore((s) => s.loaded);
  const workspacesLoaded = useWorkspacesStore((s) => s.loaded);
  const busy = useDraft(keyOf(target), "phase") !== "idle";
  const name = workspaceId ? workspaceName : noProject ? NO_PROJECT : projectName;
  const loaded = workspaceId ? workspacesLoaded : projectsLoaded;
  const gone = workspaceId ? "This workspace no longer exists." : "This project is no longer registered.";
  return (
    // Centered in the pane both ways at any size: auto margins in a column flexbox center
    // the block and, unlike justify-center, fall back to 0 (scrollable from the top) when
    // the draft outgrows the pane.
    // The backdrop sits behind the scrolling section, so it stays put when a long draft scrolls.
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <Backdrop />
      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-10" data-region="content" aria-label="New thread" data-testid="composer">
        {name === null ? (
          <p className="m-auto text-body text-muted-foreground">{loaded ? gone : "Loading…"}</p>
        ) : (
          // The heading's name is the first composer Tab stop, then the member chips, the prompt…
          <div className="m-auto w-full max-w-2xl" data-testid="composer-body" onKeyDown={cycleStops}>
            <h1 className="mb-6 text-center text-title" data-testid="composer-heading">
              {/* "build with No project" reads as "with no project"; "in" would not. */}
              What should we build {noProject ? "with" : "in"} <ProjectSwitcher target={target} name={name} disabled={busy} />?
            </h1>
            <ComposerCard target={target} />
          </div>
        )}
      </section>
      <DragBand />
    </div>
  );
}
