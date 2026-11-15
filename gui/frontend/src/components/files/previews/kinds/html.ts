import { HtmlBody } from "../HtmlBody";
import { savedMeta } from "../meta";
import type { PreviewKind } from "../types";

/** HTML: Rendered (the page in its sandboxed frame, HtmlPreview) | Source. */
const html: PreviewKind = {
  id: "html",
  match: { ext: ["html", "htm"] },
  modes: [{ id: "rendered", label: "Rendered" }],
  Body: HtmlBody,
  meta: savedMeta,
};

export default html;
