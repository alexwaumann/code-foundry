package thread

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// Inline HTML pages (docs/notes/inline-html.md): `code-foundry view.inline <path>` puts
// an html item in a thread's conversation, which the GUI renders as a sandboxed frame
// served from disk (FilesystemService.PreviewFile), so a restart re-renders it. The item
// holds the path (relative to the thread's cwd when inside it), the caller's title and
// the cwd it was relative to; never the page's content.

// KindHTML is an HTML page shown inline (ShowHTML): Item.HTML says which.
const KindHTML ItemKind = "html"

// HTMLPage is an html item's payload.
type HTMLPage struct {
	// Path is relative to BaseDir when the file is inside it, else absolute.
	Path  string `json:"path"`
	Title string `json:"title,omitempty"`
	// BaseDir is the thread's cwd when the item was made.
	BaseDir string `json:"base_dir,omitempty"`
}

// htmlPage checks path for ShowHTML and returns the item's payload: an absolute path to
// a regular .html or .htm file under home (symlinks followed), stored relative to cwd
// when it is inside it.
func htmlPage(home, cwd, path, title string) (*HTMLPage, error) {
	if path == "" || !filepath.IsAbs(path) {
		return nil, fmt.Errorf("%w: path %q is not an absolute path", ErrInvalidArgument, path)
	}
	path = filepath.Clean(path)
	switch strings.ToLower(filepath.Ext(path)) {
	case ".html", ".htm":
	default:
		return nil, fmt.Errorf("%w: %s is not an .html or .htm file", ErrInvalidArgument, path)
	}
	if !fsx.Within(home, path) {
		return nil, fmt.Errorf("%w: %s is outside your home directory", ErrInvalidArgument, path)
	}
	real, err := filepath.EvalSymlinks(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, pageNotFound("no file at " + path)
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %w", ErrInvalidArgument, path, err)
	}
	if realHome, err := filepath.EvalSymlinks(home); err == nil && !fsx.Within(realHome, real) && !fsx.Within(home, real) {
		return nil, fmt.Errorf("%w: %s links outside your home directory", ErrInvalidArgument, path)
	}
	fi, err := os.Stat(real)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %w", ErrInvalidArgument, path, err)
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: %s is not a file", ErrInvalidArgument, path)
	}
	p := &HTMLPage{Path: path, Title: strings.TrimSpace(title), BaseDir: cwd}
	if cwd != "" && fsx.Within(cwd, path) && path != cwd {
		if rel, err := filepath.Rel(cwd, path); err == nil {
			p.Path = filepath.ToSlash(rel)
		}
	}
	return p, nil
}

// pageNotFound is ErrNotFound with its own message: "thread not found: no file at …"
// would send the caller looking for the thread (inline-html-2-fixes.md).
type pageNotFound string

func (e pageNotFound) Error() string { return string(e) }

// Is makes errors.Is(err, ErrNotFound) hold.
func (e pageNotFound) Is(target error) bool { return target == ErrNotFound }

// ShowHTML implements Store: it appends an html item for path to thread id, on the
// runner's goroutine while it runs (inside the running turn: the model calls it from a
// tool), else straight onto the stopped thread's log.
func (m *Manager) ShowHTML(ctx context.Context, id, path, title string) (Item, error) {
	return m.verbItem(ctx, id, func(s Thread) (Item, error) {
		cwd := s.WorktreePath
		if cwd == "" {
			cwd = m.opts.Home
		}
		page, err := htmlPage(m.opts.Home, cwd, path, title)
		if err != nil {
			return Item{}, err
		}
		return Item{Kind: KindHTML, HTML: page}, nil
	})
}

// verbItem appends the item a verb adds to a thread's conversation (an html page, a
// theme card: the daemon's, not Claude's), which build makes from the thread's record. On
// the runner's goroutine while it runs, so it lands inside the running turn after the
// tool call that made it; else straight onto the stopped thread's log. The item's id is
// "<kind>-…".
func (m *Manager) verbItem(ctx context.Context, id string, build func(Thread) (Item, error)) (Item, error) {
	for {
		live, closing, reserved, s, err := m.lifecycle(id)
		if err != nil {
			return Item{}, err
		}
		it, err := build(s)
		if err != nil {
			return Item{}, err
		}
		switch {
		case live != nil:
			got, err := live.call(ctx, threadCmd{verb: &it})
			if errors.Is(err, errProcessGone) {
				continue
			}
			return got, err
		case closing != nil:
			if err := waitDone(ctx, closing); err != nil {
				return Item{}, err
			}
			continue
		case reserved != nil:
			select {
			case <-reserved:
			case <-ctx.Done():
				return Item{}, ctx.Err()
			}
			continue
		}
		log, err := m.thread(ctx, id)
		if err != nil {
			return Item{}, err
		}
		w := itemWriter{log: log, save: func(it Item) { m.saveItem(id, it) }}
		it.ID = string(it.Kind) + "-" + itemSuffix()
		return w.add(it), nil
	}
}

// onVerbItem is verbItem on the runner's goroutine.
func (r *runner) onVerbItem(it Item) Item {
	it.ID = r.st.proj.nextID(string(it.Kind))
	return r.st.proj.w.add(it)
}
