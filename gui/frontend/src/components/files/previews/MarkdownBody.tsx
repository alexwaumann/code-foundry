import { dirPart } from "@/lib/filePath";
import { MarkdownPreview } from "../MarkdownPreview";
import type { PreviewBodyProps } from "./types";

/** The markdown kind's body: the rendered text, searchable, its links and images relative to the file. */
export function MarkdownBody({ file, path, place, findKey }: PreviewBodyProps) {
  return <MarkdownPreview text={file.text ?? ""} dir={dirPart(path)} project={place.project} base={place.dir} findKey={findKey} />;
}
