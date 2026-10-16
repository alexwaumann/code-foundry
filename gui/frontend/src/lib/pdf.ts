/**
 * PDF pages for the composer (pdf.js). pdf.js and its worker are a chunk of their own,
 * loaded on the first call: the app's main bundle never pays for them. The worker is a
 * Vite asset (`?url`), served from the app's own origin in the Wails webview and in the
 * browsers; when a worker cannot start, pdf.js runs the same code on the main thread.
 *
 * Fonts a PDF names but does not embed (the 14 standard fonts) come from the system
 * (`useSystemFonts`): pdf.js's own font data and CMaps are not bundled.
 */
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/** An open PDF. Pages count from 1. */
export interface PdfDocument {
  pages: number;
  /** A page's size in CSS px at 100% (PDF points, rotation applied). */
  pageSize(n: number): Promise<{ width: number; height: number }>;
  /**
   * Renders a page `width` CSS px wide, at `pixelRatio` device pixels per CSS px, into
   * the given canvas (sized here) or a new one.
   */
  renderPage(n: number, width: number, opts?: { canvas?: HTMLCanvasElement; pixelRatio?: number }): Promise<HTMLCanvasElement>;
  destroy(): void;
}

type PdfJs = typeof import("pdfjs-dist");

let pdfjs: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= import("pdfjs-dist").then((m) => {
    m.GlobalWorkerOptions.workerSrc = workerUrl;
    return m;
  });
  return pdfjs;
}

/** The viewport scale that draws a page `pageWidth` px wide at `width` CSS px and `pixelRatio`. */
export function renderScale(pageWidth: number, width: number, pixelRatio = 1): number {
  if (pageWidth <= 0 || width <= 0) return 1;
  return (width / pageWidth) * Math.max(1, pixelRatio);
}

/** Opens a PDF. Rejects when it is not one pdf.js can read. */
export async function loadPdf(data: Blob | ArrayBuffer): Promise<PdfDocument> {
  const { getDocument } = await loadPdfJs();
  const bytes = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
  const task = getDocument({ data: bytes, useSystemFonts: true });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (err) {
    // Not a PDF pdf.js reads: the task still holds its worker side until destroyed.
    void task.destroy();
    throw err;
  }
  return {
    pages: doc.numPages,
    async pageSize(n) {
      const vp = (await doc.getPage(n)).getViewport({ scale: 1 });
      return { width: vp.width, height: vp.height };
    },
    async renderPage(n, width, opts = {}) {
      const page = await doc.getPage(n);
      const scale = renderScale(page.getViewport({ scale: 1 }).width, width, opts.pixelRatio);
      const viewport = page.getViewport({ scale });
      const canvas = opts.canvas ?? document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      await page.render({ canvas, viewport }).promise;
      page.cleanup();
      return canvas;
    },
    destroy() {
      void task.destroy();
    },
  };
}

/**
 * A PDF's page count and its first page as a PNG data URL `width` px wide (null when
 * the page did not render). Rejects when the file is not a PDF pdf.js can read.
 */
export async function pdfSummary(data: Blob | ArrayBuffer, width = 128): Promise<{ pages: number; thumb: string | null }> {
  const doc = await loadPdf(data);
  try {
    let thumb: string | null = null;
    try {
      thumb = (await doc.renderPage(1, width)).toDataURL("image/png");
    } catch {
      thumb = null;
    }
    return { pages: doc.pages, thumb };
  } finally {
    doc.destroy();
  }
}
