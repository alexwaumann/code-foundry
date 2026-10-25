import { memo, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { AlarmClock, ArrowRightLeft, Bot, ChevronDown, ChevronRight, CircleAlert, CornerDownRight, Folder, FolderGit2, GitBranch, Hourglass, House, Layers, OctagonX, Pin, type LucideIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { CLAUDE_ORANGE, ClaudeMark } from "@/components/icons/ClaudeMark";
import { NoGitBadge } from "@/components/projects/NoGitBadge";
import { Chip } from "@/components/thread/Chip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { agentsLabel } from "@/lib/agents";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { threadBadge, shortAge } from "@/lib/thread";
import { shortRemaining, snoozeTimeFull } from "@/lib/snooze";
import { showsPlace, statusLine, statusText, statusTones, tipStatusTone, type StatusLine, type StatusTone, type TipStatusTone } from "@/lib/statusLine";
import { modelLabel, threadRowModel, type WorkspaceLookup } from "@/lib/threadRow";
import type { HeaderRow, Row } from "@/lib/tree";
import { useCreator, useMadeByThread } from "@/stores/lineage";
import { useProjectsStore } from "@/stores/projects";
import { renameThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { useModelChoices } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { useThreadPlace, useThreadPlaceInput } from "@/components/thread/useThreadPlace";
import { useWorkspacesStore } from "@/stores/workspaces";
import { RowTooltipsEnabled } from "./rowTooltips";
import { TipWaiting } from "./TipWaiting";
import { LinkedPrsBadge } from "./LinkedPrsBadge";

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

/** Status text colours: the theme's status tokens (index.css), sky info, amber warning, emerald success, red destructive. */
const toneClasses: Readonly<Record<StatusTone, string>> = {
  muted: "",
  sky: "text-cf-info-text",
  amber: "text-cf-warning-text",
  emerald: "text-cf-success-text",
  red: "text-cf-error-text",
};

/** Status text with a relative time; only these rows subscribe to the shared 30 s clock. */
function TimedStatusText({ line }: { line: StatusLine }) {
  const now = useNow(30_000);
  return <>{statusText(line, now)}</>;
}

/**
 * "N agents" (sky, with a bot) while the thread's subagents run (Thread.agents_running,
 * docs/notes/agents-2-gui.md), ahead of the status; nothing otherwise. The sort ignores it.
 */
function AgentsRunning({ id, more }: { id: string; more: boolean }) {
  const n = useThreadsStore((st) => st.byId[id]?.agentsRunning ?? 0);
  if (n <= 0) return null;
  return (
    <>
      <span className={toneClasses.sky} data-testid="row-agents">
        <Bot className="mr-0.5 inline size-2.5 align-[-1px]" aria-hidden />
        {agentsLabel(n)}
      </span>
      {more && <span aria-hidden> · </span>}
    </>
  );
}

/**
 * The thread's second line (lib/statusLine): what it is doing or waiting on, coloured, and
 * "project @ branch" where the status leaves room for it (working, idle); "No
 * project" alone for a thread without one. A queued "Run in…" move replaces it until the
 * thread's worktree changes.
 */
function ThreadLine({ id }: { id: string }) {
  const line = useThreadsStore(useShallow((st) => statusLine(st.byId[id])));
  const badge = useThreadsStore((st) => threadBadge(st.byId[id]));
  const { project, branch, noGit, noProject, movingTo, set } = useThreadPlace(id);
  const status = line.kind !== "place";
  return (
    <span className="flex min-w-0 items-center gap-1 text-caption-sm" data-testid="row-place" data-status-line={line.kind} data-thread-badge={badge}>
      {movingTo !== null ? (
        <span className="flex min-w-0 items-center gap-1 text-cf-warning-text" data-testid="row-moving">
          <ArrowRightLeft className="size-3 shrink-0" aria-hidden />
          <span className="truncate">moving to {movingTo}…</span>
        </span>
      ) : (
        <span className="min-w-0 truncate">
          <AgentsRunning id={id} more={status || showsPlace(line.kind)} />
          {status && (
            <span className={toneClasses[statusTones[line.kind]]} data-testid="row-status">
              {line.kind === "waiting" && <Hourglass className="mr-0.5 inline size-2.5 align-[-1px] text-cf-icon-muted" aria-hidden data-testid="row-waiting" />}
              {line.at !== null ? <TimedStatusText line={line} /> : statusText(line, 0)}
            </span>
          )}
          {showsPlace(line.kind) && (
            <>
              {status && <span aria-hidden> · </span>}
              <span data-testid="row-project" data-no-project={noProject || undefined} data-set={set !== null || undefined}>
                {set ?? project}
              </span>
              {noProject || (set !== null && !branch) ? null : noGit ? (
                <>
                  {" "}
                  <NoGitBadge className="align-[1px]" tip={false} />
                </>
              ) : (
                <>
                  {" "}
                  <span className="opacity-60">@</span>{" "}
                  <span className="font-mono" data-testid="row-branch">
                    {branch}
                  </span>
                </>
              )}
            </>
          )}
        </span>
      )}
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
 * The name's look: one role above the row's text (text-body, semibold), so names stand
 * out from the status line and from each other (docs/notes/sidebar-row-emphasis.md). It
 * keeps the row's colour (text-inherit: the role's own foreground would drop the row's
 * sidebar and selection tokens). The id stands in, muted, while there is no name; a
 * provisional name (the daemon's cut of the first prompt, until the naming model's title
 * lands) is muted and italic.
 */
function nameClass(name: string, provisional: boolean): string {
  return cn("truncate text-body font-semibold text-inherit", (!name || provisional) && "text-cf-sidebar-muted-foreground", provisional && "italic");
}

function ThreadLabel({ id }: { id: string }) {
  // Unnamed until the daemon names it from the first prompt: the id stands in.
  const name = useThreadsStore((s) => s.byId[id]?.name ?? "");
  const provisional = useThreadsStore((s) => s.byId[id]?.nameProvisional ?? false);
  const pinned = useThreadsStore((s) => s.byId[id]?.pinned ?? false);
  const renaming = useUiStore((s) => s.renamingThreadId === id);
  return (
    // Whether Claude runs for the thread never shows: a stopped thread looks like any other.
    <span className="flex min-w-0 flex-1 flex-col gap-0.5" data-testid="thread-body">
      <span className="flex min-w-0 items-center gap-1.5">
        {renaming ? (
          <RenameField id={id} name={name} />
        ) : (
          <>
            <MadeByThreadGlyph id={id} />
            <span className={nameClass(name, provisional)} data-testid="thread-name" data-provisional={provisional || undefined}>
              {name || id}
            </span>
            <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1 pl-1">
              <LinkedPrsBadge id={id} />
              {pinned && <Pin className="size-3 shrink-0 text-cf-icon-muted" aria-label="pinned" data-testid="row-pinned" />}
            </span>
          </>
        )}
      </span>
      <ThreadLine id={id} />
    </span>
  );
}

/** One line of the thread tooltip: an icon, the text, and an optional muted chip on the right. */
function TipRow({ icon, chip, children, testId }: { icon: ReactNode; chip?: string | null; children: ReactNode; testId: string }) {
  return (
    <div className="flex items-center gap-2 leading-5" data-testid={testId}>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      {chip && (
        <Chip className="ml-auto" data-testid={`${testId}-chip`}>
          {chip}
        </Chip>
      )}
    </div>
  );
}

function TipIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-3.5 shrink-0 text-cf-icon-muted" aria-hidden />;
}

const tipStatusIcons: Readonly<Record<TipStatusTone, LucideIcon>> = { amber: CircleAlert, red: OctagonX };

/**
 * The full status text of a thread that needs the user or failed, in the row's line-2 words
 * and colour, wrapped rather than truncated (line 2 usually cuts it off); nothing for other
 * statuses (lib/statusLine `tipStatusTone`). A timed line ticks on the shared clock, only
 * while the tooltip is open (its body is mounted only then).
 */
function TipStatus({ id }: { id: string }) {
  const line = useThreadsStore(useShallow((st) => statusLine(st.byId[id])));
  const tone = tipStatusTone(line.kind);
  if (tone === null) return null;
  const Icon = tipStatusIcons[tone];
  return (
    <div className={cn("mb-[3px] flex items-start gap-2 leading-5", toneClasses[tone])} data-testid="tip-status" data-tone={tone}>
      <Icon className="mt-[3px] size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{line.at !== null ? <TimedStatusText line={line} /> : statusText(line, 0)}</span>
    </div>
  );
}

/**
 * A snoozed thread's wake time in full ("Snoozed until Thu, Oct 15, 9:00 AM"): its row
 * shows only the time left. Nothing for a thread that is not snoozed.
 */
function TipSnooze({ id }: { id: string }) {
  const until = useThreadsStore((s) => s.byId[id]?.snoozedUntilMs ?? null);
  const now = useNow(30_000);
  if (until === null) return null;
  return (
    <div className="mb-[3px] flex items-start gap-2 leading-5" data-testid="tip-snooze">
      <AlarmClock className="mt-[3px] size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
      <span className="min-w-0 break-words">Snoozed until {snoozeTimeFull(until, now)}</span>
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

/**
 * The projects of a multi-project thread, by name, with its workspace's name
 * as the chip (none without one): the row's line 2 only says "N projects".
 */
function TipSet({ id }: { id: string }) {
  const ids = useThreadsStore(useShallow((s) => s.byId[id]?.projectIds ?? []));
  const workspaceId = useThreadsStore((s) => s.byId[id]?.workspaceId ?? "");
  const names = useProjectsStore(useShallow((s) => ids.map((p) => s.byId[p]?.name ?? p).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))));
  const workspace = useWorkspacesStore((s) => (workspaceId ? (s.byId[workspaceId]?.name ?? workspaceId) : null));
  return (
    <TipRow icon={<TipIcon icon={Layers} />} chip={workspace} testId="tip-set">
      {names.join(", ")}
    </TipRow>
  );
}

/**
 * The tooltip's body: name, status (attention or error only; for a snoozed thread its wake
 * time instead; a thread waiting on its child threads says on which, TipWaiting), who created it (a thread an agent made), a queued move, project ("No project" with the House icon for a thread without one),
 * the projects of a multi-project thread (TipSet), branch (git only) and model. Mounted only while open.
 */
function ThreadTipBody({ id }: { id: string }) {
  const name = useThreadsStore((s) => s.byId[id]?.name ?? "");
  const snoozed = useThreadsStore((s) => (s.byId[id]?.snoozedUntilMs ?? null) !== null);
  const model = useThreadsStore((s) => s.byId[id]?.model ?? "");
  const effort = useThreadsStore((s) => s.byId[id]?.effort ?? "");
  const models = useModelChoices();
  const where = useThreadPlaceInput(id);
  // A thread in its workspace's folder is in no project: the first row names the workspace (never its w-<id>).
  const wsName = useWorkspacesStore((s) => (where.workspaceId ? (s.byId[where.workspaceId]?.name ?? "") : ""));
  const m = useProjectsStore(
    useShallow((st) => {
      const r = threadRowModel(where, st, wsName ? { byId: { [where.workspaceId]: { name: wsName } } } : NO_WORKSPACES);
      return { project: r.project, branch: r.branch, noGit: r.noGit, noProject: r.noProject, worktree: r.worktree, multi: r.set !== null, inFolder: !r.noProject && where.projectId === "" && where.workspaceId !== "" };
    }),
  );
  return (
    <>
      <div className="mb-[5px] truncate text-subheading" data-testid="tip-name">
        {name || id}
      </div>
      {snoozed ? <TipSnooze id={id} /> : <TipStatus id={id} />}
      {!snoozed && <TipWaiting id={id} />}
      <TipCreatedBy id={id} />
      <TipMoving id={id} />
      <TipRow icon={<TipIcon icon={m.noProject ? House : m.inFolder ? Layers : m.noGit ? Folder : FolderGit2} />} chip={m.noGit ? "no git" : null} testId="tip-project">
        {m.project}
      </TipRow>
      {m.multi && <TipSet id={id} />}
      {!m.noGit && !m.noProject && m.branch !== "" && (
        <TipRow icon={<TipIcon icon={GitBranch} />} chip={m.worktree ? "worktree" : null} testId="tip-branch">
          <span className="font-mono">{m.branch}</span>
        </TipRow>
      )}
      <TipRow icon={<ClaudeMark className="size-3.5 shrink-0" style={{ color: CLAUDE_ORANGE }} />} testId="tip-model">
        {modelLabel(model, models)}
        {effort && <span className="text-cf-text-muted"> ({effort})</span>}
      </TipRow>
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
 * A footer's header, Working, Snoozed or Archived (design record: /tmp/working-header/index.html?v=2):
 * an overline label (text-overline), the number of threads in the section after it, and a
 * chevron on the right saying whether the section is open. A button (aria-expanded) inside
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
        <span className="truncate text-overline" data-testid={`${row.section}-label`}>
          {row.label}
        </span>
        {/* A flex container drops this space visually; it keeps the text and name "Working 2". */}{" "}
        <span className="shrink-0 text-overline font-normal tabular-nums opacity-70" data-testid={`${row.section}-count`}>
          {row.count}
        </span>
        <Chevron className="-mr-2 ml-auto size-3 shrink-0" aria-hidden />
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
    <span className="ml-auto shrink-0 pl-1 text-caption-sm tabular-nums" data-testid="row-archived-age">
      {shortAge(at, now)}
    </span>
  );
}

/** How long until the snoozed thread wakes ("45m", "2h", "4d"; "<1m"), on the shared 30 s clock. */
function SnoozeLeft({ id }: { id: string }) {
  const until = useThreadsStore((s) => s.byId[id]?.snoozedUntilMs ?? null);
  const now = useNow(30_000);
  if (until === null) return null;
  return (
    <span className="ml-auto shrink-0 pl-1 text-caption-sm tabular-nums" data-testid="row-snooze-left">
      {shortRemaining(until, now)}
    </span>
  );
}

/**
 * An archived or snoozed thread's single line: the name (the id, muted, while unnamed) and,
 * on the right, how long ago it was archived or how long until it wakes. No status line,
 * badges or pin (such a thread is unpinned): the whole section is such threads.
 */
function SingleLineLabel({ id, section }: { id: string; section: "archived" | "snoozed" }) {
  const name = useThreadsStore((s) => s.byId[id]?.name ?? "");
  const provisional = useThreadsStore((s) => s.byId[id]?.nameProvisional ?? false);
  const renaming = useUiStore((s) => s.renamingThreadId === id);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5" data-testid="thread-body" data-archived={section === "archived" || undefined} data-snoozed={section === "snoozed" || undefined}>
      {renaming ? (
        <RenameField id={id} name={name} />
      ) : (
        <>
          <MadeByThreadGlyph id={id} />
          <span className={nameClass(name, provisional)} data-testid="thread-name" data-provisional={provisional || undefined}>
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
        {row.section === "archived" || row.section === "snoozed" ? <SingleLineLabel id={row.threadId} section={row.section} /> : <ThreadLabel id={row.threadId} />}
      </div>
    </ThreadTooltip>
  );
});
