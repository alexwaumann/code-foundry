import { useMemo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Layers, Plus, TriangleAlert, X } from "lucide-react";
import { ComposerPicker, type PickerGroup } from "./ComposerPicker";
import { byName } from "./useProjectRows";
import { Tip } from "@/components/ui/tooltip";
import type { ComposeTarget } from "@/lib/compose";
import { tildify } from "@/lib/path";
import { cn } from "@/lib/utils";
import { clearDraftSet, removeDraftWorkspace, toggleDraftProject } from "@/stores/compose";
import { useProjectsStore } from "@/stores/projects";
import { useWorkspacesStore } from "@/stores/workspaces";

/** One project the thread works in, as the chip row shows it. */
export interface MemberChipModel {
  projectId: string;
  /** The chip has a × that takes the project out of the set. */
  removable: boolean;
}

const chipClass = "flex h-7 max-w-72 min-w-0 items-center rounded-full border text-body-sm transition-colors";
const removeClass =
  "mr-1 flex size-5 shrink-0 items-center justify-center rounded-full text-cf-text-muted outline-none hover:bg-cf-canvas hover:text-cf-text focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 disabled:hidden";

/**
 * A project's name, nothing else: where the thread runs is the Run in picker's, its
 * branch the Work in picker's (it depends on the setting and the pick, so it is not
 * repeated here), and its path the Projects page's. A `warning` (another running thread
 * has the checkout this project would work in): an amber border and icon, the warning as
 * the icon's tooltip. The × has no tooltip: a chip's × is a known gesture (its accessible
 * name says what it removes).
 */
function MemberChip({ target, member, warning, disabled, focusPrompt }: { target: ComposeTarget; member: MemberChipModel; warning?: ReactNode; disabled: boolean; focusPrompt: () => void }) {
  const name = useProjectsStore((s) => s.byId[member.projectId]?.name ?? member.projectId);
  return (
    <li
      className={cn(chipClass, "bg-cf-surface-raised text-cf-text", warning ? "border-cf-warning/40" : "border-cf-border")}
      data-testid="composer-member"
      data-project={member.projectId}
      data-warning={warning ? "" : undefined}
    >
      <span className={cn("flex h-full min-w-0 items-center gap-1.5 pl-2.5", member.removable ? "pr-1" : "pr-2.5")} data-testid="composer-member-body">
        <span className="truncate font-medium">{name}</span>
        {warning && (
          <Tip label={warning} data-testid="composer-member-warning-tip">
            <span className="flex shrink-0" data-testid="composer-member-warning">
              <TriangleAlert className="size-3.5 text-cf-warning-text" aria-hidden />
            </span>
          </Tip>
        )}
      </span>
      {member.removable && (
        <button
          type="button"
          disabled={disabled}
          aria-label={`Remove ${name}`}
          data-compose-stop
          data-testid="composer-member-remove"
          className={removeClass}
          onClick={() => {
            void toggleDraftProject(target, member.projectId).then(focusPrompt);
          }}
        >
          <X className="size-3" />
        </button>
      )}
    </li>
  );
}

/**
 * The workspace the thread references (its instructions and skills), before the project
 * chips; its × takes the workspace and the members it brought out of the set (projects
 * added on top stay).
 */
function WorkspaceChip({ target, workspaceId, removable, disabled, focusPrompt }: { target: ComposeTarget; workspaceId: string; removable: boolean; disabled: boolean; focusPrompt: () => void }) {
  const name = useWorkspacesStore((s) => s.byId[workspaceId]?.name ?? workspaceId);
  return (
    <li className={cn(chipClass, "border-cf-highlight/40 bg-cf-highlight-surface text-cf-highlight-text")} data-testid="composer-workspace" data-workspace={workspaceId}>
      <span className={cn("flex h-full min-w-0 items-center gap-1.5 pl-2.5", removable ? "pr-1" : "pr-2.5")}>
        <Layers className="size-3 shrink-0" aria-hidden />
        <span className="truncate font-medium">{name}</span>
      </span>
      {removable && (
        <button
          type="button"
          disabled={disabled}
          aria-label={`Remove workspace ${name}`}
          data-compose-stop
          data-testid="composer-workspace-remove"
          className={cn(removeClass, "text-current hover:text-current")}
          onClick={() => {
            void removeDraftWorkspace(target).then(focusPrompt);
          }}
        >
          <X className="size-3" />
        </button>
      )}
    </li>
  );
}

const SEP = "\u0001";

/**
 * "Add project": every registered project by name (plain folders too), the thread's
 * checked; a row toggles its project in or out of the set and the list stays open for the
 * next, until Esc or a click away. First in the row, so it never moves as chips come and go.
 */
function AddProject({ target, selected, disabled, focusPrompt }: { target: ComposeTarget; selected: readonly string[]; disabled: boolean; focusPrompt: () => void }) {
  const keys = useProjectsStore(
    useShallow((s) =>
      s.order
        .flatMap((id) => {
          const r = s.byId[id];
          return r ? [[r.name, id, r.path].join(SEP)] : [];
        })
        .sort(byName),
    ),
  );
  const groups = useMemo<PickerGroup[]>(
    () => [
      {
        options: keys.map((k) => {
          const [label = "", value = "", path = ""] = k.split(SEP);
          return { value, label, detail: tildify(path) };
        }),
      },
    ],
    [keys],
  );
  if (keys.length === 0) return null;
  return (
    <li className="flex">
      <ComposerPicker
        label="Add project"
        icon={Plus}
        text="Add project"
        value=""
        multi
        selected={selected}
        groups={groups}
        onChange={(id) => {
          void toggleDraftProject(target, id);
        }}
        filterPlaceholder="Filter projects…"
        focusAfter={focusPrompt}
        disabled={disabled}
        contentClassName="w-72"
        data-testid="composer-add-project"
      />
    </li>
  );
}

/**
 * The projects a thread works in, above the composer card: "Add project" first, then the
 * referenced workspace, then one chip per project by name (the caller's order), and
 * "Clear" last when there is more than one chip to clear. Where the thread runs (the
 * primary) is the Run in picker's to show and pick. A lone project shows only "Add
 * project" (a set starts with a second one); in a set every project has a ×, the last one
 * too (the composer's empty state follows). Read-only (`readOnly`): "New thread on this
 * branch" shows what the daemon copies. Every button hands focus to the prompt afterwards.
 */
export function MemberChips({
  target,
  members,
  workspaceId,
  readOnly = false,
  warnings,
  disabled,
  focusPrompt,
}: {
  target: ComposeTarget;
  members: readonly MemberChipModel[];
  /** The referenced workspace; "" without one. */
  workspaceId: string;
  readOnly?: boolean;
  /** By project id: the tooltip of a project another running thread has the checkout of (CollisionTip). */
  warnings?: Readonly<Record<string, ReactNode>>;
  disabled: boolean;
  /** Focuses the composer's prompt (after a pick, a ×, a dismissal). */
  focusPrompt: () => void;
}) {
  const single = !readOnly && !workspaceId && members.length <= 1;
  const ids = useMemo(() => members.map((m) => m.projectId), [members]);
  const chips = (workspaceId ? 1 : 0) + (single ? 0 : members.length);
  return (
    <ul className="mb-2 flex flex-wrap items-center gap-1.5 empty:hidden" aria-label="Projects" data-testid="composer-members">
      {!readOnly && <AddProject target={target} selected={ids} disabled={disabled} focusPrompt={focusPrompt} />}
      {workspaceId && <WorkspaceChip target={target} workspaceId={workspaceId} removable={!readOnly} disabled={disabled} focusPrompt={focusPrompt} />}
      {!single && members.map((m) => <MemberChip key={m.projectId} target={target} member={m} warning={warnings?.[m.projectId]} disabled={disabled} focusPrompt={focusPrompt} />)}
      {!readOnly && chips > 1 && (
        <li className="flex">
          <button
            type="button"
            disabled={disabled}
            data-compose-stop
            data-testid="composer-clear"
            className="flex h-7 items-center gap-1 rounded-full px-2 text-body-sm text-cf-text-muted outline-none hover:text-cf-text focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 disabled:hidden"
            onClick={() => {
              void clearDraftSet(target).then(focusPrompt);
            }}
          >
            <X className="size-3" aria-hidden />
            Clear
          </button>
        </li>
      )}
    </ul>
  );
}
