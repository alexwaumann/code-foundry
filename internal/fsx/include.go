package fsx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode"
)

// Ignored files that file search still lists (docs/notes/file-search-1-includes.md).
//
// A git checkout's candidates are git's view (tracked plus untracked files that are not
// ignored). Include patterns, .gitignore-style, add ignored files back: the
// files.include_ignored setting for every project plus each project's own list. The
// patterns are tested against `git ls-files -oi --exclude-standard --directory`, which
// lists an ignored file in a folder git looks into on its own line and a wholly ignored
// folder as one collapsed entry. A name pattern never reaches inside a collapsed folder
// that did not match itself, so .env* does not find node_modules/x/.env.

// Bounds of include patterns and of the files they add.
const (
	// MaxIncludePatterns bounds one list (the setting's, or a project's).
	MaxIncludePatterns = 100
	// MaxIncludePatternLen bounds one pattern, in bytes.
	MaxIncludePatternLen = 200
	// maxDoubleStars bounds a pattern's "**" segments (each one multiplies the matching
	// work by the path's depth).
	maxDoubleStars = 4
	// MaxIncludedFiles bounds the ignored files added to one checkout's candidates.
	MaxIncludedFiles = 20_000
	// maxIncludedVisits bounds the entries read while walking collapsed folders for one
	// checkout.
	maxIncludedVisits = 100_000
)

// IncludeNone is the setting value for "no patterns": an empty value means the default
// list, like plugins.registries.
const IncludeNone = "none"

// SplitIncludeSetting reads files.include_ignored's value: comma-separated patterns,
// trimmed, blanks and duplicates dropped, or IncludeNone for none. Invalid patterns are
// dropped (the settings store refuses them, so only a value it never accepted has any).
func SplitIncludeSetting(v string) []string {
	if strings.EqualFold(strings.TrimSpace(v), IncludeNone) {
		return nil
	}
	var out []string
	for p := range strings.SplitSeq(v, ",") {
		p = strings.TrimSpace(p)
		if p == "" || slices.Contains(out, p) || checkIncludePattern(p) != nil {
			continue
		}
		out = append(out, p)
	}
	return out
}

// CheckIncludeSetting validates files.include_ignored's value (SplitIncludeSetting's
// form): every pattern valid, at most MaxIncludePatterns. Duplicates are allowed; the
// reader drops them.
func CheckIncludeSetting(v string) error {
	if strings.EqualFold(strings.TrimSpace(v), IncludeNone) {
		return nil
	}
	var ps []string
	for p := range strings.SplitSeq(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			ps = append(ps, p)
		}
	}
	if _, err := CleanIncludePatterns(ps); err != nil {
		// The settings store says which setting; the sentinel's words add nothing.
		return errors.New(strings.TrimPrefix(err.Error(), ErrInvalidArgument.Error()+": "))
	}
	return nil
}

// CleanIncludePatterns trims each pattern, drops repeats (the first stays) and checks
// every one: not empty, at most MaxIncludePatternLen bytes, one line without control
// characters or commas (the setting is a comma-separated list), no leading "!" (there is
// nothing to re-exclude), "#" (a comment in .gitignore), "/" or "~" (not a path from the
// root of the disk or home), no "." or ".." or empty segment, at most four "**"
// segments, and a well-formed glob. At most MaxIncludePatterns patterns. Errors wrap
// ErrInvalidArgument with a message a user can read.
func CleanIncludePatterns(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	for _, p := range in {
		p = strings.TrimSpace(p)
		if err := checkIncludePattern(p); err != nil {
			return nil, err
		}
		if !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	if len(out) > MaxIncludePatterns {
		return nil, fmt.Errorf("%w: %d patterns, at most %d", ErrInvalidArgument, len(out), MaxIncludePatterns)
	}
	return out, nil
}

// checkIncludePattern checks one trimmed pattern (CleanIncludePatterns' rules).
func checkIncludePattern(p string) error {
	bad := func(why string) error {
		return fmt.Errorf("%w: pattern %q %s", ErrInvalidArgument, p, why)
	}
	switch {
	case p == "":
		return fmt.Errorf("%w: a pattern is empty", ErrInvalidArgument)
	case len(p) > MaxIncludePatternLen:
		return bad(fmt.Sprintf("is longer than %d characters", MaxIncludePatternLen))
	case strings.IndexFunc(p, unicode.IsControl) >= 0:
		return bad("has a control character; one pattern per line")
	case strings.Contains(p, ","):
		return bad("has a comma, which separates patterns")
	case strings.HasPrefix(p, "!"):
		return bad("starts with !: these patterns only add files, so there is nothing to exclude again")
	case strings.HasPrefix(p, "#"):
		return bad("starts with #, which .gitignore reads as a comment")
	case strings.HasPrefix(p, "/"):
		return bad("starts with /: patterns are relative to the project folder")
	case p == "~" || strings.HasPrefix(p, "~/"):
		return bad("starts with ~: patterns are relative to the project folder")
	}
	stars := 0
	for seg := range strings.SplitSeq(strings.TrimSuffix(p, "/"), "/") {
		switch seg {
		case "":
			return bad("has an empty segment (//)")
		case ".", "..":
			return bad(fmt.Sprintf("has a %q segment; patterns name paths inside the project", seg))
		case "**":
			stars++
		}
		if _, err := path.Match(seg, ""); err != nil {
			return bad("is not a valid glob (check its [ ] and \\)")
		}
	}
	if stars > maxDoubleStars {
		return bad(fmt.Sprintf("has more than %d ** segments", maxDoubleStars))
	}
	return nil
}

// includePattern is a compiled include pattern with .gitignore's rules: a trailing "/"
// matches directories only; a pattern with another "/" is anchored at the checkout's
// root and matched segment by segment ("*", "?" and "[...]" within a segment, "**" for
// any number of segments, "/**" at the end for everything inside); a pattern without
// one matches a name at any depth.
type includePattern struct {
	segs     []string
	dirOnly  bool
	anchored bool
}

// compileIncludes compiles valid patterns, skipping invalid ones.
func compileIncludes(patterns []string) []includePattern {
	out := make([]includePattern, 0, len(patterns))
	for _, p := range patterns {
		if checkIncludePattern(p) != nil {
			continue
		}
		c := includePattern{dirOnly: strings.HasSuffix(p, "/")}
		p = strings.TrimSuffix(p, "/")
		c.anchored = strings.Contains(p, "/")
		for seg := range strings.SplitSeq(p, "/") {
			if seg == "**" && len(c.segs) > 0 && c.segs[len(c.segs)-1] == "**" {
				continue // a/**/**/b is a/**/b
			}
			c.segs = append(c.segs, seg)
		}
		out = append(out, c)
	}
	return out
}

// match reports whether the pattern matches rel ("/"-separated, relative to the
// checkout) itself, a directory when isDir. It does not look at rel's parents.
func (p includePattern) match(rel string, isDir bool) bool {
	if p.dirOnly && !isDir {
		return false
	}
	if !p.anchored {
		ok, _ := path.Match(p.segs[0], path.Base(rel))
		return ok
	}
	return matchSegs(p.segs, strings.Split(rel, "/"))
}

// matchSegs matches pattern segments against path segments; "**" takes zero or more
// segments, and a trailing "**" one or more (what is inside, not the folder itself).
func matchSegs(p, s []string) bool {
	for len(p) > 0 {
		if p[0] == "**" {
			p = p[1:]
			if len(p) == 0 {
				return len(s) > 0
			}
			for i := range len(s) + 1 {
				if matchSegs(p, s[i:]) {
					return true
				}
			}
			return false
		}
		if len(s) == 0 {
			return false
		}
		if ok, _ := path.Match(p[0], s[0]); !ok {
			return false
		}
		p, s = p[1:], s[1:]
	}
	return len(s) == 0
}

// names reports whether the pattern's leading segments name dir's segments one by one,
// with no "**" among them, and it has segments left for what is inside: the only way a
// pattern reaches into a collapsed folder that did not match itself
// (build/reports/*.html into build/; never .env*, never **/.env).
func (p includePattern) names(dir string) bool {
	if !p.anchored {
		return false
	}
	ds := strings.Split(dir, "/")
	if len(p.segs) <= len(ds) {
		return false
	}
	for i, d := range ds {
		if p.segs[i] == "**" {
			return false
		}
		if ok, _ := path.Match(p.segs[i], d); !ok {
			return false
		}
	}
	return true
}

// mayContain reports whether something under dir, a folder inside a collapsed folder the
// pattern named, could match: like names, but a "**" lets everything below through.
func (p includePattern) mayContain(dir string) bool {
	ds := strings.Split(dir, "/")
	for i, d := range ds {
		if i >= len(p.segs)-1 {
			return p.segs[len(p.segs)-1] == "**"
		}
		if p.segs[i] == "**" {
			return true
		}
		if ok, _ := path.Match(p.segs[i], d); !ok {
			return false
		}
	}
	return true
}

// matchAny reports whether any pattern matches rel itself.
func matchAny(ps []includePattern, rel string, isDir bool) bool {
	return slices.ContainsFunc(ps, func(p includePattern) bool { return p.match(rel, isDir) })
}

// matchUp reports whether any pattern matches rel or one of its parent folders, which
// .gitignore treats as matching everything inside them.
func matchUp(ps []includePattern, rel string, isDir bool) bool {
	if matchAny(ps, rel, isDir) {
		return true
	}
	for d := path.Dir(rel); d != "." && d != "/"; d = path.Dir(d) {
		if matchAny(ps, d, true) {
			return true
		}
	}
	return false
}

// IgnoredEntry is one line of a checkout's ignored listing.
type IgnoredEntry struct {
	// Path is relative to the checkout, "/"-separated, no trailing "/".
	Path string
	// Dir: a collapsed folder, ignored as a whole; git did not look inside.
	Dir bool
}

// ignoredTimeout bounds the ignored listing.
const ignoredTimeout = 15 * time.Second

// IgnoredEntries lists a git checkout's ignored, untracked entries (git ls-files -oi
// --exclude-standard --directory): files git saw one by one, and collapsed folders.
// Git also prints an untracked folder whose files are all ignored, then the files in
// it; such a folder is dropped (its files are listed), so a Dir entry is always a
// folder git did not look into. Sorted by path. At most MaxGitFiles entries; truncated
// reports more.
func IgnoredEntries(ctx context.Context, dir string) (entries []IgnoredEntry, truncated bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, ignoredTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", dir, "ls-files", "-oi", "--exclude-standard", "--directory", "-z")
	cmd.Env = gitEnv(os.Environ())
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	outb, err := cmd.Output()
	if err != nil {
		return nil, false, fmt.Errorf("fsx: git ls-files -oi in %s: %w: %s", dir, err, strings.TrimSpace(stderr.String()))
	}
	var lines []string
	for p := range bytes.SplitSeq(outb, []byte{0}) {
		if len(p) > 0 {
			lines = append(lines, string(p))
		}
	}
	return parseIgnored(lines)
}

// parseIgnored turns ls-files -oi --directory lines into entries (IgnoredEntries).
func parseIgnored(lines []string) (entries []IgnoredEntry, truncated bool, err error) {
	slices.Sort(lines)
	lines = slices.Compact(lines)
	for i, l := range lines {
		name, isDir := strings.CutSuffix(l, "/")
		name = strings.TrimPrefix(name, "./")
		if name == "" {
			continue
		}
		// Lines under a folder sort right after it ("a/" < "a/x"; "a-b" sorts before "a/").
		if isDir && i+1 < len(lines) && strings.HasPrefix(lines[i+1], l) {
			continue
		}
		if len(entries) == MaxGitFiles {
			return entries, true, nil
		}
		entries = append(entries, IgnoredEntry{Path: name, Dir: isDir})
	}
	return entries, false, nil
}

// IncludedIgnored lists the ignored files of the git checkout dir that patterns
// include, "/"-separated and relative to dir, at most MaxIncludedFiles (truncated
// reports more). This is the one rule for which ignored files file search (and later
// text search) reads.
func IncludedIgnored(ctx context.Context, dir string, patterns []string) (files []string, truncated bool, err error) {
	ps := compileIncludes(patterns)
	if len(ps) == 0 {
		return nil, false, nil
	}
	entries, capped, err := IgnoredEntries(ctx, dir)
	if err != nil {
		return nil, false, err
	}
	files, truncated, err = includedFrom(ctx, dir, entries, ps, MaxIncludedFiles)
	return files, truncated || capped, err
}

// includedFrom applies the rules: an entry a pattern matches (itself or through a
// parent folder) is included; a collapsed folder is then walked for its files. A
// collapsed folder that no pattern matches is walked only for the anchored patterns
// that name it (includePattern.names), testing those against what is inside.
func includedFrom(ctx context.Context, dir string, entries []IgnoredEntry, ps []includePattern, max int) ([]string, bool, error) {
	w := &includeWalker{ctx: ctx, root: dir, max: max, budget: maxIncludedVisits}
	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		if w.full {
			break
		}
		switch {
		case !e.Dir:
			if matchUp(ps, e.Path, false) {
				w.add(e.Path)
			}
		case matchUp(ps, e.Path, true):
			w.walk(e.Path, nil)
		default:
			var named []includePattern
			for _, p := range ps {
				if p.names(e.Path) {
					named = append(named, p)
				}
			}
			if len(named) > 0 {
				w.walk(e.Path, named)
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	return w.files, w.full, nil
}

// includeWalker walks collapsed folders without following symlinks, skipping .git,
// within a budget of entries read and files kept.
type includeWalker struct {
	ctx    context.Context
	root   string
	max    int
	budget int
	files  []string
	full   bool // max files kept, or the budget spent
}

func (w *includeWalker) add(rel string) {
	if len(w.files) >= w.max {
		w.full = true
		return
	}
	w.files = append(w.files, rel)
}

// walk adds the files under rel: all of them when ps is nil, else those a pattern in
// ps matches (a folder one matches brings everything in it). Folders no pattern may
// reach into are skipped. Unreadable folders are skipped.
func (w *includeWalker) walk(rel string, ps []includePattern) {
	if w.full || w.ctx.Err() != nil {
		return
	}
	des, err := os.ReadDir(filepath.Join(w.root, filepath.FromSlash(rel)))
	if err != nil {
		return
	}
	for _, de := range des {
		if w.budget--; w.budget < 0 {
			w.full = true
		}
		if w.full {
			return
		}
		name := de.Name()
		if name == ".git" {
			continue
		}
		p := rel + "/" + name
		t := de.Type()
		switch {
		case t.IsDir():
			sub := ps
			if ps != nil {
				if matchAny(ps, p, true) {
					sub = nil
				} else {
					sub = slices.DeleteFunc(slices.Clone(ps), func(q includePattern) bool { return !q.mayContain(p) })
					if len(sub) == 0 {
						continue
					}
				}
			}
			w.walk(p, sub)
		case t.IsRegular() || t&os.ModeSymlink != 0: // a link is listed, never followed
			if ps == nil || matchAny(ps, p, false) {
				w.add(p)
			}
		}
		if w.ctx.Err() != nil {
			return
		}
	}
}
