import { Code, ConnectError } from "@connectrpc/connect";
import { formatPatterns, patternErrorText } from "@/lib/includePatterns";
import { runCommandForResult } from "./commands";
import { projectContext } from "./context";

const invalidArgument = (err: unknown) => err instanceof ConnectError && err.code === Code.InvalidArgument;

/**
 * project.files.include with the project's whole new list (`none` when empty). Answers the
 * daemon's message for refused patterns (shown in place, not toasted), or null once set.
 * Other failures are toasted too.
 */
export async function setProjectIncludes(projectId: string, next: readonly string[]): Promise<string | null> {
  let message = "";
  const res = await runCommandForResult(
    "project.files.include",
    { project: projectId, patterns: formatPatterns(next) },
    {
      ctx: projectContext(projectId),
      // The list shows the change in place (docs/notes/toast-success-rule.md).
      inView: true,
      expected: invalidArgument,
      onError: (m) => {
        message = m;
      },
    },
  );
  return res ? null : patternErrorText(message || "Not saved.");
}
