package session

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

// Attachments are images staged for a new session's first prompt. The GUI uploads
// them with StageAttachment before Create; Create appends one "Attached image: <path>"
// line per path and Claude reads them with its Read tool. Staged files are kept so a
// later turn can read them again (and so what a thread was sent can be inspected when
// debugging). The Manager reaps files older than Options.AttachmentMaxAge (default
// AttachmentMaxAge) when it starts and then every Options.AttachmentReapInterval
// (default AttachmentReapInterval) until Shutdown, since the daemon runs for days.
// Reaping only removes regular, non-hidden files directly in the directory.

// MaxAttachmentBytes bounds one staged attachment.
const MaxAttachmentBytes = 10 << 20

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
}

// attachmentType validates a declared MIME type against the data and returns the
// extension to store it with. The declared type must be accepted and the content must
// sniff as an accepted image type too (the stored extension follows the content).
func attachmentType(mimeType string, data []byte) (string, error) {
	declared, _, err := mime.ParseMediaType(mimeType)
	if err != nil || AttachmentTypes[declared] == "" {
		return "", fmt.Errorf("%w: attachment type %q (want image/png, image/jpeg, image/gif or image/webp)", ErrInvalidArgument, mimeType)
	}
	switch {
	case len(data) == 0:
		return "", fmt.Errorf("%w: attachment is empty", ErrInvalidArgument)
	case len(data) > MaxAttachmentBytes:
		return "", fmt.Errorf("%w: attachment is %d bytes; the limit is %d MiB", ErrInvalidArgument, len(data), MaxAttachmentBytes>>20)
	}
	sniffed := http.DetectContentType(data)
	ext := AttachmentTypes[sniffed]
	if ext == "" {
		return "", fmt.Errorf("%w: attachment declared %s but its content is %s", ErrInvalidArgument, declared, sniffed)
	}
	return ext, nil
}

// StageAttachment writes an image under Options.AttachmentsDir and returns its path.
func (m *Manager) StageAttachment(_ context.Context, name, mimeType string, data []byte) (string, error) {
	dir := m.opts.AttachmentsDir
	if dir == "" {
		return "", fmt.Errorf("%w: attachments are not enabled", ErrFailedPrecondition)
	}
	ext, err := attachmentType(mimeType, data)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("session: attachments dir: %w", err)
	}
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("session: attachment name: %w", err)
	}
	path := filepath.Join(dir, hex.EncodeToString(b[:])+ext)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", fmt.Errorf("session: stage attachment: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return "", fmt.Errorf("session: stage attachment: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("session: stage attachment: %w", err)
	}
	m.log.Info("attachment staged", "path", path, "name", name, "bytes", len(data))
	return path, nil
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
		return 0, fmt.Errorf("session: reap attachments: %w", err)
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
				first = fmt.Errorf("session: reap attachments: %w", err)
			}
			continue
		}
		n++
	}
	return n, first
}
