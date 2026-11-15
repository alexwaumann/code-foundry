import { pdfMeta } from "../../fileKind";
import { PdfBody } from "../PdfBody";
import type { PreviewKind } from "../types";

/** A PDF: its pages (pdf.js), no switch. */
const pdf: PreviewKind = {
  id: "pdf",
  match: { ext: ["pdf"], mime: ["application/pdf"] },
  shows: (f) => f.pdf !== null,
  modes: [{ id: "pages", label: "Pages" }],
  Body: PdfBody,
  meta: ({ file }) => pdfMeta(file.size, null),
  edit: false,
  tooLarge: "PDF",
};

export default pdf;
