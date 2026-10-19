/**
 * A minimal valid PDF of `pages` 300×200pt pages, each saying "Page i of n" in Helvetica
 * (the daemon's testPDF in Go). `pad` bytes of a comment after the header grow the file
 * without changing what it holds. Used by the mock daemon's file fixtures (mock/files.ts)
 * and the e2e specs (e2e/fixtures.ts re-exports it).
 */
export function testPdf(pages: number, pad = 0): Buffer {
  const parts: string[] = [];
  const offsets: number[] = [];
  let len = 0;
  const write = (s: string) => {
    parts.push(s);
    len += Buffer.byteLength(s, "latin1");
  };
  const obj = (body: string) => {
    offsets.push(len);
    write(`${String(offsets.length)} 0 obj\n${body}\nendobj\n`);
  };
  write("%PDF-1.4\n");
  if (pad > 0) write(`%${"x".repeat(pad)}\n`);
  obj("<< /Type /Catalog /Pages 2 0 R >>");
  const kids = Array.from({ length: pages }, (_, i) => `${String(4 + 2 * i)} 0 R`).join(" ");
  obj(`<< /Type /Pages /Kids [${kids}] /Count ${String(pages)} >>`);
  obj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < pages; i++) {
    obj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${String(5 + 2 * i)} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    const text = `BT /F1 18 Tf 40 100 Td (Page ${String(i + 1)} of ${String(pages)}) Tj ET`;
    obj(`<< /Length ${String(text.length)} >>\nstream\n${text}\nendstream`);
  }
  const xref = len;
  write(`xref\n0 ${String(offsets.length + 1)}\n0000000000 65535 f \n`);
  for (const o of offsets) write(`${String(o).padStart(10, "0")} 00000 n \n`);
  write(`trailer\n<< /Size ${String(offsets.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`);
  return Buffer.from(parts.join(""), "latin1");
}
