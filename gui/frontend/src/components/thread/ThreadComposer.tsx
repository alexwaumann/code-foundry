import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { useShallow } from "zustand/react/shallow";
import { AlarmClockOff, ArrowUp, Brain, Gauge, Loader2, Paperclip, RotateCcw, ShieldCheck } from "lucide-react";
import { ATTACHMENT_MIME_TYPES } from "@/api/session";
import type { ThreadPendingView } from "@/api/thread";
import { AttachmentPreview } from "@/components/compose/AttachmentPreview";
import { CompletionCard } from "@/components/compose/CompletionCard";
import { Attachments } from "@/components/compose/Composer";
import { ComposerPicker } from "@/components/compose/ComposerPicker";
import { PromptEditor, type EditorTrigger, type PromptEditorHandle } from "@/components/compose/PromptEditor";
import { TagMultiProjectContext } from "@/components/compose/tagContext";
import { useNoProjectThread } from "@/components/session/useNoProject";
import { useCommandSource, useCompletion, useFileSource, useSkillSource } from "@/components/compose/useCompletion";
import { choiceLabel, EFFORT_CHOICES, PERMISSION_CHOICES, type ComposePermission } from "@/lib/compose";
import { fileSources, skillSources, skillSourcesKey, type TriggerChar } from "@/lib/completion";
import { useNow } from "@/lib/clock";
import { disconnectCause } from "@/lib/session";
import { snoozeTimeShort } from "@/lib/snooze";
import { statusLine, statusText } from "@/lib/statusLine";
import { cn } from "@/lib/utils";
import { addAttachments, openPreview, updateDraft, useDraft } from "@/stores/compose";
import { getPanel } from "@/stores/panel";
import { reconnectSession, snoozeSession } from "@/stores/sessionActions";
import { useSessionsStore } from "@/stores/sessions";
import { useModelChoices } from "@/stores/settings";
import { loadSkills } from "@/stores/skills";
import { useSlashCommands } from "@/stores/thread";
import { interruptThread, sendThreadDraft, setThreadEffort, setThreadModel, setThreadPermission, threadDraftKey } from "@/stores/threadActions";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { ColdCacheNote } from "./ColdCacheNote";
import { RetryNote } from "./RetryNote";
import { PendingPrompts, type PromptKeys } from "./PendingPrompt";

const TRIGGERS: readonly TriggerChar[] = ["/", "@"];
/** A thread without a project: "/" only ("@" would search its cwd, the home directory, which is never indexed). */
const HOME_TRIGGERS: readonly TriggerChar[] = ["/"];

/**
 * The last ui promptFocusSeq a thread composer acted on. Module-level: selecting a thread
 * to type in bumps it before that thread's composer mounts, so a fresh composer still
 * sees the request as new.
 */
let handledPromptSeq = 0;

/** The keyboard is in a region a thread's disconnect or reconnect must not take it from. */
function keyboardElsewhere(): boolean {
  const ui = useUiStore.getState();
  return ui.palette.open || ui.focus === "bottom" || ui.focus === "panel" || ui.focus === "palette";
}

function hasFocusWithin(el: HTMLElement | null): boolean {
  return !!el && el.contains(document.activeElement);
}
const EFFORT_GROUPS = [{ options: EFFORT_CHOICES.map((c) => ({ value: c.value, label: c.label })) }];
const SEP = "\u0001";

/**
 * The thread's projects for "/" and "@": its workspace's members, else its project at its
 * worktree; none without a project (only the user's skills, and no "@").
 */
function useThreadSources(sessionId: string) {
  const noProject = useNoProjectThread(sessionId);
  const repoId = useSessionsStore((s) => s.byId[sessionId]?.repoId ?? "");
  const worktreePath = useSessionsStore((s) => s.byId[sessionId]?.worktreePath ?? "");
  const workspaceId = useSessionsStore((s) => s.byId[sessionId]?.workspaceId ?? "");
  const memberKeys = useWorkspacesStore(useShallow((s) => (workspaceId ? (s.byId[workspaceId]?.members ?? []).map((m) => m.repoId + SEP + m.worktreePath) : [])));
  return useMemo(() => {
    if (noProject) return { noProject, repoIds: [], skills: [], files: [] };
    const wsMembers = memberKeys.map((k) => {
      const [r = "", p = ""] = k.split(SEP);
      return { repoId: r, worktreePath: p };
    });
    const workspace = wsMembers.length > 0;
    // The thread's own repo first: where it runs.
    const repoIds = workspace ? [repoId, ...wsMembers.map((m) => m.repoId).filter((r) => r !== repoId)] : [repoId];
    const input = { target: workspace ? ("workspace" as const) : ("project" as const), repoIds, wsMembers };
    return {
      noProject,
      repoIds,
      skills: skillSources({ ...input, worktree: { kind: "existing", path: worktreePath } }),
      files: fileSources({ ...input, worktree: workspace ? { kind: "members" } : { kind: "existing", path: worktreePath } }),
    };
  }, [noProject, repoId, worktreePath, memberKeys]);
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
    <span className="text-warning" data-testid="thread-snooze-ended">
      {statusText({ kind: "snoozeEnded", detail: "", at }, now)}
    </span>
  );
}

/**
 * A disconnected thread's composer: what happened, and Reconnect. The button takes the
 * focus requests the prompt would (`ref`), and the keyboard when the thread disconnects
 * while shown; once it reconnects the prompt takes it back (ThreadComposer). A snoozed
 * thread says until when, with Unsnooze next to Reconnect (which unsnoozes too); a thread
 * the daemon woke says "Snooze ended · <ago>" (the header's Snooze button snoozes again).
 */
function Reconnect({ sessionId, ref }: { sessionId: string; ref: Ref<HTMLButtonElement> }) {
  const cause = useSessionsStore((s) => {
    const x = s.byId[sessionId];
    return x ? disconnectCause(x) : "";
  });
  const snoozedUntil = useSessionsStore((s) => s.byId[sessionId]?.snoozedUntilMs ?? null);
  const wokeAt = useSessionsStore((s) => {
    const l = statusLine(s.byId[sessionId]);
    return l.kind === "snoozeEnded" ? (l.at ?? 0) : null;
  });
  const [busy, setBusy] = useState(false);
  return (
    <div className="ccard docked items-center" data-testid="thread-disconnected">
      <p className="px-4 py-3 text-[13px] text-muted-foreground">
        {snoozedUntil !== null ? (
          <SnoozedUntil until={snoozedUntil} />
        ) : wokeAt !== null ? (
          <SnoozeEnded at={wokeAt === 0 ? null : wokeAt} />
        ) : (
          <>Not connected{cause ? ` · ${cause}` : ""}</>
        )}
        . Reconnect to continue the conversation.
      </p>
      <div className="flex shrink-0 items-center gap-1.5 pr-2">
        {snoozedUntil !== null && (
          <button
            type="button"
            className="btn outline"
            data-testid="thread-unsnooze"
            onClick={() => {
              void snoozeSession(sessionId, null);
            }}
          >
            <AlarmClockOff aria-hidden />
            Unsnooze
          </button>
        )}
        <button
          ref={ref}
          type="button"
          className="btn primary"
          disabled={busy}
          data-testid="reconnect"
          onClick={() => {
            setBusy(true);
            void reconnectSession(sessionId).finally(() => {
              setBusy(false);
            });
          }}
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />}
          Reconnect
        </button>
      </div>
    </div>
  );
}

/**
 * The follow-up composer floating over the bottom of the thread (variant A): the
 * new-thread composer's prompt editor with its "/" skills (the running process's slash
 * commands when it has reported them) and "@" files, image
 * attachments, the model / effort / permission pickers, attach, Interrupt while Claude
 * works (the only Interrupt), and send. Pending permissions and questions dock into the
 * top of the card, oldest first (the card turns opaque); while the editor is empty its
 * digits (and a question's Enter) answer the oldest. Escape does not interrupt (it stopped
 * turns by accident); only the Interrupt button does. An effort change restarts Claude,
 * after the turn when one runs. The draft is the compose store's `thread:<id>`.
 */
export function ThreadComposer({ sessionId, pending, busy }: { sessionId: string; pending: readonly ThreadPendingView[]; busy: boolean }) {
  const draftKey = threadDraftKey(sessionId);
  const text = useDraft(draftKey, "text");
  const hasAttachments = useDraft(draftKey, "attachments").length > 0;
  const phase = useDraft(draftKey, "phase");
  const error = useDraft(draftKey, "error");
  const notice = useDraft(draftKey, "notice");
  const state = useSessionsStore((s) => s.byId[sessionId]?.state ?? "unknown");
  const model = useSessionsStore((s) => s.byId[sessionId]?.model ?? "");
  const effort = useSessionsStore((s) => s.byId[sessionId]?.effort ?? "");
  const permission = useSessionsStore((s) => s.byId[sessionId]?.permissionMode ?? "");
  const effortPending = useSessionsStore((s) => s.byId[sessionId]?.effortPending ?? false);
  const promptKeys = useRef<PromptKeys | null>(null);
  const modelChoices = useModelChoices();
  const modelGroups = useMemo(() => [{ options: modelChoices }], [modelChoices]);
  const sources = useThreadSources(sessionId);
  const editorRef = useRef<PromptEditorHandle>(null);
  const reconnectRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [trigger, setTrigger] = useState<EditorTrigger | null>(null);
  // "/": the running process's own list (what "/name" runs); the disk scan while there is
  // none (not running yet, or a daemon that predates the list).
  const commands = useSlashCommands(sessionId);
  const skillSource = useSkillSource(trigger, skillSourcesKey(sources.skills), sources.repoIds);
  const commandSource = useCommandSource(trigger, commands, skillSourcesKey(sources.skills), sources.repoIds);
  const slashSource = commands.length > 0 ? commandSource : skillSource;
  const fileSource = useFileSource(trigger, sources.files, sources.repoIds, sources.repoIds[0] ?? "");
  const completion = useCompletion(trigger, setTrigger, trigger?.char === "@" ? fileSource : slashSource, editorRef);
  const live = state === "connected";
  const sending = phase !== "idle";
  const canSend = live && !sending && (text.trim() !== "" || hasAttachments);

  useEffect(() => {
    void loadSkills(sources.skills);
  }, [sources.skills]);

  // Focus requests land in the prompt (a disconnected thread's: its Reconnect button): a
  // thread selected to be typed in (ui promptFocusSeq), the content pane asked for (the side
  // panel hid, ui contentFocusSeq). So does the thread disconnecting or reconnecting while
  // shown, unless the keyboard is elsewhere (keyboardElsewhere: a key typed in the bottom
  // panel, the side panel or the palette must not land on the Reconnect button). A composer
  // that mounts with no request (Show worktree, a revealed shell) leaves the keyboard where
  // that put it. Under an expanded side panel the panel takes the requested focus.
  const disconnected = state === "disconnected";
  const focusSeq = useUiStore((s) => s.promptFocusSeq);
  const contentFocusSeq = useUiStore((s) => s.contentFocusSeq);
  const seenContent = useRef(contentFocusSeq);
  const wasDisconnected = useRef(disconnected);
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
  const rootOrCard = (el: Element | null): boolean => el !== null && (rootRef.current?.contains(el) === true || el === reconnectRef.current);
  useEffect(() => {
    const asked = handledPromptSeq !== focusSeq || seenContent.current !== contentFocusSeq;
    const flipped = wasDisconnected.current !== disconnected;
    wasDisconnected.current = disconnected;
    if (!asked && (!flipped || keyboardElsewhere())) return;
    const key = `${String(focusSeq)}:${String(contentFocusSeq)}:${String(disconnected)}`;
    if (request.current?.key !== key) request.current = { key, before: document.activeElement };
    const { before } = request.current;
    // At once when the composer has settled (a key pressed right after must reach the
    // prompt, not the palette input closing over it), else on the next frame (a composer
    // just mounted, or a prompt or card that just replaced the other: its editor may still
    // be replaced).
    const attempt = (): boolean => {
      const panel = getPanel();
      if (panel.open && panel.expanded) {
        if (asked) useUiStore.setState((u) => ({ panelFocusSeq: u.panelFocusSeq + 1 }));
        return true;
      }
      // Something took the keyboard meanwhile (the side panel, the inline rename a
      // double-click on the sidebar row starts): leave it there.
      const now = document.activeElement;
      if (now !== before && now !== null && now !== document.body && !rootOrCard(now)) return true;
      (editorRef.current ?? reconnectRef.current)?.focus();
      return rootOrCard(document.activeElement);
    };
    const done = () => {
      handledPromptSeq = focusSeq;
      seenContent.current = contentFocusSeq;
    };
    if (settled.current && !flipped && attempt()) {
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
  }, [focusSeq, contentFocusSeq, sessionId, disconnected]);

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

  if (state === "disconnected") return <Reconnect sessionId={sessionId} ref={reconnectRef} />;

  const send = () => {
    if (canSend) void sendThreadDraft(sessionId);
  };
  const attach = (files: File[]) => {
    const added = addAttachments(draftKey, files);
    editorRef.current?.insertChips(added.map((a) => ({ id: a.id, name: a.file.name })));
  };
  const refocus = () => editorRef.current?.focus();
  const editorEmpty = text.trim() === "" && !hasAttachments;
  const docked = pending.length > 0;

  return (
    // data-chord-yield: cmd chords bound to commands (cmd+j, cmd+shift+w, cmd+r) reach
    // the app from the prompt, as they did from a thread's terminal (keys/bindings.ts).
    <div className="relative" ref={rootRef} data-chord-yield="">
      <div
        className={cn("ccard", docked && "docked")}
        data-testid="thread-composer"
        data-dragging={dragging || undefined}
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
        <RetryNote sessionId={sessionId} />
        <ColdCacheNote sessionId={sessionId} pending={pending.length} />
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
          <TagMultiProjectContext.Provider value={sources.repoIds.length > 1}>
            <PromptEditor
              handleRef={editorRef}
              draftKey={draftKey}
              value={text}
              disabled={sending}
              placeholder={busy ? "Send a follow-up… Claude picks it up mid-turn" : "Send a follow-up…"}
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
              if (v !== model) void setThreadModel(sessionId, v);
            }}
            disabled={!live}
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
              if (v !== effort) void setThreadEffort(sessionId, v);
            }}
            disabled={!live}
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
              if (v !== permission) void setThreadPermission(sessionId, v as ComposePermission);
            }}
            disabled={!live}
            contentClassName="w-60"
            data-testid="thread-permission-mode"
          />
          <button
            type="button"
            disabled={sending}
            aria-label="Attach images"
            title="Attach images"
            data-testid="thread-attach"
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
            onChange={(e) => {
              attach(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </div>
        <div className="col-start-2 flex items-end gap-1.5 pr-2 pb-2">
          {busy && live && (
            <button
              type="button"
              className="intr"
              data-testid="thread-interrupt"
              onClick={() => {
                void interruptThread(sessionId);
              }}
            >
              <i aria-hidden />
              Interrupt
            </button>
          )}
          <button
            type="button"
            disabled={!canSend}
            aria-label={phase === "attaching" ? "Attaching images…" : sending ? "Sending…" : "Send"}
            title="Send"
            data-testid="thread-send"
            data-phase={phase}
            className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none transition-all hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40"
            // A click leaves the caret in the prompt, so it is focused again after the send.
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={send}
          >
            {sending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ArrowUp className="size-4" aria-hidden />}
          </button>
        </div>
        {effortPending && live && (
          <p className="col-span-2 px-4 pb-2 text-xs text-muted-foreground" role="status" data-testid="thread-effort-pending">
            {busy ? `Effort changes to ${choiceLabel(EFFORT_CHOICES, effort)} after this turn` : `Restarting Claude with ${choiceLabel(EFFORT_CHOICES, effort)} effort…`}
          </p>
        )}
        {(error ?? notice) && (
          <div className="col-span-2 flex flex-col gap-1 px-4 pb-2 text-sm">
            {error && (
              <p role="alert" className="text-destructive" data-testid="thread-composer-error">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="text-warning">
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
