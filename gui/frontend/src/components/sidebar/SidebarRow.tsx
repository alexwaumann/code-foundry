import { memo, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode, type SyntheticEvent } from "react";
import { AlarmClock, ArrowRightLeft, BellRing, Bookmark, Bot, Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CornerDownRight, GitBranch, House, Layers, OctagonX, Pin, SquareTerminal, type LucideIcon } from "lucide-react";
import { SnoozeEventIcon } from "@/components/snooze/SnoozeEventIcon";
import { dropdownMenuKit } from "@/components/thread/menuKit";
import { useShallow } from "zustand/react/shallow";
import { CLAUDE_ORANGE, ClaudeMark } from "@/components/icons/ClaudeMark";
import { ProjectKindIcon } from "@/components/icons/ProjectKindIcon";
import { useProjectKind } from "@/components/icons/projectKind";
import { SnoozePresetItems } from "@/components/snooze/SnoozeMenu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { agentsLabel } from "@/lib/agents";
import { autoSavedSentence } from "@/lib/autoTidy";
import { useNowSelect } from "@/lib/clock";
import { formatAge, formatDuration } from "@/lib/duration";
import { QUIET } from "@/lib/quiet";
import { cn } from "@/lib/utils";
import { threadBadge, threadGroup } from "@/lib/thread";
import { shortRemaining } from "@/lib/snooze";
import { statusLine, statusText, statusToneText, tipStatusTone, type StatusLineKind, type TipStatusTone } from "@/lib/statusLine";
import { statusBadge, statusTimeAt, statusTimeUnits } from "@/lib/statusRegistry";
import { modelLabel } from "@/lib/threadRow";
import type { HeaderRow, Row } from "@/lib/tree";
import { useCreator, useLiveCount, useMadeByThread } from "@/stores/lineage";
import { useThreadTilt } from "@/stores/arrivals";
import { useThreadMark } from "@/stores/notifications";
import { archiveThread, clearSnoozeEnded, renameThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { useModelChoices } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { ThreadPlaceRows, TipRow } from "@/components/thread/ThreadPlaceRows";
import { rowHasBranchLine, useThreadPlace } from "@/components/thread/useThreadPlace";
import { RowTooltipsEnabled } from "./rowTooltips";
import { TipWaiting } from "./TipWaiting";
import { LinkedPrsBadge } from "./LinkedPrsBadge";
import { NotificationMark } from "./NotificationMark";
import { TipLinkedPrs } from "./TipLinkedPrs";
import { TipNotifications } from "./TipNotifications";
import { useNameProvisional } from "@/shell/useThreadName";
import type { ThreadSnoozeEventView } from "@/api/snoozeEvents";

interface RowProps {
  row: Row;
  selected: boolean;
  cursor: boolean;
  onActivate: (row: Row) => void;
}

/**
 * Inline name editor; Enter or blur commits via thread.rename, Escape cancels. It commits
 * only an edit of the name it opened with: a name that changed meanwhile (the naming
 * model's title replacing a provisional name) is not overwritten by the untouched text.
 * Enter and Escape give focus back to what had it when the rename began; a blur leaves
 * focus where it went.
 */
export function RenameField({ id, name }: { id: string; name: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const opened = useRef(name);
  // Read on the first render: by the first effect, autoFocus has already moved focus here.
  const [returnTo] = useState(() => document.activeElement);
  useEffect(() => {
    ref.current?.select();
  }, []);
  const finish = (commit: boolean, restoreFocus: boolean) => {
    if (done.current) return;
    done.current = true;
    const value = ref.current?.value.trim() ?? "";
    useUiStore.getState().setRenaming(null);
    if (commit && value && value !== opened.current && value !== name) void renameThread(id, value);
    if (!restoreFocus) return;
    if (returnTo instanceof HTMLElement && returnTo !== document.body && returnTo.isConnected) returnTo.focus();
    else useUiStore.getState().focusSidebar();
  };
  return (
    <input
      ref={ref}
      autoFocus
      defaultValue={name}
      aria-label="Thread name"
      data-testid="rename-input"
      className="h-[22px] min-w-0 flex-1 rounded-sm border border-cf-focus bg-cf-canvas px-1 text-body outline-none"
      onClick={(e) => {
        e.stopPropagation();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true, true);
        else if (e.key === "Escape") finish(false, true);
      }}
      onBlur={() => {
        finish(true, false);
      }}
    />
  );
}


/**
 * Time since `at` (lib/statusRegistry statusTimeUnits: "4s", "4m", "1h 4m", "3d"). One shared 1 s
 * clock (lib/clock) drives every row that shows a time, but a row re-renders only when its
 * text changes: every second under a minute, then once a minute.
 * A slower clock would hand a row a `now` up to a period old.
 */
function useElapsed(at: number): string {
  return useNowSelect(1000, (now) => formatDuration(now - at, statusTimeUnits(now - at)));
}

function Elapsed({ at, className }: { at: number; className?: string }) {
  const text = useElapsed(at);
  return (
    <span className={cn("tabular-nums", className)} data-testid="row-time">
      {text}
    </span>
  );
}

/**
 * Line 1's right side (lib/statusRegistry statusBadge): the status's icon in its tone, then
 * for working, waiting and setting up a plain space and the time since the status changed in
 * the same tone; for an idle thread only the time since its last activity, muted. The word
 * is not shown (the hover card says it, docs/notes/sidebar-title-first.md); it stays for
 * screen readers. A woken snooze shows it ("Woke", StatusEntry.rowWord). Only the icon tilts when
 * the thread starts calling on the user (lib/arrivals.ts), never the word.
 */
export function RowStatus({ id }: { id: string }) {
  const line = useThreadsStore(useShallow((st) => statusLine(st.byId[id])));
  const at = useThreadsStore((st) => statusTimeAt(line, st.byId[id]));
  const badge = statusBadge(line);
  const Icon = badge.icon;
  const { className: tiltClass, place: tiltPlace } = useThreadTilt(id, Icon);
  if (Icon === null) {
    return at === null ? null : <Elapsed at={at} className="text-caption-sm text-cf-sidebar-muted-foreground" />;
  }
  return (
    <span className={cn("flex min-w-0 items-center gap-[3px] text-caption-sm font-medium", badge.toneClass)} data-testid="row-status" data-kind={line.kind}>
      <Icon className={cn("size-3.5 shrink-0", tiltClass)} ref={tiltPlace} aria-hidden data-testid="row-status-icon" />
      <span className={cn(!badge.rowWord && "sr-only")} data-testid="row-status-word">
        {badge.word}
      </span>
      {at !== null && <Elapsed at={at} className="whitespace-nowrap" />}
    </span>
  );
}

/** A row action's look: no background, muted at rest; each action adds its own hover foreground. */
const ACTION_BUTTON = "flex shrink-0 items-center justify-center rounded-sm text-cf-icon-muted outline-none focus-visible:ring-1 focus-visible:ring-cf-focus";

/** Keeps a click (and a double click) on a row's own control from reaching the row: no select, no rename. */
const stop = (e: SyntheticEvent) => {
  e.stopPropagation();
};

/**
 * The row's hover actions, in HoverSlot: Snooze (the preset menu, SnoozePresetItems)
 * and Archive (at once, thread.archive); on a woken row Clear in Archive's place (at once,
 * thread.snooze.clear; Archive stays in the context menu), and Archive again once cleared. Shown while the row is hovered, while one of them
 * has the keyboard, and while the snooze menu is open. They are tab stops only on the
 * keyboard cursor's row (`cursor`), so Tab leaves the list after one row's actions rather
 * than walking every row's; the context menu and the palette have the same commands.
 */
function RowActions({ id, cursor, onShownChange }: { id: string; cursor: boolean; onShownChange: (shown: boolean) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  // The daemon refuses a snooze while a setup runs: spawn may be reading the row.
  const settingUp = useThreadsStore((s) => s.byId[id]?.setup?.phase === "running");
  const woken = useThreadsStore((s) => statusLine(s.byId[id]).kind === "snoozeEnded");
  const shown = menuOpen || focused;
  useEffect(() => {
    onShownChange(shown);
  }, [shown, onShownChange]);
  const tab = cursor ? 0 : -1;
  return (
    <span
      className={cn(
        "pointer-events-none absolute top-1/2 right-0 flex -translate-y-1/2 items-center gap-1 opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100",
        shown && "pointer-events-auto opacity-100",
      )}
      data-testid="row-actions"
      data-shown={shown || undefined}
      onClick={stop}
      onDoubleClick={stop}
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
    >
      {!settingUp && (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button type="button" tabIndex={tab} aria-label="Snooze thread" className={cn(ACTION_BUTTON, "size-5 hover:text-cf-warning-text aria-expanded:text-cf-warning-text")} data-testid="row-snooze">
              <AlarmClock className="size-3.5" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" data-testid="row-snooze-menu" onClick={stop} onDoubleClick={stop}>
            <SnoozePresetItems id={id} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} kit={dropdownMenuKit} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {woken ? (
        <button
          type="button"
          tabIndex={tab}
          aria-label="Clear snooze ended"
          className={cn(ACTION_BUTTON, "h-5 gap-[3px] px-1 text-caption-sm font-medium hover:text-cf-success-text")}
          data-testid="row-clear"
          onClick={(e) => {
            e.stopPropagation();
            void clearSnoozeEnded(id, { inView: true });
          }}
        >
          <Check className="size-3 shrink-0" aria-hidden />
          Clear
        </button>
      ) : (
        <button
          type="button"
          tabIndex={tab}
          aria-label="Archive thread"
          className={cn(ACTION_BUTTON, "h-5 gap-[3px] px-1 text-caption-sm font-medium hover:text-cf-success-text")}
          data-testid="row-archive"
          onClick={(e) => {
            e.stopPropagation();
            void archiveThread(id, true, { inView: true });
          }}
        >
          <Check className="size-3 shrink-0" aria-hidden />
          Archive
        </button>
      )}
    </span>
  );
}

/**
 * The right end of a row's last line: what `children` shows at rest, and on hover the row's
 * actions (RowActions) in its place, keeping at least their own width so they never cover the
 * text before them. They stay while one of them has the keyboard or the snooze menu is open.
 */
export function HoverSlot({ id, cursor, children }: { id: string; cursor: boolean; children?: ReactNode }) {
  const [actionsShown, setActionsShown] = useState(false);
  return (
    <span className={cn("relative ml-auto flex shrink-0 items-center justify-end pl-1.5 group-hover/row:min-w-[97px]", actionsShown && "min-w-[97px]")} data-testid="row-hover-slot">
      <span className={cn("flex min-w-0 items-center gap-2 group-hover/row:invisible", actionsShown && "invisible")}>{children}</span>
      <RowActions id={id} cursor={cursor} onShownChange={setActionsShown} />
    </span>
  );
}

/** A count on line 2's right: an icon and a number. */
function Count({ icon: Icon, n, className, label, testId }: { icon: LucideIcon; n: number; className: string; label: string; testId: string }) {
  if (n <= 0) return null;
  return (
    <span className={cn("flex shrink-0 items-center gap-0.5 font-medium tabular-nums", className)} aria-label={label} data-testid={testId}>
      <Icon className="size-3 shrink-0" aria-hidden />
      {n}
    </span>
  );
}

/**
 * Line 2's right side: the live count (info tone; lib/liveCount: background subagents plus
 * live child threads, one number whatever the model started), the background shells (muted),
 * the thread's notifications (NotificationMark), then the linked PR tag.
 */
export function RowCounts({ id }: { id: string }) {
  const agents = useLiveCount(id);
  const shells = useThreadsStore((s) => s.byId[id]?.backgroundShellsRunning ?? 0);
  return (
    <>
      <Count icon={Bot} n={agents} className="text-cf-info-text" label={agentsLabel(agents)} testId="row-bg-agents" />
      <Count icon={SquareTerminal} n={shells} className="text-cf-sidebar-muted-foreground" label={shells === 1 ? "1 shell" : `${String(shells)} shells`} testId="row-bg-shells" />
      <NotificationMark id={id} />
      <LinkedPrsBadge id={id} />
    </>
  );
}

/**
 * The glyph before the project: the project's kind (ProjectKindIcon, as on the Projects page),
 * Layers for a thread across a workspace's projects or in its workspace's folder, House for a
 * thread without a project.
 */
export function PlaceIcon({ id, noProject, set }: { id: string; noProject: boolean; set: boolean }) {
  const projectId = useThreadsStore((s) => s.byId[id]?.projectId ?? "");
  const kind = useProjectKind(projectId);
  if (noProject) return <House className="size-3 shrink-0" aria-hidden data-testid="row-place-icon" data-place="none" />;
  if (set) return <Layers className="size-3 shrink-0" aria-label="workspace" data-testid="row-workspace" />;
  return <ProjectKindIcon kind={kind} className="size-3 shrink-0" data-testid="row-place-icon" />;
}

/**
 * Line 2 (text-caption-sm, muted): the project the thread runs in after its kind's glyph (a
 * thread in its workspace's folder, which has no project, shows the workspace's name; plain
 * "No project" for a thread without one), and on the right the counts (RowCounts). On a
 * two-line row (no branch line) this is the last line, so the counts give way to the row's
 * actions on hover.
 */
function LineProject({ id, cursor, last }: { id: string; cursor: boolean; last: boolean }) {
  const { project, noProject, set, inFolder } = useThreadPlace(id);
  return (
    <span className="flex h-4 min-w-0 items-center text-caption-sm" data-testid="row-line-2">
      <span className="flex min-w-0 items-center gap-[3px] text-cf-sidebar-muted-foreground" data-testid="row-project" data-no-project={noProject || undefined} data-set={set !== null || undefined}>
        <PlaceIcon id={id} noProject={noProject} set={set !== null} />
        <span className="truncate">{inFolder ? set : project}</span>
      </span>
      {last ? (
        <HoverSlot id={id} cursor={cursor}>
          <RowCounts id={id} />
        </HoverSlot>
      ) : (
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-1.5">
          <RowCounts id={id} />
        </span>
      )}
    </span>
  );
}

/**
 * Line 3 (text-caption-sm, muted): the branch, a GitBranch glyph and the name in mono, with
 * the row's actions on its right on hover. Only on a row of a thread with a project with git
 * (rowHasBranchLine); empty but for the actions until the branch is known (a thread being set
 * up). What the thread is doing or needs is on the hover card, never here.
 */
function LineBranch({ id, cursor, branch }: { id: string; cursor: boolean; branch: string }) {
  return (
    <span className="flex h-4 min-w-0 items-center text-caption-sm" data-testid="row-line-3">
      {branch !== "" && (
        <span className="flex min-w-0 items-center gap-[3px] text-cf-sidebar-muted-foreground">
          <GitBranch className="size-3 shrink-0" aria-hidden data-testid="row-branch-icon" />
          <span className="truncate font-mono" data-testid="row-branch">
            {branch}
          </span>
        </span>
      )}
      <HoverSlot id={id} cursor={cursor} />
    </span>
  );
}

/**
 * The muted ↳ before the name of a thread an agent created (docs/notes/agents-3-lineage-gui.md,
 * sketch variant A); nothing for the user's threads. No tooltip of its own: the row's
 * tooltip says who created it.
 */
export function MadeByThreadGlyph({ id }: { id: string }) {
  const made = useMadeByThread(id);
  if (!made) return null;
  return <CornerDownRight className="-mr-px size-3 shrink-0 text-cf-icon-muted opacity-85" aria-label="Created by a thread" data-testid="row-created-by" />;
}

/**
 * The name's look: one role above the row's text (text-body, medium), so names stand
 * out from the status line and from each other (docs/notes/sidebar-row-emphasis.md). It
 * keeps the row's colour (text-inherit: the role's own foreground would drop the row's
 * sidebar and selection tokens). The id stands in, muted, while there is no name; a
 * provisional name (the daemon's cut of the first prompt, until the utility model's title
 * lands) is muted and italic.
 *
 * A quiet row (Archived, Snoozed) keeps the size but not the weight or the row's colour:
 * regular and muted, so those sections recede behind the live list
 * (docs/notes/sidebar-quiet-rows.md).
 */
function nameClass(name: string, provisional: boolean, quiet = false): string {
  return cn(
    "truncate text-body",
    quiet ? "text-cf-sidebar-muted-foreground" : "font-medium text-inherit",
    (!name || provisional) && "text-cf-sidebar-muted-foreground",
    provisional && "italic",
  );
}

/** The muted pin before a pinned thread's name; nothing for the rest. */
export function PinGlyph({ id }: { id: string }) {
  const pinned = useThreadsStore((s) => s.byId[id]?.pinned ?? false);
  if (!pinned) return null;
  return <Pin className="-mr-px size-3 shrink-0 text-cf-icon-muted" aria-label="pinned" data-testid="row-pinned" />;
}

/**
 * A thread row, title first (docs/notes/sidebar-title-first.md): line 1 the name (text-body,
 * medium; the pin and made-by-thread glyphs before it) and the status icon (RowStatus), line 2
 * the project and the counts (LineProject), line 3 the branch (LineBranch). A thread without a
 * project or without git has no line 3: its row is TWO_LINE_ROW (rowSizes.ts).
 * The row's actions sit on the right of its last line on hover. The status kind and the thread
 * badge are on the body as data attributes for tests.
 */
function ThreadLabel({ id, cursor }: { id: string; cursor: boolean }) {
  // Unnamed until the daemon names it from the first prompt: the id stands in.
  const name = useThreadsStore((s) => s.byId[id]?.name ?? "");
  // A provisional name, or one being regenerated: muted and italic until the model's title lands.
  const provisional = useNameProvisional(id);
  const kind = useThreadsStore((s) => statusLine(s.byId[id]).kind);
  const badge = useThreadsStore((s) => threadBadge(s.byId[id]));
  const renaming = useUiStore((s) => s.renamingThreadId === id);
  const place = useThreadPlace(id);
  const branchLine = rowHasBranchLine(place);
  return (
    // Whether Claude runs for the thread never shows: a stopped thread looks like any other.
    <span className="flex min-w-0 flex-1 flex-col" data-testid="thread-body" data-status-line={kind} data-thread-badge={badge}>
      <span className="flex h-[22px] min-w-0 items-center gap-1.5" data-testid="row-line-1">
        {renaming ? (
          <RenameField id={id} name={name} />
        ) : (
          <>
            <PinGlyph id={id} />
            <MadeByThreadGlyph id={id} />
            <span className={nameClass(name, provisional)} data-testid="thread-name" data-provisional={provisional || undefined}>
              {name || id}
            </span>
          </>
        )}
        <span className="ml-auto flex shrink-0 items-center pl-1">
          <RowStatus id={id} />
        </span>
      </span>
      <LineProject id={id} cursor={cursor} last={!branchLine} />
      {branchLine && <LineBranch id={id} cursor={cursor} branch={place.branch} />}
    </span>
  );
}


type CardTone = TipStatusTone | "emerald";

const tipStatusIcons: Readonly<Record<CardTone, LucideIcon>> = { amber: CircleAlert, red: OctagonX, emerald: CircleCheck };

/** Kinds whose card icon is their row's rather than their tone's: a woken snooze keeps its bell. */
const tipKindIcons: Partial<Readonly<Record<StatusLineKind, LucideIcon>>> = { snoozeEnded: BellRing };

/** The kinds whose card time is a moment ("6m ago") rather than a span ("for 6m"): a finished turn, a wake (as the dock strip says it). */
const agoCardKinds: ReadonlySet<StatusLineKind> = new Set<StatusLineKind>(["finished", "snoozeEnded"]);

/** The kinds whose card status says how long the thread has been so ("for 6m"): Claude's prompts and errors, not a deleted transcript. */
const timedCardKinds: ReadonlySet<StatusLineKind> = new Set<StatusLineKind>(["input", "question", "plan", "snoozeEnded", "error", "interrupted", "crashed", "setupFailed"]);

/** "for 6m" (or "6m ago", `ago`) since `at`, muted, on the shared clock while the card is open. */
function TipElapsed({ at, ago }: { at: number; ago: boolean }) {
  const text = useElapsed(at);
  return (
    <span className="text-cf-text-muted" data-testid="tip-status-time">
      {ago ? `${text} ago` : `for ${text}`}
    </span>
  );
}

/**
 * The full status text of a thread that needs the user or failed, in the hover card's
 * words and colour, wrapped rather than truncated; then how long it has been so ("· for
 * 6m"), the time the row no longer shows. A finished turn reads "Finished 6m ago" in
 * green. Nothing for other statuses (lib/statusLine `tipStatusTone`). The time ticks only
 * while the card is open (its body is mounted only then).
 */
function TipStatus({ id }: { id: string }) {
  const line = useThreadsStore(useShallow((st) => statusLine(st.byId[id])));
  const changedAt = useThreadsStore((st) => st.byId[id]?.statusChangedAtMs ?? null);
  const tone: CardTone | null = line.kind === "finished" ? "emerald" : tipStatusTone(line.kind);
  if (tone === null) return null;
  const Icon = tipKindIcons[line.kind] ?? tipStatusIcons[tone];
  const finished = line.kind === "finished";
  const timed = changedAt !== null && (finished || timedCardKinds.has(line.kind));
  return (
    <div className={cn("mb-[3px] flex items-start gap-2 leading-5", statusToneText[tone])} data-testid="tip-status" data-tone={tone}>
      <Icon className="mt-[3px] size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">
        {statusText({ ...line, at: null }, 0)}
        {timed && (
          <>
            {finished ? " " : " · "}
            <TipElapsed at={changedAt} ago={agoCardKinds.has(line.kind)} />
          </>
        )}
      </span>
    </div>
  );
}

/**
 * A snooze until an event in full (docs/notes/snooze-until-event.md): "Snoozed until checks finish
 * on #812" while it waits, or what ended it ("#812 was merged") while the thread reads "snooze
 * ended". Nothing otherwise.
 */
function TipSnoozeEvent({ id }: { id: string }) {
  const tip = useThreadsStore(
    useShallow((s) => {
      const t = s.byId[id];
      if (t?.snoozeEvent) return { kind: t.snoozeEvent.kind, text: `Snoozed until ${t.snoozeEvent.waitingFor}` };
      if (t && t.snoozeEndedBy && statusLine(t).kind === "snoozeEnded") return { kind: null, text: t.snoozeEndedBy };
      return null;
    }),
  );
  if (!tip) return null;
  return (
    <div className="mb-[3px] flex items-start gap-2 leading-5" data-testid="tip-snooze-event">
      {tip.kind ? <SnoozeEventIcon kind={tip.kind} className="mt-[3px] size-3.5 shrink-0 text-cf-text-muted" /> : <span className="size-3.5 shrink-0" aria-hidden />}
      <span className="min-w-0 break-words">{tip.text}</span>
    </div>
  );
}

/**
 * "↳ Created by <name>" for a thread an agent created (the creator's current name); a
 * removed creator keeps the name it had then, muted and marked so. Nothing for the user's
 * threads.
 */
function TipCreatedBy({ id }: { id: string }) {
  const creator = useCreator(id);
  if (creator === null) return null;
  return (
    <div className="mb-[3px] flex items-start gap-2 leading-5" data-testid="tip-created-by" data-removed={!creator.exists || undefined}>
      <CornerDownRight className="mt-[3px] size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
      <span className="min-w-0 break-words">
        Created by <span className={creator.exists ? "font-medium" : "text-cf-text-muted"}>{creator.name}</span>
        {!creator.exists && <span className="text-cf-text-muted"> (removed)</span>}
      </span>
    </div>
  );
}

/**
 * A queued "Run in…" move, which only this card shows (the row keeps the current place):
 * the thread runs there once it is idle at its prompt. Nothing without a move.
 */
function TipMoving({ id }: { id: string }) {
  const { movingTo } = useThreadPlace(id);
  if (movingTo === null) return null;
  return (
    <div className="mb-[3px] flex items-start gap-2 leading-5 text-cf-warning-text" data-testid="tip-moving">
      <ArrowRightLeft className="mt-[3px] size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">Runs in {movingTo} once it is idle at its prompt</span>
    </div>
  );
}

/**
 * "Saved automatically after 3 days without activity" for a thread auto-tidy saved for later:
 * the row says only "Auto". Nothing for any other thread, nor for one snoozed until an event
 * (TipSnoozeEvent says what it waits on, as its row does).
 */
function TipAutoSaved({ id }: { id: string }) {
  const sentence = useThreadsStore((s) => {
    const t = s.byId[id];
    return (t?.savedAtMs ?? null) === null || t?.snoozeEvent ? null : autoSavedSentence(t?.autoSavedAfterMs);
  });
  if (sentence === null) return null;
  return (
    <div className="mb-[3px] flex items-start gap-2 leading-5" data-testid="tip-auto-saved">
      <Bookmark className="mt-[3px] size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
      <span className="min-w-0 break-words">{sentence}</span>
    </div>
  );
}

/**
 * The tooltip's body: name, status (attention or error only; a thread waiting on its child
 * threads says on which, TipWaiting), who created it (a thread an agent made), that auto-tidy saved it (TipAutoSaved), a queued move,
 * where it works (ThreadPlaceRows), model, the linked pull requests (TipLinkedPrs), and the
 * notifications naming the thread (TipNotifications). Mounted only while open
 * (docs/notes/sidebar-thread-card.md).
 */
function ThreadTipBody({ id, onMenuOpenChange }: { id: string; onMenuOpenChange: (open: boolean) => void }) {
  const name = useThreadsStore((s) => s.byId[id]?.name ?? "");
  const model = useThreadsStore((s) => s.byId[id]?.model ?? "");
  const effort = useThreadsStore((s) => s.byId[id]?.effort ?? "");
  const models = useModelChoices();
  return (
    <>
      <div className="mb-[5px] truncate text-subheading" data-testid="tip-name">
        {name || id}
      </div>
      <TipStatus id={id} />
      <TipSnoozeEvent id={id} />
      <TipWaiting id={id} />
      <TipCreatedBy id={id} />
      <TipAutoSaved id={id} />
      <TipMoving id={id} />
      <ThreadPlaceRows id={id} />
      <TipRow icon={<ClaudeMark className="size-3.5 shrink-0" style={{ color: CLAUDE_ORANGE }} />} testId="tip-model">
        {modelLabel(model, models)}
        {effort && <span className="text-cf-text-muted"> ({effort})</span>}
      </TipRow>
      <TipLinkedPrs id={id} />
      <TipNotifications id={id} onMenuOpenChange={onMenuOpenChange} />
    </>
  );
}

/** Whether the pointer is over an element now (`:hover`, which the browser keeps up to date). */
function hovered(el: Element | null): boolean {
  return el?.matches(":hover") ?? false;
}

/** Keeps a press, click, double click, menu or key in the card from reaching the row (open, drag, rename, the row's menu) through React's tree. */
const keepInCard = (e: SyntheticEvent) => {
  e.stopPropagation();
};

/**
 * A thread row's hover card, open at once (delayDuration 0, not the app root's 500 ms).
 * Pointer only: the rows are not focusable (the list uses aria-activedescendant), so
 * keyboard navigation never opens it, nor does focus coming back to a row action, nor a move
 * over the row's portalled snooze menu; a click or right-click closes it. It stays open over
 * everything in the row, its actions and the linked PR tag too. Not while renaming.
 *
 * A thread that notifications name lists them on the card with their buttons
 * (docs/notes/notifications-4-row-mark.md), so the pointer can then travel from the row into the
 * card (Radix's hoverable content and its grace area), and the card stays open while the pointer
 * is in it (a corner button's own tooltip opening asks every other tooltip to shut) and while a
 * card's snooze menu is up. Without notifications it is the plain tooltip it was: it shuts as the
 * pointer leaves the row. Whether it is hoverable is fixed while it is open, so dismissing the last
 * notification from the card does not strand it open. Presses in the card stay in it.
 */
export function ThreadTooltip({ id, children }: { id: string; children: ReactElement }) {
  const enabled = useContext(RowTooltipsEnabled);
  const renaming = useUiStore((s) => s.renamingThreadId === id);
  const marked = useThreadMark(id).count > 0;
  const [open, setOpen] = useState(false);
  const allowed = enabled && !renaming;
  const shown = open && allowed;
  // Hoverable while notifications name the thread, decided as the card opens.
  const [hoverable, setHoverable] = useState(marked);
  if (!shown && hoverable !== marked) setHoverable(marked);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // The pointer is in the card (React's enter and leave, which count its portalled menus as in it).
  const inside = useRef(false);
  // A card's snooze menu is up.
  const held = useRef(false);
  // Shut unless the pointer is over the row or the card.
  const settle = () => {
    if (held.current || hovered(trigger.current) || hovered(content.current)) return;
    inside.current = false;
    setOpen(false);
  };
  const onMenuOpenChange = (o: boolean) => {
    held.current = o;
    if (!o) settle();
  };
  return (
    <Tooltip
      open={shown}
      onOpenChange={(o) => {
        // Radix shuts a hoverable card when another tooltip opens (a corner button's) and when the
        // pointer leaves it for a menu: neither while the pointer is in the card or a menu is up.
        if (!o && hoverable && (inside.current || held.current)) return;
        setOpen(o && allowed);
      }}
      disableHoverableContent={!hoverable}
      delayDuration={0}
    >
      <TooltipTrigger
        asChild
        ref={trigger}
        // Any press in the row shuts the card. Radix's own close is not enough: it skips a press
        // that is default-prevented, as the one opening the snooze menu is, and RowActions stops
        // the click, so the card would stay open behind the menu. A press in the card itself
        // (React brings it here through the portal) is the card's.
        onPointerDownCapture={(e) => {
          if (e.target instanceof Node && e.currentTarget.contains(e.target)) setOpen(false);
        }}
        // Pointer only: focus never opens the card. The snooze menu hands focus back to its
        // button as it closes, which opened the card with nothing hovered (and kept it open).
        onFocus={(e) => {
          e.preventDefault();
        }}
        // Moves over the row's portalled content (the snooze menu) bubble here through React's
        // tree; they are not over the row, so Radix must not see them.
        onPointerMove={(e) => {
          if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) e.preventDefault();
        }}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        ref={content}
        side="right"
        align="start"
        sideOffset={12}
        className={cn("px-2.5 py-2 text-body-sm", marked ? "w-[340px]" : "w-[260px]")}
        data-testid="thread-tooltip"
        data-thread-id={id}
        data-hoverable={hoverable || undefined}
        onPointerEnter={() => {
          inside.current = true;
        }}
        onPointerLeave={() => {
          inside.current = false;
          settle();
        }}
        // Escape shuts it even with the pointer in it.
        onEscapeKeyDown={() => {
          inside.current = false;
          setOpen(false);
        }}
        onClick={keepInCard}
        onPointerDown={keepInCard}
        onDoubleClick={keepInCard}
        onContextMenu={keepInCard}
        onKeyDown={keepInCard}
      >
        <ThreadTipBody id={id} onMenuOpenChange={onMenuOpenChange} />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A section's header, the one look of the sidebar's five (Needs you and Active in the main list,
 * Working, Snoozed and Archived in the footers): a title-case label (text-caption, medium) on the
 * rows' 8px inset, then on the right the section's own control if it has one (`aside`, Needs
 * you's scope button), the number of threads in the section, and a chevron saying whether the
 * section is open. The chevron's box ends on the sidebar's right edge, the line the status row's
 * last button (SidebarStatus) ends on: it is pulled through the bar's 8px right padding (px-2, so
 * -mr-2). docs/notes/design-system-2-shell.md.
 *
 * The whole bar collapses and expands the section, the hover fill across its full width. A
 * button cannot hold the aside's button, so the collapse target is a button laid over the bar
 * (`absolute inset-0`, aria-expanded, named "<label> <count>" as its text would be) and the label,
 * count and chevron are drawn beside it for the eye only; the aside sits above it (`z-10`), so
 * its click is its own and never collapses the section. Pressing either with the mouse does not
 * take focus from the list. Test ids `<section>-header` (the collapse button), `-label`, `-count`.
 */
export function SectionHeaderBar({ section, label, count, collapsed, onToggle, aside }: { section: string; label: string; count: number; collapsed: boolean; onToggle: () => void; aside?: ReactNode }) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className="relative flex h-[22px] w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-cf-sidebar-muted-foreground hover:bg-cf-sidebar-row-hover">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={`${label} ${String(count)}`}
        data-testid={`${section}-header`}
        className="absolute inset-0 cursor-default rounded-md outline-none focus-visible:ring-1 focus-visible:ring-cf-focus"
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={onToggle}
      />
      <span className="pointer-events-none truncate text-caption font-medium text-inherit" aria-hidden data-testid={`${section}-label`}>
        {label}
      </span>
      {/* A flex container drops this space visually; it keeps the row's text "Working 2". */}{" "}
      {aside !== undefined && <span className="relative z-10 ml-auto flex shrink-0 items-center">{aside}</span>}
      <span className={cn("pointer-events-none shrink-0 text-caption tabular-nums text-inherit opacity-70", aside === undefined && "ml-auto")} aria-hidden data-testid={`${section}-count`}>
        {count}
      </span>
      <Chevron className="pointer-events-none -mr-2 size-3 shrink-0" aria-hidden />
    </div>
  );
}

/** A footer's header, Working, Snoozed or Archived (SectionHeaderBar). The row is role="presentation", so the listbox's cursor never lands on it. */
function SectionHeader({ row }: { row: HeaderRow }) {
  return (
    <div id={`row-${row.key}`} role="presentation" data-row-kind="header" data-row-key={row.key} data-section={row.section} className="flex h-full items-end select-none">
      <SectionHeaderBar
        section={row.section}
        label={row.label}
        count={row.count}
        collapsed={row.collapsed}
        onToggle={() => {
          const ui = useUiStore.getState();
          if (row.section === "archived") ui.toggleArchivedCollapsed();
          else if (row.section === "snoozed") ui.toggleSnoozedCollapsed();
          else ui.toggleWorkingCollapsed();
        }}
      />
    </div>
  );
}

/** How long ago the thread was archived ("now", "5m", "3h", "2d"), on the shared 30 s clock. */
function ArchivedAge({ id }: { id: string }) {
  const at = useThreadsStore((s) => s.byId[id]?.archivedAtMs ?? null);
  const age = useNowSelect(30_000, (now) => (at === null ? "" : formatAge(at, now, { minutes: true, hours: true, days: true, ago: false })));
  if (at === null) return null;
  return (
    <span className="ml-auto shrink-0 pl-1 text-caption-sm text-cf-sidebar-muted-foreground tabular-nums" data-testid="row-archived-age">
      {age}
    </span>
  );
}

/** What a row's event mark needs of the thread's snooze event (a narrow, shallow-compared pick). */
function eventMarkOf(e: ThreadSnoozeEventView | null | undefined): { kind: ThreadSnoozeEventView["kind"]; label: string } | null {
  return e ? { kind: e.kind, label: e.label } : null;
}

/**
 * A thread snoozed until an event (docs/notes/snooze-until-event.md): where a timed row shows the
 * alarm and its countdown, a pull request or plug glyph and the event in a few words ("#812
 * checks", "deploy"). The hover card says it in full.
 */
function EventMark({ kind, label }: { kind: ThreadSnoozeEventView["kind"]; label: string }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 text-caption-sm whitespace-nowrap text-cf-sidebar-muted-foreground" data-testid="row-snooze-event">
      <SnoozeEventIcon kind={kind} className="size-3 shrink-0" />
      <span className="tabular-nums">{label}</span>
    </span>
  );
}

/**
 * A thread saved for later: a bookmark and "Saved", where a snoozed row counts down (it never
 * wakes); "Auto" when the daemon saved it on its own (auto-tidy, docs/notes/auto-tidy.md), whose
 * full sentence is the hover card's (TipAutoSaved).
 */
function SavedMark({ auto }: { auto: boolean }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 text-caption-sm text-cf-sidebar-muted-foreground" data-testid="row-saved" data-auto={auto || undefined}>
      <Bookmark className="size-3 shrink-0" aria-hidden data-testid="row-saved-icon" />
      {auto ? "Auto" : "Saved"}
    </span>
  );
}

/**
 * How long until the snoozed thread wakes ("45m", "2h", "4d"; "<1m"), on the shared 30 s
 * clock, after an alarm clock that says it is a countdown (the tooltip no longer repeats it);
 * SavedMark for one saved for later.
 */
function SnoozeLeft({ id }: { id: string }) {
  const until = useThreadsStore((s) => s.byId[id]?.snoozedUntilMs ?? null);
  const saved = useThreadsStore((s) => (s.byId[id]?.savedAtMs ?? null) !== null);
  const event = useThreadsStore(useShallow((s) => eventMarkOf(s.byId[id]?.snoozeEvent)));
  const auto = useThreadsStore((s) => (s.byId[id]?.autoSavedAfterMs ?? 0) > 0);
  const left = useNowSelect(30_000, (now) => (until === null ? "" : shortRemaining(until, now)));
  if (event) return <EventMark kind={event.kind} label={event.label} />;
  if (saved) return <SavedMark auto={auto} />;
  if (until === null) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 text-caption-sm text-cf-sidebar-muted-foreground tabular-nums" data-testid="row-snooze-left">
      <AlarmClock className="size-3 shrink-0" aria-hidden data-testid="row-snooze-icon" />
      {left}
    </span>
  );
}

/**
 * A snoozed thread that works (a message from another thread started it; the snooze holds,
 * docs/notes/snooze-holds-archive-refuses.md): its working status (RowStatus: the icon and how
 * long), before the countdown. Nothing while it does not work.
 */
function SnoozedWork({ id }: { id: string }) {
  const working = useThreadsStore((s) => {
    const t = s.byId[id];
    return t !== undefined && threadGroup(t) === "working";
  });
  if (!working) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center pl-1" data-testid="row-snoozed-working">
      <RowStatus id={id} />
    </span>
  );
}

/**
 * An archived or snoozed thread's single line: the name, quiet (regular and muted; the id
 * while unnamed) and, on the right, how long ago it was archived or how long until it wakes. No status line,
 * badges or pin (an archived thread is unpinned; a snoozed one keeps its pin for when it wakes,
 * docs/notes/snooze-without-teardown.md, but is not among the pinned meanwhile): the whole section is such threads. A snoozed thread
 * that works says so before its countdown (SnoozedWork). All of it is
 * dimmed (QUIET) but the rename field, which is being typed in.
 */
export function SingleLineLabel({ id, section }: { id: string; section: "archived" | "snoozed" }) {
  const name = useThreadsStore((s) => s.byId[id]?.name ?? "");
  // A provisional name, or one being regenerated: muted and italic until the model's title lands.
  const provisional = useNameProvisional(id);
  const renaming = useUiStore((s) => s.renamingThreadId === id);
  return (
    <span className={cn("flex min-w-0 flex-1 items-center gap-1.5", !renaming && QUIET)} data-testid="thread-body" data-archived={section === "archived" || undefined} data-snoozed={section === "snoozed" || undefined}>
      {renaming ? (
        <RenameField id={id} name={name} />
      ) : (
        <>
          <MadeByThreadGlyph id={id} />
          <span className={nameClass(name, provisional, true)} data-testid="thread-name" data-provisional={provisional || undefined}>
            {name || id}
          </span>
          {section === "archived" ? (
            <ArchivedAge id={id} />
          ) : (
            <>
              <SnoozedWork id={id} />
              <SnoozeLeft id={id} />
            </>
          )}
        </>
      )}
    </span>
  );
}

export const SidebarRow = memo(function SidebarRow({ row, selected, cursor, onActivate }: RowProps) {
  if (row.kind === "header") return <SectionHeader row={row} />;
  return (
    <ThreadTooltip id={row.threadId}>
      <div
        id={`row-${row.key}`}
        role="option"
        aria-selected={selected}
        data-row-kind={row.kind}
        data-row-key={row.key}
        data-section={row.section}
        data-cursor={cursor || undefined}
        className={cn(
          "group/row flex h-full cursor-default items-center gap-1.5 rounded-md px-2 text-body-sm select-none",
          selected ? "bg-cf-sidebar-row-selected text-cf-sidebar-foreground" : "text-cf-sidebar-foreground/90 hover:bg-cf-sidebar-row-hover",
          cursor && "group-focus:ring-1 group-focus:ring-cf-focus group-focus:ring-inset",
        )}
        onClick={() => {
          onActivate(row);
        }}
        onDoubleClick={() => {
          useUiStore.getState().setRenaming(row.threadId);
        }}
      >
        {row.section === "archived" || row.section === "snoozed" ? <SingleLineLabel id={row.threadId} section={row.section} /> : <ThreadLabel id={row.threadId} cursor={cursor} />}
      </div>
    </ThreadTooltip>
  );
});
