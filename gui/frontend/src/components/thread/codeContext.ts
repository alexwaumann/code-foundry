import { createContext, useContext } from "react";

/**
 * Where a code block sits, for its "Run in terminal" button: Claude's reply (TextRow)
 * provides it; summaries, subagent reports and tool output do not, so their blocks only
 * copy. `text` and `streaming` are the reply's, to hide Run on a block still being written.
 */
export interface CodeRunCtx {
  sessionId: string;
  text: string;
  streaming: boolean;
}

export const CodeRunContext = createContext<CodeRunCtx | null>(null);

export function useCodeRun(): CodeRunCtx | null {
  return useContext(CodeRunContext);
}
