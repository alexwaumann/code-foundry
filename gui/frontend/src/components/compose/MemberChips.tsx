import { useMemo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Layers, Plus, TriangleAlert, X } from "lucide-react";
import { ComposerPicker, type PickerGroup } from "./ComposerPicker";
import { Tip } from "@/components/ui/tooltip";
import type { ComposeTarget } from "@/lib/compose";
import { tildify } from "@/lib/path";
import { cn } from "@/lib/utils";
import { pickDraftWorkspace, toggleDraftProject } from "@/stores/compose";
import { useProjectsStore } from "@/stores/projects";
import { useWorkspacesStore } from "@/stores/workspaces";

/** One project the thread works in, as the chip row shows it. */
export interface MemberChipModel {
  projectId: string;
  /** The chip has a × that takes the project out of the set. */
  removable: boolean;
}

const chipClass = "flex h-7 max-w-72 min-w-0 items-center rounded-full border text-body-sm transition-colors";

/**
 * A project's name, nothing else: where the thread runs is the Runs in picker's, its
 * branch the Work in picker's (it depends on the setting and the pick, so it is not
 * repeated here), and its path the Projects page's. A `warning` (another running thread
 * has the checkout this project would work in): an amber border and icon, the warning as
 * the icon's tooltip.
 */
function MemberChip({ target, member, warning, disabled }: { target: ComposeTarget; member: MemberChipModel; warning?: ReactNode; disabled: boolean }) {
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
        <Tip label={`Remove ${name}`}>
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove ${name}`}
            data-compose-stop
            data-testid="composer-member-remove"
            className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-full text-cf-text-muted outline-none hover:bg-cf-canvas hover:text-cf-text focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 disabled:hidden"
            onClick={() => {
              void toggleDraftProject(target, member.projectId);
            }}
          >
            <X className="size-3" />
          </button>
        </Tip>
      )}
    </li>
  );
}

/**
 * The workspace the thread references (its instructions and skills), before the project
 * chips; its × drops the reference and keeps the projects.
 */
function WorkspaceChip({ target, workspaceId, removable, disabled }: { target: ComposeTarget; workspaceId: string; removable: boolean; disabled: boolean }) {
  const name = useWorkspacesStore((s) => s.byId[workspaceId]?.name ?? workspaceId);
  return (
    <li className={cn(chipClass, "border-cf-highlight/40 bg-cf-highlight-surface text-cf-highlight-text")} data-testid="composer-workspace" data-workspace={workspaceId}>
      <span className={cn("flex h-full min-w-0 items-center gap-1.5 pl-2.5", removable ? "pr-1" : "pr-2.5")}>
        <Layers className="size-3 shrink-0" aria-hidden />
        <span className="truncate font-medium">{name}</span>
      </span>
      {removable && (
        <Tip label={`Not in ${name}: keep the projects only`}>
          <button
            type="button"
            disabled={disabled}
            aria-label={`Drop workspace ${name}`}
            data-compose-stop
            data-testid="composer-workspace-remove"
            className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-full outline-none hover:bg-cf-canvas focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 disabled:hidden"
            onClick={() => {
              void pickDraftWorkspace(target, workspaceId);
            }}
          >
            <X className="size-3" />
          </button>
        </Tip>
      )}
    </li>
  );
}

const SEP = "\u0001";

/** "Add project": registered projects the thread does not work in yet (plain folders too). */
function AddProject({ target, exclude, disabled }: { target: ComposeTarget; exclude: readonly string[]; disabled: boolean }) {
  const keys = useProjectsStore(
    useShallow((s) =>
      s.order.flatMap((id) => {
        const r = s.byId[id];
        return r && !exclude.includes(id) ? [[id, r.name, r.path].join(SEP)] : [];
      }),
    ),
  );
  const groups = useMemo<PickerGroup[]>(
    () => [
      {
        options: keys.map((k) => {
          const [value = "", label = "", path = ""] = k.split(SEP);
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
        groups={groups}
        onChange={(id) => {
          void toggleDraftProject(target, id);
        }}
        filterPlaceholder="Filter projects…"
        disabled={disabled}
        contentClassName="w-72"
        data-testid="composer-add-project"
      />
    </li>
  );
}

/**
 * The projects a thread works in, above the composer card, by name (the caller's order): the
 * referenced workspace first, then one chip per project. Where the thread runs (the primary)
 * is the Runs in picker's to show and pick. A lone project shows only "Add project" (a set
 * starts with a second one); in a set every project has a × (the last one of a set without
 * a workspace stays). Read-only (`readOnly`): "New thread on this branch" shows what the
 * daemon copies.
 */
export function MemberChips({
  target,
  members,
  workspaceId,
  readOnly = false,
  warnings,
  disabled,
}: {
  target: ComposeTarget;
  members: readonly MemberChipModel[];
  /** The referenced workspace; "" without one. */
  workspaceId: string;
  readOnly?: boolean;
  /** By project id: the tooltip of a project another running thread has the checkout of (CollisionTip). */
  warnings?: Readonly<Record<string, ReactNode>>;
  disabled: boolean;
}) {
  const single = !readOnly && !workspaceId && members.length <= 1;
  const ids = useMemo(() => members.map((m) => m.projectId), [members]);
  return (
    <ul className="mb-2 flex flex-wrap items-center gap-1.5 empty:hidden" aria-label="Projects" data-testid="composer-members">
      {workspaceId && <WorkspaceChip target={target} workspaceId={workspaceId} removable={!readOnly && members.length > 0} disabled={disabled} />}
      {!single && members.map((m) => <MemberChip key={m.projectId} target={target} member={m} warning={warnings?.[m.projectId]} disabled={disabled} />)}
      {!readOnly && <AddProject target={target} exclude={ids} disabled={disabled} />}
    </ul>
  );
}
