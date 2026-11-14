import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, ChevronLeft, CornerDownLeft, Layers } from "lucide-react";
import { CollisionTip } from "@/components/compose/CollisionBanner";
import { ComposerPicker } from "@/components/compose/ComposerPicker";
import { placementCheckouts, usePlacement, usePlacementPickers, usePrimaryPicker } from "@/components/compose/placement";
import { ProjectBadge } from "@/components/compose/ProjectRows";
import { useCollisions } from "@/components/compose/useCollisions";
import { byName, useProjectRows } from "@/components/compose/useProjectRows";
import { NoGitBadge } from "@/components/projects/NoGitBadge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { HintProject } from "@/lib/collisionHints";
import type { WorktreeChoice } from "@/lib/compose";
import { moveArgs, moveLine, type MoveTarget } from "@/lib/move";
import { tildify } from "@/lib/path";
import { resolveSet, type ResolvedSet } from "@/lib/projectSet";
import { cn } from "@/lib/utils";
import { closeMovePicker, focusDropped, focusMovedThreadPrompt, holdMovePicker, moveThread, useMovePickerStore } from "@/stores/movePicker";
import { useProjectsStore } from "@/stores/projects";
import { useWorkspacesStore } from "@/stores/workspaces";

/** Step 1's filter placeholder, and the line under its list. */
export const MOVE_FILTER = "Move to a project or workspace…";
export const MOVE_FOOTER = "Claude keeps the conversation and carries on there.";
/** Step 2's footer, beside Move. */
export const MOVE_NOTE = "The thread is renamed and Claude carries on there.";

/**
 * A workspace's row: layers, its name, and "N projects" on the right. A search matches its
 * name only: the row does not show its members, and a project's name typed in full must
 * land on the project, not on a workspace listed above it.
 */
function WorkspaceItem({ id, onPick }: { id: string; onPick: (t: MoveTarget) => void }) {
  const name = useWorkspacesStore((s) => s.byId[id]?.name ?? id);
  const n = useWorkspacesStore((s) => s.byId[id]?.members.length ?? 0);
  return (
    <CommandItem
      value={`ws:${id}`}
      keywords={[name]}
      onSelect={() => {
        onPick({ kind: "workspace", workspaceId: id });
      }}
      data-workspace={id}
      className="gap-2.5"
    >
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center text-cf-text-muted">
        <Layers className="size-3.5" />
      </span>
      <span className="truncate font-medium">{name}</span>
      <span className="ml-auto shrink-0 pl-3 text-caption text-cf-text-muted">{n === 1 ? "1 project" : `${String(n)} projects`}</span>
    </CommandItem>
  );
}

/** A project's row: its badge (as in cmd+N's picker), its name, and "No git" on the right for a plain folder. */
function ProjectItem({ id, onPick }: { id: string; onPick: (t: MoveTarget) => void }) {
  const name = useProjectsStore((s) => s.byId[id]?.name ?? id);
  const path = useProjectsStore((s) => s.byId[id]?.path ?? "");
  const noGit = useProjectsStore((s) => s.byId[id]?.git === false);
  return (
    <CommandItem
      value={id}
      keywords={[name, path]}
      onSelect={() => {
        onPick({ kind: "project", projectId: id });
      }}
      data-project={id}
      className="gap-2.5"
    >
      <ProjectBadge name={name} className="size-5 rounded-sm" />
      <span className="truncate font-medium">{name}</span>
      {noGit && <span className="ml-auto shrink-0 pl-3 text-caption text-cf-text-muted">No git</span>}
    </CommandItem>
  );
}

/** Step 1: where to: a filter, the workspaces, then the projects (cmd+N's order). ↑↓ and Enter pick. */
function TargetList({ onPick }: { onPick: (t: MoveTarget) => void }) {
  const { workspaces, projects } = useProjectRows();
  const inputRef = useRef<HTMLInputElement>(null);
  // On opening and back from step 2: the filter has the keyboard.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <Command loop label="Move to" className="rounded-lg" data-testid="move-targets">
      <CommandInput ref={inputRef} placeholder={MOVE_FILTER} data-testid="move-filter" />
      <CommandList className="max-h-80 p-1">
        <CommandEmpty>No project or workspace matches.</CommandEmpty>
        {workspaces.length > 0 && (
          <CommandGroup heading="Workspaces">
            {workspaces.map((id) => (
              <WorkspaceItem key={id} id={id} onPick={onPick} />
            ))}
          </CommandGroup>
        )}
        {projects.length > 0 && (
          <CommandGroup heading="Projects">
            {projects.map((id) => (
              <ProjectItem key={id} id={id} onPick={onPick} />
            ))}
          </CommandGroup>
        )}
      </CommandList>
      <p className="border-t border-cf-border px-3 py-2 text-caption text-cf-text-muted" data-testid="move-footer">
        {MOVE_FOOTER}
      </p>
    </Command>
  );
}

/** The set a target stands for (lib/projectSet resolveSet), the primary the user picked over the workspace's default. */
function useTargetSet(target: MoveTarget, primaryChoice: string | null): { set: ResolvedSet; name: string; detail: string } {
  const wsId = target.kind === "workspace" ? target.workspaceId : "";
  const wsKey = useWorkspacesStore(
    useShallow((s) => {
      const w = s.byId[wsId];
      return w ? [w.name, w.defaultPrimary ?? "", ...w.members.map((m) => m.projectId)] : [];
    }),
  );
  const known = useProjectsStore(useShallow((s) => s.order));
  const projectId = target.kind === "project" ? target.projectId : "";
  const projectName = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const projectPath = useProjectsStore((s) => s.byId[projectId]?.path ?? "");
  const [wsName = "", , ...members] = wsKey;
  const memberNames = useProjectsStore(useShallow((s) => members.map((m) => s.byId[m]?.name ?? m).sort(byName)));
  const set = useMemo(() => {
    const [, dp = "", ...ms] = wsKey;
    const defaults = target.kind === "project" ? { projects: [target.projectId], workspace: "" } : { projects: ms, workspace: wsId };
    return resolveSet({ projects: null, workspace: null, primary: primaryChoice }, defaults, {
      known: (id) => known.includes(id),
      workspace: (id) => (id === wsId && wsKey.length > 0 ? { members: ms, defaultPrimary: dp } : undefined),
    });
  }, [target, primaryChoice, known, wsId, wsKey]);
  return target.kind === "project"
    ? { set, name: projectName, detail: tildify(projectPath) }
    : { set, name: wsName || wsId, detail: memberNames.join(", ") };
}

/**
 * Step 2: how it works there: the composer's own Work in, Branch from and Run in pickers
 * (components/compose/placement.ts) over the target's set, with the settings' defaults, a
 * line saying what the choice does, and Move. Enter moves (unless a pill has the
 * keyboard); Backspace or ← goes back to the list.
 */
function PlacementStep({ threadId, target, onBack }: { threadId: string; target: MoveTarget; onBack: () => void }) {
  const [choice, setChoice] = useState<WorktreeChoice | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [primaryChoice, setPrimaryChoice] = useState<string | null>(null);
  const [workInOpen, setWorkInOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { set, name, detail } = useTargetSet(target, primaryChoice);
  const placement = usePlacement(set, choice);
  const pickers = usePlacementPickers(placement, { base: base ?? "", workInOpen });
  const primary = usePrimaryPicker(set, target.kind === "workspace" ? name : "", set.primary);
  const mainPath = placement.noGitPath ?? placement.worktrees.find((w) => w.isMain)?.path;
  const mine = useMemo(() => (projects: Readonly<Record<string, HintProject>>) => placementCheckouts(placement, set.projectIds, set.primary, projects), [placement, set.projectIds, set.primary]);
  const found = useCollisions(mine);
  const collisionTip = useMemo(() => (found.length > 0 ? <CollisionTip list={found} /> : null), [found]);
  const focusRoot = () => rootRef.current?.focus();
  useEffect(() => {
    focusRoot();
  }, []);
  const move = () => {
    const args = moveArgs(threadId, target, { worktree: placement.worktree, base: pickers.base.show ? (base ?? "") : "", primary: set.primary, mainPath });
    void moveThread(threadId, args, name);
  };
  const noGit = placement.noGitPath !== undefined;
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex flex-col outline-none"
      data-testid="move-placement"
      data-target={target.kind === "project" ? target.projectId : target.workspaceId}
      onKeyDown={(e) => {
        // Keys from an inner picker's list (portalled, but bubbling here through React) and from a pill are theirs.
        if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "Enter") {
          e.preventDefault();
          move();
        } else if (e.key === "Backspace" || e.key === "ArrowLeft") {
          e.preventDefault();
          onBack();
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-cf-border px-2 py-1.5" data-testid="move-header">
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Back" className="text-cf-text-muted" onClick={onBack} data-testid="move-back">
          <ChevronLeft />
        </Button>
        {target.kind === "project" ? (
          <ProjectBadge name={name} className="size-5 rounded-sm" />
        ) : (
          <span aria-hidden className="flex size-5 shrink-0 items-center justify-center text-cf-text-muted">
            <Layers className="size-3.5" />
          </span>
        )}
        <span className="max-w-56 shrink-0 truncate text-label font-medium" data-testid="move-name">
          {name}
        </span>
        <span className="ml-auto min-w-0 shrink truncate pl-3 text-caption text-cf-text-muted" data-testid="move-detail">
          {detail}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-0.5 px-1.5 pt-2" data-testid="move-pills">
        {noGit ? (
          <NoGitBadge className="mx-1 h-6 rounded-md px-1.5 text-caption" />
        ) : (
          <ComposerPicker
            label="Work in"
            icon={pickers.workIn.icon}
            text={pickers.workIn.text}
            value={pickers.workIn.value}
            groups={pickers.workIn.groups}
            onChange={(v) => {
              setChoice(pickers.workIn.choiceOf(v));
            }}
            filterPlaceholder={pickers.workIn.hasBranchSearch ? "Find existing branch" : undefined}
            onOpen={pickers.workIn.hasBranchSearch ? pickers.loadLists : undefined}
            onOpenChange={setWorkInOpen}
            contentClassName="w-90"
            listClassName="max-h-96"
            warning={collisionTip}
            focusAfter={focusRoot}
            data-testid="move-worktree"
          />
        )}
        {pickers.base.show && (
          <ComposerPicker
            label="Branch from"
            icon={pickers.base.icon}
            text={pickers.base.text}
            value={pickers.base.value}
            groups={pickers.base.groups}
            onChange={(v) => {
              setBase(pickers.base.baseOf(v));
            }}
            filterPlaceholder="Filter branches…"
            onOpen={pickers.loadLists}
            footer={pickers.base.footer}
            focusAfter={focusRoot}
            contentClassName="w-72"
            data-testid="move-base"
          />
        )}
        {target.kind === "workspace" && primary.show && (
          <ComposerPicker
            label="Run in"
            icon={primary.icon}
            text={primary.text}
            value={primary.value}
            groups={primary.groups}
            onChange={setPrimaryChoice}
            focusAfter={focusRoot}
            className="ml-auto"
            contentClassName="w-64"
            data-testid="move-primary"
          />
        )}
      </div>
      <p className="px-3 pt-1.5 pb-2.5 text-caption text-pretty text-cf-text-muted" data-testid="move-line">
        {moveLine({ worktree: placement.worktree, set: placement.isSet, many: placement.many, noGit, mainPath })}
      </p>
      <div className="flex items-center gap-3 border-t border-cf-border py-2 pr-2 pl-3">
        <span className="min-w-0 text-caption text-cf-text-muted" data-testid="move-note">{MOVE_NOTE}</span>
        <Button type="button" size="sm" className="ml-auto h-7 bg-cf-accent px-2.5 text-cf-accent-foreground hover:bg-cf-accent/90" onClick={move} data-testid="move-submit">
          Move
          <CornerDownLeft className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/**
 * The header crumb's place for a No project thread as the move picker's trigger: a
 * chevron after "No project", pressed while open. The popover lists the workspaces and
 * projects (step 1); a pick shows where it works there (step 2), and Move invokes
 * thread.move (stores/movePicker.ts). Esc closes.
 */
export function MovePicker({ threadId, children }: { threadId: string; children: ReactNode }) {
  const open = useMovePickerStore((s) => s.open === threadId);
  // Leaving the thread (its header unmounts) closes it, so coming back does not reopen it.
  // A header that mounts again at once (its tab drawn as it opens, React's effect replay)
  // is not leaving: the picker a menu asked for while the thread's tab opened stays open.
  // The thread moving (from here or the CLI) unmounts the trigger with the popover: when
  // the keyboard was in either, it falls to the body, so the thread's prompt takes it. Only
  // then: a header remounting while the keyboard is nowhere of its own (the menu that asked
  // for the picker just went) must not leave a request the prompt serves once the picker
  // has the keyboard, which would close it.
  const hadKeyboard = useRef(false);
  const onFocus = () => {
    hadKeyboard.current = true;
  };
  const onBlur = () => {
    hadKeyboard.current = false;
  };
  useEffect(() => {
    const done = holdMovePicker(threadId);
    return () => {
      done();
      if (hadKeyboard.current && focusDropped()) focusMovedThreadPrompt(threadId);
    };
  }, [threadId]);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) useMovePickerStore.setState({ open: threadId });
        else closeMovePicker(threadId);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 outline-none [--wails-draggable:no-drag] hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus aria-expanded:bg-cf-control-hover aria-expanded:text-cf-text"
          data-testid="thread-crumb-move"
          onFocus={onFocus}
          onBlur={onBlur}
        >
          {children}
          <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto p-0"
        onOpenAutoFocus={(e) => {
          // The step's own focus (the filter) takes the keyboard, not the popover.
          e.preventDefault();
        }}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        <MoveSteps threadId={threadId} />
      </PopoverContent>
    </Popover>
  );
}

/** The popover's body, mounted with each opening (the content unmounts on close): it starts on the list. */
function MoveSteps({ threadId }: { threadId: string }) {
  const [target, setTarget] = useState<MoveTarget | null>(null);
  return (
    <div className={cn("flex flex-col", target ? "w-110" : "w-85")} data-testid="move-picker" data-step={target ? "2" : "1"}>
      {target ? (
        <PlacementStep
          key={target.kind === "project" ? target.projectId : target.workspaceId}
          threadId={threadId}
          target={target}
          onBack={() => {
            setTarget(null);
          }}
        />
      ) : (
        <TargetList onPick={setTarget} />
      )}
    </div>
  );
}
