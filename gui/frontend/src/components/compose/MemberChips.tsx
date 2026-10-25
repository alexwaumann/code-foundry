import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Layers, Plus, X } from "lucide-react";
import { ComposerPicker, type PickerGroup } from "./ComposerPicker";
import { NoGitBadge } from "@/components/projects/NoGitBadge";
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
  /**
   * The branch the thread works on there: the checkout's, or "cf/…" for new worktrees.
   * "" when there is none to show.
   */
  branch: string;
  /** A project without git: the No git badge instead of a branch. */
  noGit?: boolean;
  /** The chip has a × that takes the project out of the set. */
  removable: boolean;
}

const chipClass = "flex h-7 max-w-72 min-w-0 items-center rounded-full border text-body-sm transition-colors";

function MemberChip({ target, member, primary, disabled }: { target: ComposeTarget; member: MemberChipModel; primary: boolean; disabled: boolean }) {
  const name = useProjectsStore((s) => s.byId[member.projectId]?.name ?? member.projectId);
  return (
    <li
      className={cn(chipClass, primary ? "border-cf-accent/50 bg-cf-control-hover text-cf-text" : "border-cf-border bg-cf-surface-raised text-cf-text-muted")}
      data-testid="composer-member"
      data-project={member.projectId}
      data-primary={primary || undefined}
      aria-label={`${name}${member.noGit ? ", not a git repository" : member.branch ? ` on ${member.branch}` : ""}${primary ? ", the thread runs here" : ""}`}
    >
      <span className={cn("flex h-full min-w-0 items-center gap-1.5 pl-2.5", member.removable ? "pr-1" : "pr-2.5")}>
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", primary ? "bg-cf-accent" : "bg-cf-text-muted/40")} />
        <span className="truncate font-medium">{name}</span>
        {member.noGit ? (
          <NoGitBadge />
        ) : (
          member.branch && (
            <span className="truncate font-mono text-caption-sm" data-testid="composer-member-branch">
              {member.branch}
            </span>
          )
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
 * The projects a thread works in, above the composer card, sorted by project id: the
 * referenced workspace first, then one chip per project with its branch, the primary
 * (where the thread runs, its cwd) marked; the primary itself is picked in the Runs in
 * picker. A lone project shows only "Add project" (a set starts with a second one); in a
 * set every project has a × (the last one of a set without a workspace stays). Read-only
 * (`readOnly`): "New thread on this branch" shows what the daemon copies.
 */
export function MemberChips({
  target,
  members,
  primary,
  workspaceId,
  readOnly = false,
  disabled,
}: {
  target: ComposeTarget;
  members: readonly MemberChipModel[];
  primary: string;
  /** The referenced workspace; "" without one. */
  workspaceId: string;
  readOnly?: boolean;
  disabled: boolean;
}) {
  const single = !readOnly && !workspaceId && members.length <= 1;
  const ids = useMemo(() => members.map((m) => m.projectId), [members]);
  return (
    <ul className="mb-2 flex flex-wrap items-center gap-1.5 empty:hidden" aria-label="Projects" data-testid="composer-members">
      {workspaceId && <WorkspaceChip target={target} workspaceId={workspaceId} removable={!readOnly && members.length > 0} disabled={disabled} />}
      {!single && members.map((m) => <MemberChip key={m.projectId} target={target} member={m} primary={m.projectId === primary} disabled={disabled} />)}
      {!readOnly && <AddProject target={target} exclude={ids} disabled={disabled} />}
    </ul>
  );
}
