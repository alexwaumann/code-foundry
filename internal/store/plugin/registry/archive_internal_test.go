package registry

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A tarball whose one entry follows many PAX headers (each under the reader's 1 MiB
// limit, none an entry) stops at the decompression cap instead of inflating them all.
func TestExtractStopsAtTheDecompressionCap(t *testing.T) {
	defer func(v int64) { maxDecompressed = v }(maxDecompressed)
	maxDecompressed = 4 << 20

	var one bytes.Buffer
	tw := tar.NewWriter(&one)
	h := tar.Header{Name: "a", Typeflag: tar.TypeReg, Mode: 0o644, Format: tar.FormatPAX,
		PAXRecords: map[string]string{"comment": strings.Repeat("a", 512<<10)}}
	if err := tw.WriteHeader(&h); err != nil {
		t.Fatal(err)
	}
	// The PAX header (its header block and records) is everything before the entry's own
	// header block, the last 512 bytes written so far.
	if err := tw.Flush(); err != nil {
		t.Fatal(err)
	}
	pax := one.Bytes()[:one.Len()-512]
	entry := one.Bytes()[one.Len()-512:]

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	for range 64 { // 32 MiB of PAX headers
		_, _ = gz.Write(pax)
	}
	_, _ = gz.Write(entry)
	_, _ = gz.Write(make([]byte, 1024)) // end of archive
	_ = gz.Close()

	file := filepath.Join(t.TempDir(), "bomb.tar.gz")
	if err := os.WriteFile(file, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	err := Extract(file, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "bytes decompressed") {
		t.Fatalf("err = %v, want the decompression cap", err)
	}

	// A tarball within the cap still extracts.
	maxDecompressed = 64 << 20
	if err := Extract(file, t.TempDir()); err != nil {
		t.Fatalf("under the cap: %v", err)
	}
}
