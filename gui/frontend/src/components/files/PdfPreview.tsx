import { useMemo } from "react";
import { PDF_MIME } from "@/api/files";
import { PdfPages } from "@/components/compose/PdfPages";

/**
 * A PDF file: the attachment lightbox's page column (components/compose/PdfPages) filling
 * the tab body, each page drawn as it scrolls near. `onPages` reports the page count for
 * the header's meta. A re-read brings new bytes, so the document opens again.
 */
export function PdfPreview({ bytes, onPages }: { bytes: Uint8Array; onPages: (pages: number) => void }) {
  // A copy: a Blob wants an ArrayBuffer-backed view, and the response's bytes may sit in a larger buffer.
  const file = useMemo(() => new Blob([bytes.slice()], { type: PDF_MIME }), [bytes]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-pdf">
      <PdfPages file={file} fill onPages={onPages} />
    </div>
  );
}
