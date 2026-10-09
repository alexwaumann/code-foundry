import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowUp, Brain, FolderGit2, Gauge, GitBranch, GitBranchPlus, GitCommitHorizontal, Loader2, Paperclip, ShieldCheck, X } from "lucide-react";
import { ComposerPicker, type PickerGroup } from "./ComposerPicker";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";
import { ATTACHMENT_MIME_TYPES } from "@/api/session";
import {
  choiceLabel,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORT_CHOICES,
  MODEL_CHOICES,
  PERMISSION_CHOICES,
  pickDefault,
  type ComposePermission,
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

const SEP = "\u0001";

/** Model and effort the composer starts with: the settings defaults, else opus / high. */
function useDefaults(): { model: string; effort: string } {
  const model = pickDefault(MODEL_CHOICES, useSettingValue("sessions.default_model"), DEFAULT_MODEL);
  const effort = pickDefault(EFFORT_CHOICES, useSettingValue("sessions.default_effort"), DEFAULT_EFFORT);
  return useMemo(() => ({ model, effort }), [model, effort]);
}

interface WorktreeOption {
  path: string;
  branch: string;
  isMain: boolean;
}

/** The repo's worktrees (main first), as a shallow-stable list. */
function useWorktrees(repoId: string): WorktreeOption[] {
  const keys = useReposStore(
    useShallow((s) => (s.byId[repoId]?.worktrees ?? []).map((w) => [w.path, w.branch || w.head.slice(0, 7), w.isMain ? "1" : ""].join(SEP))),
  );
  return useMemo(
    () =>
      keys.map((k) => {
        const [path = "", branch = "", main = ""] = k.split(SEP);
        return { path, branch, isMain: main === "1" };
      }),
    [keys],
  );
}

/** The chosen worktree, or a new one when the chosen one no longer exists. */
function resolveWorktree(choice: WorktreeChoice, worktrees: readonly WorktreeOption[]): WorktreeChoice {
  return choice.kind === "existing" && !worktrees.some((w) => w.path === choice.path) ? { kind: "new" } : choice;
}

function phaseText(phase: DraftPhase, newWorktree: boolean): string {
  if (phase === "attaching") return "Attaching images…";
  return newWorktree ? "Creating worktree…" : "Starting Claude…";
}

/**
 * Removes an attachment from the draft. Still referenced by a chip in the text: asks
 * first, then removes the image and every reference; unreferenced: removes it at once.
 */
async function removeWithConfirm(repoId: string, a: DraftAttachment, refocus: () => void): Promise<void> {
  if (isReferenced(getDraft(repoId).text, a.id)) {
    const yes = await requestConfirm({
      title: `Remove ${a.file.name} from the message?`,
      message: "It is referenced in your text; removing it also removes every reference.",
      confirmLabel: "Confirm",
      centered: true,
    });
    if (!yes) return;
  }
  removeAttachment(repoId, a.id);
  refocus();
}

function Attachments({ repoId, disabled, refocus }: { repoId: string; disabled: boolean; refocus: () => void }) {
  const attachments = useDraft(repoId, "attachments");
  if (attachments.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attached images">
      {attachments.map((a) => (
        <li
          key={a.id}
          className="group relative size-16 overflow-hidden rounded-lg border bg-muted/40"
          data-testid="attachment"
          data-attachment-id={a.id}
          title={`${a.file.name}\n${formatAttachmentSize(a.file.size)}`}
        >
          <img src={a.url} alt={a.file.name} className="size-full object-cover" />
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove ${a.file.name}`}
            className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-black/70 text-white opacity-80 hover:opacity-100 focus-visible:opacity-100 disabled:hidden"
            onClick={() => {
              void removeWithConfirm(repoId, a, refocus);
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

/**
 * The card: attachments, the prompt, the model/effort/permission pickers, attach and
 * send; below it the worktree and base-ref pickers. Grid placement keeps the send button
 * inside the card while Tab goes textarea → pickers (worktree and base included) → send.
 */
function ComposerCard({ repoId }: { repoId: string }) {
  const defaults = useDefaults();
  const text = useDraft(repoId, "text");
  const hasAttachments = useDraft(repoId, "attachments").length > 0;
  const model = useDraft(repoId, "model") ?? defaults.model;
  const effort = useDraft(repoId, "effort") ?? defaults.effort;
  const permission = useDraft(repoId, "permission");
  const choice = useDraft(repoId, "worktree");
  const baseChoice = useDraft(repoId, "base");
  const phase = useDraft(repoId, "phase");
  const error = useDraft(repoId, "error");
  const notice = useDraft(repoId, "notice");
  const refsStatus = useComposeStore((s) => s.refs[repoId]?.status ?? "loading");
  const refsError = useComposeStore((s) => s.refs[repoId]?.error ?? null);
  const refsOutdated = useComposeStore((s) => s.refs[repoId]?.outdated ?? false);
  const refs = useComposeStore((s) => s.refs[repoId]?.refs);
  const defaultRef = useComposeStore((s) => s.refs[repoId]?.defaultRef ?? "");
  const worktrees = useWorktrees(repoId);
  const focusSeq = useUiStore((s) => s.composerFocusSeq);
  const editorRef = useRef<PromptEditorHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const busy = phase !== "idle";
  const worktree = resolveWorktree(choice, worktrees);
  const base = baseChoice ?? defaultRef;
  const canSend = !busy && (text.trim() !== "" || hasAttachments);

  useEffect(() => {
    void loadRefs(repoId);
  }, [repoId]);

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
    if (canSend) void sendDraft(repoId, defaults);
  };

  /** Pasted, dropped or picked files: thumbnails, and chips at the caret. */
  const attach = (files: File[]) => {
    const added = addAttachments(repoId, files);
    editorRef.current?.insertChips(added.map((a) => ({ id: a.id, name: a.file.name })));
  };
  const refocus = () => editorRef.current?.focus();

  const worktreeGroups = useMemo<PickerGroup[]>(
    () => [
      { options: [{ value: "new", label: "New worktree", detail: "A cf/… branch named from the prompt" }] },
      {
        heading: "Existing",
        options: worktrees.map((w) => ({
          value: w.path,
          label: w.isMain ? "Current checkout" : w.branch,
          detail: w.isMain ? `${w.branch} · ${tildify(w.path)}` : tildify(w.path),
        })),
      },
    ],
    [worktrees],
  );
  const chosen = worktree.kind === "existing" ? worktrees.find((w) => w.path === worktree.path) : undefined;
  const worktreeText = !chosen ? "New worktree" : chosen.isMain ? "Current checkout" : `Existing worktree: ${chosen.branch}`;

  // ListRefs order (local branches, then remote-tracking refs), the default first.
  const refGroups = useMemo<PickerGroup[]>(() => {
    const list = refs ?? [];
    const ordered = defaultRef && list.includes(defaultRef) ? [defaultRef, ...list.filter((r) => r !== defaultRef)] : list;
    return [{ options: ordered.map((r) => ({ value: r, label: r, detail: r === defaultRef ? "default" : undefined })) }];
  }, [refs, defaultRef]);

  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_auto]"
      data-testid="composer-card"
      data-dragging={dragging || undefined}
      onKeyDown={cycleStops}
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
        <Attachments repoId={repoId} disabled={busy} refocus={refocus} />
        <PromptEditor
          handleRef={editorRef}
          repoId={repoId}
          value={text}
          disabled={busy}
          placeholder="Describe what to build…"
          onChange={(t) => {
            updateDraft(repoId, { text: t, error: null });
          }}
          onSubmit={send}
          onEscape={() => {
            if (!isDraftEmpty(getDraft(repoId))) return false;
            useUiStore.getState().select({ kind: "repo", repoId });
            return true;
          }}
          onPasteFiles={attach}
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
            updateDraft(repoId, { model: v });
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
            updateDraft(repoId, { effort: v });
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
            updateDraft(repoId, { permission: v as ComposePermission });
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
          icon={!chosen ? GitBranchPlus : chosen.isMain ? FolderGit2 : GitBranch}
          text={worktreeText}
          value={worktree.kind === "existing" ? worktree.path : "new"}
          groups={worktreeGroups}
          onChange={(v) => {
            updateDraft(repoId, { worktree: v === "new" ? { kind: "new" } : { kind: "existing", path: v } });
          }}
          disabled={busy}
          contentClassName="w-80"
          data-testid="composer-worktree"
        />
        {worktree.kind === "new" && (
          <ComposerPicker
            label="Base"
            icon={GitCommitHorizontal}
            text={base ? `From ${base}` : "From the default branch"}
            value={base}
            groups={refGroups}
            onChange={(v) => {
              updateDraft(repoId, { base: v });
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
          aria-label={busy ? phaseText(phase, worktree.kind === "new") : "Start thread"}
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
              {phaseText(phase, worktree.kind === "new")}
            </>
          ) : (
            <ArrowUp className="size-4" aria-hidden />
          )}
        </button>
      </div>
    </div>
  );
}

/** The new-thread composer for a repo (Selection kind "compose"). */
export function Composer({ repoId }: { repoId: string }) {
  const name = useReposStore((s) => s.byId[repoId]?.name ?? null);
  const loaded = useReposStore((s) => s.loaded);
  return (
    // Centered in the pane both ways at any size: auto margins in a column flexbox center
    // the block and, unlike justify-center, fall back to 0 (scrollable from the top) when
    // the draft outgrows the pane.
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-10" data-region="content" aria-label="New thread" data-testid="composer">
      {name === null ? (
        <p className="m-auto text-sm text-muted-foreground">{loaded ? "This repository is no longer registered." : "Loading…"}</p>
      ) : (
        <div className="m-auto w-full max-w-2xl" data-testid="composer-body">
          <h1 className="mb-6 text-center text-2xl font-semibold tracking-tight" data-testid="composer-heading">
            What should we build in <span className="text-foreground">{name}</span>?
          </h1>
          <ComposerCard repoId={repoId} />
        </div>
      )}
    </section>
  );
}
