package threadtest

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// ShowHTML records "ShowHTML <id> <path>" and appends an html item with the path as
// given (relative to the thread's worktree path when inside it). It checks only that
// the path is absolute and the thread exists; the real store checks the file. It never
// reuses a card (the real store's shownHTML).
func (f *Fake) ShowHTML(_ context.Context, id, path, title string, _ thread.ShowHTMLOptions) (thread.ShowHTMLResult, error) {
	f.mu.Lock()
	if err := f.record("ShowHTML " + id + " " + path); err != nil {
		f.mu.Unlock()
		return thread.ShowHTMLResult{}, err
	}
	s, err := f.get(id)
	if err != nil {
		f.mu.Unlock()
		return thread.ShowHTMLResult{}, err
	}
	if !filepath.IsAbs(path) {
		f.mu.Unlock()
		return thread.ShowHTMLResult{}, fmt.Errorf("%w: path %q is not an absolute path", thread.ErrInvalidArgument, path)
	}
	page := &thread.HTMLPage{Path: path, Title: title, BaseDir: s.WorktreePath}
	if rel, err := filepath.Rel(s.WorktreePath, path); s.WorktreePath != "" && err == nil && filepath.IsLocal(rel) {
		page.Path = filepath.ToSlash(rel)
	}
	f.next++
	it, ev := f.appendItem(id, thread.Item{ID: fmt.Sprintf("html-%d", f.next), Kind: thread.KindHTML, HTML: page})
	f.mu.Unlock()
	bus.Publish(f.bus, ev)
	return thread.ShowHTMLResult{Item: it}, nil
}
