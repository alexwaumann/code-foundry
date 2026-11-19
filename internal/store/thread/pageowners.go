package thread

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"time"
)

// Pages' owners (docs/notes/page-ownership-daemon.md): the daemon keeps which thread owns
// each HTML page file, so the GUI gives a page its thread's bridge without the thread's
// log. This store says when a thread shows a page (ShowHTML: view.inline) or its Claude
// writes or edits one (a Write, Edit or MultiEdit call that succeeded, the thread's own or
// a subagent's); the page store (internal/store/page) keeps it, latest wins. A page written
// any other way (a Bash redirect, a script) is not seen here: it is owned once it is shown.

// PageRecorder records thread id as the owner of the page at path, how ("shown",
// "written"); internal/store/page.Store. A path it refuses (not an HTML file under home,
// a guarded one) is not recorded and its error only logged.
type PageRecorder interface {
	Record(ctx context.Context, id, path, how string) error
}

// How a thread came to own a page (page.Shown, page.Written).
const (
	pageShown   = "shown"
	pageWritten = "written"
)

// pageRecordTimeout bounds one record: a SQLite write and a symlink resolution.
const pageRecordTimeout = 5 * time.Second

// SetPageRecorder sets where the threads' pages are recorded; nil records nothing.
func (m *Manager) SetPageRecorder(r PageRecorder) {
	if r == nil {
		m.pageRecorder.Store(nil)
		return
	}
	m.pageRecorder.Store(&r)
}

// recordPage records thread id as path's owner, how; a refusal is logged at debug (a
// thread writes many files that are no pages anyone opens).
func (m *Manager) recordPage(id, path, how string) {
	r := m.pageRecorder.Load()
	if r == nil || path == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), pageRecordTimeout)
	defer cancel()
	if err := (*r).Record(ctx, id, path, how); err != nil {
		m.log.Debug("a page's owner not recorded", "thread", id, "path", path, "how", how, "err", err)
	}
}

// writtenPage is the HTML file a finished tool call wrote, "" for any other call: a
// Write, Edit or MultiEdit of an absolute .html or .htm path.
func writtenPage(t *ToolCall) string {
	if t == nil || t.IsError || t.Status != ToolDone {
		return ""
	}
	switch t.Name {
	case "Write", "Edit", "MultiEdit":
	default:
		return ""
	}
	var in struct {
		FilePath string `json:"file_path"`
	}
	if json.Unmarshal([]byte(t.InputJSON), &in) != nil || !filepath.IsAbs(in.FilePath) {
		return ""
	}
	switch strings.ToLower(filepath.Ext(in.FilePath)) {
	case ".html", ".htm":
		return filepath.Clean(in.FilePath)
	}
	return ""
}
