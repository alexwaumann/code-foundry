package thread

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testPDF writes a minimal valid PDF with n pages, page i saying "Page i of n" (pdfinfo
// and Claude both read it), with a comment of pad bytes after the header to grow it.
func testPDF(n, pad int) []byte {
	var b bytes.Buffer
	var offsets []int
	obj := func(body string) {
		offsets = append(offsets, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", len(offsets), body)
	}
	b.WriteString("%PDF-1.4\n")
	if pad > 0 {
		b.WriteString("%" + strings.Repeat("x", pad) + "\n")
	}
	// 1 catalog, 2 pages, 3 font, then a page and its content stream per page.
	obj("<< /Type /Catalog /Pages 2 0 R >>")
	kids := ""
	for i := range n {
		kids += fmt.Sprintf("%d 0 R ", 4+2*i)
	}
	obj(fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", kids, n))
	obj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
	for i := range n {
		obj(fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents %d 0 R /Resources << /Font << /F1 3 0 R >> >> >>", 5+2*i))
		text := fmt.Sprintf("BT /F1 18 Tf 40 100 Td (Page %d of %d) Tj ET", i+1, n)
		obj(fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(text), text))
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(offsets)+1)
	for _, o := range offsets {
		fmt.Fprintf(&b, "%010d 00000 n \n", o)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets)+1, xref)
	return b.Bytes()
}

func TestParsePDFInfoPages(t *testing.T) {
	// Captured from pdfinfo 26.10.0 (poppler) on testPDF(3).
	captured := "Custom Metadata: no\nMetadata Stream: no\nTagged:          no\nUserProperties:  no\n" +
		"Suspects:        no\nForm:            none\nJavaScript:      no\nPages:           3\nEncrypted:       no\n" +
		"Page size:       300 x 200 pts\nPage rot:        0\nFile size:       1117 bytes\nOptimized:       no\nPDF version:     1.4\n"
	tests := []struct {
		name  string
		out   string
		pages int
		ok    bool
	}{
		{"captured", captured, 3, true},
		{"large", "Title: x\nPages:      1234\n", 1234, true},
		{"no pages line", "Title: Pages: 3\nEncrypted: no\n", 0, false},
		{"zero", "Pages: 0\n", 0, false},
		{"not a number", "Pages: many\n", 0, false},
		{"empty", "", 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			n, ok := parsePDFInfoPages([]byte(tt.out))
			if n != tt.pages || ok != tt.ok {
				t.Errorf("= %d, %v; want %d, %v", n, ok, tt.pages, tt.ok)
			}
		})
	}
}

func TestPDFPagesEstimate(t *testing.T) {
	noPdfinfo(t)
	dir := t.TempDir()
	tests := []struct {
		name  string
		size  int
		pages int
	}{
		{"tiny", 10, 1},
		{"exactly one estimate page", 100 << 10, 1},
		{"just over", 100<<10 + 1, 2},
		{"a megabyte", 1 << 20, 11},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := filepath.Join(dir, tt.name+".pdf")
			data := append([]byte("%PDF-1.4\n"), make([]byte, tt.size-9)...)
			if err := os.WriteFile(p, data[:tt.size], 0o600); err != nil {
				t.Fatal(err)
			}
			if n, exact := pdfPages(context.Background(), p); n != tt.pages || exact {
				t.Errorf("pdfPages = %d, %v; want %d estimated", n, exact, tt.pages)
			}
		})
	}
	if n, exact := pdfPages(context.Background(), filepath.Join(dir, "gone.pdf")); n != 1 || exact {
		t.Errorf("missing file = %d, %v", n, exact)
	}
}

// TestPDFPagesPdfinfo runs the real pdfinfo when it is installed.
func TestPDFPagesPdfinfo(t *testing.T) {
	if pdfinfoPath() == "" {
		t.Skip("pdfinfo not installed")
	}
	p := filepath.Join(t.TempDir(), "a.pdf")
	if err := os.WriteFile(p, testPDF(12, 0), 0o600); err != nil {
		t.Fatal(err)
	}
	if n, exact := pdfPages(context.Background(), p); n != 12 || !exact {
		t.Errorf("pdfPages = %d, %v; want 12 exact", n, exact)
	}
	// The count is the document's, not the size estimate.
	if err := os.WriteFile(p, testPDF(2, 1<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	if n, exact := pdfPages(context.Background(), p); n != 2 || !exact {
		t.Errorf("padded pdfPages = %d, %v; want 2 exact", n, exact)
	}
	// A file pdfinfo cannot parse falls back to the estimate.
	bad := filepath.Join(t.TempDir(), "bad.pdf")
	if err := os.WriteFile(bad, []byte("%PDF-1.4\ngarbage"), 0o600); err != nil {
		t.Fatal(err)
	}
	if n, exact := pdfPages(context.Background(), bad); n != 1 || exact {
		t.Errorf("unparseable = %d, %v; want 1 estimated", n, exact)
	}
}
