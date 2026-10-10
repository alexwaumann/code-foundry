import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Plus, X } from "lucide-react";
import { ComposerPicker, type PickerGroup } from "./ComposerPicker";
import { tildify } from "@/lib/path";
import { cn } from "@/lib/utils";
import { addAlsoIn, removeAlsoIn, setPrimary } from "@/stores/compose";
import { useReposStore } from "@/stores/repos";

/** One project the thread works in, as the chip row shows it. */
export interface MemberChipModel {
  repoId: string;
  /** The branch the thread works on there: the member worktree's, or "cf/…" for new worktrees. */
  branch: string;
  /** An "Also in" project (removable); the project itself and workspace members are not. */
  removable: boolean;
}

function MemberChip({ draftKey, member, primary, disabled }: { draftKey: string; member: MemberChipModel; primary: boolean; disabled: boolean }) {
  const name = useReposStore((s) => s.byId[member.repoId]?.name ?? member.repoId);
  return (
    <li
      className={cn(
        "flex h-7 max-w-72 min-w-0 items-center rounded-full border text-xs transition-colors",
        primary ? "border-primary/50 bg-accent text-foreground" : "border-border bg-card text-muted-foreground",
      )}
      data-testid="composer-member"
      data-repo={member.repoId}
      data-primary={primary || undefined}
    >
      <button
        type="button"
        disabled={disabled}
        aria-pressed={primary}
        aria-label={`${name} on ${member.branch}${primary ? ", primary: the thread runs here" : ""}`}
        title={primary ? "The thread runs here" : `Run the thread in ${name}`}
        data-compose-stop
        className={cn(
          "flex h-full min-w-0 items-center gap-1.5 rounded-full pr-2.5 pl-2.5 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60",
          member.removable && "pr-1",
        )}
        onClick={() => {
          setPrimary(draftKey, member.repoId);
        }}
      >
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", primary ? "bg-primary" : "bg-muted-foreground/40")} />
        <span className="truncate font-medium">{name}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{member.branch}</span>
        {primary && (
          <span className="shrink-0 rounded-sm bg-primary/10 px-1 text-[10px] font-medium text-primary" data-testid="composer-member-primary">
            primary
          </span>
        )}
      </button>
      {member.removable && (
        <button
          type="button"
          disabled={disabled}
          aria-label={`Remove ${name}`}
          title={`Remove ${name}`}
          data-compose-stop
          className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:hidden"
          onClick={() => {
            removeAlsoIn(draftKey, member.repoId);
          }}
        >
          <X className="size-3" />
        </button>
      )}
    </li>
  );
}

const SEP = "\u0001";

/** "Also in": registered projects the thread does not work in yet. */
function AddProject({ draftKey, exclude, first, disabled }: { draftKey: string; exclude: readonly string[]; first: boolean; disabled: boolean }) {
  const keys = useReposStore(
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
        label="Also in"
        icon={Plus}
        text={first ? "Also in…" : "Add project"}
        value=""
        groups={groups}
        onChange={(id) => {
          addAlsoIn(draftKey, id);
        }}
        filterPlaceholder="Filter projects…"
        disabled={disabled}
        contentClassName="w-72"
        data-testid="composer-also-in"
      />
    </li>
  );
}

/**
 * The projects a thread works in, above the composer card: one chip per member with its
 * branch, the primary (where the thread runs, its cwd) marked; a click on another chip
 * makes it primary. A project shows only "Also in…" until another project is added;
 * added projects can be removed again. A workspace's members are fixed here (members
 * are edited on the workspace, not per thread).
 */
export function MemberChips({
  draftKey,
  members,
  primary,
  canAdd,
  disabled,
}: {
  draftKey: string;
  members: readonly MemberChipModel[];
  primary: string;
  /** Offer "Also in" (projects only). */
  canAdd: boolean;
  disabled: boolean;
}) {
  const single = canAdd && members.length <= 1;
  const ids = useMemo(() => members.map((m) => m.repoId), [members]);
  return (
    <ul className="mb-2 flex flex-wrap items-center gap-1.5 empty:hidden" aria-label="Projects" data-testid="composer-members">
      {!single && members.map((m) => <MemberChip key={m.repoId} draftKey={draftKey} member={m} primary={m.repoId === primary} disabled={disabled} />)}
      {canAdd && <AddProject draftKey={draftKey} exclude={ids} first={single} disabled={disabled} />}
    </ul>
  );
}
