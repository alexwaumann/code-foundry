import { pdfMeta } from "../fileKind";
import { PdfPreview } from "../PdfPreview";
import type { PreviewBodyProps } from "./types";

/** The PDF kind's body: its pages; the page count joins the meta once pdf.js opens it. */
export function PdfBody({ file, onMeta }: PreviewBodyProps) {
  return (
    file.pdf && (
      <PdfPreview
        bytes={file.pdf}
        onPages={(pages) => {
          onMeta(pdfMeta(file.size, pages));
        }}
      />
    )
  );
}
