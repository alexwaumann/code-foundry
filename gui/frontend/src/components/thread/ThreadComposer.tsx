import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useServesFocusRequests } from "@/shell/paneContext";
import { ArrowUp, Gauge, Loader2, Paperclip, ShieldCheck } from "lucide-react";
import type { ThreadPendingView } from "@/api/thread";
import { AttachmentPreview } from "@/components/compose/AttachmentPreview";
import { CompletionCard } from "@/components/compose/CompletionCard";
import { DictationMic, DictationNote } from "@/components/compose/DictationMic";
import { useComposerDictation } from "@/components/compose/useComposerDictation";
import { PromptHistoryCard } from "@/components/compose/PromptHistoryCard";
import { usePromptPicker } from "@/components/compose/usePromptHistory";
import { ATTACHMENT_ACCEPT, Attachments, SEND_DISABLED } from "@/components/compose/Composer";
import { ClaudeMarkBrand } from "@/components/icons/ClaudeMark";
import { ComposerPicker } from "@/components/compose/ComposerPicker";
import { PromptEditor, type EditorTrigger, type PromptEditorHandle } from "@/components/compose/PromptEditor";
import { TagMultiProjectContext } from "@/components/compose/tagContext";
import { attachLabel, useHostFiles } from "@/components/compose/useHostFiles";
import { useNoProjectThread } from "@/components/thread/useNoProject";
import { useThreadCheckouts } from "@/components/thread/useThreadCheckouts";
import { useCompletion, useFileSource, useSlashSource, type CompletionSource } from "@/components/compose/useCompletion";
import { useMentionSource, useProjectSlugs, usePrSource } from "@/components/compose/useRefSources";
import { Tip } from "@/components/ui/tooltip";
import { choiceLabel, EFFORT_CHOICES, PERMISSION_CHOICES, type ComposePermission } from "@/lib/compose";
import { skillSources, skillSourcesKey, type TriggerChar } from "@/lib/completion";
import { useNow } from "@/lib/clock";
import { LISTENING_PLACEHOLDER } from "@/lib/dictation";
import { isSnoozed } from "@/lib/snooze";
import { statusLine, statusText } from "@/lib/statusLine";
import { setupUnfinished, setupWaitedFor } from "@/lib/threadSetup";

const PLACEHOLDER = "Reply or ask anything. @ files and threads, / skills and commands";
const BUSY_PLACEHOLDER = "Steer the agent mid-turn. @ files and threads, / skills and commands";
/** A setup in the background, or one that stopped: the daemon keeps what is sent for Claude. */
const SETUP_PLACEHOLDER = "Add to your message. It goes in once Claude starts.";
/** A setup its creator waits for: the daemon takes nothing, since its failure takes the thread too. */
const BLOCKING_PLACEHOLDER = "You can reply once Claude has started.";
import { cn } from "@/lib/utils";
import { addAttachments, openPreview, updateDraft, useDraft } from "@/stores/compose";
import { useThreadsStore } from "@/stores/threads";
import { useModelChoices } from "@/stores/settings";
import { loadSkills } from "@/stores/skills";
import { useSlashCommands } from "@/stores/thread";
import { interruptThread, sendThreadDraft, setThreadEffort, setThreadModel, setThreadPermission, threadDraftKey } from "@/stores/threadActions";
import { useUiStore } from "@/stores/ui";
import { registerCiteTarget } from "@/stores/cite";
import { cancelSetup } from "@/stores/setupActions";
import { ColdCacheNote } from "./ColdCacheNote";
import { CompactChip } from "./CompactChip";
import { FailedPromptNote } from "./FailedPromptNote";
import { RetryNote } from "./RetryNote";
import { SetupNote } from "./SetupNote";
import { TranscriptDeletedNote } from "./TranscriptDeleted";
import { AskStrip } from "@/components/needs/AskStrip";
import { PendingPrompts, type PromptKeys } from "./PendingPrompt";

const TRIGGERS: readonly TriggerChar[] = ["/", "@", "#"];
/**
 * A thread without a project: "/" and "@" for other threads only (files would come from
 * its cwd, the home directory, which is never indexed; no repository for "#").
 */
const HOME_TRIGGERS: readonly TriggerChar[] = ["/", "@"];
const NO_TRIGGERS: readonly TriggerChar[] = [];

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
    if (noProject) return { noProject, projectIds: [], checkouts: [] };
    return { noProject, projectIds, checkouts: skillSources({ projectIds, paths }) };
  }, [noProject, projectIds, paths]);
}

/** "Snooze ended · 2m ago" in amber, like the sidebar row's line 2, for a woken thread. */
function SnoozeEnded({ at }: { at: number | null }) {
  const now = useNow(30_000);
  return (
    <span className="text-cf-warning-text" data-testid="thread-snooze-ended">
      {statusText({ kind: "snoozeEnded", detail: "", at }, now)}
    </span>
  );
}

/**
 * The composer's line above the prompt for a thread the daemon woke: "Snooze ended · <ago>"
 * (the header's Snooze button snoozes again). Nothing otherwise; a thread still snoozed has
 * the dock's strip instead (SnoozeStrip).
 */
export function SnoozeNote({ threadId }: { threadId: string }) {
  const wokeAt = useThreadsStore((s) => {
    const t = s.byId[threadId];
    const l = statusLine(t);
    return l.kind === "snoozeEnded" && !(t && isSnoozed(t)) ? (l.at ?? 0) : null;
  });
  if (wokeAt === null) return null;
  return (
    <div className="col-span-2 flex min-w-0 items-center gap-2 px-4 pt-2 text-caption" data-testid="thread-snooze-note">
      <SnoozeEnded at={wokeAt === 0 ? null : wokeAt} />
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
  askStrip = null,
}: {
  threadId: string;
  pending: readonly ThreadPendingView[];
  busy: boolean;
  /** The empty prompt's text (default "Reply or ask anything. @ files and threads, / skills and commands"). */
  placeholder?: string | undefined;
  /** The empty prompt's text while Claude works (default "Steer the agent mid-turn. @ files and threads, / skills and commands"). */
  busyPlaceholder?: string | undefined;
  /** Whether focus requests for the content pane land here: the content pane's composer only, not a plugin's thread node's. */
  focusRequests?: boolean;
  /** A shell pane too short for the full ask (shell/askStrip.ts): that pane's id, and the ask docks as one line (AskStrip). */
  askStrip?: string | null;
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
  const slashSource = useSlashSource(trigger, useSlashCommands(threadId), skillSourcesKey(sources.checkouts), sources.projectIds);
  const fileSource = useFileSource(trigger, sources.checkouts, sources.projectIds, sources.projectIds[0] ?? "");
  const mentionSource = useMentionSource(trigger, sources.noProject ? null : fileSource, threadId);
  const prSource = usePrSource(trigger, useProjectSlugs(sources.projectIds));
  const bySource: Record<TriggerChar, CompletionSource> = { "/": slashSource, "@": mentionSource, "#": prSource };
  const completion = useCompletion(trigger, setTrigger, bySource[trigger?.char ?? "/"], editorRef);
  const sending = phase !== "idle";
  // Native drops and the native open panel (in the Wails host); the panel opens in the
  // thread's checkout, else home (a thread without a project).
  const worktreePath = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  // Claude Code deleted the transcript: the thread cannot continue, so nothing is typed,
  // attached or sent; the card's note offers Archive and Remove (TranscriptDeleted.tsx).
  const transcriptMissing = useThreadsStore((s) => s.byId[threadId]?.transcriptMissing === true);
  // The daemon refuses a model, effort or permission change while a setup runs: spawn may be reading them.
  const settingUp = useThreadsStore((s) => s.byId[threadId]?.setup?.phase === "running");
  // Only a background setup takes messages and can be cancelled; the other is its creator's.
  const setupBlocks = useThreadsStore((s) => setupWaitedFor(s.byId[threadId]?.setup));
  const setupHoldsMessages = useThreadsStore((s) => setupUnfinished(s.byId[threadId]?.setup)) && !setupBlocks;
  const [cancelling, setCancelling] = useState(false);
  const inputOff = sending || transcriptMissing;
  const hostFiles = useHostFiles({ draftKey, editorRef, disabled: inputOff, startDir: worktreePath });
  // The daemon takes a message in any state but those two: a stopped thread starts on it.
  const canSend = !inputOff && !setupBlocks && (text.trim() !== "" || hasAttachments);

  useEffect(() => {
    void loadSkills(sources.checkouts);
  }, [sources.checkouts]);

  // The thread's cite layer inserts citations at the prompt's caret (docs/notes/citations.md),
  // the file finder an @ file (⌥⏎).
  useEffect(
    () =>
      registerCiteTarget(draftKey, {
        insert: (id) => {
          editorRef.current?.insertCite(id);
        },
        insertTag: (tag) => {
          editorRef.current?.insertTagAtCaret(tag);
        },
        focus: () => {
          editorRef.current?.focusCollapsed();
        },
      }),
    [draftKey],
  );

  // Focus requests land in the prompt: a thread selected to be typed in (ui
  // promptFocusSeq), the content asked for (a sheet closed, ui contentFocusSeq).
  // A composer that mounts with no request (Show worktree, a revealed shell) leaves the
  // keyboard where that put it.
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
  // In the window shell only the focused pane's thread takes a request (shell/paneContext.ts).
  const serves = useServesFocusRequests();
  useEffect(() => {
    if (!focusRequests || !serves) return;
    if (handledPromptSeq === focusSeq && seenContent.current === contentFocusSeq) return;
    const key = `${String(focusSeq)}:${String(contentFocusSeq)}`;
    if (request.current?.key !== key) request.current = { key, before: document.activeElement };
    const { before } = request.current;
    // At once when the composer has settled (a key pressed right after must reach the
    // prompt, not the palette input closing over it), else on the next frame (a composer
    // just mounted: its editor may still be replaced).
    const attempt = (): boolean => {
      // Something took the keyboard meanwhile (another pane, the inline rename a
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
  }, [focusSeq, contentFocusSeq, threadId, focusRequests, serves]);

  // The editor turns read-only while a send is in flight. Chromium drops its focus then;
  // WebKit keeps the element focused but no longer edits in it, and the editor's focus()
  // is a no-op on a focused view. So: note whether the composer had focus as the send
  // began (a layout effect, ahead of the editor's own effect that makes it read-only), and
  // once the draft is idle again blur and refocus the prompt, unless the user has moved on
  // to something else meanwhile.
  const rootRef = useRef<HTMLDivElement>(null);
  const focusedAtSend = useRef(false);
  // The mic (docs/notes/dictation-4-gui.md): phrases land at the prompt's caret.
  const dictation = useComposerDictation({
    draftKey,
    rootRef,
    primary: focusRequests,
    insert: (t) => editorRef.current?.insertDictated(t),
    setMarker: (on) => editorRef.current?.setDictationMarker(on),
  });
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
    // Dictating: stop, let the last phrase land, then send what the prompt holds.
    if (dictation.phase) {
      if (!inputOff && !setupBlocks) void dictation.flush().then(() => sendThreadDraft(threadId));
      return;
    }
    if (canSend) void sendThreadDraft(threadId);
  };
  const attach = (files: File[]) => {
    if (transcriptMissing) return;
    const added = addAttachments(draftKey, files);
    editorRef.current?.insertChips(added.map((a) => ({ id: a.id, name: a.file.name })));
  };
  const refocus = () => editorRef.current?.focus();
  const editorEmpty = text.trim() === "" && !hasAttachments;
  const docked = pending.length > 0;
  // Previous prompts: Up in the empty prompt (no tags, attachments or open card) opens it,
  // in This thread (docs/notes/prompt-history-2-picker.md).
  const historySource = useMemo(() => ({ threadId }), [threadId]);
  const picker = usePromptPicker({
    draftKey,
    editorRef,
    rootRef,
    threadId,
    source: historySource,
    canOpen: editorEmpty && trigger === null && completion.show === "none",
    blocked: inputOff || docked,
  });

  return (
    // data-chord-yield: cmd chords bound to commands (cmd+j, cmd+r) reach
    // the app from the prompt, as they did from a thread's terminal (keys/bindings.ts).
    <div className="relative" ref={rootRef} data-chord-yield="" onBlur={picker.onBlur}>
      <div
        className={cn("ccard", docked && "docked")}
        data-testid="thread-composer"
        data-dragging={dragging || undefined}
        // A native drop (Wails host) lands here by this id; the runtime marks the card
        // file-drop-target-active while a drag from the OS is over it (thread.css).
        {...hostFiles.dropTarget}
        onDragOver={(e) => {
          if (transcriptMissing || !e.dataTransfer.types.includes("Files")) return;
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
        {docked && (askStrip !== null ? <AskStrip threadId={threadId} pending={pending} paneId={askStrip} /> : <PendingPrompts pending={pending} keysRef={promptKeys} refocus={refocus} />)}
        <SnoozeNote threadId={threadId} />
        <SetupNote threadId={threadId} />
        <RetryNote threadId={threadId} />
        <FailedPromptNote threadId={threadId} pending={pending.length} focusEditor={() => editorRef.current?.focusCollapsed()} />
        {/* A cold cache means nothing once the conversation is gone. */}
        {transcriptMissing ? <TranscriptDeletedNote threadId={threadId} /> : <ColdCacheNote threadId={threadId} pending={pending.length} />}
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
          <Attachments draftKey={draftKey} disabled={inputOff} refocus={refocus} />
          <AttachmentPreview draftKey={draftKey} />
          <TagMultiProjectContext.Provider value={sources.projectIds.length > 1}>
            <PromptEditor
              handleRef={editorRef}
              draftKey={draftKey}
              value={text}
              disabled={inputOff}
              placeholder={
                transcriptMissing
                  ? "Transcript deleted"
                  : (picker.placeholder ??
                    (dictation.listening
                      ? LISTENING_PLACEHOLDER
                      : setupBlocks
                        ? BLOCKING_PLACEHOLDER
                        : setupHoldsMessages
                          ? SETUP_PLACEHOLDER
                          : busy
                            ? (busyPlaceholder ?? BUSY_PLACEHOLDER)
                            : (placeholder ?? PLACEHOLDER)))
              }
              onChange={(t) => {
                updateDraft(draftKey, { text: t, error: null });
              }}
              onSubmit={send}
              onEscape={dictation.onEscape}
              onPasteFiles={attach}
              onPreviewChip={(id, el) => openPreview(draftKey, id, el)}
              // The open picker filters on the text: no completion meanwhile.
              triggers={picker.card.open ? NO_TRIGGERS : sources.noProject ? HOME_TRIGGERS : TRIGGERS}
              onTrigger={completion.onTrigger}
              onCompletionKey={completion.onKey}
              completionAria={picker.aria ?? completion.aria}
              onKeyDown={picker.onKeyDown}
            />
          </TagMultiProjectContext.Provider>
        </div>
        <div className="col-start-1 flex min-w-0 flex-wrap items-center gap-0.5 px-2 pb-2">
          <ComposerPicker
            label="Model"
            disabled={settingUp}
            icon={ClaudeMarkBrand}
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
            disabled={settingUp}
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
            disabled={settingUp}
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
          <CompactChip threadId={threadId} />
          <div className="ml-auto flex items-center gap-0.5">
            <DictationMic dictation={dictation} disabled={inputOff} />
            {/* The span carries the tooltip while the button is disabled (no pointer events). */}
            <Tip label={attachLabel(hostFiles.hosted)}>
              <span className="flex">
                <button
                  type="button"
                  disabled={inputOff}
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
          </div>
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
          {settingUp && !setupBlocks && (
            <button
              type="button"
              className="intr"
              disabled={cancelling}
              data-testid="thread-setup-cancel"
              onClick={() => {
                setCancelling(true);
                void cancelSetup(threadId).finally(() => {
                  setCancelling(false);
                });
              }}
            >
              <i aria-hidden />
              Cancel
            </button>
          )}
          {busy && !settingUp && (
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
                disabled={!canSend && !(dictation.listening && !inputOff && !setupBlocks)}
                aria-label={phase === "attaching" ? "Attaching files…" : sending ? "Sending…" : "Send"}
                data-testid="thread-send"
                data-phase={phase}
                className={`flex size-8 items-center justify-center rounded-full bg-cf-accent text-cf-accent-foreground outline-none transition-all hover:bg-cf-accent/90 focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 disabled:pointer-events-none ${SEND_DISABLED}`}
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
        <DictationNote dictation={dictation} className="col-span-2 px-4 pb-2" />
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
      <PromptHistoryCard picker={picker.card} above />
    </div>
  );
}
