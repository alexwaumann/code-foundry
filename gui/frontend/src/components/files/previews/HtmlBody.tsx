import { HtmlPreview } from "../HtmlPreview";
import type { PreviewBodyProps } from "./types";

/** The HTML kind's body: the page in its sandboxed frame, loaded again on Refresh. */
export function HtmlBody({ file, path, name, page, reloads }: PreviewBodyProps) {
  return <HtmlPreview path={path} text={file.text ?? ""} name={name} page={page} reloads={reloads} />;
}
