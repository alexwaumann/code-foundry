/**
 * ProjectService.Rename and the project.rename command, as internal/command/commands_project_rename.go and
 * internal/store/project/rename.go: the ref is an id, the one project with a name, or a path inside one; the
 * new name follows the daemon's rules (src/lib/projectName.ts). Only the name changes.
 */
import { Code, ConnectError } from "@connectrpc/connect";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { projectRenameError } from "../src/lib/projectName";

/** What World offers this module (mock/world.ts). */
export interface RenameWorld {
  projectList(): { id: string; name: string; path: string }[];
  /** Sets the name and publishes projectUpdated. */
  setProjectName(id: string, name: string): void;
}

function resolve(world: RenameWorld, ref: string): string {
  const all = world.projectList();
  if (all.some((p) => p.id === ref)) return ref;
  const named = all.filter((p) => p.name === ref);
  if (named.length === 1) return named[0]?.id ?? ref;
  if (named.length > 1) throw new ConnectError(`invalid argument: ${String(named.length)} projects are named ${ref}; pass an id (code-foundry project list)`, Code.InvalidArgument);
  const inside = all.filter((p) => ref === p.path || ref.startsWith(`${p.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  return inside?.id ?? ref;
}

/** ProjectService.Rename (by id) and project.rename (by ref). */
export function renameProjectIn(world: RenameWorld, ref: string, name: string): { id: string; name: string } {
  const id = resolve(world, ref.trim());
  const all = world.projectList();
  const p = all.find((x) => x.id === id);
  if (!p) throw new ConnectError(`not found: project "${ref}"`, Code.NotFound);
  const n = name.trim().normalize("NFC");
  const why = projectRenameError(n, all.filter((x) => x.id !== id));
  if (why) throw new ConnectError(why, why.startsWith("A project named") ? Code.FailedPrecondition : Code.InvalidArgument);
  if (p.name !== n) world.setProjectName(id, n);
  return { id, name: n };
}

interface CommandEntry {
  cmd: { name: string; title: string; category: string; description: string; keybindings: string[]; args: { name: string; type: ArgType; required: boolean; description: string }[] };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => string;
}

export function renameCommands(world: RenameWorld): CommandEntry[] {
  return [
    {
      cmd: {
        name: "project.rename",
        title: "Rename Project",
        category: "Project",
        description:
          "Rename a project. Only its name in Code Foundry changes: the folder, worktrees and branches stay. Names are unique among projects, whatever their case, and may not contain / or ,.",
        keybindings: [],
        args: [
          { name: "project", type: ArgType.STRING, required: true, description: "Project id, name, or a path inside it (default: the active project)" },
          { name: "name", type: ArgType.STRING, required: true, description: "New name" },
        ],
      },
      // The daemon offers it with an active project, and with an explicit --project (the CLI).
      when: () => true,
      run: (ctx, args) => {
        const r = renameProjectIn(world, args.project || ctx?.activeProjectId || "", args.name ?? "");
        return `renamed project ${r.id} to ${r.name}`;
      },
    },
  ];
}
