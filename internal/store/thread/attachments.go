package thread

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Attachments are images and PDFs staged for a message. The GUI uploads them with
// StageAttachment before Create or Send, which append one "Attached image: <path>" or
// "Attached PDF: <path> (<N> pages)" line per path (buildPrompt) and send the file's
// content along as an image or document block; a PDF over MaxInlinePDFPages goes only
// as its path, and Claude reads it with its Read tool. Staged files are kept so a
// later turn can read them again (and so what a thread was sent can be inspected when
// debugging). The Manager reaps files older than Options.AttachmentMaxAge (default
// AttachmentMaxAge) when it starts and then every Options.AttachmentReapInterval
// (default AttachmentReapInterval) until Shutdown, since the daemon runs for days.
// Reaping only removes regular, non-hidden files directly in the directory.

// MaxAttachmentBytes bounds one staged image.
const MaxAttachmentBytes = 10 << 20

// MaxPDFAttachmentBytes bounds one staged PDF.
const MaxPDFAttachmentBytes = 20 << 20

// MaxMessageMediaBytes bounds the raw bytes of the attachments one message sends
// inline (images and PDFs of at most MaxInlinePDFPages): the API takes 32 MB per
// request, base64 included, and base64 grows the bytes by a third.
const MaxMessageMediaBytes = 24 << 20

// pdfType is the MIME type of a PDF attachment.
const pdfType = "application/pdf"

// AttachmentMaxAge is the default for how long a staged attachment is kept.
const AttachmentMaxAge = 7 * 24 * time.Hour

// AttachmentReapInterval is the default interval between reaps while the daemon runs.
const AttachmentReapInterval = 24 * time.Hour

// AttachmentTypes maps the accepted MIME types to the file extension they are stored
// with.
var AttachmentTypes = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
	pdfType:      ".pdf",
}

// maxAttachmentBytes is the size limit for a type in AttachmentTypes.
func maxAttachmentBytes(mimeType string) int {
	if mimeType == pdfType {
		return MaxPDFAttachmentBytes
	}
	return MaxAttachmentBytes
}

// attachmentType validates a declared MIME type against the data and returns the
// extension to store it with. The declared type must be accepted and the content must
// sniff as an accepted type too (the stored extension follows the content). The size
// limit is the content's: MaxPDFAttachmentBytes for a PDF, else MaxAttachmentBytes.
func attachmentType(mimeType string, data []byte) (string, error) {
	declared, _, err := mime.ParseMediaType(mimeType)
	if err != nil || AttachmentTypes[declared] == "" {
		return "", fmt.Errorf("%w: attachment type %q (want image/png, image/jpeg, image/gif, image/webp or application/pdf)", ErrInvalidArgument, mimeType)
	}
	if len(data) == 0 {
		return "", fmt.Errorf("%w: attachment is empty", ErrInvalidArgument)
	}
	sniffed := http.DetectContentType(data)
	ext := AttachmentTypes[sniffed]
	if ext == "" {
		return "", fmt.Errorf("%w: attachment declared %s but its content is %s", ErrInvalidArgument, declared, sniffed)
	}
	if limit := maxAttachmentBytes(sniffed); len(data) > limit {
		what := "an image"
		if sniffed == pdfType {
			what = "a PDF"
		}
		return "", fmt.Errorf("%w: attachment is %d bytes; the limit for %s is %d MiB", ErrInvalidArgument, len(data), what, limit>>20)
	}
	return ext, nil
}

// StageAttachment writes an image or PDF under Options.AttachmentsDir and returns its
// path: <32 hex><ext> for an image; <32 hex>-<N>p.pdf for a PDF, or <32 hex>-~<N>p.pdf
// when N is the size estimate (settlePDFPages, with pages as the client's hint). The
// count is settled here once, so every message that sends the file agrees with it.
func (m *Manager) StageAttachment(ctx context.Context, name, mimeType string, data []byte, pages int) (string, error) {
	dir := m.opts.AttachmentsDir
	if dir == "" {
		return "", fmt.Errorf("%w: attachments are not enabled", ErrFailedPrecondition)
	}
	ext, err := attachmentType(mimeType, data)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("thread: attachments dir: %w", err)
	}
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("thread: attachment name: %w", err)
	}
	stem := hex.EncodeToString(b[:])
	path := filepath.Join(dir, stem+ext)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", fmt.Errorf("thread: stage attachment: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return "", fmt.Errorf("thread: stage attachment: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("thread: stage attachment: %w", err)
	}
	if ext != ".pdf" {
		m.log.Info("attachment staged", "path", path, "name", name, "bytes", len(data))
		return path, nil
	}
	n, exact := settlePDFPages(ctx, path, int64(len(data)), pages)
	counted := filepath.Join(dir, pdfFileName(stem, n, exact))
	if err := os.Rename(path, counted); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("thread: stage attachment: %w", err)
	}
	m.log.Info("attachment staged", "path", counted, "name", name, "bytes", len(data), "pages", n, "exact", exact, "hint", pages)
	return counted, nil
}

// ReadAttachment returns a staged attachment's content and its sniffed MIME type. The
// path must be a regular file directly in Options.AttachmentsDir (what StageAttachment
// returned); a reaped or unknown one is ErrNotFound.
func (m *Manager) ReadAttachment(_ context.Context, path string) ([]byte, string, error) {
	paths, err := checkAttachments(m.opts.AttachmentsDir, []string{path})
	if err != nil {
		return nil, "", fmt.Errorf("%w: attachment %q", ErrNotFound, path)
	}
	if fi, err := os.Stat(paths[0]); err != nil || fi.Size() > MaxPDFAttachmentBytes {
		return nil, "", fmt.Errorf("%w: attachment %q", ErrNotFound, path)
	}
	data, err := os.ReadFile(paths[0])
	if err != nil {
		return nil, "", fmt.Errorf("%w: attachment %q", ErrNotFound, path)
	}
	mimeType := http.DetectContentType(data)
	if AttachmentTypes[mimeType] == "" || len(data) > maxAttachmentBytes(mimeType) {
		return nil, "", fmt.Errorf("%w: attachment %q is %s, not an image or PDF", ErrInvalidArgument, path, mimeType)
	}
	return data, mimeType, nil
}

// attachment is a staged file as one message carries it.
type attachment struct {
	path string
	size int64
	pdf  bool
	// pages is a PDF's page count; exact is false when it is pdfPages' estimate.
	pages int
	exact bool
}

// inline reports whether the file's content goes with the message (an image or
// document block) rather than only its path.
func (a attachment) inline() bool { return !a.pdf || a.pages <= MaxInlinePDFPages }

// attachmentPaths returns the staged paths.
func attachmentPaths(as []attachment) []string {
	if len(as) == 0 {
		return nil
	}
	out := make([]string, len(as))
	for i, a := range as {
		out[i] = a.path
	}
	return out
}

// messageAttachments checks a message's attachment paths (checkAttachments), reads
// each PDF's page count from its file name (stagedPDFPages; pdfPages for a name
// without one), and enforces MaxMessageMediaBytes over what goes inline. A file is a
// PDF by its extension, which StageAttachment took from the sniffed content.
func messageAttachments(ctx context.Context, dir string, paths []string) ([]attachment, error) {
	clean, err := checkAttachments(dir, paths)
	if err != nil || len(clean) == 0 {
		return nil, err
	}
	out := make([]attachment, len(clean))
	var inline int64
	for i, p := range clean {
		a := attachment{path: p, pdf: strings.EqualFold(filepath.Ext(p), ".pdf")}
		if fi, err := os.Stat(p); err == nil {
			a.size = fi.Size()
		}
		if a.pdf {
			var ok bool
			if a.pages, a.exact, ok = stagedPDFPages(p); !ok {
				a.pages, a.exact = pdfPages(ctx, p)
			}
		}
		if a.inline() {
			inline += a.size
		}
		out[i] = a
	}
	if inline > MaxMessageMediaBytes {
		return nil, fmt.Errorf("%w: the attachments sent with one message total %d bytes; the limit is %d MiB", ErrInvalidArgument, inline, MaxMessageMediaBytes>>20)
	}
	return out, nil
}

// checkAttachments verifies that every path is a staged attachment: a regular file
// directly inside dir (after Clean). It returns the cleaned paths.
func checkAttachments(dir string, paths []string) ([]string, error) {
	if len(paths) == 0 {
		return nil, nil
	}
	if dir == "" {
		return nil, fmt.Errorf("%w: attachments are not enabled", ErrInvalidArgument)
	}
	dir = filepath.Clean(dir)
	out := make([]string, len(paths))
	for i, p := range paths {
		c := filepath.Clean(p)
		if !filepath.IsAbs(c) || filepath.Dir(c) != dir {
			return nil, fmt.Errorf("%w: attachment %q is not a staged attachment", ErrInvalidArgument, p)
		}
		fi, err := os.Lstat(c)
		if err != nil || !fi.Mode().IsRegular() {
			return nil, fmt.Errorf("%w: attachment %q is not a staged attachment", ErrInvalidArgument, p)
		}
		out[i] = c
	}
	return out, nil
}

// reapAttachmentsLoop reaps on every tick until Shutdown cancels m.ctx. New reaps once
// itself and then runs this under m.wg when attachments are enabled.
func (m *Manager) reapAttachmentsLoop(tick <-chan time.Time) {
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-tick:
			m.reapAttachmentsNow()
		}
	}
}

// reapAttachmentsNow removes staged attachments older than Options.AttachmentMaxAge
// and logs the outcome.
func (m *Manager) reapAttachmentsNow() {
	dir := m.opts.AttachmentsDir
	n, err := reapAttachments(dir, m.opts.Now().Add(-m.opts.AttachmentMaxAge))
	switch {
	case err != nil:
		m.log.Warn("reap staged attachments", "dir", dir, "removed", n, "err", err)
	case n > 0:
		m.log.Info("reaped staged attachments", "dir", dir, "removed", n)
	default:
		m.log.Debug("reaped staged attachments", "dir", dir, "removed", n)
	}
}

// reapAttachments deletes staged files in dir last modified before cutoff. Best
// effort: it returns how many were removed and the first error.
func reapAttachments(dir string, cutoff time.Time) (int, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("thread: reap attachments: %w", err)
	}
	n := 0
	var first error
	for _, e := range entries {
		if !e.Type().IsRegular() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		fi, err := e.Info()
		if err != nil || !fi.ModTime().Before(cutoff) {
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
			if first == nil {
				first = fmt.Errorf("thread: reap attachments: %w", err)
			}
			continue
		}
		n++
	}
	return n, first
}
