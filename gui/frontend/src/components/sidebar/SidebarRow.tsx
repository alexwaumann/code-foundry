import { memo, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode, type SyntheticEvent } from "react";
import { AlarmClock, ArrowRightLeft, Bookmark, Bot, Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CornerDownRight, GitBranch, House, Layers, OctagonX, Pin, SquareTerminal, type LucideIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { CLAUDE_ORANGE, ClaudeMark } from "@/components/icons/ClaudeMark";
import { ProjectKindIcon } from "@/components/icons/ProjectKindIcon";
import { useProjectKind } from "@/components/icons/projectKind";
import { SnoozePresetItems } from "@/components/snooze/SnoozeMenu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { agentsLabel } from "@/lib/agents";
import { useNowSelect } from "@/lib/clock";
import { formatAge, formatDuration } from "@/lib/duration";
import { QUIET } from "@/lib/quiet";
import { cn } from "@/lib/utils";
import { threadBadge } from "@/lib/thread";
import { shortRemaining } from "@/lib/snooze";
import { statusLine, statusText, statusToneText, tipStatusTone, type StatusLineKind, type TipStatusTone } from "@/lib/statusLine";
import { statusBadge, statusTimeAt, statusTimeUnits } from "@/lib/statusRegistry";
import { modelLabel } from "@/lib/threadRow";
import type { HeaderRow, Row } from "@/lib/tree";
import { useCreator, useLiveCount, useMadeByThread } from "@/stores/lineage";
import { archiveThread, renameThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { useModelChoices } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { ThreadPlaceRows, TipRow } from "@/components/thread/ThreadPlaceRows";
import { rowHasBranchLine, useThreadPlace } from "@/components/thread/useThreadPlace";
import { RowTooltipsEnabled } from "./rowTooltips";
import { TipWaiting } from "./TipWaiting";
import { LinkedPrsBadge } from "./LinkedPrsBadge";
import { TipLinkedPrs } from "./TipLinkedPrs";

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
 * screen readers.
 */
export function RowStatus({ id }: { id: string }) {
  const line = useThreadsStore(useShallow((st) => statusLine(st.byId[id])));
  const at = useThreadsStore((st) => statusTimeAt(line, st.byId[id]));
  const badge = statusBadge(line);
  const Icon = badge.icon;
  if (Icon === null) {
    return at === null ? null : <Elapsed at={at} className="text-caption-sm text-cf-sidebar-muted-foreground" />;
  }
  return (
    <span className={cn("flex min-w-0 items-center gap-[3px] text-caption-sm font-medium", badge.toneClass)} data-testid="row-status" data-kind={line.kind}>
      <Icon className="size-3.5 shrink-0" aria-hidden data-testid="row-status-icon" />
      <span className="sr-only" data-testid="row-status-word">
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
 * The row's hover actions, on the right of its last line (HoverSlot): Snooze (the preset menu, SnoozePresetItems)
 * and Archive (at once, thread.archive). Shown while the row is hovered, while one of them
 * has the keyboard, and while the snooze menu is open. They are tab stops only on the
 * keyboard cursor's row (`cursor`), so Tab leaves the list after one row's actions rather
 * than walking every row's; the context menu and the palette have the same commands.
 */
function RowActions({ id, cursor, onShownChange }: { id: string; cursor: boolean; onShownChange: (shown: boolean) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  // The daemon refuses a snooze while a setup runs: spawn may be reading the row.
  const settingUp = useThreadsStore((s) => s.byId[id]?.setup?.phase === "running");
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
            <SnoozePresetItems id={id} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <button
        type="button"
        tabIndex={tab}
        aria-label="Archive thread"
        className={cn(ACTION_BUTTON, "h-5 gap-[3px] px-1 text-caption-sm font-medium hover:text-cf-success-text")}
        data-testid="row-archive"
        onClick={(e) => {
          e.stopPropagation();
          void archiveThread(id, true);
        }}
      >
        <Check className="size-3 shrink-0" aria-hidden />
        Archive
      </button>
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
 * then the linked PR tag.
 */
export function RowCounts({ id }: { id: string }) {
  const agents = useLiveCount(id);
  const shells = useThreadsStore((s) => s.byId[id]?.backgroundShellsRunning ?? 0);
  return (
    <>
      <Count icon={Bot} n={agents} className="text-cf-info-text" label={agentsLabel(agents)} testId="row-bg-agents" />
      <Count icon={SquareTerminal} n={shells} className="text-cf-sidebar-muted-foreground" label={shells === 1 ? "1 shell" : `${String(shells)} shells`} testId="row-bg-shells" />
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
  const provisional = useThreadsStore((s) => (s.byId[id]?.nameProvisional || s.byId[id]?.naming) ?? false);
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

/** The kinds whose card status says how long the thread has been so ("for 6m"): Claude's prompts and errors, not a plugin's flag or a deleted transcript. */
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
  const Icon = tipStatusIcons[tone];
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
            <TipElapsed at={changedAt} ago={finished} />
          </>
        )}
      </span>
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
 * The tooltip's body: name, status (attention or error only; a thread waiting on its child
 * threads says on which, TipWaiting), who created it (a thread an agent made), a queued move,
 * where it works (ThreadPlaceRows), model, and the linked pull requests (TipLinkedPrs).
 * Mounted only while open (docs/notes/sidebar-thread-card.md).
 */
function ThreadTipBody({ id }: { id: string }) {
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
      <TipWaiting id={id} />
      <TipCreatedBy id={id} />
      <TipMoving id={id} />
      <ThreadPlaceRows id={id} />
      <TipRow icon={<ClaudeMark className="size-3.5 shrink-0" style={{ color: CLAUDE_ORANGE }} />} testId="tip-model">
        {modelLabel(model, models)}
        {effort && <span className="text-cf-text-muted"> ({effort})</span>}
      </TipRow>
      <TipLinkedPrs id={id} />
    </>
  );
}

/**
 * A thread row's hover card, open at once (delayDuration 0, not the app root's 500 ms).
 * Pointer only: the rows are not focusable (the list uses aria-activedescendant), so
 * keyboard navigation never opens it, nor does focus coming back to a row action, nor a move
 * over the row's portalled snooze menu; a click or right-click closes it. It stays open over
 * everything in the row, its actions and the linked PR tag too. Not while renaming.
 */
export function ThreadTooltip({ id, children }: { id: string; children: ReactElement }) {
  const enabled = useContext(RowTooltipsEnabled);
  const renaming = useUiStore((s) => s.renamingThreadId === id);
  const [open, setOpen] = useState(false);
  const allowed = enabled && !renaming;
  return (
    <Tooltip
      open={open && allowed}
      onOpenChange={(o) => {
        setOpen(o && allowed);
      }}
      disableHoverableContent
      delayDuration={0}
    >
      <TooltipTrigger
        asChild
        // Any press in the row shuts the card. Radix's own close is not enough: it skips a press
        // that is default-prevented, as the one opening the snooze menu is, and RowActions stops
        // the click, so the card would stay open behind the menu.
        onPointerDownCapture={() => {
          setOpen(false);
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
      <TooltipContent side="right" align="start" sideOffset={12} className="w-[260px] px-2.5 py-2 text-body-sm" data-testid="thread-tooltip" data-thread-id={id}>
        <ThreadTipBody id={id} />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A footer's header, Working, Snoozed or Archived: a title-case label (text-caption, medium),
 * the number of threads in the section pushed to the right, and a chevron after it saying
 * whether the section is open. A button (aria-expanded) inside
 * the row; the row itself is role="presentation", so the listbox's cursor never lands on
 * it. Pressing it with the mouse does not take focus from the list. Test ids
 * `<section>-header`, `-label`, `-count`.
 *
 * The chevron's box ends on the sidebar's right edge, the line the status row's last
 * button (SidebarStatus) ends on just below: it is pulled through the button's 8px right
 * padding (px-2, so -mr-2). docs/notes/design-system-2-shell.md.
 */
function SectionHeader({ row }: { row: HeaderRow }) {
  const Chevron = row.collapsed ? ChevronRight : ChevronDown;
  return (
    <div id={`row-${row.key}`} role="presentation" data-row-kind="header" data-row-key={row.key} data-section={row.section} className="flex h-full items-end select-none">
      <button
        type="button"
        aria-expanded={!row.collapsed}
        data-testid={`${row.section}-header`}
        className="flex h-[22px] w-full min-w-0 cursor-default items-center gap-1.5 rounded-md px-2 text-cf-sidebar-muted-foreground outline-none hover:bg-cf-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-cf-focus"
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => {
          const ui = useUiStore.getState();
          if (row.section === "archived") ui.toggleArchivedCollapsed();
          else if (row.section === "snoozed") ui.toggleSnoozedCollapsed();
          else ui.toggleWorkingCollapsed();
        }}
      >
        <span className="truncate text-caption font-medium text-inherit" data-testid={`${row.section}-label`}>
          {row.label}
        </span>
        {/* A flex container drops this space visually; it keeps the text and name "Working 2". */}{" "}
        <span className="ml-auto shrink-0 text-caption tabular-nums text-inherit opacity-70" data-testid={`${row.section}-count`}>
          {row.count}
        </span>
        <Chevron className="-mr-2 size-3 shrink-0" aria-hidden />
      </button>
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

/** A thread saved for later: a bookmark and "Saved", where a snoozed row counts down (it never wakes). */
function SavedMark() {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 text-caption-sm text-cf-sidebar-muted-foreground" data-testid="row-saved">
      <Bookmark className="size-3 shrink-0" aria-hidden data-testid="row-saved-icon" />
      Saved
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
  const left = useNowSelect(30_000, (now) => (until === null ? "" : shortRemaining(until, now)));
  if (saved) return <SavedMark />;
  if (until === null) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 text-caption-sm text-cf-sidebar-muted-foreground tabular-nums" data-testid="row-snooze-left">
      <AlarmClock className="size-3 shrink-0" aria-hidden data-testid="row-snooze-icon" />
      {left}
    </span>
  );
}

/**
 * An archived or snoozed thread's single line: the name, quiet (regular and muted; the id
 * while unnamed) and, on the right, how long ago it was archived or how long until it wakes. No status line,
 * badges or pin (such a thread is unpinned): the whole section is such threads. All of it is
 * dimmed (QUIET) but the rename field, which is being typed in.
 */
function SingleLineLabel({ id, section }: { id: string; section: "archived" | "snoozed" }) {
  const name = useThreadsStore((s) => s.byId[id]?.name ?? "");
  // A provisional name, or one being regenerated: muted and italic until the model's title lands.
  const provisional = useThreadsStore((s) => (s.byId[id]?.nameProvisional || s.byId[id]?.naming) ?? false);
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
          {section === "archived" ? <ArchivedAge id={id} /> : <SnoozeLeft id={id} />}
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
