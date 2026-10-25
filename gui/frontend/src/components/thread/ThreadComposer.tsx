import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlarmClockOff, ArrowUp, Brain, Gauge, Loader2, Paperclip, ShieldCheck } from "lucide-react";
import type { ThreadPendingView } from "@/api/thread";
import { AttachmentPreview } from "@/components/compose/AttachmentPreview";
import { CompletionCard } from "@/components/compose/CompletionCard";
import { ATTACHMENT_ACCEPT, Attachments } from "@/components/compose/Composer";
import { ComposerPicker } from "@/components/compose/ComposerPicker";
import { PromptEditor, type EditorTrigger, type PromptEditorHandle } from "@/components/compose/PromptEditor";
import { TagMultiProjectContext } from "@/components/compose/tagContext";
import { attachLabel, useHostFiles } from "@/components/compose/useHostFiles";
import { useNoProjectThread } from "@/components/thread/useNoProject";
import { useThreadCheckouts } from "@/components/thread/useThreadCheckouts";
import { useCommandSource, useCompletion, useFileSource, useSkillSource, type CompletionSource } from "@/components/compose/useCompletion";
import { useMentionSource, useProjectSlugs, usePrSource } from "@/components/compose/useRefSources";
import { Tip } from "@/components/ui/tooltip";
import { choiceLabel, EFFORT_CHOICES, PERMISSION_CHOICES, type ComposePermission } from "@/lib/compose";
import { fileSources, skillSources, skillSourcesKey, type TriggerChar } from "@/lib/completion";
import { useNow } from "@/lib/clock";
import { snoozeTimeShort } from "@/lib/snooze";
import { statusLine, statusText } from "@/lib/statusLine";
import { cn } from "@/lib/utils";
import { addAttachments, openPreview, updateDraft, useDraft } from "@/stores/compose";
import { getPanel } from "@/stores/panel";
import { useThreadsStore } from "@/stores/threads";
import { useModelChoices } from "@/stores/settings";
import { loadSkills } from "@/stores/skills";
import { useSlashCommands } from "@/stores/thread";
import { interruptThread, sendThreadDraft, snoozeThread, setThreadEffort, setThreadModel, setThreadPermission, threadDraftKey } from "@/stores/threadActions";
import { useUiStore } from "@/stores/ui";
import { registerCiteTarget } from "@/stores/cite";
import { ColdCacheNote } from "./ColdCacheNote";
import { RetryNote } from "./RetryNote";
import { PendingPrompts, type PromptKeys } from "./PendingPrompt";

const TRIGGERS: readonly TriggerChar[] = ["/", "@", "#"];
/**
 * A thread without a project: "/" and "@" for other threads only (files would come from
 * its cwd, the home directory, which is never indexed; no repository for "#").
 */
const HOME_TRIGGERS: readonly TriggerChar[] = ["/", "@"];

/**
 * The last ui promptFocusSeq a thread composer acted on. Module-level: selecting a thread
 * to type in bumps it before that thread's composer mounts, so a fresh composer still
 * sees the request as new.
 */
let handledPromptSeq = 0;

function hasFocusWithin(el: HTMLElement | null): boolean {
  return !!el && el.contains(document.activeElement);
}
const EFFORT_GROUPS = [{ options: EFFORT_CHOICES.map((c) => ({ value: c.value, label: c.label })) }];

/**
 * The thread's projects for "/" and "@": its set, the primary first, each read from the
 * checkout the thread has there (useThreadCheckouts); none without a project (only the
 * user's skills, and no "@").
 */
function useThreadSources(threadId: string) {
  const noProject = useNoProjectThread(threadId);
  const { projectIds, paths } = useThreadCheckouts(threadId);
  return useMemo(() => {
    if (noProject) return { noProject, projectIds: [], skills: [], files: [] };
    const input = { projectIds, paths };
    return { noProject, projectIds, skills: skillSources(input), files: fileSources(input) };
  }, [noProject, projectIds, paths]);
}

/** "Snoozed until Thu 9:00 AM" for a snoozed thread, on the shared 30 s clock. */
function SnoozedUntil({ until }: { until: number }) {
  const now = useNow(30_000);
  return <span data-testid="thread-snoozed">Snoozed until {snoozeTimeShort(until, now)}</span>;
}

/** "Snooze ended · 2 min ago" in amber, like the sidebar row's line 2, for a woken thread. */
function SnoozeEnded({ at }: { at: number | null }) {
  const now = useNow(30_000);
  return (
    <span className="text-cf-warning-text" data-testid="thread-snooze-ended">
      {statusText({ kind: "snoozeEnded", detail: "", at }, now)}
    </span>
  );
}

/**
 * The composer's snooze line above the prompt: a snoozed thread says until when, with
 * Unsnooze (a message unsnoozes too); a thread the daemon woke says "Snooze ended · <ago>"
 * (the header's Snooze button snoozes again). Nothing otherwise.
 */
function SnoozeNote({ threadId }: { threadId: string }) {
  const snoozedUntil = useThreadsStore((s) => s.byId[threadId]?.snoozedUntilMs ?? null);
  const wokeAt = useThreadsStore((s) => {
    const l = statusLine(s.byId[threadId]);
    return l.kind === "snoozeEnded" ? (l.at ?? 0) : null;
  });
  if (snoozedUntil === null && wokeAt === null) return null;
  return (
    <div className="col-span-2 flex min-w-0 items-center gap-2 px-4 pt-2 text-caption" data-testid="thread-snooze-note">
      {snoozedUntil !== null ? <SnoozedUntil until={snoozedUntil} /> : <SnoozeEnded at={wokeAt === 0 ? null : wokeAt} />}
      {snoozedUntil !== null && (
        <button
          type="button"
          className="btn outline ml-auto"
          data-testid="thread-unsnooze"
          onClick={() => {
            void snoozeThread(threadId, null);
          }}
        >
          <AlarmClockOff aria-hidden />
          Unsnooze
        </button>
      )}
    </div>
  );
}

/**
 * The follow-up composer floating over the bottom of the thread (variant A): the
 * new-thread composer's prompt editor with its "/" skills (the running process's slash
 * commands when it has reported them) and "@" files, image
 * and PDF attachments, the model / effort / permission pickers, attach, Interrupt while Claude
 * works (the only Interrupt), and send. Pending permissions and questions dock into the
 * top of the card, oldest first (the card turns opaque); while the editor is empty its
 * digits (and a question's Enter) answer the oldest. Escape does not interrupt (it stopped
 * turns by accident); only the Interrupt button does. An effort change restarts Claude,
 * after the turn when one runs. The draft is the compose store's `thread:<id>`.
 */
export function ThreadComposer({
  threadId,
  pending,
  busy,
  placeholder,
  busyPlaceholder,
  focusRequests = true,
}: {
  threadId: string;
  pending: readonly ThreadPendingView[];
  busy: boolean;
  /** The empty prompt's text (default "Send a follow-up…"). */
  placeholder?: string | undefined;
  /** The empty prompt's text while Claude works (default: the placeholder and "Claude picks it up mid-turn"). */
  busyPlaceholder?: string | undefined;
  /** Whether focus requests for the content pane land here: the content pane's composer only, not a plugin's thread node's. */
  focusRequests?: boolean;
}) {
  const draftKey = threadDraftKey(threadId);
  const text = useDraft(draftKey, "text");
  const hasAttachments = useDraft(draftKey, "attachments").length > 0;
  const phase = useDraft(draftKey, "phase");
  const error = useDraft(draftKey, "error");
  const notice = useDraft(draftKey, "notice");
  const model = useThreadsStore((s) => s.byId[threadId]?.model ?? "");
  const effort = useThreadsStore((s) => s.byId[threadId]?.effort ?? "");
  const permission = useThreadsStore((s) => s.byId[threadId]?.permissionMode ?? "");
  const effortPending = useThreadsStore((s) => s.byId[threadId]?.effortPending ?? false);
  const promptKeys = useRef<PromptKeys | null>(null);
  const modelChoices = useModelChoices();
  const modelGroups = useMemo(() => [{ options: modelChoices }], [modelChoices]);
  const sources = useThreadSources(threadId);
  const editorRef = useRef<PromptEditorHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [trigger, setTrigger] = useState<EditorTrigger | null>(null);
  // "/": the running process's own list (what "/name" runs); the disk scan while there is
  // none (not running yet, or a daemon that predates the list).
  const commands = useSlashCommands(threadId);
  const skillSource = useSkillSource(trigger, skillSourcesKey(sources.skills), sources.projectIds);
  const commandSource = useCommandSource(trigger, commands, skillSourcesKey(sources.skills), sources.projectIds);
  const slashSource = commands.length > 0 ? commandSource : skillSource;
  const fileSource = useFileSource(trigger, sources.files, sources.projectIds, sources.projectIds[0] ?? "");
  const mentionSource = useMentionSource(trigger, sources.noProject ? null : fileSource, threadId);
  const prSource = usePrSource(trigger, useProjectSlugs(sources.projectIds));
  const bySource: Record<TriggerChar, CompletionSource> = { "/": slashSource, "@": mentionSource, "#": prSource };
  const completion = useCompletion(trigger, setTrigger, bySource[trigger?.char ?? "/"], editorRef);
  const sending = phase !== "idle";
  // Native drops and the native open panel (in the Wails host); the panel opens in the
  // thread's checkout, else home (a thread without a project).
  const worktreePath = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const hostFiles = useHostFiles({ draftKey, editorRef, disabled: sending, startDir: worktreePath });
  // The daemon takes a message in any state: a stopped thread starts on it.
  const canSend = !sending && (text.trim() !== "" || hasAttachments);

  useEffect(() => {
    void loadSkills(sources.skills);
  }, [sources.skills]);

  // The thread's cite layer inserts citations at the prompt's caret (docs/notes/citations.md).
  useEffect(
    () =>
      registerCiteTarget(draftKey, {
        insert: (id) => {
          editorRef.current?.insertCite(id);
        },
        focus: () => {
          editorRef.current?.focusCollapsed();
        },
      }),
    [draftKey],
  );

  // Focus requests land in the prompt: a thread selected to be typed in (ui
  // promptFocusSeq), the content pane asked for (the side panel hid, ui contentFocusSeq).
  // A composer that mounts with no request (Show worktree, a revealed shell) leaves the
  // keyboard where that put it. Under an expanded side panel the panel takes the
  // requested focus.
  const focusSeq = useUiStore((s) => s.promptFocusSeq);
  const contentFocusSeq = useUiStore((s) => s.contentFocusSeq);
  const seenContent = useRef(contentFocusSeq);
  // Where the keyboard was when this request came in (kept across StrictMode's effect replay).
  const request = useRef<{ key: string; before: Element | null } | null>(null);
  // Settled a frame after mount: the editor (recreated by StrictMode's replay in dev) is
  // the one that stays, so a focus request can be served at once.
  const settled = useRef(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      settled.current = true;
    });
    return () => {
      cancelAnimationFrame(raf);
      settled.current = false;
    };
  }, []);
  const inRoot = (el: Element | null): boolean => el !== null && rootRef.current?.contains(el) === true;
  useEffect(() => {
    if (!focusRequests) return;
    if (handledPromptSeq === focusSeq && seenContent.current === contentFocusSeq) return;
    const key = `${String(focusSeq)}:${String(contentFocusSeq)}`;
    if (request.current?.key !== key) request.current = { key, before: document.activeElement };
    const { before } = request.current;
    // At once when the composer has settled (a key pressed right after must reach the
    // prompt, not the palette input closing over it), else on the next frame (a composer
    // just mounted: its editor may still be replaced).
    const attempt = (): boolean => {
      const panel = getPanel();
      if (panel.open && panel.expanded) {
        useUiStore.setState((u) => ({ panelFocusSeq: u.panelFocusSeq + 1 }));
        return true;
      }
      // Something took the keyboard meanwhile (the side panel, the inline rename a
      // double-click on the sidebar row starts): leave it there.
      const now = document.activeElement;
      if (now !== before && now !== null && now !== document.body && !inRoot(now)) return true;
      editorRef.current?.focus();
      return inRoot(document.activeElement);
    };
    const done = () => {
      handledPromptSeq = focusSeq;
      seenContent.current = contentFocusSeq;
    };
    if (settled.current && attempt()) {
      done();
      return;
    }
    const raf = requestAnimationFrame(() => {
      done();
      attempt();
    });
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [focusSeq, contentFocusSeq, threadId, focusRequests]);

  // The editor turns read-only while a send is in flight. Chromium drops its focus then;
  // WebKit keeps the element focused but no longer edits in it, and the editor's focus()
  // is a no-op on a focused view. So: note whether the composer had focus as the send
  // began (a layout effect, ahead of the editor's own effect that makes it read-only), and
  // once the draft is idle again blur and refocus the prompt, unless the user has moved on
  // to something else meanwhile.
  const rootRef = useRef<HTMLDivElement>(null);
  const focusedAtSend = useRef(false);
  useLayoutEffect(() => {
    if (sending) focusedAtSend.current ||= hasFocusWithin(rootRef.current);
  }, [sending]);
  useEffect(() => {
    if (sending || !focusedAtSend.current) return;
    focusedAtSend.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && !hasFocusWithin(rootRef.current)) return;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
    editorRef.current?.focus();
  }, [sending]);

  const send = () => {
    if (canSend) void sendThreadDraft(threadId);
  };
  const attach = (files: File[]) => {
    const added = addAttachments(draftKey, files);
    editorRef.current?.insertChips(added.map((a) => ({ id: a.id, name: a.file.name })));
  };
  const refocus = () => editorRef.current?.focus();
  const editorEmpty = text.trim() === "" && !hasAttachments;
  const docked = pending.length > 0;

  return (
    // data-chord-yield: cmd chords bound to commands (cmd+j, cmd+r) reach
    // the app from the prompt, as they did from a thread's terminal (keys/bindings.ts).
    <div className="relative" ref={rootRef} data-chord-yield="">
      <div
        className={cn("ccard", docked && "docked")}
        data-testid="thread-composer"
        data-dragging={dragging || undefined}
        // A native drop (Wails host) lands here by this id; the runtime marks the card
        // file-drop-target-active while a drag from the OS is over it (thread.css).
        {...hostFiles.dropTarget}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setDragging(false);
        }}
        onDrop={(e) => {
          setDragging(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length === 0) return;
          e.preventDefault();
          attach(files);
        }}
      >
        {docked && <PendingPrompts pending={pending} keysRef={promptKeys} refocus={refocus} />}
        <SnoozeNote threadId={threadId} />
        <RetryNote threadId={threadId} />
        <ColdCacheNote threadId={threadId} pending={pending.length} />
        <div
          className="col-span-2 flex min-w-0 flex-col"
          onKeyDownCapture={(e) => {
            // The oldest prompt takes an empty editor's digits and Enter (ahead of the editor).
            const take = promptKeys.current;
            if (!take || e.nativeEvent.isComposing || !(e.target instanceof HTMLElement) || !e.target.isContentEditable) return;
            if (take({ key: e.key, plain: !e.metaKey && !e.ctrlKey && !e.altKey, from: "editor", editorEmpty })) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        >
          <Attachments draftKey={draftKey} disabled={sending} refocus={refocus} />
          <AttachmentPreview draftKey={draftKey} />
          <TagMultiProjectContext.Provider value={sources.projectIds.length > 1}>
            <PromptEditor
              handleRef={editorRef}
              draftKey={draftKey}
              value={text}
              disabled={sending}
              placeholder={busy ? (busyPlaceholder ?? `${placeholder ?? "Send a follow-up…"} Claude picks it up mid-turn`) : (placeholder ?? "Send a follow-up…")}
              onChange={(t) => {
                updateDraft(draftKey, { text: t, error: null });
              }}
              onSubmit={send}
              onPasteFiles={attach}
              onPreviewChip={(id, el) => openPreview(draftKey, id, el)}
              triggers={sources.noProject ? HOME_TRIGGERS : TRIGGERS}
              onTrigger={completion.onTrigger}
              onCompletionKey={completion.onKey}
              completionAria={completion.aria}
            />
          </TagMultiProjectContext.Provider>
        </div>
        <div className="col-start-1 flex min-w-0 flex-wrap items-center gap-0.5 px-2 pb-2">
          <ComposerPicker
            label="Model"
            icon={Brain}
            text={model ? choiceLabel(modelChoices, model) : "Default"}
            value={model}
            groups={modelGroups}
            onChange={(v) => {
              if (v !== model) void setThreadModel(threadId, v);
            }}
            contentClassName="w-44"
            data-testid="thread-model"
          />
          {/* Claude has no live effort switch: the daemon restarts it with --resume, after the turn when one runs. */}
          <ComposerPicker
            label="Effort"
            icon={Gauge}
            text={effort ? choiceLabel(EFFORT_CHOICES, effort) : "Default"}
            value={effort}
            groups={EFFORT_GROUPS}
            onChange={(v) => {
              if (v !== effort) void setThreadEffort(threadId, v);
            }}
            contentClassName="w-44"
            data-testid="thread-effort"
          />
          <ComposerPicker
            label="Permissions"
            icon={ShieldCheck}
            text={permission ? choiceLabel(PERMISSION_CHOICES, permission) : "Default"}
            value={permission}
            groups={[{ options: PERMISSION_CHOICES.map((p) => ({ value: p.value, label: p.label, detail: p.hint })) }]}
            onChange={(v) => {
              if (v !== permission) void setThreadPermission(threadId, v as ComposePermission);
            }}
            contentClassName="w-60"
            data-testid="thread-permission-mode"
          />
          {/* The span carries the tooltip while the button is disabled (no pointer events). */}
          <Tip label={attachLabel(hostFiles.hosted)}>
            <span className="ml-auto flex">
              <button
                type="button"
                disabled={sending}
                aria-label={attachLabel(hostFiles.hosted)}
                data-testid="thread-attach"
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
            data-testid="thread-file-input"
            onChange={(e) => {
              attach(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </div>
        <div className="col-start-2 flex items-end gap-1.5 pr-2 pb-2">
          {busy && (
            <button
              type="button"
              className="intr"
              data-testid="thread-interrupt"
              onClick={() => {
                void interruptThread(threadId);
              }}
            >
              <i aria-hidden />
              Interrupt
            </button>
          )}
          {/* The span carries the tooltip while the button is disabled (no pointer events). */}
          <Tip label="Send">
            <span className="flex">
              <button
                type="button"
                disabled={!canSend}
                aria-label={phase === "attaching" ? "Attaching files…" : sending ? "Sending…" : "Send"}
                data-testid="thread-send"
                data-phase={phase}
                className="flex size-8 items-center justify-center rounded-full bg-cf-accent text-cf-accent-foreground outline-none transition-all hover:bg-cf-accent/90 focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 disabled:pointer-events-none disabled:opacity-40"
                // A click leaves the caret in the prompt, so it is focused again after the send.
                onMouseDown={(e) => {
                  e.preventDefault();
                }}
                onClick={send}
              >
                {sending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ArrowUp className="size-4" aria-hidden />}
              </button>
            </span>
          </Tip>
        </div>
        {effortPending && (
          <p className="col-span-2 px-4 pb-2 text-caption" role="status" data-testid="thread-effort-pending">
            {busy ? `Effort changes to ${choiceLabel(EFFORT_CHOICES, effort)} after this turn` : `Switching to ${choiceLabel(EFFORT_CHOICES, effort)} effort…`}
          </p>
        )}
        {(error ?? notice) && (
          <div className="col-span-2 flex flex-col gap-1 px-4 pb-2 text-body">
            {error && (
              <p role="alert" className="text-cf-error-text" data-testid="thread-composer-error">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="text-cf-warning-text">
                {notice}
              </p>
            )}
          </div>
        )}
      </div>
      <CompletionCard completion={completion} above />
    </div>
  );
}
