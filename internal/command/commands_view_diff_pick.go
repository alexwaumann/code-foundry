package command

import (
	"context"
	"maps"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// The checkout's own Diff tab is the user's (docs/notes/shell-gaps-c-identity.md, gap 21): a
// view.open.diff that frames nothing (no side, note, title, hide or narrowed list, so no asker)
// only picks a file in it, and what the user compares, filters and folds there stays. The
// daemon does the pick in the open_surface it sends, so the window only reads the tab's params
// (docs/notes/shell-22-retire-verbs.md; the window's half was stores/threadPanelIntent.ts).
//
// The call found its file in the default sides. When the user's tab compares others, the file
// is picked there only if they list it too, and otherwise it opens in a tab of the asker's own,
// as a call naming those sides would: "no longer in this comparison" about a file that never
// was would leave the thread thinking the user sees its change (docs/notes/diff-fuzz-fixes.md).

// diffCommitParams are a Diff tab's params while it shows one commit from its Commits list:
// the commit and the sides and file All changes goes back to.
var diffCommitParams = []string{"commit", "backBase", "backHead", "backPath", "backOldPath"}

// diffSides are a Diff tab's sides params and their defaults (gui/frontend/src/surfaces/diffTarget.ts).
const (
	diffBaseDefault = "merge-base"
	diffHeadDefault = "working"
)

// sideParam is a tab's side param as the window reads it (sourceOfParam), "" for the side's
// default def: a named side as itself, "ref:<ref>" as itself, anything else the default.
func sideParam(v, def string) string {
	switch {
	case v == def:
		return ""
	case v == "working" || v == "staged" || v == "merge-base":
		return v
	case strings.HasPrefix(v, "ref:") && len(v) > len("ref:"):
		return v
	}
	return ""
}

// paramSource is a side param as a source; "" is def.
func paramSource(v, def string) *v1.DiffSource {
	if v == "" {
		v = def
	}
	switch v {
	case "working":
		return &v1.DiffSource{Kind: v1.DiffSourceKind_DIFF_SOURCE_KIND_WORKING_TREE}
	case "staged":
		return &v1.DiffSource{Kind: v1.DiffSourceKind_DIFF_SOURCE_KIND_STAGED}
	case "merge-base":
		return &v1.DiffSource{Kind: v1.DiffSourceKind_DIFF_SOURCE_KIND_MERGE_BASE}
	}
	return &v1.DiffSource{Kind: v1.DiffSourceKind_DIFF_SOURCE_KIND_REF, Ref: strings.TrimPrefix(v, "ref:")}
}

// setOrDrop sets params[k] to v, or drops k when v is "".
func setOrDrop(params map[string]string, k, v string) {
	if v == "" {
		delete(params, k)
		return
	}
	params[k] = v
}

// pickTries bounds how often intoUsersDiff starts over because the user changed their tab
// while it compared.
const pickTries = 3

// intoUsersDiff is the tab params of a view.open.diff for thread id whose check gave asked.
// A call that frames nothing (asked names no asker) while the checkout's tab is open in the
// thread's space gets that tab as the user has it: with its own flag from the call and, when
// the call names a file, that file picked in the sides the user's tab compares (a commit the
// user was in is left for its All changes), or a tab of asker's own when those sides do not
// list it. Any other call is asked as it is.
//
// Asking whether the user's sides list the file runs git, and the user may change the tab in
// the meantime (another file, a filter, other sides). The tab is read again after it, and a
// change starts the pick over from what the user has now, so the params it gives never write
// the tab as it was over what the user did. A tab the user keeps changing gives the call a tab
// of its own.
func (d ViewDeps) intoUsersDiff(ctx context.Context, id, asker string, asked map[string]string) map[string]string {
	if d.Layout == nil || asked[core.DiffAskerParam] != "" {
		return asked
	}
	for range pickTries {
		open := d.usersDiff(id, asked)
		if open == nil {
			return asked
		}
		mine, done := d.pickIn(ctx, open, asker, asked)
		if done {
			return mine
		}
		if now := d.usersDiff(id, asked); now != nil && maps.Equal(now.Params, open.Params) {
			return mine
		}
	}
	own := maps.Clone(asked)
	own[core.DiffAskerParam] = asker
	return own
}

// usersDiff is the checkout's Diff tab of thread id open in its space now; nil for none.
func (d ViewDeps) usersDiff(id string, asked map[string]string) *core.Tab {
	snap := d.Layout.Snapshot()
	if snap == nil {
		return nil
	}
	return openLinked(snap.State, itemTab(tabDiff, id, asked))
}

// pickIn is intoUsersDiff's pick in the user's tab open; done when it asked the checkout
// nothing, so the tab could not have changed under it.
func (d ViewDeps) pickIn(ctx context.Context, open *core.Tab, asker string, asked map[string]string) (_ map[string]string, done bool) {
	mine := maps.Clone(open.Params)
	if mine == nil {
		mine = map[string]string{}
	}
	setOrDrop(mine, "own", asked["own"])
	file, oldPath := asked["path"], asked["oldPath"]
	if file == "" {
		return mine, true
	}
	base, head := mine["base"], mine["head"]
	if mine["commit"] != "" {
		base, head = mine["backBase"], mine["backHead"]
	}
	base, head = sideParam(base, diffBaseDefault), sideParam(head, diffHeadDefault)
	done = true
	if base != sideParam(asked["base"], diffBaseDefault) || head != sideParam(asked["head"], diffHeadDefault) {
		done = false
		row := d.listedIn(ctx, mine["project"], mine["worktree"], base, head, file)
		if row == nil {
			own := maps.Clone(asked)
			own[core.DiffAskerParam] = asker
			return own, false
		}
		file, oldPath = row.GetPath(), row.GetOldPath()
	}
	for _, k := range diffCommitParams {
		delete(mine, k)
	}
	setOrDrop(mine, "base", base)
	setOrDrop(mine, "head", head)
	mine["path"] = file
	if oldPath == file {
		oldPath = ""
	}
	setOrDrop(mine, "oldPath", oldPath)
	return mine, done
}

// listedIn is file's row in what the checkout at worktree differs by between base and head
// (side params); nil when it is not listed there, or the comparison cannot say.
func (d ViewDeps) listedIn(ctx context.Context, project, worktree, base, head, file string) *v1.CompareFile {
	res, err := d.Diffs.CompareWorktree(ctx, connect.NewRequest(&v1.CompareWorktreeRequest{
		ProjectId: project, Path: worktree,
		Base: paramSource(base, diffBaseDefault), Head: paramSource(head, diffHeadDefault),
		Paths: []string{file},
	}))
	if err != nil || res.Msg.GetError() != "" {
		return nil
	}
	for _, f := range res.Msg.GetFiles() {
		if f.GetPath() == file {
			return f
		}
	}
	return nil
}
