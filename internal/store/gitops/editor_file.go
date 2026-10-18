package gitops

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"slices"
	"strconv"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// OpenOptions names what OpenEditor and Reveal open: a worktree, or one file.
type OpenOptions struct {
	WorktreePath string
	// File is absolute or relative to WorktreePath, and must be under Options.Root;
	// empty opens the worktree.
	File string
	// Line is 1-based (OpenEditor only); 0 for none.
	Line int
}

// resolveFile makes file absolute against the worktree and checks it (symlinks
// resolved when it exists) is under the root. Empty stays empty.
func (m *Manager) resolveFile(t target, file string) (string, error) {
	if file == "" {
		return "", nil
	}
	p := file
	if !filepath.IsAbs(p) {
		p = filepath.Join(t.path, p)
	}
	p = filepath.Clean(p)
	check := p
	if real, err := filepath.EvalSymlinks(p); err == nil {
		check = real
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("%w: file %s: %v", ErrInvalidArgument, file, err)
	}
	if m.opts.Root == "" || !fsx.Within(m.opts.Root, check) {
		return "", fmt.Errorf("%w: %s is outside your home directory", ErrInvalidArgument, file)
	}
	return p, nil
}

// lineSyntax is how an editor's CLI takes a line number.
type lineSyntax int

const (
	lineNone  lineSyntax = iota // only the file
	lineGoto                    // -g file:line (VS Code and its forks)
	lineColon                   // file:line
)

var editorLines = map[string]lineSyntax{
	"code": lineGoto, "code-insiders": lineGoto, "cursor": lineGoto, "windsurf": lineGoto,
	"zed": lineColon, "subl": lineColon,
}

// editorArgs fills an editor argv template (PathPlaceholder where the path goes, as
// resolveEditor returns it for PathPlaceholder) with file, at line when the editor
// takes one. `open -a App` and unknown editors get only the file.
func editorArgs(template []string, file string, line int) []string {
	syntax := lineNone
	if len(template) > 0 && line > 0 {
		syntax = editorLines[filepath.Base(template[0])]
	}
	if syntax == lineNone {
		return withPath(template, file)
	}
	target := file + ":" + strconv.Itoa(line)
	argv := withPath(template, target)
	if syntax == lineGoto {
		if i := slices.Index(argv, target); i > 0 {
			argv = slices.Insert(argv, i, "-g")
		}
	}
	return argv
}
