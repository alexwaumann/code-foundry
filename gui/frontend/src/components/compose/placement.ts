/**
 * Where a thread works in a set of projects: the new-thread composer's Work in, Branch
 * from and Run in pickers, as hooks over a resolved set (lib/projectSet) and the user's
 * pick. The composer (Composer.tsx) and the move picker (components/thread/MovePicker.tsx)
 * render ComposerPicker with what these return, so both offer the same groups, defaults
 * (threads.default_worktree) and collision checks.
 */
import { useCallback, useMemo, type ComponentType, type SVGProps } from "react";
import { useShallow } from "zustand/react/shallow";
import { FolderGit2, GitBranch, GitBranchPlus, GitCommitHorizontal, Layers, MapPin, type LucideIcon } from "lucide-react";
import { PROJECT_KIND_ICONS, useProjectKind } from "@/components/icons/projectKind";
import { draftCheckouts, type Checkout, type HintProject } from "@/lib/collisionHints";
import {
  BASE_FROM_ORIGIN_KEY,
  baseRuleText,
  baseText,
  commonBranches,
  defaultBranchLabel,
  defaultWorktree,
  FRESH_COPIES,
  FRESH_COPY,
  mergedBranches,
  PROJECT_FOLDER,
  PROJECT_FOLDERS,
  setWorkIn,
  WORK_IN_SETTING_KEY,
  workInText,
  type WorktreeChoice,
} from "@/lib/compose";
import { primaryOptions, WORKSPACE_FOLDER, WORKSPACE_PRIMARY, type ResolvedSet } from "@/lib/projectSet";
import { projectKind, type ProjectKind } from "@/lib/projects";
import { loadBranches, noGitCheckout, useComposeStore } from "@/stores/compose";
import { usePlacementRefusals } from "@/stores/placementChecks";
import { useProjectsStore } from "@/stores/projects";
import { useSettingValue } from "@/stores/settings";
import type { PickerGroup } from "./ComposerPicker";

const SEP = "\u0001";

interface WorktreeOption {
  path: string;
  /** "" when detached. */
  branch: string;
  head: string;
  detached: boolean;
  isMain: boolean;
}

/** The project's worktrees (main first), as a shallow-stable list that follows branch changes live. */
function useWorktrees(projectId: string): WorktreeOption[] {
  const keys = useProjectsStore(
    useShallow((s) => (s.byId[projectId]?.worktrees ?? []).map((w) => [w.path, w.branch, w.head, w.detached ? "1" : "", w.isMain ? "1" : ""].join(SEP))),
  );
  return useMemo(
    () =>
      keys.map((k) => {
        const [path = "", branch = "", head = "", detached = "", main = ""] = k.split(SEP);
        return { path, branch, head, detached: detached === "1", isMain: main === "1" };
      }),
    [keys],
  );
}

/**
 * A Work in row's value for an existing branch: a prefix no branch name, path or "new" /
 * "current" starts with, and that a search never types.
 */
const BRANCH_VALUE = "⎇ ";
/** Branch from's first row (the default branches; the draft keeps null). */
const DEFAULT_BASE_VALUE = "⎇default";

/**
 * Work in: where a project's thread runs. The option titles are the pill's words
 * (lib/compose FRESH_COPY…); the copy is docs/notes/onboarding-3-work-in.md's.
 */
const FRESH_COPY_DETAIL = "Edits land in a new branch with its own worktree. Multiple threads at a time is safe.";
/**
 * A set's Work in choices: one new branch with a worktree in every repository, or every
 * project's own folder. Singular for a set of one project (a workspace with one member).
 */
const FRESH_COPIES_DETAIL = "Edits land in a new branch with a worktree for every project. Multiple threads at a time is safe.";
const FRESH_COPY_OF_ONE_DETAIL = "Edits land in a new branch with a worktree for the project. Multiple threads at a time is safe.";
const PROJECT_FOLDERS_DETAIL = "Edits land in every project's checkout directly. One thread at a time is safest.";
const PROJECT_FOLDER_OF_ONE_DETAIL = "Edits land in the project's checkout directly. One thread at a time is safest.";

/** A single project's choice resolved: "current" is its main checkout; a worktree that is gone is a new one. */
function resolveWorktree(choice: WorktreeChoice, worktrees: readonly WorktreeOption[]): WorktreeChoice {
  if (choice.kind === "current") {
    const main = worktrees.find((w) => w.isMain);
    return main ? { kind: "existing", path: main.path } : { kind: "new" };
  }
  return choice.kind === "existing" && !worktrees.some((w) => w.path === choice.path) ? { kind: "new" } : choice;
}

/**
 * Where a set's thread works, resolved: a set (several projects, or a workspace) works
 * on one branch in every git project or in every project's own checkout; a lone project
 * in a fresh copy, its folder, an existing worktree or an existing branch. The pick, else
 * threads.default_worktree (lib/compose defaultWorktree, setWorkIn). A project without git
 * works in its folder only.
 */
export interface Placement {
  isSet: boolean;
  /** A set of more than one project: the Work in titles are plural. */
  many: boolean;
  /** The lone project's id ("" for a set or no set). */
  single: string;
  worktrees: WorktreeOption[];
  /** A lone project without git: its folder (the only place it runs); undefined otherwise. */
  noGitPath: string | undefined;
  singleKind: ProjectKind;
  /** The set's git projects, in its order (their branches fill the pickers). */
  gitIds: string[];
  /** A set's git project count (0 for a lone project). */
  setGit: number;
  worktree: WorktreeChoice;
  /** A lone project's existing worktree (its main checkout for Project folder). */
  chosen: WorktreeOption | undefined;
  /** A lone project's existing worktree's path; "" otherwise. */
  existingPath: string;
  /** An existing branch picked by name; "" otherwise. */
  pickedBranch: string;
}

/**
 * `set` null: nothing to place (no project, or a like draft, which copies its thread's
 * placement). The same object while nothing it holds changes (a keystroke in the prompt
 * does not make a new one).
 */
export function usePlacement(set: ResolvedSet | null, choice: WorktreeChoice | null): Placement {
  const workInSetting = useSettingValue(WORK_IN_SETTING_KEY);
  const isSet = set?.isSet ?? false;
  const many = isSet && (set?.projectIds.length ?? 0) > 1;
  const single = set && !set.isSet ? (set.projectIds[0] ?? "") : "";
  const worktrees = useWorktrees(single);
  const mainPath = worktrees.find((w) => w.isMain)?.path;
  const noGitPath = useProjectsStore((s) => noGitCheckout(s.byId[single]));
  const singleKind = useProjectKind(single);
  const gitIds = useProjectsStore(useShallow((s) => (set ? set.projectIds.filter((id) => s.byId[id]?.git === true) : [])));
  const setGit = isSet ? gitIds.length : 0;
  const setMode = setWorkIn(choice, workInSetting, setGit > 0);
  const resolved: WorktreeChoice = isSet
    ? choice?.kind === "branch" && setGit > 0
      ? choice
      : { kind: setMode }
    : noGitPath !== undefined
      ? { kind: "existing", path: noGitPath }
      : resolveWorktree(choice ?? defaultWorktree({ setting: workInSetting, mainPath }), worktrees);
  // The result is memoized on primitives: a draft's choice object (and the resolved one)
  // is new on every render, and the composer's collision check and pills key on this.
  const kind = resolved.kind;
  const arg = resolved.kind === "branch" ? resolved.name : resolved.kind === "existing" ? resolved.path : "";
  return useMemo(() => {
    const worktree = choiceOf(kind, arg);
    const chosen = !isSet && worktree.kind === "existing" ? worktrees.find((w) => w.path === worktree.path) : undefined;
    const existingPath = !isSet && worktree.kind === "existing" ? worktree.path : "";
    const pickedBranch = worktree.kind === "branch" ? worktree.name : "";
    return { isSet, many, single, worktrees, noGitPath, singleKind, gitIds, setGit, worktree, chosen, existingPath, pickedBranch };
  }, [kind, arg, isSet, many, single, worktrees, noGitPath, singleKind, gitIds, setGit]);
}

/** A WorktreeChoice from its kind and its name or path. */
function choiceOf(kind: WorktreeChoice["kind"], arg: string): WorktreeChoice {
  switch (kind) {
    case "branch":
      return { kind, name: arg };
    case "existing":
      return { kind, path: arg };
    default:
      return { kind };
  }
}

/**
 * The checkouts a placed thread would work in, for the collision hints
 * (lib/collisionHints draftCheckouts): a worktree thread on a new branch shares none, one
 * on an existing branch shares its listed worktrees.
 */
export function placementCheckouts(p: Placement, setIds: readonly string[], primary: string, projects: Readonly<Record<string, HintProject>>): { checkouts: Checkout[]; worktreeMode: boolean } {
  const worktreeMode = p.worktree.kind === "new" || p.pickedBranch !== "";
  if (p.single) return { checkouts: draftCheckouts({ projectIds: [p.single], primary: p.single, worktreeMode, primaryPath: p.existingPath, branch: p.pickedBranch }, projects), worktreeMode };
  return { checkouts: draftCheckouts({ projectIds: setIds, primary, worktreeMode, branch: p.pickedBranch }, projects), worktreeMode };
}

/**
 * The picker lists of the draft's git projects (ListRefs, loaded when a picker opens):
 * every project's branches newest first, the default branches, and the status line while
 * any is loading or failed ("" when all are ready).
 */
function useBranchLists(gitIds: readonly string[], many: boolean): { lists: (readonly string[])[]; defaults: string[]; status: string } {
  const states = useComposeStore(useShallow((s) => gitIds.map((id) => s.refs[id])));
  return useMemo(() => {
    const lists = states.map((r) => r?.branches ?? []);
    const defaults = states.flatMap((r) => (r?.defaultBranch ? [r.defaultBranch] : []));
    const failed = states.find((r) => r?.status === "error");
    let status = "";
    if (states.some((r) => !r || r.status === "loading")) status = "Loading branches…";
    else if (failed) status = failed.outdated ? (failed.error ?? "") : `Cannot list branches: ${failed.error ?? "unknown error"}. ${many ? "The default branches are" : "The default branch is"} used.`;
    return { lists, defaults, status };
  }, [states, many]);
}

/** What a Work in or Branch from pill shows and lists. */
interface PickerModel {
  groups: PickerGroup[];
  value: string;
  text: string;
  icon: LucideIcon | ComponentType<SVGProps<SVGSVGElement>>;
}

interface PlacementPickers {
  workIn: PickerModel & {
    /** The branch search ("Find existing branch") is there: a git project to list branches of. */
    hasBranchSearch: boolean;
    /** The pick a Work in row's value stands for. */
    choiceOf: (value: string) => WorktreeChoice;
  };
  /** Branch from: shown for new worktrees on a new branch in a set with a git project. */
  base: PickerModel & { show: boolean; footer: string | undefined; baseOf: (value: string) => string | null };
  /** Loads the git projects' branches (the pickers' onOpen). */
  loadLists: () => void;
}

/**
 * Work in's and Branch from's groups, values and pill texts over a placement. The
 * branches of every git project, loaded when a picker opens; a branch the daemon would
 * refuse greyed with its reason while Work in is open (`workInOpen`).
 */
export function usePlacementPickers(p: Placement, o: { base: string; workInOpen: boolean }): PlacementPickers {
  const { isSet, many, setGit, worktrees, noGitPath, gitIds, worktree, chosen, singleKind } = p;
  const manyGit = gitIds.length > 1;
  const branchLists = useBranchLists(gitIds, manyGit);
  const ruleOn = useSettingValue(BASE_FROM_ORIGIN_KEY) !== "false";
  const loadLists = useCallback(() => {
    void loadBranches(gitIds);
  }, [gitIds]);
  // Work in's existing branches (W2): every git project's, merged by name, newest first, minus the default branches.
  const branchNames = useMemo(() => mergedBranches(branchLists.lists, branchLists.defaults), [branchLists]);
  // A branch the Create would refuse (a main checkout on it, its worktree moved): greyed, the refusal as its tooltip.
  const refusals = usePlacementRefusals(gitIds, branchNames, o.workInOpen);
  const branchGroup = useMemo<PickerGroup>(
    () => ({
      options: branchNames.map((b) => ({ value: BRANCH_VALUE + b, label: b, icon: GitBranch, mono: true, unavailable: refusals[b] })),
      status: branchLists.status || undefined,
    }),
    [branchNames, refusals, branchLists.status],
  );
  const groups = useMemo<PickerGroup[]>(() => {
    if (isSet) {
      const inPlace = { value: "current", label: many ? PROJECT_FOLDERS : PROJECT_FOLDER, detail: many ? PROJECT_FOLDERS_DETAIL : PROJECT_FOLDER_OF_ONE_DETAIL, wrap: true };
      // No git project: fresh copies would have nothing to copy (the note under the picker says so).
      if (setGit === 0) return [{ heading: "Work in", options: [inPlace] }];
      return [
        {
          heading: "Work in",
          fixed: true,
          options: [{ value: "new", label: many ? FRESH_COPIES : FRESH_COPY, detail: many ? FRESH_COPIES_DETAIL : FRESH_COPY_OF_ONE_DETAIL, wrap: true }, inPlace],
        },
        branchGroup,
      ];
    }
    if (noGitPath !== undefined) {
      return [{ heading: "Work in", options: [{ value: noGitPath, label: PROJECT_FOLDER, detail: PROJECT_FOLDER_OF_ONE_DETAIL, wrap: true }] }];
    }
    const main = worktrees.find((w) => w.isMain);
    return [
      {
        heading: "Work in",
        fixed: true,
        options: [
          { value: "new", label: FRESH_COPY, detail: FRESH_COPY_DETAIL, wrap: true },
          ...(main ? [{ value: main.path, label: PROJECT_FOLDER, detail: PROJECT_FOLDER_OF_ONE_DETAIL, wrap: true }] : []),
        ],
      },
      branchGroup,
    ];
  }, [isSet, many, setGit, worktrees, noGitPath, branchGroup]);
  // The Work in row that is checked: a picked branch, or an existing worktree's branch (the sidebar's "+").
  const value = isSet
    ? worktree.kind === "branch"
      ? BRANCH_VALUE + worktree.name
      : worktree.kind
    : worktree.kind === "branch"
      ? BRANCH_VALUE + worktree.name
      : worktree.kind === "existing"
        ? chosen && !chosen.isMain && chosen.branch
          ? BRANCH_VALUE + chosen.branch
          : worktree.path
        : worktree.kind;
  const icon =
    noGitPath !== undefined
      ? PROJECT_KIND_ICONS.nogit
      : worktree.kind === "branch"
        ? GitBranch
        : isSet
          ? worktree.kind === "new"
            ? GitBranchPlus
            : FolderGit2
          : !chosen
            ? GitBranchPlus
            : chosen.isMain
              ? PROJECT_KIND_ICONS[singleKind]
              : GitBranch;
  const choiceOf = useCallback(
    (v: string): WorktreeChoice => (v === "new" || v === "current" ? { kind: v } : v.startsWith(BRANCH_VALUE) ? { kind: "branch", name: v.slice(BRANCH_VALUE.length) } : { kind: "existing", path: v }),
    [],
  );

  // Branch from (B3): the default branch(es) first, then the branches every git project
  // has (names only: the daemon picks origin's copy or the local one), newest first.
  const baseGroups = useMemo<PickerGroup[]>(() => {
    const branches = commonBranches(branchLists.lists, branchLists.defaults);
    return [
      {
        heading: "Branch from",
        options: [
          { value: DEFAULT_BASE_VALUE, label: defaultBranchLabel(manyGit), icon: GitCommitHorizontal, mono: true },
          ...branches.map((b) => ({ value: b, label: b, icon: GitBranch, mono: true })),
        ],
        status: branchLists.status || undefined,
      },
    ];
  }, [branchLists, manyGit]);
  const baseOf = useCallback((v: string) => (v === DEFAULT_BASE_VALUE ? null : v), []);
  return {
    workIn: { groups, value, text: workInText({ set: isSet, many, noGit: noGitPath !== undefined, worktree, chosen }), icon, hasBranchSearch: groups.length > 1, choiceOf },
    base: {
      show: worktree.kind === "new" && gitIds.length > 0,
      groups: baseGroups,
      value: o.base || DEFAULT_BASE_VALUE,
      text: baseText(o.base, manyGit),
      icon: GitCommitHorizontal,
      footer: ruleOn ? baseRuleText(manyGit) : undefined,
      baseOf,
    },
    loadLists,
  };
}

/** Each project's name (its id when the store does not know it), for labels built in hooks. */
export function useProjectNames(ids: readonly string[]): (id: string) => string {
  const names = useProjectsStore(useShallow((s) => ids.map((id) => s.byId[id]?.name ?? id)));
  return useCallback((id: string) => names[ids.indexOf(id)] ?? id, [ids, names]);
}

/** Each project's kind (projectKind), for the Run in picker's icons; "git" while unknown. */
function useProjectKinds(ids: readonly string[]): (id: string) => ProjectKind {
  const kinds = useProjectsStore(useShallow((s) => ids.map((id) => (s.byId[id] ? projectKind(s.byId[id]).kind : "git"))));
  return useCallback((id: string) => kinds[ids.indexOf(id)] ?? "git", [ids, kinds]);
}

/**
 * Run in: where a set's thread runs, its primary: the workspace's folder (WORKSPACE_FOLDER)
 * first when there is one, then the projects by name. Shown for a set of more than one
 * project or a workspace.
 */
export function usePrimaryPicker(s: Pick<ResolvedSet, "projectIds" | "workspaceId">, workspaceName: string, primary: string): PickerModel & { show: boolean } {
  const projectNames = useProjectNames(s.projectIds);
  const projectKinds = useProjectKinds(s.projectIds);
  const groups = useMemo<PickerGroup[]>(() => {
    const options = primaryOptions(s, workspaceName, projectNames).map((o) => ({ ...o, icon: o.value === WORKSPACE_PRIMARY ? Layers : PROJECT_KIND_ICONS[projectKinds(o.value)] }));
    return [{ heading: "Run in", options }];
  }, [s, workspaceName, projectNames, projectKinds]);
  return {
    show: s.projectIds.length > 1 || s.workspaceId !== "",
    groups,
    value: primary,
    text: primary === WORKSPACE_PRIMARY ? WORKSPACE_FOLDER : projectNames(primary),
    icon: primary === WORKSPACE_PRIMARY ? Layers : MapPin,
  };
}
