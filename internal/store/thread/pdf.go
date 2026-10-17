package thread

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// MaxInlinePDFPages is the most pages a PDF attachment may have to be sent to Claude
// whole, as a document block. Claude Code's own paste rule: a longer PDF goes only as
// its path, and Claude reads it with the Read tool's pages parameter (at most 20 pages
// per call, required above 10 pages).
const MaxInlinePDFPages = 10

// pdfEstimateBytes is Claude Code's page estimate when pdfinfo is missing: one page per
// 100 KiB, rounded up.
const pdfEstimateBytes = 100 << 10

// pdfinfoTimeout bounds one pdfinfo run.
const pdfinfoTimeout = 3 * time.Second

// pdfinfoFallbacks are tried when pdfinfo is not on $PATH: a Finder-launched daemon
// inherits launchd's minimal PATH, which has no Homebrew directory. Tests clear it.
var pdfinfoFallbacks = []string{"/opt/homebrew/bin/pdfinfo", "/usr/local/bin/pdfinfo"}

// pdfPages counts a PDF's pages with poppler's pdfinfo when it is installed (exact);
// otherwise, or when pdfinfo fails, it estimates ceil(size/100 KiB) like Claude Code
// does (exact false). A file it cannot stat counts as one page. Only for a PDF staged
// before its file name carried the count (stagedPDFPages).
func pdfPages(ctx context.Context, path string) (pages int, exact bool) {
	if n, ok := pdfinfoPages(ctx, path); ok {
		return n, true
	}
	fi, err := os.Stat(path)
	if err != nil {
		return 1, false
	}
	return estimatePDFPages(fi.Size()), false
}

// settlePDFPages is the page count StageAttachment records in a PDF's file name:
// pdfinfo's when it is installed, else the client's hint (the GUI counts with pdf.js;
// 0 is no hint), both exact, else the size estimate.
func settlePDFPages(ctx context.Context, path string, size int64, hint int) (pages int, exact bool) {
	if n, ok := pdfinfoPages(ctx, path); ok {
		return n, true
	}
	if hint > 0 {
		return hint, true
	}
	return estimatePDFPages(size), false
}

// estimatePDFPages is ceil(size/100 KiB), at least one.
func estimatePDFPages(size int64) int {
	if size <= 0 {
		return 1
	}
	return int((size + pdfEstimateBytes - 1) / pdfEstimateBytes)
}

// pdfinfoPages runs pdfinfo on path; false when it is missing or fails.
func pdfinfoPages(ctx context.Context, path string) (int, bool) {
	bin := pdfinfoPath()
	if bin == "" {
		return 0, false
	}
	cctx, cancel := context.WithTimeout(ctx, pdfinfoTimeout)
	defer cancel()
	out, err := exec.CommandContext(cctx, bin, path).Output()
	if err != nil {
		return 0, false
	}
	return parsePDFInfoPages(out)
}

// stagedPDFName matches a staged PDF's file name with its page count:
// <32 hex>-<N>p.pdf for an exact count, <32 hex>-~<N>p.pdf for an estimate.
var stagedPDFName = regexp.MustCompile(`^[0-9a-f]{32}-(~?)([1-9][0-9]{0,6})p\.pdf$`)

// pdfFileName is the name StageAttachment gives a PDF: stem (32 hex) plus the count.
func pdfFileName(stem string, pages int, exact bool) string {
	approx := "~"
	if exact {
		approx = ""
	}
	return fmt.Sprintf("%s-%s%dp.pdf", stem, approx, pages)
}

// stagedPDFPages reads the page count from a staged PDF's file name; ok is false for
// a name without one (staged before the count was recorded, or not by StageAttachment).
func stagedPDFPages(path string) (pages int, exact, ok bool) {
	m := stagedPDFName.FindStringSubmatch(filepath.Base(path))
	if m == nil {
		return 0, false, false
	}
	n, err := strconv.Atoi(m[2])
	if err != nil {
		return 0, false, false
	}
	return n, m[1] == "", true
}

// pdfinfoPath finds pdfinfo on $PATH, then in pdfinfoFallbacks; "" when missing.
func pdfinfoPath() string {
	if p, err := exec.LookPath("pdfinfo"); err == nil {
		return p
	}
	for _, p := range pdfinfoFallbacks {
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0 {
			return p
		}
	}
	return ""
}

// parsePDFInfoPages reads the "Pages:" line of pdfinfo's output. A count below one is
// not a count.
func parsePDFInfoPages(out []byte) (int, bool) {
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok || k != "Pages" {
			continue
		}
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil || n < 1 {
			return 0, false
		}
		return n, true
	}
	return 0, false
}
