/**
 * Mock-only commands a page's bridge test reads (docs/notes/bridge-2-gui.md): the daemon's
 * `thread.list` (read-only), with its JSON result.
 */
import { ArgType } from "../src/gen/codefoundry/v1/command_pb";

interface ListedThread {
  id: string;
  name: string;
  archivedAt: Date | null;
}

export function bridgeCommands(threads: () => ListedThread[]) {
  return [
    {
      cmd: {
        name: "thread.list",
        title: "List Threads",
        category: "Thread",
        description: "List threads",
        keybindings: [],
        readOnly: true,
        args: [{ name: "archived", type: ArgType.BOOL, required: false, description: "Archived threads too" }],
      },
      when: () => true,
      run: (_ctx: unknown, args: Record<string, string>) => {
        const list = threads().filter((t) => args.archived === "true" || !t.archivedAt);
        return Promise.resolve({
          message: list.map((t) => `${t.id}  ${t.name}`).join("\n"),
          resultJson: JSON.stringify({ threads: list.map((t) => ({ id: t.id, name: t.name, archived: t.archivedAt !== null })) }),
        });
      },
    },
  ];
}
