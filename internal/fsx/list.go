package fsx

import (
	"cmp"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf8"
)

// MaxEntries is the default bound on one listing.
const MaxEntries = 200

// Entry is one directory a prefix can complete to.
type Entry struct {
	// Path is the absolute path as typed (with "~" expanded, symlinks kept).
	Path string
	Name string
	// IsGit is set when the directory contains a .git entry.
	IsGit bool
	// Registered is set when Lister.Registered reports the resolved path.
	Registered bool
}

// Listing is the result of Lister.List.
type Listing struct {
	// Entries are sorted by name, case-insensitively.
	Entries []Entry
	// Completion is the longest extension of the prefix shared by every match, in the
	// prefix's own spelling; with exactly one match it is that directory plus "/".
	Completion string
	// Truncated is set when more than the bound matched.
	Truncated bool
}

// Lister completes path prefixes to directories under Root.
type Lister struct {
	// Root is the allowed root and what "~" expands to: the user's home directory in
	// the daemon, a temp dir in tests. Absolute, symlinks resolved (see ResolveRoot).
	Root string
	// Registered reports whether a resolved directory path is already a project. Nil
	// means none is.
	Registered func(path string) bool
	// Max bounds the entries returned. Zero means MaxEntries.
	Max int
}

// List completes prefix ("~", "~/co", "/Users/me/co", "~/code/") to directories. The
// last segment is matched case-insensitively against the entries of the directory
// before it; dot-directories are listed only when that segment starts with ".". A
// directory that does not exist or cannot be read yields an empty listing. A prefix
// that is relative, names another user's home, or resolves outside Root is
// ErrInvalidArgument.
func (l Lister) List(prefix string) (Listing, error) {
	if prefix == "" || prefix == "~" {
		prefix = "~/"
	}
	var abs string
	switch {
	case strings.HasPrefix(prefix, "~/"):
		abs = l.Root + prefix[1:]
	case strings.HasPrefix(prefix, "~"):
		return Listing{}, fmt.Errorf("%w: ~user paths are not supported: %q", ErrInvalidArgument, prefix)
	case !strings.HasPrefix(prefix, "/"):
		return Listing{}, fmt.Errorf("%w: want an absolute path or one starting with ~, got %q", ErrInvalidArgument, prefix)
	default:
		abs = prefix
	}
	typedDir, base := splitLast(prefix)
	absDir, _ := splitLast(abs)
	absDir = filepath.Clean(absDir)

	empty := Listing{Completion: prefix}
	real, err := filepath.EvalSymlinks(absDir)
	if err != nil {
		// A directory that does not exist (yet) is fine to type towards, as long as
		// it would be inside the root.
		if !Within(l.Root, absDir) {
			return Listing{}, fmt.Errorf("%w: %s is outside your home directory", ErrInvalidArgument, prefix)
		}
		return empty, nil
	}
	if !Within(l.Root, real) {
		return Listing{}, fmt.Errorf("%w: %s is outside your home directory", ErrInvalidArgument, prefix)
	}
	dirents, err := os.ReadDir(real)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.ENOTDIR) {
			return empty, nil
		}
		return Listing{}, fmt.Errorf("fsx: list %s: %w", absDir, err)
	}

	showDot := strings.HasPrefix(base, ".")
	lowBase := strings.ToLower(base)
	var names []string
	for _, d := range dirents {
		name := d.Name()
		if !showDot && strings.HasPrefix(name, ".") {
			continue
		}
		if !strings.HasPrefix(strings.ToLower(name), lowBase) {
			continue
		}
		isDir := d.IsDir()
		if d.Type()&fs.ModeSymlink != 0 {
			fi, err := os.Stat(filepath.Join(real, name))
			isDir = err == nil && fi.IsDir()
		}
		if isDir {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return empty, nil
	}
	slices.SortFunc(names, func(a, b string) int {
		return cmp.Or(cmp.Compare(strings.ToLower(a), strings.ToLower(b)), cmp.Compare(a, b))
	})

	out := Listing{Completion: typedDir + commonFoldPrefix(names)}
	if len(names) == 1 {
		out.Completion = typedDir + names[0] + "/"
	}
	limit := cmp.Or(l.Max, MaxEntries)
	if len(names) > limit {
		names, out.Truncated = names[:limit], true
	}
	out.Entries = make([]Entry, len(names))
	for i, name := range names {
		resolved := filepath.Join(real, name)
		if r, err := filepath.EvalSymlinks(resolved); err == nil {
			resolved = r
		}
		_, gitErr := os.Lstat(filepath.Join(resolved, ".git"))
		out.Entries[i] = Entry{
			Path:       filepath.Join(absDir, name),
			Name:       name,
			IsGit:      gitErr == nil,
			Registered: l.Registered != nil && l.Registered(resolved),
		}
	}
	return out, nil
}

// splitLast splits p after its last "/": "~/co" -> "~/", "co".
func splitLast(p string) (dir, base string) {
	i := strings.LastIndexByte(p, '/')
	return p[:i+1], p[i+1:]
}

// commonFoldPrefix is the longest prefix of names[0] that every name starts with,
// ignoring case. It never splits a rune.
func commonFoldPrefix(names []string) string {
	first := names[0]
	n := len(first)
	for _, other := range names[1:] {
		i, j := 0, 0
		for i < n && j < len(other) {
			a, sa := utf8.DecodeRuneInString(first[i:])
			b, sb := utf8.DecodeRuneInString(other[j:])
			if a != b && !foldEqual(a, b) {
				break
			}
			i, j = i+sa, j+sb
		}
		n = i
	}
	return first[:n]
}

// foldEqual reports whether a and b are equal under Unicode simple case folding.
func foldEqual(a, b rune) bool {
	for f := unicode.SimpleFold(a); f != a; f = unicode.SimpleFold(f) {
		if f == b {
			return true
		}
	}
	return false
}
