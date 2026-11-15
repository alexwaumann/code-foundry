import { MarkdownBody } from "../MarkdownBody";
import { savedMeta } from "../meta";
import type { PreviewKind } from "../types";

/** Markdown: Rendered | Source. The rendered text can be searched. */
const markdown: PreviewKind = {
  id: "markdown",
  match: { ext: ["md", "markdown", "mdx"] },
  modes: [{ id: "rendered", label: "Rendered" }],
  Body: MarkdownBody,
  meta: savedMeta,
  find: true,
};

export default markdown;
