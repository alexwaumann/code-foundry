package thread

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
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
	declared, err := declaredAttachmentType(mimeType)
	if err != nil {
		return "", err
	}
	return contentAttachmentType(declared, data, int64(len(data)))
}

// declaredAttachmentType parses a declared MIME type and checks it is accepted.
func declaredAttachmentType(mimeType string) (string, error) {
	declared, _, err := mime.ParseMediaType(mimeType)
	if err != nil || AttachmentTypes[declared] == "" {
		return "", unsupportedAttachmentType(mimeType)
	}
	return declared, nil
}

// unsupportedAttachmentType is the error for a type outside AttachmentTypes, declared
// by the client or (for a file staged by path) sniffed from the content.
func unsupportedAttachmentType(mimeType string) error {
	return fmt.Errorf("%w: attachment type %q (want image/png, image/jpeg, image/gif, image/webp or application/pdf)", ErrInvalidArgument, mimeType)
}

// contentAttachmentType sniffs content of size bytes from head, its first bytes (at
// least the first 512 when there are that many, all http.DetectContentType reads),
// checks the type is accepted and the size within its limit, and returns the
// extension to store it with. declared is the client's type, or "" when it gave none
// (a file staged by path), in which case unsupported content gets the
// unsupported-type error.
func contentAttachmentType(declared string, head []byte, size int64) (string, error) {
	if size == 0 {
		return "", fmt.Errorf("%w: attachment is empty", ErrInvalidArgument)
	}
	sniffed := http.DetectContentType(head)
	ext := AttachmentTypes[sniffed]
	switch {
	case ext == "" && declared == "":
		return "", unsupportedAttachmentType(sniffed)
	case ext == "":
		return "", fmt.Errorf("%w: attachment declared %s but its content is %s", ErrInvalidArgument, declared, sniffed)
	}
	if size > attachmentLimit(ext) {
		return "", attachmentTooLarge(ext, size)
	}
	return ext, nil
}

// attachmentLimit is the size limit for a stored extension: MaxPDFAttachmentBytes for
// a PDF, else MaxAttachmentBytes.
func attachmentLimit(ext string) int64 {
	if ext == ".pdf" {
		return MaxPDFAttachmentBytes
	}
	return MaxAttachmentBytes
}

// attachmentTooLarge is the error for size bytes of a type (by its stored extension)
// over its limit.
func attachmentTooLarge(ext string, size int64) error {
	what := "an image"
	if ext == ".pdf" {
		what = "a PDF"
	}
	return fmt.Errorf("%w: attachment is %d bytes; the limit for %s is %d MiB", ErrInvalidArgument, size, what, attachmentLimit(ext)>>20)
}

// attachmentsDir is Options.AttachmentsDir, or ErrFailedPrecondition when attachments
// are not enabled.
func (m *Manager) attachmentsDir() (string, error) {
	if m.opts.AttachmentsDir == "" {
		return "", fmt.Errorf("%w: attachments are not enabled", ErrFailedPrecondition)
	}
	return m.opts.AttachmentsDir, nil
}

// StageAttachment writes an image or PDF under Options.AttachmentsDir and returns its
// path: <32 hex><ext> for an image; <32 hex>-<N>p.pdf for a PDF, or <32 hex>-~<N>p.pdf
// when N is the size estimate (settlePDFPages, with pages as the client's hint). The
// count is settled here once, so every message that sends the file agrees with it.
func (m *Manager) StageAttachment(ctx context.Context, name, mimeType string, data []byte, pages int) (string, error) {
	if _, err := m.attachmentsDir(); err != nil {
		return "", err
	}
	ext, err := attachmentType(mimeType, data)
	if err != nil {
		return "", err
	}
	return m.stageAttachment(ctx, name, ext, pages, func(w io.Writer) (int64, error) {
		n, err := w.Write(data)
		return int64(n), err
	})
}

// StageAttachmentFile stages the file at path like StageAttachment stages bytes: the
// same types (sniffed from the content; mimeType, when set, is checked like
// StageAttachment's), limits, page count and naming. path must be absolute (else
// ErrInvalidArgument) and name a regular file (ErrNotFound when missing,
// ErrInvalidArgument for a directory or anything else). The size limit is checked
// before the copy, which streams; a file that grows past it meanwhile is refused too.
func (m *Manager) StageAttachmentFile(ctx context.Context, path, mimeType string, pages int) (string, error) {
	if _, err := m.attachmentsDir(); err != nil {
		return "", err
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("%w: attachment path %q is not absolute", ErrInvalidArgument, path)
	}
	declared := ""
	if mimeType != "" {
		var err error
		if declared, err = declaredAttachmentType(mimeType); err != nil {
			return "", err
		}
	}
	// Stat before opening: opening a FIFO would block.
	fi, err := os.Stat(path)
	if err != nil {
		return "", attachmentFileError(path, err)
	}
	if fi.IsDir() {
		return "", fmt.Errorf("%w: attachment %q is a directory", ErrInvalidArgument, path)
	}
	if !fi.Mode().IsRegular() {
		return "", fmt.Errorf("%w: attachment %q is not a regular file", ErrInvalidArgument, path)
	}
	f, err := os.Open(path)
	if err != nil {
		return "", attachmentFileError(path, err)
	}
	defer func() { _ = f.Close() }()
	head := make([]byte, 512)
	n, err := io.ReadFull(f, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return "", attachmentFileError(path, err)
	}
	ext, err := contentAttachmentType(declared, head[:n], fi.Size())
	if err != nil {
		return "", err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", attachmentFileError(path, err)
	}
	limit := attachmentLimit(ext)
	return m.stageAttachment(ctx, filepath.Base(path), ext, pages, func(w io.Writer) (int64, error) {
		n, err := io.Copy(w, io.LimitReader(f, limit+1))
		if err == nil && n > limit {
			err = attachmentTooLarge(ext, n)
		}
		return n, err
	})
}

// attachmentFileError maps an error reading a file staged by path: ErrNotFound when it
// does not exist, else ErrInvalidArgument (not readable by the daemon's user).
func attachmentFileError(path string, err error) error {
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w: attachment %q does not exist", ErrNotFound, path)
	}
	return fmt.Errorf("%w: attachment %q: %w", ErrInvalidArgument, path, err)
}

// stageAttachment creates a fresh file in the attachments directory, fills it with
// write and, for a PDF, settles the page count into its name (StageAttachment's
// naming). ext is the checked extension; name is only logged. A failed write removes
// the file; its ErrInvalidArgument (a limit) is returned as is.
func (m *Manager) stageAttachment(ctx context.Context, name, ext string, pages int, write func(io.Writer) (int64, error)) (string, error) {
	dir, err := m.attachmentsDir()
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
	size, err := write(f)
	if err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		if errors.Is(err, ErrInvalidArgument) {
			return "", err
		}
		return "", fmt.Errorf("thread: stage attachment: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("thread: stage attachment: %w", err)
	}
	if ext != ".pdf" {
		m.log.Info("attachment staged", "path", path, "name", name, "bytes", size)
		return path, nil
	}
	n, exact := settlePDFPages(ctx, path, size, pages)
	counted := filepath.Join(dir, pdfFileName(stem, n, exact))
	if err := os.Rename(path, counted); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("thread: stage attachment: %w", err)
	}
	m.log.Info("attachment staged", "path", counted, "name", name, "bytes", size, "pages", n, "exact", exact, "hint", pages)
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
