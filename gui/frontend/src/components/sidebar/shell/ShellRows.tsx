import { memo, useContext } from "react";
import { ChevronDown, ChevronRight, GitBranch, Layers, PencilLine, Square, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Tip } from "@/components/ui/tooltip";
import { rowHasBranchLine, useThreadPlace } from "@/components/thread/useThreadPlace";
import { type DraftRow, type MainHeaderRow, type NeedsScope, type ShellThreadRow } from "@/lib/shellSections";
import { statusLine } from "@/lib/statusLine";
import { statusBadge } from "@/lib/statusRegistry";
import { threadBadge } from "@/lib/thread";
import { cn } from "@/lib/utils";
import { useThreadDrag } from "@/shell/drag/draggable";
import { discardDraft } from "@/shell/drafts";
import { runCommandForResult } from "@/stores/commands";
import { spaceOfThread, useLayoutStore } from "@/stores/layout";
import { useLiveCount } from "@/stores/lineage";
import { useProjectsStore } from "@/stores/projects";
import { NEEDS_SCOPE_KEY, useNeedsScope } from "@/stores/shellList";
import { toggleActiveCollapsed, toggleNeedsCollapsed } from "@/stores/shellSidebar";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { linkedPrTag } from "../linkedPrTag";
import { HoverSlot, MadeByThreadGlyph, PinGlyph, PlaceIcon, RenameField, RowCounts, RowStatus, ThreadTooltip } from "../SidebarRow";
import { useLinkedPrFacts, useLinkKeys } from "../useLinkedPrs";
import { RowTooltipsEnabled } from "../rowTooltips";
import { NeedsHoverCard } from "@/components/needs/NeedsCard";
import { openNeedsPopup, useNeedsStore } from "@/stores/needs";

/**
 * The shell sidebar's rows (docs/notes/shell-model.md, "Sidebar"; docs/notes/shell-16-sidebar.md):
 * the thread row's three lines, a Needs you row, a composer draft, and the Needs you and Active
 * headers with the scope button. The footers' headers and the Snoozed and Archived rows are the
 * classic ones (SidebarRow).
 */

/** A row's box: the classic row's colours, the lines stacked. */
function rowClass(selected: boolean, cursor: boolean, draft = false): string {
  return cn(
    "group/row flex h-full cursor-default flex-col rounded-md px-2 py-1 text-body-sm select-none",
    // A draft keeps a light amber tint at all times, stronger on hover and when selected (docs/notes/shell-model.md, "Drafts").
    draft
      ? selected
        ? "bg-cf-warning/20 text-cf-sidebar-foreground"
        : "bg-cf-warning-surface text-cf-sidebar-foreground/90 hover:bg-cf-warning/15"
      : selected
        ? "bg-cf-sidebar-row-selected text-cf-sidebar-foreground"
        : "text-cf-sidebar-foreground/90 hover:bg-cf-sidebar-row-hover",
    cursor && "group-focus:ring-1 group-focus:ring-cf-focus group-focus:ring-inset",
  );
}

/** Line 1's left: the made-by-thread glyph, the place's icon and the project (or "No project"), the pin. */
function PlaceLabel({ id }: { id: string }) {
  const { project, noProject, set, inFolder } = useThreadPlace(id);
  return (
    <span
      className="flex min-w-0 items-center gap-[3px] text-cf-sidebar-muted-foreground"
      data-testid="row-project"
      data-no-project={noProject || undefined}
      data-set={set !== null || undefined}
    >
      <MadeByThreadGlyph id={id} />
      <PlaceIcon id={id} noProject={noProject} set={set !== null} />
      <span className="truncate">{inFolder ? set : project}</span>
      <PinGlyph id={id} />
    </span>
  );
}

/**
 * The title: the row's whole width, at most two lines, then cut with an ellipsis. Nothing sits
 * beside it, so nothing ever narrows it. The id stands in while the thread is unnamed; a
 * provisional name is muted and italic until the model's title lands.
 */
function Title({ id, quiet = false }: { id: string; quiet?: boolean }) {
  const name = useThreadsStore((s) => s.byId[id]?.name ?? "");
  const provisional = useThreadsStore((s) => (s.byId[id]?.nameProvisional || s.byId[id]?.naming) ?? false);
  const renaming = useUiStore((s) => s.renamingThreadId === id);
  if (renaming) {
    return (
      <span className="flex min-w-0 py-px">
        <RenameField id={id} name={name} />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "line-clamp-2 text-body break-words",
        quiet ? "text-cf-sidebar-muted-foreground" : "font-medium text-inherit",
        (!name || provisional) && "text-cf-sidebar-muted-foreground",
        provisional && "italic",
      )}
      data-testid="thread-name"
      data-provisional={provisional || undefined}
    >
      {name || id}
    </span>
  );
}

/** Whether the thread has something for line 3's right: live agents, background shells, or a pull request tag. */
function useHasCounts(id: string): boolean {
  const agents = useLiveCount(id);
  const shells = useThreadsStore((s) => s.byId[id]?.backgroundShellsRunning ?? 0);
  const tag = linkedPrTag(useLinkedPrFacts(useLinkKeys(id)));
  return agents > 0 || shells > 0 || tag !== null;
}

/**
 * Line 3: the branch (a thread with a project with git; empty until the branch is known), then
 * the pull request tag and the counts on the right (RowCounts). Only when the thread has a branch
 * line or counts: a thread without a project has none unless it has a tag or counts.
 */
function LineBranch({ id }: { id: string }) {
  const place = useThreadPlace(id);
  const counts = useHasCounts(id);
  if (!rowHasBranchLine(place) && !counts) return null;
  return (
    <span className="flex h-4 min-w-0 items-center text-caption-sm" data-testid="row-line-3">
      {place.branch !== "" && (
        <span className="flex min-w-0 items-center gap-[3px] text-cf-sidebar-muted-foreground">
          <GitBranch className="size-3 shrink-0" aria-hidden data-testid="row-branch-icon" />
          <span className="truncate font-mono" data-testid="row-branch">
            {place.branch}
          </span>
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-1.5">
        <RowCounts id={id} />
      </span>
    </span>
  );
}

/** A thread row's lines: the place with the status (the snooze and archive controls on hover), the title, the branch. */
function ThreadLines({ id, cursor }: { id: string; cursor: boolean }) {
  const kind = useThreadsStore((s) => statusLine(s.byId[id]).kind);
  const badge = useThreadsStore((s) => threadBadge(s.byId[id]));
  return (
    <span className="flex min-w-0 flex-col" data-testid="thread-body" data-status-line={kind} data-thread-badge={badge}>
      <span className="flex h-4 min-w-0 items-center text-caption-sm" data-testid="row-line-1">
        <PlaceLabel id={id} />
        <HoverSlot id={id} cursor={cursor}>
          <RowStatus id={id} />
        </HoverSlot>
      </span>
      <Title id={id} />
      <LineBranch id={id} />
    </span>
  );
}

/** What a Needs you thread asks: the status's icon and word in its tone ("Permission", "Question", a plugin's name). */
function AskKind({ id }: { id: string }) {
  const line = useThreadsStore(useShallow((s) => statusLine(s.byId[id])));
  const badge = statusBadge(line);
  const Icon = badge.icon;
  return (
    <span className={cn("ml-auto flex shrink-0 items-center gap-1 pl-1.5 text-caption-sm font-medium", badge.toneClass)} data-testid="row-ask" data-kind={line.kind}>
      {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
      {badge.word}
    </span>
  );
}

/**
 * A Needs you row's lines: the place and the kind of ask, then the title. No controls: a click on
 * the title opens the thread's popup (`anchor` names the hover card it shuts until the next
 * hover), a click elsewhere goes to the thread (the row's own click). Also the top bar's popover rows.
 */
export function NeedsLines({ id, anchor }: { id: string; anchor: string }) {
  return (
    <span className="flex min-w-0 flex-col" data-testid="thread-body" data-needs>
      <span className="flex h-4 min-w-0 items-center text-caption-sm" data-testid="row-line-1">
        <PlaceLabel id={id} />
        <AskKind id={id} />
      </span>
      <span
        className="flex min-w-0 cursor-pointer"
        data-testid="needs-title"
        onClick={(e) => {
          e.stopPropagation();
          openNeedsPopup(id, anchor);
        }}
      >
        <Title id={id} />
      </span>
    </span>
  );
}

interface RowProps<R> {
  row: R;
  selected: boolean;
  cursor: boolean;
  onActivate: (row: R) => void;
}

/**
 * A thread row of the main list or the Working footer. It drags into the pane grid (ShellDnd)
 * while the thread lives in the current space, and onto a space tab whatever its space. Live rows
 * keep the classic hover card; a Needs you row has the inbox's (components/needs/NeedsCard.tsx).
 */
export const ShellThreadRowView = memo(function ShellThreadRowView({ row, selected, cursor, onActivate }: RowProps<ShellThreadRow>) {
  const id = row.threadId;
  const needs = row.section === "needs";
  const anchor = `sidebar:${id}`;
  const cards = useContext(RowTooltipsEnabled);
  const keyCursor = useNeedsStore((s) => s.keyCursor);
  const elsewhere = useLayoutStore((s) => spaceOfThread(s, id) !== s.currentSpaceId);
  // A thread of another space drags too: only a space tab in the top bar takes it (ShellDnd).
  const { setNodeRef, listeners, describedBy, dragging } = useThreadDrag(id);
  const body = (
    <div
      ref={setNodeRef}
      {...listeners}
      id={`row-${row.key}`}
      role="option"
      aria-selected={selected}
      aria-describedby={describedBy}
      data-row-kind="thread"
      data-row-key={row.key}
      data-section={row.section}
      data-cursor={cursor || undefined}
      data-elsewhere={elsewhere || undefined}
      className={cn(rowClass(selected, cursor), dragging && "opacity-60")}
      onClick={() => {
        onActivate(row);
      }}
      onDoubleClick={() => {
        useUiStore.getState().setRenaming(id);
      }}
    >
      {needs ? <NeedsLines id={id} anchor={anchor} /> : <ThreadLines id={id} cursor={cursor} />}
    </div>
  );
  if (!needs) return <ThreadTooltip id={id}>{body}</ThreadTooltip>;
  // The Needs-you card: on hover anywhere on the row, or while the list's keyboard cursor is on it.
  return (
    <NeedsHoverCard threadId={id} anchor={anchor} keyboardOpen={cursor && keyCursor} enabled={cards}>
      {body}
    </NeedsHoverCard>
  );
});

/** The draft's project, when it starts in one. */
function useDraftProject(draftId: string): string {
  const projectId = useLayoutStore((s) => s.spaces[s.currentSpaceId]?.drafts.find((d) => d.id === draftId)?.params.project ?? "");
  return useProjectsStore((s) => (projectId ? (s.byId[projectId]?.name ?? "") : ""));
}

/**
 * A composer draft under Active, on a light amber tint: line 1 a pencil and "Draft" (and its
 * project), its Discard on hover; then its label as the title, regular weight, or "Untitled draft" muted while it has none.
 * A click focuses its tab or opens it in the focused pane (onActivate: composer.draft.open).
 */
export const DraftRowView = memo(function DraftRowView({ row, selected, cursor, onActivate }: RowProps<DraftRow>) {
  const project = useDraftProject(row.draftId);
  return (
    <div
      id={`row-${row.key}`}
      role="option"
      aria-selected={selected}
      data-row-kind="draft"
      data-row-key={row.key}
      data-draft-id={row.draftId}
      data-section="active"
      data-cursor={cursor || undefined}
      className={rowClass(selected, cursor, true)}
      onClick={() => {
        onActivate(row);
      }}
    >
      <span className="flex h-4 min-w-0 items-center gap-[3px] text-caption-sm text-cf-sidebar-muted-foreground" data-testid="row-line-1">
        <PencilLine className="size-3 shrink-0" aria-hidden data-testid="row-draft-mark" />
        <span className="truncate">
          Draft{project && <span> · {project}</span>}
        </span>
        <span className="relative ml-auto flex h-4 shrink-0 items-center">
          <button
            type="button"
            tabIndex={cursor ? 0 : -1}
            aria-label="Discard draft"
            className="pointer-events-none flex h-5 shrink-0 items-center gap-[3px] rounded-sm px-1 text-caption-sm font-medium text-cf-icon-muted opacity-0 outline-none group-hover/row:pointer-events-auto group-hover/row:opacity-100 hover:text-cf-error-text focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-cf-focus"
            data-testid="row-discard-draft"
            onClick={(e) => {
              e.stopPropagation();
              void discardDraft(row.draftId);
            }}
          >
            <X className="size-3 shrink-0" aria-hidden />
            Discard
          </button>
        </span>
      </span>
      <span className={cn("line-clamp-2 text-body break-words", row.label ? "text-inherit" : "text-cf-sidebar-muted-foreground italic")} data-testid="draft-label">
        {row.label || "Untitled draft"}
      </span>
    </div>
  );
});

const SCOPE_LOOK: Readonly<Record<NeedsScope, { icon: typeof Layers; label: string; next: NeedsScope; tip: string }>> = {
  all: { icon: Layers, label: "All spaces", next: "space", tip: "Show this space's only" },
  space: { icon: Square, label: "This space", next: "all", tip: "Show every space's" },
};

/**
 * The Needs you header's one scope button: it names the scope in force (every space, or this
 * one) and switches it (settings.set sidebar.needs_scope, a global setting). Small enough for
 * the header's line at the sidebar's narrowest width.
 */
export function NeedsScopeToggle() {
  const scope = useNeedsScope();
  const look = SCOPE_LOOK[scope];
  const Icon = look.icon;
  return (
    <Tip label={look.tip} side="bottom">
      <button
        type="button"
        className="flex h-5 shrink-0 items-center gap-1 rounded-full border border-cf-divider px-2 text-caption-sm whitespace-nowrap text-cf-sidebar-muted-foreground outline-none hover:bg-cf-sidebar-row-hover hover:text-cf-sidebar-foreground focus-visible:ring-1 focus-visible:ring-cf-focus"
        data-testid="needs-scope"
        data-scope={scope}
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => {
          void runCommandForResult("settings.set", { key: NEEDS_SCOPE_KEY, value: look.next }, { quiet: true });
        }}
      >
        <Icon className="size-3 shrink-0" aria-hidden />
        {look.label}
      </button>
    </Tip>
  );
}

/**
 * Needs you's and Active's header: a toggle with a chevron and the title; Needs you's count is
 * always there (the inbox's number), Active's only while collapsed. Needs you's has the scope
 * button at its end. A press does not take focus from the list.
 */
export function MainHeaderView({ row }: { row: MainHeaderRow }) {
  const Chevron = row.collapsed ? ChevronRight : ChevronDown;
  const showCount = row.section === "needs" ? row.count > 0 : row.collapsed;
  return (
    <div id={`row-${row.key}`} role="presentation" data-row-kind="header" data-row-key={row.key} data-section={row.section} className="flex h-full items-end gap-2 pr-0.5 select-none">
      <button
        type="button"
        aria-expanded={!row.collapsed}
        data-testid={`${row.section}-header`}
        className="flex h-[22px] min-w-0 cursor-default items-center gap-1 rounded-md px-1 text-cf-sidebar-muted-foreground outline-none hover:bg-cf-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-cf-focus"
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={row.section === "needs" ? toggleNeedsCollapsed : toggleActiveCollapsed}
      >
        <Chevron className="size-3 shrink-0" aria-hidden />
        <span className="truncate text-caption font-medium text-inherit" data-testid={`${row.section}-label`}>
          {row.label}
        </span>
        {showCount && (
          <>
            {" "}
            <span className="shrink-0 text-caption tabular-nums text-inherit opacity-70" data-testid={`${row.section}-count`}>
              {row.count}
            </span>
          </>
        )}
      </button>
      {row.section === "needs" && (
        <span className="ml-auto flex shrink-0 items-center pb-px">
          <NeedsScopeToggle />
        </span>
      )}
    </div>
  );
}
