/**
 * A page saved a file (file.export, docs/notes/page-save.md): the path goes back to the page,
 * and the app shows the user where it went, with a way to it. The bridge host calls this
 * after each run of a page's that succeeded (stores/bridgeHost.ts); only a verb that names a
 * written file in its result shows anything.
 */
import { toast } from "sonner";
import type { InvokeResultView } from "@/api/command";
import { revealInFinder } from "@/components/files/fileActions";
import { fileName } from "@/lib/filePath";
import { tildify } from "@/lib/path";
import { openFileInPanel } from "./filePanel";
import { useThreadsStore } from "./threads";

/** The verbs whose result's `path` is a file the page just wrote. */
const SAVES_A_FILE: ReadonlySet<string> = new Set(["file.export"]);

/** The written file's absolute path in a saving verb's result, or "". */
export function savedPath(verb: string, res: InvokeResultView | null): string {
  if (!SAVES_A_FILE.has(verb) || !res?.resultJson) return "";
  try {
    const out = JSON.parse(res.resultJson) as { path?: unknown };
    return typeof out.path === "string" && out.path.startsWith("/") ? out.path : "";
  } catch {
    return "";
  }
}

/**
 * Shows "Saved <name>" for a page's run that wrote a file, with Open (a File tab in the
 * tab beside the thread) and Show in Finder; nothing for any other run.
 */
export function noticePageResult(threadId: string, verb: string, res: InvokeResultView | null): void {
  const path = savedPath(verb, res);
  if (!path) return;
  const t = useThreadsStore.getState().byId[threadId];
  const project = t?.projectId ?? "";
  const dir = t?.worktreePath || path.slice(0, path.lastIndexOf("/"));
  toast.success(`Saved ${fileName(path)}`, {
    description: tildify(path),
    action: {
      label: "Open",
      onClick: () => {
        openFileInPanel(`thread:${threadId}`, { project, base: dir, path });
      },
    },
    cancel: {
      label: "Show in Finder",
      onClick: () => {
        revealInFinder({ project, dir, file: path });
      },
    },
  });
}
