package command

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// view.open.diff (docs/notes/diff-viewer-3.md): what a thread shows in a Diff tab. Its
// check is the tab's own read (ProjectService.CompareWorktree), so a call that would show
// nothing fails instead. The checkout's own tab is the user's: a call that names a side,
// narrows the list, says something or hides a control gets a tab of its own (the "thread" param).

const (
	// maxDiffTitle is the longest --title, in characters: it is a tab's name.
	maxDiffTitle = 100
	// diffSourceHelp says what --base and --head take.
	diffSourceHelp = "working, staged, merge-base, or any branch, tag or sha"
)

// diffHides are --hide's values: the parts of the tab it can take away. The user can
// always bring them back from the tab.
var diffHides = []string{"compare", "files"}

// diffArgs are view.open.diff's flags, before thread and focus.
func diffArgs() []ArgSpec {
	return []ArgSpec{
		{Name: "path", Type: Path, Positional: true, Repeatable: true, Description: "A changed file or directory in one of the thread's checkouts: absolute, or relative to the current directory. " +
			"One file is selected in the whole list; more than one, or a directory, gets a tab of its own listing only them. The checkout's root, or none: every changed file. " +
			"One that matches no changed file is named in a warning; if none does, the call is refused"},
		{Name: "base", Type: String, Description: "The older side: " + diffSourceHelp + " (default: merge-base, where the branch left its base)"},
		{Name: "head", Type: String, Description: "The newer side: " + diffSourceHelp + " (default: working, the files on disk)"},
		{Name: "scope", Type: Enum, Enum: []string{"working", "branch"}, Default: "working",
			Description: "working: the base against the file on disk, uncommitted changes included; branch: against the last commit. Not with --base or --head"},
		{Name: "title", Type: String, Description: fmt.Sprintf("Name a tab of your own with this; the same title updates the same tab. Without one, a side (--base, --head, --scope), --note, --hide or a narrowed list still get a tab of their own, and the rest pick a file in the checkout's. At most %d characters", maxDiffTitle)},
		{Name: "note", Type: String, Description: fmt.Sprintf("Why you are showing this: one plain paragraph, quoted as yours, which the user can dismiss; at most %d characters", maxEditNote)},
		{Name: "hide", Type: String, Repeatable: true, Description: "Take away a part of the tab: compare (the bar choosing the two sides) or files (the file list). The tab offers the user a way to show them again"},
	}
}

// diffSource is a --base or --head value as a source, and as the tab's param ("" for def).
func diffSource(v string, def v1.DiffSourceKind) (*v1.DiffSource, string) {
	kinds := map[string]v1.DiffSourceKind{
		"working":    v1.DiffSourceKind_DIFF_SOURCE_KIND_WORKING_TREE,
		"staged":     v1.DiffSourceKind_DIFF_SOURCE_KIND_STAGED,
		"merge-base": v1.DiffSourceKind_DIFF_SOURCE_KIND_MERGE_BASE,
	}
	switch k, named := kinds[v]; {
	case v == "":
		return &v1.DiffSource{Kind: def}, ""
	case !named:
		return &v1.DiffSource{Kind: v1.DiffSourceKind_DIFF_SOURCE_KIND_REF, Ref: v}, "ref:" + v
	case k == def:
		return &v1.DiffSource{Kind: k}, ""
	default:
		return &v1.DiffSource{Kind: k}, v
	}
}

// diffSources is the two sides a call asks for and their tab params.
func diffSources(a Args) (base, head *v1.DiffSource, baseParam, headParam string, err error) {
	if a.Given("scope") && (a.String("base") != "" || a.String("head") != "") {
		return nil, nil, "", "", InvalidArg("scope", "says the same as --base and --head: give one or the other")
	}
	base, baseParam = diffSource(a.String("base"), v1.DiffSourceKind_DIFF_SOURCE_KIND_MERGE_BASE)
	head, headParam = diffSource(a.String("head"), v1.DiffSourceKind_DIFF_SOURCE_KIND_WORKING_TREE)
	if a.String("scope") == "branch" {
		head, headParam = diffSource("HEAD", v1.DiffSourceKind_DIFF_SOURCE_KIND_WORKING_TREE)
	}
	return base, head, baseParam, headParam, nil
}

// diffCheckout is the checkout a call's paths are in: the thread's own without any. A
// thread can own several, and one tab shows one.
type diffCheckout struct {
	project, root string
	rels          []string
}

// inCheckout is path relative to root, with forward slashes, "" for root itself; false when
// it is not in it.
func inCheckout(root, path string) (string, bool) {
	rel, err := filepath.Rel(root, path)
	switch {
	case err != nil || rel == ".." || strings.HasPrefix(rel, "../"):
		return "", false
	case rel == ".":
		return "", true
	}
	return filepath.ToSlash(rel), true
}

// checkoutOf finds the deepest of the thread's checkouts holding path.
func checkoutOf(t *v1.Thread, path string) (project, root, rel string, ok bool) {
	consider := func(p, r string) {
		if v, in := inCheckout(r, path); in && len(r) > len(root) {
			project, root, rel, ok = p, r, v, true
		}
	}
	consider(t.GetProjectId(), t.GetWorktreePath())
	for _, c := range t.GetCheckoutPaths() {
		consider(c.GetProjectId(), c.GetPath())
	}
	return project, root, rel, ok
}

// resolveDiffPaths places the call's paths in one checkout. The checkout's root among them
// is every file, so it narrows nothing.
func resolveDiffPaths(t *v1.Thread, a Args) (diffCheckout, error) {
	c := diffCheckout{project: t.GetProjectId(), root: t.GetWorktreePath()}
	if a.Path("path") == "" {
		return c, nil
	}
	whole := false
	for i, p := range strings.Split(a.Path("path"), "\n") {
		project, root, rel, ok := checkoutOf(t, p)
		switch {
		case !ok:
			return c, InvalidArg("path", "%s is not a file in thread %s's worktree %s", p, t.GetId(), t.GetWorktreePath())
		case i > 0 && root != c.root:
			return c, InvalidArg("path", "%s is in %s and the paths before it in %s: one tab shows one checkout, so run this once for each", p, root, c.root)
		}
		c.project, c.root = project, root
		if rel == "" {
			whole = true
			continue
		}
		c.rels = append(c.rels, rel)
	}
	if whole {
		c.rels = nil
	}
	return c, nil
}

// diffHideParam checks --hide's values and joins them for the tab.
func diffHideParam(a Args) (string, error) {
	if a.String("hide") == "" {
		return "", nil
	}
	hide := strings.Split(a.String("hide"), "\n")
	for _, h := range hide {
		if !slices.Contains(diffHides, h) {
			return "", InvalidArg("hide", "want %s, got %q", strings.Join(diffHides, " or "), h)
		}
	}
	return strings.Join(hide, ","), nil
}

// diffText is a --title or --note as the tab may show it, within limit characters.
func diffText(a Args, name string, limit int) (string, error) {
	s := plainNote(a.String(name))
	if n := utf8.RuneCountInString(s); n > limit {
		return "", InvalidArg(name, "%d characters, at most %d", n, limit)
	}
	return s, nil
}

// diffTitle is --title as the tab shows it. One that cleans down to nothing is refused: it
// was meant to name a tab of the thread's own, and without it the call could land on the user's.
func diffTitle(a Args) (string, error) {
	s, err := diffText(a, "title", maxDiffTitle)
	if err == nil && s == "" && (a.Given("title") || a.Blank("title")) {
		return "", InvalidArg("title", "--title has no plain text left: name the tab, or leave the flag out")
	}
	return s, err
}

// diffMatches splits the call's paths into those with something to show and a warning for each
// of the others, as the daemon found them: only it saw the list before its cap.
func diffMatches(m *v1.CompareWorktreeResponse, rels []string) (listed, warnings []string) {
	for _, rel := range rels {
		if slices.Contains(m.GetUnmatchedPaths(), rel) {
			warnings = append(warnings, fmt.Sprintf("%s has no changes here (%s against %s), so it is not listed", rel, m.GetBase().GetLabel(), m.GetHead().GetLabel()))
		} else {
			listed = append(listed, rel)
		}
	}
	return listed, warnings
}

// diffWhat names the paths of a refusal, or the checkout without any.
func diffWhat(rels []string) string {
	if len(rels) == 0 {
		return "this checkout"
	}
	return strings.Join(rels, ", ")
}

// noDiff is the refusal for a comparison with nothing to show.
func noDiff(t *v1.Thread, rels []string, res *v1.CompareWorktreeResponse, branch bool) error {
	switch len(rels) {
	case 0:
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("nothing differs between %s and %s in thread %s's checkout", res.GetBase().GetLabel(), res.GetHead().GetLabel(), t.GetId()))
	case 1:
	default:
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("none of %s has changes in thread %s's worktree (%s against %s)", strings.Join(rels, ", "), t.GetId(), res.GetBase().GetLabel(), res.GetHead().GetLabel()))
	}
	what := res.GetHead().GetLabel()
	switch {
	case branch:
		what = "the last commit"
	case res.GetHead().GetKind() == v1.DiffSourceKind_DIFF_SOURCE_KIND_WORKING_TREE:
		what = "the file on disk"
	}
	return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s has no changes in thread %s's worktree (%s against %s)", rels[0], t.GetId(), res.GetBase().GetLabel(), what))
}

// runPanelDiff is view.open.diff. A tab of the thread's own names the thread that asked,
// which may not be the one whose tab opens.
func (d ViewDeps) runPanelDiff(ctx context.Context, uctx Context, a Args) (Result, error) {
	id := a.String("thread")
	if id == "" {
		return Result{}, InvalidArg("thread", "needs a thread whose tab to open (--thread, or run it inside a thread)")
	}
	asker := id
	if uctx.ActiveView == "" && uctx.CallerThreadID != "" {
		asker = uctx.CallerThreadID
	}
	var warnings []string
	res, err := d.showItem(ctx, uctx, a, id, tabDiff, func(ctx context.Context, t *v1.Thread, a Args) (map[string]string, error) {
		params, w, err := d.diffCheck(ctx, t, a, asker)
		warnings = w
		if err != nil {
			return nil, err
		}
		return d.intoUsersDiff(ctx, id, asker, params), nil
	})
	res.Warnings = warnings
	return res, err
}

// diffCheck is view.open.diff's check: the thread runs in a project worktree, its paths
// are in one of its checkouts, and the two sides differ there. Refs go to the daemon as
// given: it is the boundary, and refuses what cannot be one. It gives the tab's params and
// the paths it left out, as warnings.
func (d ViewDeps) diffCheck(ctx context.Context, t *v1.Thread, a Args, asker string) (map[string]string, []string, error) {
	if _, err := inWorktree(ctx, t, a); err != nil {
		return nil, nil, err
	}
	base, head, baseParam, headParam, err := diffSources(a)
	if err != nil {
		return nil, nil, err
	}
	c, err := resolveDiffPaths(t, a)
	if err != nil {
		return nil, nil, err
	}
	title, err := diffTitle(a)
	if err != nil {
		return nil, nil, err
	}
	note, err := diffText(a, "note", maxEditNote)
	if err != nil {
		return nil, nil, err
	}
	hide, err := diffHideParam(a)
	if err != nil {
		return nil, nil, err
	}
	res, err := d.Diffs.CompareWorktree(ctx, connect.NewRequest(&v1.CompareWorktreeRequest{ProjectId: c.project, Path: c.root, Base: base, Head: head, Paths: c.rels}))
	if err != nil {
		return nil, nil, err
	}
	m := res.Msg
	branch := a.String("scope") == "branch"
	switch {
	case m.GetError() != "":
		return nil, nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("cannot compare: %s", m.GetError()))
	case branch && m.GetBaseRef() == "":
		return nil, nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("cannot diff %s (branch): the worktree has no base branch to compare with", diffWhat(c.rels)))
	case branch && m.GetMergeBase() == "":
		return nil, nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("cannot diff %s (branch): HEAD has no merge base with %s", diffWhat(c.rels), m.GetBaseRef()))
	case len(m.GetFiles()) == 0:
		return nil, nil, noDiff(t, c.rels, m, branch)
	}
	listed, warnings := diffMatches(m, c.rels)
	params := map[string]string{"project": c.project, "worktree": c.root}
	if c.root == t.GetWorktreePath() {
		params["own"] = "1"
	}
	for k, v := range map[string]string{"base": baseParam, "head": headParam, "title": title, "note": note, "hide": hide} {
		if v != "" {
			params[k] = v
		}
	}
	// One file stays in the whole list, as it always has; anything else narrows the list.
	if i := slices.IndexFunc(m.GetFiles(), func(f *v1.CompareFile) bool { return len(c.rels) == 1 && f.GetPath() == c.rels[0] }); i >= 0 {
		params["path"] = c.rels[0]
		if old := m.GetFiles()[i].GetOldPath(); old != "" {
			params["oldPath"] = old
		}
	} else if len(c.rels) > 0 {
		params["paths"] = strings.Join(listed, "\n")
	}
	// Anything but choosing a file is the thread's, in a tab of its own: the checkout's is the
	// user's. A side counts as given, default or not: the own tab may compare something else.
	if a.Given("base") || a.Given("head") || a.Given("scope") || title != "" || note != "" || hide != "" || params["paths"] != "" {
		params["thread"] = asker
	}
	return params, warnings, nil
}
