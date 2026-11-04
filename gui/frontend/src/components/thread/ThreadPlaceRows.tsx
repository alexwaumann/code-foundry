import type { ReactNode } from "react";
import { GitBranch, House, Layers, type LucideIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { ProjectKindIcon } from "@/components/icons/ProjectKindIcon";
import { FRESH_COPY, PROJECT_FOLDER } from "@/lib/compose";
import { projectKind, type ProjectKind } from "@/lib/projects";
import { WORKSPACE_FOLDER } from "@/lib/projectSet";
import { projectsLabel, threadRowModel, type ThreadPlace, type WorkspaceLookup } from "@/lib/threadRow";
import { useProjectsStore } from "@/stores/projects";
import { useWorkspacesStore } from "@/stores/workspaces";
import { Chip } from "./Chip";
import { useThreadPlaceInput } from "./useThreadPlace";

const NO_WORKSPACES: WorkspaceLookup = { byId: {} };

/**
 * One line of a thread hover card: an icon, the text, and on the right an optional muted
 * chip or a muted meta text (a count), never both.
 */
export function TipRow({ icon, chip, meta, children, testId }: { icon: ReactNode; chip?: string | null; meta?: string | null; children: ReactNode; testId: string }) {
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

/** The project row's muted meta: where the thread runs, in the composer's Work in words (lib/threadRow threadPlace). */
const placeWords: Readonly<Record<NonNullable<ThreadPlace>, string>> = { fresh: FRESH_COPY, folder: PROJECT_FOLDER };

/**
 * Where a thread works, as a hover card says it (the sidebar's and the Lineage rows'): the
 * workspace of a multi-project thread (its name with "N projects" as muted meta on the
 * right, else "N projects"), the project it runs in ("No project" with the House icon for a
 * thread without one; "Workspace folder" for its workspace's folder) with where it runs as
 * muted meta on the right (Fresh copy, Project folder; a "no git" chip instead), and the
 * branch (git only; with `freshBranchOnly`, only for a thread in a fresh copy).
 */
export function ThreadPlaceRows({ id, freshBranchOnly = false }: { id: string; freshBranchOnly?: boolean }) {
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
      {m.set !== null && (
        // A named workspace says how many projects it spans on the right; an unnamed set's label already is "N projects".
        <TipRow icon={<TipIcon icon={Layers} />} meta={wsName ? projectsLabel(where.projectCount ?? 0) : null} testId="tip-workspace">
          {m.set}
        </TipRow>
      )}
      <TipRow
        icon={m.noProject ? <TipIcon icon={House} /> : m.inFolder ? <TipIcon icon={Layers} /> : <ProjectKindIcon kind={m.kind} className={TIP_ICON} />}
        chip={m.noGit ? "no git" : null}
        meta={m.place === null ? null : placeWords[m.place]}
        testId="tip-project"
      >
        {m.inFolder ? WORKSPACE_FOLDER : m.project}
      </TipRow>
      {!m.noGit && !m.noProject && m.branch !== "" && (!freshBranchOnly || m.place === "fresh") && (
        <TipRow icon={<TipIcon icon={GitBranch} />} testId="tip-branch">
          <span className="font-mono">{m.branch}</span>
        </TipRow>
      )}
    </>
  );
}
