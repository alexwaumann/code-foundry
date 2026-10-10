import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowUp, Brain, FolderGit2, Gauge, GitBranch, GitBranchPlus, GitCommitHorizontal, Layers, Loader2, Paperclip, ShieldCheck, X } from "lucide-react";
import { AttachmentPreview } from "./AttachmentPreview";
import { BranchIndicator } from "./BranchIndicator";
import { ComposerPicker, type PickerGroup } from "./ComposerPicker";
import { MemberChips, type MemberChipModel } from "./MemberChips";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";
import { ATTACHMENT_MIME_TYPES } from "@/api/session";
import {
  choiceLabel,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  draftKey as keyOf,
  draftMembers,
  EFFORT_CHOICES,
  MODEL_CHOICES,
  PERMISSION_CHOICES,
  pickDefault,
  type ComposePermission,
  type ComposeTarget,
  type WorktreeChoice,
} from "@/lib/compose";
import { tildify } from "@/lib/path";
import { formatAttachmentSize, isReferenced } from "@/lib/prompt";
import { cn } from "@/lib/utils";
import {
  addAttachments,
  getDraft,
  isDraftEmpty,
  loadRefs,
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
import { useReposStore } from "@/stores/repos";
import { useSettingValue } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";

const SEP = "\u0001";

/** Model and effort the composer starts with: the settings defaults, else opus / high. */
function useDefaults(): { model: string; effort: string } {
  const model = pickDefault(MODEL_CHOICES, useSettingValue("sessions.default_model"), DEFAULT_MODEL);
  const effort = pickDefault(EFFORT_CHOICES, useSettingValue("sessions.default_effort"), DEFAULT_EFFORT);
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

/** The repo's worktrees (main first), as a shallow-stable list that follows branch changes live. */
function useWorktrees(repoId: string): WorktreeOption[] {
  const keys = useReposStore(
    useShallow((s) => (s.byId[repoId]?.worktrees ?? []).map((w) => [w.path, w.branch, w.head, w.detached ? "1" : "", w.isMain ? "1" : ""].join(SEP))),
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
  if (phase === "attaching") return "Attaching images…";
  if (newWorktrees > 1) return "Creating worktrees…";
  return newWorktrees === 1 ? "Creating worktree…" : "Starting Claude…";
}

const NEW_BRANCH = "cf/…";

/** A workspace's members (repo id + worktree path), shallow-stable. */
function useWorkspaceMembers(workspaceId: string | null): { repoId: string; worktreePath: string }[] {
  const keys = useWorkspacesStore(useShallow((s) => (workspaceId ? (s.byId[workspaceId]?.members ?? []).map((m) => m.repoId + SEP + m.worktreePath) : [])));
  return useMemo(
    () =>
      keys.map((k) => {
        const [repoId = "", worktreePath = ""] = k.split(SEP);
        return { repoId, worktreePath };
      }),
    [keys],
  );
}

/** The branch a member worktree has checked out now ("" when the repo store does not list it). */
function useCheckout(repoId: string, path: string): WorktreeOption | undefined {
  const key = useReposStore((s) => {
    const w = s.byId[repoId]?.worktrees.find((x) => x.path === path);
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
  const known = useReposStore(useShallow((s) => s.order));
  const wsMembers = useWorkspaceMembers(target.kind === "workspace" ? target.workspaceId : null);
  return useMemo(() => {
    const workspace = target.kind === "workspace" ? { id: target.workspaceId, members: wsMembers } : undefined;
    const { repoIds, primary } = draftMembers({ target, alsoIn, primary: primaryChoice }, workspace, (id) => known.includes(id));
    return { repoIds, primary, wsMembers };
  }, [target, alsoIn, primaryChoice, known, wsMembers]);
}

/** A workspace member's chip: the branch its worktree has checked out (else the workspace branch). */
function useMemberChips(target: ComposeTarget, repoIds: readonly string[], wsMembers: readonly { repoId: string; worktreePath: string }[], newWorktrees: boolean): MemberChipModel[] {
  const wsId = target.kind === "workspace" ? target.workspaceId : "";
  const branches = useReposStore(
    useShallow((s) =>
      wsMembers.map((m) => {
        const w = s.byId[m.repoId]?.worktrees.find((x) => x.path === m.worktreePath);
        return w ? w.branch || w.head.slice(0, 7) : "";
      }),
    ),
  );
  const wsBranch = useWorkspacesStore((s) => (wsId ? (s.byId[wsId]?.branch ?? "") : ""));
  return useMemo(
    () =>
      repoIds.map((repoId, i) => {
        if (target.kind === "project") return { repoId, branch: NEW_BRANCH, removable: i > 0 };
        const j = wsMembers.findIndex((m) => m.repoId === repoId);
        return { repoId, branch: newWorktrees ? NEW_BRANCH : branches[j] || wsBranch, removable: false };
      }),
    [target, repoIds, wsMembers, branches, wsBranch, newWorktrees],
  );
}

/**
 * Removes an attachment from the draft. Still referenced by a chip in the text: asks
 * first, then removes the image and every reference; unreferenced: removes it at once.
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

function Attachments({ draftKey, disabled, refocus }: { draftKey: string; disabled: boolean; refocus: () => void }) {
  const attachments = useDraft(draftKey, "attachments");
  if (attachments.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attached images">
      {attachments.map((a) => (
        <li
          key={a.id}
          className="group relative size-16 overflow-hidden rounded-lg border bg-muted/40"
          data-testid="attachment"
          data-attachment-id={a.id}
        >
          <button
            type="button"
            title="Open preview"
            aria-label={`Preview ${a.file.name}, ${formatAttachmentSize(a.file.size)}`}
            aria-haspopup="dialog"
            data-testid="attachment-open"
            className="block size-full cursor-pointer rounded-[inherit] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
            onClick={(e) => {
              openPreview(draftKey, a.id, e.currentTarget);
            }}
          >
            <img src={a.url} alt={a.file.name} draggable={false} className="size-full object-cover" />
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

/**
 * The member chips (MemberChips) above the card. The card: attachments, the prompt, the
 * model/effort/permission pickers, attach and send; below it the worktree picker and,
 * beside it, the base-ref picker for new worktrees or the chosen worktree's branch
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
  const { repoIds, primary, wsMembers } = useMembers(target, draftKey);
  const refsStatus = useComposeStore((s) => s.refs[primary]?.status ?? "loading");
  const refsError = useComposeStore((s) => s.refs[primary]?.error ?? null);
  const refsOutdated = useComposeStore((s) => s.refs[primary]?.outdated ?? false);
  const refs = useComposeStore((s) => s.refs[primary]?.refs);
  const defaultRef = useComposeStore((s) => s.refs[primary]?.defaultRef ?? "");
  const projectId = target.kind === "project" ? target.repoId : "";
  const worktrees = useWorktrees(projectId);
  const wsBranch = useWorkspacesStore((s) => (target.kind === "workspace" ? (s.byId[target.workspaceId]?.branch ?? "") : ""));
  const primaryCheckout = useCheckout(primary, wsMembers.find((m) => m.repoId === primary)?.worktreePath ?? "");
  const focusSeq = useUiStore((s) => s.composerFocusSeq);
  const editorRef = useRef<PromptEditorHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const busy = phase !== "idle";
  const multi = target.kind === "project" && repoIds.length > 1;
  const worktree: WorktreeChoice =
    target.kind === "workspace" ? (choice.kind === "new" ? choice : { kind: "members" }) : multi ? { kind: "new" } : resolveWorktree(choice, worktrees);
  const newWorktrees = worktree.kind !== "new" ? 0 : target.kind === "workspace" || multi ? repoIds.length : 1;
  const chips = useMemberChips(target, repoIds, wsMembers, worktree.kind === "new");
  const base = baseChoice ?? defaultRef;
  const canSend = !busy && (text.trim() !== "" || hasAttachments);

  useEffect(() => {
    if (primary) void loadRefs(primary);
  }, [primary]);

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

  const projects = repoIds.length;
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
    if (multi) return [{ options: [{ value: "new", label: "New worktree", detail: NEW_IN_EVERY }] }];
    return [
      { options: [{ value: "new", label: "New worktree", detail: "A cf/… branch named from the prompt" }] },
      {
        heading: "Existing",
        options: worktrees.map((w) => ({
          value: w.path,
          label: w.isMain ? "Current checkout" : worktreeName(w),
          detail: w.isMain ? `${worktreeName(w)} · ${tildify(w.path)}` : tildify(w.path),
        })),
      },
    ];
  }, [target.kind, multi, wsBranch, projects, worktrees]);
  const chosen = worktree.kind === "existing" ? worktrees.find((w) => w.path === worktree.path) : undefined;
  const worktreeText = worktree.kind === "members" ? "Workspace worktrees" : !chosen ? "New worktree" : chosen.isMain ? "Current checkout" : `Existing worktree: ${worktreeName(chosen)}`;
  const worktreeIcon = worktree.kind === "members" ? Layers : !chosen ? GitBranchPlus : chosen.isMain ? FolderGit2 : GitBranch;

  // ListRefs order (local branches, then remote-tracking refs), the default first.
  const refGroups = useMemo<PickerGroup[]>(() => {
    const list = refs ?? [];
    const ordered = defaultRef && list.includes(defaultRef) ? [defaultRef, ...list.filter((r) => r !== defaultRef)] : list;
    return [{ options: ordered.map((r) => ({ value: r, label: r, detail: r === defaultRef ? "default" : undefined })) }];
  }, [refs, defaultRef]);

  return (
    <div onKeyDown={cycleStops}>
      <MemberChips draftKey={draftKey} members={chips} primary={primary} canAdd={target.kind === "project"} disabled={busy} />
      <div
        className="grid grid-cols-[minmax(0,1fr)_auto]"
        data-testid="composer-card"
        data-dragging={dragging || undefined}
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
            "col-span-2 col-start-1 row-span-2 row-start-1 rounded-2xl border bg-card shadow-sm transition-colors",
            dragging ? "border-sky-400/70 bg-sky-400/5" : "border-border",
          )}
        />
        <div className="col-span-2 col-start-1 row-start-1 flex min-w-0 flex-col">
          <Attachments draftKey={draftKey} disabled={busy} refocus={refocus} />
          <AttachmentPreview draftKey={draftKey} />
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
              const back = target.kind === "project" ? target.repoId : primary;
              useUiStore.getState().select(back ? { kind: "repo", repoId: back } : { kind: "none" });
              return true;
            }}
            onPasteFiles={attach}
            onPreviewChip={(id, el) => openPreview(draftKey, id, el)}
          />
        </div>
        <div className="col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-0.5 px-2 pb-2">
          <ComposerPicker
            label="Model"
            icon={Brain}
            text={choiceLabel(MODEL_CHOICES, model)}
            value={model}
            groups={[{ options: MODEL_CHOICES }]}
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
          <button
            type="button"
            disabled={busy}
            aria-label="Attach images"
            title="Attach images"
            data-compose-stop
            data-testid="composer-attach"
            className="ml-auto flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip className="size-4" />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={`image/*,${ATTACHMENT_MIME_TYPES.join(",")}`}
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
          <div className="col-span-2 col-start-1 row-start-3 flex flex-col gap-1 px-2 pt-2 text-sm">
            {error && (
              <p role="alert" className="text-destructive" data-testid="composer-error">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="text-amber-600 dark:text-amber-300" data-testid="composer-notice">
                {notice}
              </p>
            )}
          </div>
        )}
        <div className="col-span-2 col-start-1 row-start-4 flex flex-wrap items-center gap-0.5 px-1 pt-2">
          <ComposerPicker
            label="Worktree"
            icon={worktreeIcon}
            text={worktreeText}
            value={worktree.kind === "existing" ? worktree.path : worktree.kind}
            groups={worktreeGroups}
            onChange={(v) => {
              updateDraft(draftKey, { worktree: v === "new" || v === "members" ? { kind: v } : { kind: "existing", path: v } });
            }}
            disabled={busy}
            contentClassName="w-80"
            data-testid="composer-worktree"
          />
          {chosen && <BranchIndicator worktree={chosen} />}
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
        </div>
        <div className="col-start-2 row-start-2 flex items-end pr-2 pb-2">
          <button
            type="button"
            disabled={!canSend}
            aria-label={busy ? phaseText(phase, newWorktrees) : "Start thread"}
            title="Start thread"
            data-compose-stop
            data-testid="composer-send"
            data-phase={phase}
            className={cn(
              "flex h-8 items-center justify-center gap-1.5 rounded-full bg-primary text-primary-foreground outline-none transition-all hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none",
              busy ? "px-3 text-xs font-medium" : "w-8 disabled:opacity-40",
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
        </div>
      </div>
    </div>
  );
}

/** The new-thread composer for a project, or a workspace with workspaceId (Selection kind "compose"). */
export function Composer({ repoId, workspaceId }: { repoId: string; workspaceId?: string }) {
  const target = useMemo<ComposeTarget>(() => (workspaceId ? { kind: "workspace", workspaceId } : { kind: "project", repoId }), [repoId, workspaceId]);
  const projectName = useReposStore((s) => s.byId[repoId]?.name ?? null);
  const workspaceName = useWorkspacesStore((s) => (workspaceId ? (s.byId[workspaceId]?.name ?? null) : null));
  const reposLoaded = useReposStore((s) => s.loaded);
  const workspacesLoaded = useWorkspacesStore((s) => s.loaded);
  const name = workspaceId ? workspaceName : projectName;
  const loaded = workspaceId ? workspacesLoaded : reposLoaded;
  const gone = workspaceId ? "This workspace no longer exists." : "This project is no longer registered.";
  return (
    // Centered in the pane both ways at any size: auto margins in a column flexbox center
    // the block and, unlike justify-center, fall back to 0 (scrollable from the top) when
    // the draft outgrows the pane.
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-10" data-region="content" aria-label="New thread" data-testid="composer">
      {name === null ? (
        <p className="m-auto text-sm text-muted-foreground">{loaded ? gone : "Loading…"}</p>
      ) : (
        <div className="m-auto w-full max-w-2xl" data-testid="composer-body">
          <h1 className="mb-6 text-center text-2xl font-semibold tracking-tight" data-testid="composer-heading">
            What should we build in <span className="text-foreground">{name}</span>?
          </h1>
          <ComposerCard target={target} />
        </div>
      )}
    </section>
  );
}
