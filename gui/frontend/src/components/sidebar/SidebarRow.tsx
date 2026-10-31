import { memo, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode, type SyntheticEvent } from "react";
import { AlarmClock, Archive, ArrowRightLeft, Bot, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CornerDownRight, GitBranch, House, Layers, OctagonX, Pin, SquareTerminal, type LucideIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { CLAUDE_ORANGE, ClaudeMark } from "@/components/icons/ClaudeMark";
import { ProjectKindIcon } from "@/components/icons/ProjectKindIcon";
import { NoGitBadge } from "@/components/projects/NoGitBadge";
import { Chip } from "@/components/thread/Chip";
import { SnoozePresetItems } from "@/components/snooze/SnoozeMenu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { agentsLabel } from "@/lib/agents";
import { useNow, useNowSelect } from "@/lib/clock";
import { formatElapsed } from "@/lib/elapsed";
import { cn } from "@/lib/utils";
import { threadBadge, shortAge } from "@/lib/thread";
import { shortRemaining } from "@/lib/snooze";
import { statusLine, statusText, tipStatusTone, type StatusLineKind, type StatusTone, type TipStatusTone } from "@/lib/statusLine";
import { statusBadge, statusDetail, statusTimeAt } from "@/lib/statusRegistry";
import { FRESH_COPY, PROJECT_FOLDER } from "@/lib/compose";
import { projectKind, type ProjectKind } from "@/lib/projects";
import { WORKSPACE_FOLDER } from "@/lib/projectSet";
import { modelLabel, projectsLabel, threadRowModel, type ThreadPlace, type WorkspaceLookup } from "@/lib/threadRow";
import type { HeaderRow, Row } from "@/lib/tree";
import { useCreator, useMadeByThread } from "@/stores/lineage";
import { useProjectsStore } from "@/stores/projects";
import { archiveThread, renameThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { useModelChoices } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { useThreadPlace, useThreadPlaceInput } from "@/components/thread/useThreadPlace";
import { useWorkspacesStore } from "@/stores/workspaces";
import { RowTooltipsEnabled } from "./rowTooltips";
import { TipWaiting } from "./TipWaiting";
import { LinkedPrsBadge } from "./LinkedPrsBadge";
import { TipLinkedPrs } from "./TipLinkedPrs";

interface RowProps {
  row: Row;
  selected: boolean;
  cursor: boolean;
  onActivate: (row: Row, how: "click") => void;
}

/**
 * Inline name editor; Enter or blur commits via thread.rename, Escape cancels. It commits
 * only an edit of the name it opened with: a name that changed meanwhile (the naming
 * model's title replacing a provisional name) is not overwritten by the untouched text.
 */
function RenameField({ id, name }: { id: string; name: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const opened = useRef(name);
  const returnTo = useRef<Element | null>(null);
  useEffect(() => {
    returnTo.current = document.activeElement;
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const value = ref.current?.value.trim() ?? "";
    useUiStore.getState().setRenaming(null);
    if (commit && value && value !== opened.current && value !== name) void renameThread(id, value);
    if (returnTo.current instanceof HTMLElement && returnTo.current.isConnected) returnTo.current.focus();
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
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => {
        finish(true);
      }}
    />
  );
}

const NO_WORKSPACES: WorkspaceLookup = { byId: {} };

/** The hover card's status colours (lib/statusLine tones): amber waiting on the user, red failed, emerald done. */
const toneClasses: Readonly<Record<StatusTone, string>> = {
  muted: "",
  sky: "text-cf-info-text",
  amber: "text-cf-warning-text",
  emerald: "text-cf-success-text",
  red: "text-cf-error-text",
};

/**
 * Time since `at` (lib/elapsed formatElapsed: "4s", "4m", "1h 4m", "3d"). One shared 1 s
 * clock (lib/clock) drives every row that shows a time, but a row re-renders only when its
 * text changes: every second under a minute, then once a minute (elapsedTickMs's cadence).
 * A slower clock would hand a row a `now` up to a period old.
 */
function useElapsed(at: number): string {
  return useNowSelect(1000, (now) => formatElapsed(at, now));
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
 * Line 1's right side (lib/statusRegistry statusBadge): `<icon> <word>` in the kind's tone,
 * then for working and waiting a plain space and the time since the status changed in the
 * same tone; for an idle thread only the time since its last activity, muted; for the
 * attention, error and done kinds nothing after the word (the hover card has the time).
 */
function RowStatus({ id }: { id: string }) {
  const line = useThreadsStore(useShallow((st) => statusLine(st.byId[id])));
  const at = useThreadsStore((st) => statusTimeAt(line, st.byId[id]));
  const badge = statusBadge(line);
  const Icon = badge.icon;
  if (Icon === null) {
    return at === null ? null : <Elapsed at={at} className="text-cf-sidebar-muted-foreground" />;
  }
  return (
    <span className={cn("flex min-w-0 items-center gap-[3px] font-medium", badge.toneClass)} data-testid="row-status" data-kind={line.kind}>
      <Icon className="size-3 shrink-0" aria-hidden data-testid="row-status-icon" />
      <span className="whitespace-nowrap">
        <span data-testid="row-status-word">{badge.word}</span>
        {at !== null && (
          <>
            {" "}
            <Elapsed at={at} />
          </>
        )}
      </span>
    </span>
  );
}

const ACTION_BUTTON =
  "flex size-5 shrink-0 items-center justify-center rounded-sm bg-cf-sidebar-row-selected text-cf-icon-muted outline-none hover:text-cf-sidebar-foreground focus-visible:ring-1 focus-visible:ring-cf-focus aria-expanded:text-cf-sidebar-foreground";

/** Keeps a click (and a double click) on a row's own control from reaching the row: no select, no rename. */
const stop = (e: SyntheticEvent) => {
  e.stopPropagation();
};

/**
 * The row's hover actions, over line 1's status: Snooze (the preset menu, SnoozePresetItems)
 * and Archive (at once, thread.archive). Shown while the row is hovered, while one of them
 * has the keyboard, and while the snooze menu is open. They are tab stops only on the
 * keyboard cursor's row (`cursor`), so Tab leaves the list after one row's actions rather
 * than walking every row's; the context menu and the palette have the same commands.
 */
function RowActions({ id, cursor, onShownChange }: { id: string; cursor: boolean; onShownChange: (shown: boolean) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [focused, setFocused] = useState(false);
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
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <Tip label="Snooze thread" side="top" delay={0} data-testid="row-snooze-tip">
          <DropdownMenuTrigger asChild>
            <button type="button" tabIndex={tab} aria-label="Snooze thread" className={ACTION_BUTTON} data-testid="row-snooze">
              <AlarmClock className="size-3.5" aria-hidden />
            </button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="start" data-testid="row-snooze-menu" onClick={stop} onDoubleClick={stop}>
          <SnoozePresetItems id={id} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} />
        </DropdownMenuContent>
      </DropdownMenu>
      <Tip label="Archive thread" side="top" delay={0} data-testid="row-archive-tip">
        <button
          type="button"
          tabIndex={tab}
          aria-label="Archive thread"
          className={ACTION_BUTTON}
          data-testid="row-archive"
          onClick={(e) => {
            e.stopPropagation();
            void archiveThread(id, true);
          }}
        >
          <Archive className="size-3.5" aria-hidden />
        </button>
      </Tip>
    </span>
  );
}

/**
 * Line 1 (text-caption-sm, muted): where the thread runs and, on the right, its status.
 * The project it runs in, after a Layers glyph when the thread spans several projects
 * (its workspace's name is on the hover card; a thread in its workspace's folder, which has
 * no project, shows the workspace's name); plain "No project" for a thread without one; the pin after it.
 * On hover the status gives way to the row's actions (RowActions), which keep at least
 * their own width so they never cover the project name.
 */
function LineProject({ id, cursor }: { id: string; cursor: boolean }) {
  const pinned = useThreadsStore((s) => s.byId[id]?.pinned ?? false);
  const { project, noProject, set, inFolder } = useThreadPlace(id);
  const [actionsShown, setActionsShown] = useState(false);
  return (
    <span className="flex h-4 min-w-0 items-center text-caption-sm" data-testid="row-line-1">
      <span className="min-w-0 truncate text-cf-sidebar-muted-foreground" data-testid="row-project" data-no-project={noProject || undefined} data-set={set !== null || undefined}>
        {set !== null && <Layers className="mr-1 inline size-3 align-[-2px] text-cf-icon-muted" aria-label="workspace" data-testid="row-workspace" />}
        {inFolder ? set : project}
      </span>
      {pinned && <Pin className="ml-1 size-3 shrink-0 text-cf-icon-muted" aria-label="pinned" data-testid="row-pinned" />}
      <span className={cn("relative ml-auto flex shrink-0 items-center justify-end pl-1.5 group-hover/row:min-w-[50px]", actionsShown && "min-w-[50px]")}>
        <span className={cn("flex min-w-0 items-center group-hover/row:invisible", actionsShown && "invisible")}>
          <RowStatus id={id} />
        </span>
        <RowActions id={id} cursor={cursor} onShownChange={setActionsShown} />
      </span>
    </span>
  );
}

/** A count on line 3's right: an icon and a number. */
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
 * Line 3 (text-caption-sm): the status's detail (lib/statusRegistry statusDetail: the tool
 * a working turn runs, the question, the error…), muted and truncated, or else the branch
 * (a GitBranch glyph and the name in mono; the No git badge for a project without git;
 * nothing for a thread without a project, the line keeps its height). A queued "Run in…"
 * move replaces both until the thread's worktree changes. On the right the background
 * agents (info tone) and shells (muted) running now, then the linked PR tag.
 */
function LineMeta({ id }: { id: string }) {
  const line = useThreadsStore(useShallow((st) => statusLine(st.byId[id])));
  const detail = useThreadsStore((st) => statusDetail(line, st.byId[id]));
  const agents = useThreadsStore((s) => s.byId[id]?.backgroundAgentsRunning ?? 0);
  const shells = useThreadsStore((s) => s.byId[id]?.backgroundShellsRunning ?? 0);
  const { branch, noGit, noProject, movingTo } = useThreadPlace(id);
  let left: ReactNode = null;
  if (movingTo !== null) {
    left = (
      <span className="flex min-w-0 items-center gap-1 text-cf-warning-text" data-testid="row-moving">
        <ArrowRightLeft className="size-3 shrink-0" aria-hidden />
        <span className="truncate">moving to {movingTo}…</span>
      </span>
    );
  } else if (detail) {
    left = (
      <span className="min-w-0 truncate text-cf-sidebar-muted-foreground" data-testid="row-detail">
        {detail}
      </span>
    );
  } else if (noGit) {
    left = <NoGitBadge tip={false} />;
  } else if (!noProject && branch) {
    left = (
      <span className="flex min-w-0 items-center gap-[3px] text-cf-sidebar-muted-foreground">
        <GitBranch className="size-3 shrink-0" aria-hidden data-testid="row-branch-icon" />
        <span className="truncate font-mono" data-testid="row-branch">
          {branch}
        </span>
      </span>
    );
  }
  return (
    <span className="flex h-4 min-w-0 items-center text-caption-sm" data-testid="row-line-3">
      {left}
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-1.5">
        <Count icon={Bot} n={agents} className="text-cf-info-text" label={agentsLabel(agents)} testId="row-bg-agents" />
        <Count icon={SquareTerminal} n={shells} className="text-cf-sidebar-muted-foreground" label={shells === 1 ? "1 shell" : `${String(shells)} shells`} testId="row-bg-shells" />
        <LinkedPrsBadge id={id} />
      </span>
    </span>
  );
}

/**
 * The muted ↳ before the name of a thread an agent created (docs/notes/agents-3-lineage-gui.md,
 * sketch variant A); nothing for the user's threads. No tooltip of its own: the row's
 * tooltip says who created it.
 */
function MadeByThreadGlyph({ id }: { id: string }) {
  const made = useMadeByThread(id);
  if (!made) return null;
  return <CornerDownRight className="-mr-px size-3 shrink-0 text-cf-icon-muted opacity-85" aria-label="Created by a thread" data-testid="row-created-by" />;
}

/**
 * The name's look: one role above the row's text (text-body, medium), so names stand
 * out from the status line and from each other (docs/notes/sidebar-row-emphasis.md). It
 * keeps the row's colour (text-inherit: the role's own foreground would drop the row's
 * sidebar and selection tokens). The id stands in, muted, while there is no name; a
 * provisional name (the daemon's cut of the first prompt, until the naming model's title
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

/**
 * A thread row in the inbox layout (docs/notes/sidebar-inbox-3-row.md): three lines with
 * no gap, filling the row's THREE_LINE_ROW box (rowSizes.ts). Line 1 the project and the
 * status (LineProject), line 2 the name (text-body, medium; the made-by-thread glyph for a
 * thread an agent created), line 3 the detail or branch and the counts (LineMeta). The
 * status kind and the thread badge are on the body as data attributes for tests.
 */
function ThreadLabel({ id, cursor }: { id: string; cursor: boolean }) {
  // Unnamed until the daemon names it from the first prompt: the id stands in.
  const name = useThreadsStore((s) => s.byId[id]?.name ?? "");
  // A provisional name, or one being regenerated: muted and italic until the model's title lands.
  const provisional = useThreadsStore((s) => (s.byId[id]?.nameProvisional || s.byId[id]?.naming) ?? false);
  const kind = useThreadsStore((s) => statusLine(s.byId[id]).kind);
  const badge = useThreadsStore((s) => threadBadge(s.byId[id]));
  const renaming = useUiStore((s) => s.renamingThreadId === id);
  return (
    // Whether Claude runs for the thread never shows: a stopped thread looks like any other.
    <span className="flex min-w-0 flex-1 flex-col" data-testid="thread-body" data-status-line={kind} data-thread-badge={badge}>
      <LineProject id={id} cursor={cursor} />
      <span className="flex h-[22px] min-w-0 items-center gap-1.5">
        {renaming ? (
          <RenameField id={id} name={name} />
        ) : (
          <>
            <MadeByThreadGlyph id={id} />
            <span className={nameClass(name, provisional)} data-testid="thread-name" data-provisional={provisional || undefined}>
              {name || id}
            </span>
          </>
        )}
      </span>
      <LineMeta id={id} />
    </span>
  );
}


/**
 * One line of the thread tooltip: an icon, the text, and on the right an optional muted
 * chip or a muted meta text (a count), never both.
 */
function TipRow({ icon, chip, meta, children, testId }: { icon: ReactNode; chip?: string | null; meta?: string | null; children: ReactNode; testId: string }) {
  return (
    <div className="flex items-center gap-2 leading-5" data-testid={testId}>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      {meta && !chip && (
        <span className="ml-auto shrink-0 pl-1 text-cf-text-muted tabular-nums" data-testid={`${testId}-meta`}>
          {meta}
        </span>
      )}
      {chip && (
        <Chip className="ml-auto" data-testid={`${testId}-chip`}>
          {chip}
        </Chip>
      )}
    </div>
  );
}

const TIP_ICON = "size-3.5 shrink-0 text-cf-icon-muted";

function TipIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className={TIP_ICON} aria-hidden />;
}

type CardTone = TipStatusTone | "emerald";

const tipStatusIcons: Readonly<Record<CardTone, LucideIcon>> = { amber: CircleAlert, red: OctagonX, emerald: CircleCheck };

/** The kinds whose card status says how long the thread has been so ("for 6m"): Claude's prompts and errors, not a plugin's flag or a deleted transcript. */
const timedCardKinds: ReadonlySet<StatusLineKind> = new Set<StatusLineKind>(["input", "question", "plan", "snoozeEnded", "error", "interrupted", "crashed"]);

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
    <div className={cn("mb-[3px] flex items-start gap-2 leading-5", toneClasses[tone])} data-testid="tip-status" data-tone={tone}>
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
 * A queued "Run in…" move in full (the row's "moving to X…" is cut short and does not say
 * when): the thread runs there once it is idle at its prompt. Nothing without a move.
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

/** The project row's chip: where the thread runs, in the composer's Work in words (lib/threadRow threadPlace). */
const placeWords: Readonly<Record<NonNullable<ThreadPlace>, string>> = { fresh: FRESH_COPY, folder: PROJECT_FOLDER };

/**
 * The tooltip's body: name, status (attention or error only; a thread waiting on its child
 * threads says on which, TipWaiting), who created it (a thread an agent made), a queued move,
 * the workspace of a multi-project thread (its name with "N projects" as muted meta on the right, else "N projects"), the project it runs in ("No project" with
 * the House icon for a thread without one; "Workspace folder" for its workspace's folder) with where it runs as the
 * chip (Fresh copy, Project folder), branch (git only), model, and the linked pull requests (TipLinkedPrs).
 * Mounted only while open (docs/notes/sidebar-thread-card.md).
 */
function ThreadTipBody({ id }: { id: string }) {
  const name = useThreadsStore((s) => s.byId[id]?.name ?? "");
  const model = useThreadsStore((s) => s.byId[id]?.model ?? "");
  const effort = useThreadsStore((s) => s.byId[id]?.effort ?? "");
  const models = useModelChoices();
  const where = useThreadPlaceInput(id);
  // A thread in its workspace's folder is in no project: the workspace row names it (never its w-<id>).
  const wsName = useWorkspacesStore((s) => (where.workspaceId ? (s.byId[where.workspaceId]?.name ?? "") : ""));
  const m = useProjectsStore(
    useShallow((st) => {
      const r = threadRowModel(where, st, wsName ? { byId: { [where.workspaceId]: { name: wsName } } } : NO_WORKSPACES);
      const p = st.byId[where.projectId];
      const kind: ProjectKind = p ? projectKind(p).kind : r.noGit ? "nogit" : "git";
      return { project: r.project, branch: r.branch, noGit: r.noGit, noProject: r.noProject, place: r.place, set: r.set, inFolder: !r.noProject && where.projectId === "" && where.workspaceId !== "", kind };
    }),
  );
  return (
    <>
      <div className="mb-[5px] truncate text-subheading" data-testid="tip-name">
        {name || id}
      </div>
      <TipStatus id={id} />
      <TipWaiting id={id} />
      <TipCreatedBy id={id} />
      <TipMoving id={id} />
      {m.set !== null && (
        // A named workspace says how many projects it spans on the right; an unnamed set's label already is "N projects".
        <TipRow icon={<TipIcon icon={Layers} />} meta={wsName ? projectsLabel(where.projectCount ?? 0) : null} testId="tip-workspace">
          {m.set}
        </TipRow>
      )}
      <TipRow
        icon={m.noProject ? <TipIcon icon={House} /> : m.inFolder ? <TipIcon icon={Layers} /> : <ProjectKindIcon kind={m.kind} className={TIP_ICON} />}
        chip={m.noGit ? "no git" : m.place === null ? null : placeWords[m.place]}
        testId="tip-project"
      >
        {m.inFolder ? WORKSPACE_FOLDER : m.project}
      </TipRow>
      {!m.noGit && !m.noProject && m.branch !== "" && (
        <TipRow icon={<TipIcon icon={GitBranch} />} testId="tip-branch">
          <span className="font-mono">{m.branch}</span>
        </TipRow>
      )}
      <TipRow icon={<ClaudeMark className="size-3.5 shrink-0" style={{ color: CLAUDE_ORANGE }} />} testId="tip-model">
        {modelLabel(model, models)}
        {effort && <span className="text-cf-text-muted"> ({effort})</span>}
      </TipRow>
      <TipLinkedPrs id={id} />
    </>
  );
}

/**
 * A thread row's hover tooltip (the app root's TooltipProvider sets the 500 ms delay). Pointer
 * only: the rows are not focusable (the list uses aria-activedescendant), so keyboard
 * navigation never opens it; a click or right-click closes it. Not while renaming, and not
 * over a badge with a tooltip of its own.
 */
function ThreadTooltip({ id, children }: { id: string; children: ReactElement }) {
  const enabled = useContext(RowTooltipsEnabled);
  const renaming = useUiStore((s) => s.renamingThreadId === id);
  const [open, setOpen] = useState(false);
  // Typed as Radix's trigger (a button); asChild puts it on the row's div.
  const ref = useRef<HTMLButtonElement>(null);
  const allowed = enabled && !renaming;
  return (
    <Tooltip
      open={open && allowed}
      onOpenChange={(o) => {
        // Not over a badge with its own tooltip (Tip, the linked-PRs tag): that one says it.
        setOpen(o && allowed && !ref.current?.querySelector("[data-tip]:hover"));
      }}
      disableHoverableContent
    >
      <TooltipTrigger
        asChild
        ref={ref}
        onPointerOver={(e) => {
          if (e.target instanceof Element && e.target.closest("[data-tip]")) setOpen(false);
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

/** How long ago the thread was archived ("5m", "3h", "2d"), on the shared 30 s clock. */
function ArchivedAge({ id }: { id: string }) {
  const at = useThreadsStore((s) => s.byId[id]?.archivedAtMs ?? null);
  const now = useNow(30_000);
  if (at === null) return null;
  return (
    <span className="ml-auto shrink-0 pl-1 text-caption-sm text-cf-sidebar-muted-foreground tabular-nums" data-testid="row-archived-age">
      {shortAge(at, now)}
    </span>
  );
}

/**
 * How long until the snoozed thread wakes ("45m", "2h", "4d"; "<1m"), on the shared 30 s
 * clock, after an alarm clock that says it is a countdown (the tooltip no longer repeats it).
 */
function SnoozeLeft({ id }: { id: string }) {
  const until = useThreadsStore((s) => s.byId[id]?.snoozedUntilMs ?? null);
  const now = useNow(30_000);
  if (until === null) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 text-caption-sm text-cf-sidebar-muted-foreground tabular-nums" data-testid="row-snooze-left">
      <AlarmClock className="size-3 shrink-0" aria-hidden data-testid="row-snooze-icon" />
      {shortRemaining(until, now)}
    </span>
  );
}

/**
 * An archived or snoozed thread's single line: the name, quiet (regular and muted; the id
 * while unnamed) and, on the right, how long ago it was archived or how long until it wakes. No status line,
 * badges or pin (such a thread is unpinned): the whole section is such threads.
 */
function SingleLineLabel({ id, section }: { id: string; section: "archived" | "snoozed" }) {
  const name = useThreadsStore((s) => s.byId[id]?.name ?? "");
  // A provisional name, or one being regenerated: muted and italic until the model's title lands.
  const provisional = useThreadsStore((s) => (s.byId[id]?.nameProvisional || s.byId[id]?.naming) ?? false);
  const renaming = useUiStore((s) => s.renamingThreadId === id);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5" data-testid="thread-body" data-archived={section === "archived" || undefined} data-snoozed={section === "snoozed" || undefined}>
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
          onActivate(row, "click");
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
