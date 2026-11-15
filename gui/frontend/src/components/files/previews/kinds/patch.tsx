import { lazy } from "react";
import { FileDiff } from "lucide-react";
import { formatSize } from "../../fileKind";
import { patchModelOf } from "../patch";
import { PatchControls } from "../PatchControls";
import type { PreviewKind } from "../types";

/**
 * A patch or diff (`.patch`, `.diff`; the daemon's `text/x-diff`): Diff | Source, plus
 * Unified | Split. One section per file under the commit's subject (PatchBody).
 */
const patch: PreviewKind = {
  id: "patch",
  match: { ext: ["patch", "diff"], mime: ["text/x-diff", "text/x-patch"] },
  modes: [{ id: "diff", label: "Diff" }],
  Body: lazy(() => import("../PatchBody").then((m) => ({ default: m.PatchBody }))),
  Controls: PatchControls,
  meta: ({ file }) => {
    const m = patchModelOf(file.text ?? "");
    const n = m.files.length;
    if (n === 0) return `${formatSize(file.size)} · Patch`;
    return (
      <>
        {n.toLocaleString()} {n === 1 ? "file" : "files"} · <span className="text-cf-diff-addition">+{m.added.toLocaleString()}</span> <span className="text-cf-diff-deletion">−{m.deleted.toLocaleString()}</span> · Patch
      </>
    );
  },
  wrap: true,
  icon: FileDiff,
};

export default patch;
