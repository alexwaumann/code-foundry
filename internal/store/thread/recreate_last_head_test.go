package thread

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// The branch a removed checkout is made again on: its last HEAD while that exists
// locally or on origin, else the created-for branch, looked up as before.
func TestRecreateBranch(t *testing.T) {
	tests := []struct {
		name, last string
		local      []string // local branches
		remote     []string // on origin (a remote-tracking ref, or found by a fetch)
		wantBranch string
		wantLocal  bool
		wantRemote bool
		// wantAsked are the branches looked up, in order.
		wantAsked []string
	}{
		{name: "last head exists locally", last: "feat/y", local: []string{"feat/x", "feat/y"},
			wantBranch: "feat/y", wantLocal: true, wantAsked: []string{"feat/y"}},
		{name: "last head only on origin", last: "feat/y", local: []string{"feat/x"}, remote: []string{"feat/y"},
			wantBranch: "feat/y", wantRemote: true, wantAsked: []string{"feat/y"}},
		{name: "last head gone: the created-for branch", last: "feat/y", local: []string{"feat/x"},
			wantBranch: "feat/x", wantLocal: true, wantAsked: []string{"feat/y", "feat/x"}},
		{name: "last head gone, created-for only on origin", last: "feat/y", remote: []string{"feat/x"},
			wantBranch: "feat/x", wantRemote: true, wantAsked: []string{"feat/y", "feat/x"}},
		{name: "both gone: the created-for branch, made from the base", last: "feat/y",
			wantBranch: "feat/x", wantAsked: []string{"feat/y", "feat/x"}},
		{name: "not recorded: as before", local: []string{"feat/x", "feat/y"},
			wantBranch: "feat/x", wantLocal: true, wantAsked: []string{"feat/x"}},
		{name: "last head is the created-for branch", last: "feat/x", local: []string{"feat/x"},
			wantBranch: "feat/x", wantLocal: true, wantAsked: []string{"feat/x"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var asked []string
			find := func(b string) (bool, bool) {
				asked = append(asked, b)
				local := slices.Contains(tt.local, b)
				return local, !local && slices.Contains(tt.remote, b)
			}
			branch, local, remote := recreateBranch(tt.last, "feat/x", find)
			if branch != tt.wantBranch || local != tt.wantLocal || remote != tt.wantRemote {
				t.Errorf("recreateBranch = %q local %v remote %v, want %q %v %v", branch, local, remote, tt.wantBranch, tt.wantLocal, tt.wantRemote)
			}
			if !slices.Equal(asked, tt.wantAsked) {
				t.Errorf("looked up %q, want %q", asked, tt.wantAsked)
			}
		})
	}
}

// A cleanup about to remove a worktree records the branch it has for the threads whose
// checkout it is, persisted; a detached HEAD or the created-for branch records nothing.
func TestRememberHead(t *testing.T) {
	tests := []struct {
		name string
		// w is the worktree removed; "<path>" is the thread's cwd, "<b>" its branch.
		w    project.Worktree
		want map[string]string
	}{
		{name: "moved to another branch", w: project.Worktree{ProjectID: "r1", Path: "<path>", Branch: "feat/y"}, want: map[string]string{"r1": "feat/y"}},
		{name: "on the created-for branch", w: project.Worktree{ProjectID: "r1", Path: "<path>", Branch: "<b>"}},
		{name: "detached", w: project.Worktree{ProjectID: "r1", Path: "<path>", Head: "abc1234", Detached: true}},
		{name: "another path", w: project.Worktree{ProjectID: "r1", Path: "/elsewhere", Branch: "feat/y"}},
		{name: "another project", w: project.Worktree{ProjectID: "r9", Path: "<path>", Branch: "feat/y"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, _ := newRecreatingEnv(t)
			s := e.create(CreateOptions{ProjectID: "r1", InitialPrompt: "first", NewWorktree: &NewWorktree{}})
			e.waitItems(s.ID, "the first turn", turnCount(1))
			w := tt.w
			w.Path = strings.ReplaceAll(w.Path, "<path>", s.WorktreePath)
			w.Branch = strings.ReplaceAll(w.Branch, "<b>", s.Branch)
			e.m.RememberHead(w)
			got, _ := e.m.Snapshot().Thread(s.ID)
			if !mapsEqual(got.LastHeads, tt.want) {
				t.Errorf("LastHeads %v, want %v", got.LastHeads, tt.want)
			}
			rows, err := loadThreads(e.ctx(), e.m.opts.DB)
			if err != nil {
				t.Fatal(err)
			}
			i := slices.IndexFunc(rows, func(r Thread) bool { return r.ID == s.ID })
			if i < 0 || !mapsEqual(rows[i].LastHeads, tt.want) {
				t.Errorf("persisted LastHeads %v, want %v", rows[i].LastHeads, tt.want)
			}
		})
	}
}

func mapsEqual(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

// A thread whose worktree a cleanup removed after it moved to feat/y gets it back on
// feat/y, at the same path, while feat/y exists locally or on origin; with feat/y gone,
// or checked out in the main checkout, on the created-for branch as before. The note
// names the branch checked out, and the record is dropped once HEAD is live again.
func TestSendRecreatesOnLastHead(t *testing.T) {
	tests := []struct {
		name string
		// refs and onFetch as TestSendRecreatesRemovedWorktree's ("<b>" the created-for branch).
		refs, onFetch []string
		mainOnY       bool
		// wantBranch "<b>" is the created-for branch.
		wantBranch, wantNote string
		wantFetchY           bool
	}{
		{name: "last head exists locally", refs: []string{"refs/heads/<b>", "refs/heads/feat/y"},
			wantBranch: "feat/y", wantNote: "recreated from branch feat/y, where this thread had moved from <b>. Untracked"},
		{name: "last head only on origin", refs: []string{"refs/heads/<b>", "refs/remotes/origin/feat/y"},
			wantBranch: "feat/y", wantNote: "recreated from branch feat/y, where this thread had moved from <b>."},
		{name: "last head on origin after a fetch", refs: []string{"refs/heads/<b>"}, onFetch: []string{"refs/remotes/origin/feat/y"},
			wantBranch: "feat/y", wantNote: "recreated from branch feat/y, where", wantFetchY: true},
		{name: "last head gone: the created-for branch", refs: []string{"refs/heads/<b>"},
			wantBranch: "<b>", wantNote: "recreated from branch <b>. Untracked", wantFetchY: true},
		{name: "last head in the main checkout: the created-for branch", refs: []string{"refs/heads/<b>", "refs/heads/feat/y"}, mainOnY: true,
			wantBranch: "<b>", wantNote: "recreated from branch <b>. Untracked"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, re := newRecreatingEnv(t)
			s := e.create(CreateOptions{ProjectID: "r1", InitialPrompt: "first", NewWorktree: &NewWorktree{}})
			e.waitItems(s.ID, "the first turn", turnCount(1))
			b := s.Branch
			cid := argOf(e.spec(s.ID).Argv, "--session-id")
			e.writeTranscriptIn(s.WorktreePath, cid, userLine("hi"))
			e.waitFor(s.ID, "discovered", func(s Thread) bool { return s.ClaudeSessionID == cid })
			sub := func(v []string) []string {
				out := make([]string, len(v))
				for i, r := range v {
					out[i] = strings.ReplaceAll(r, "<b>", b)
				}
				return out
			}
			if err := e.m.Close(e.ctx(), s.ID); err != nil {
				t.Fatal(err)
			}
			e.m.RememberHead(project.Worktree{ProjectID: "r1", Path: s.WorktreePath, Branch: "feat/y"})
			if err := os.RemoveAll(s.WorktreePath); err != nil {
				t.Fatal(err)
			}
			re.refs.set(sub(tt.refs), sub(tt.onFetch))
			if tt.mainOnY {
				r, _ := re.projects.Snapshot().Project("r1")
				r.Worktrees = slices.Clone(r.Worktrees)
				for i := range r.Worktrees {
					if r.Worktrees[i].IsMain {
						r.Worktrees[i].Branch = "feat/y"
					}
				}
				re.projects.Put(r)
			}
			creates := len(re.projects.created())
			if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); err != nil {
				t.Fatal(err)
			}
			e.waitDeliveries("again", func(f, r int) bool { return r == 1 })
			got := e.waitFor(s.ID, "connected", func(s Thread) bool { return s.State == StateConnected })
			if got.WorktreePath != s.WorktreePath || got.Branch != b || got.LastError != "" || len(got.LastHeads) != 0 {
				t.Errorf("after the start %+v", got)
			}
			all := re.projects.created()
			if len(all) != creates+1 {
				t.Fatalf("CreateWorktree calls %+v", all)
			}
			wantBranch := strings.ReplaceAll(tt.wantBranch, "<b>", b)
			want := project.CreateWorktreeOptions{ProjectID: "r1", Branch: wantBranch, Fetch: true, BaseFromOrigin: true}
			if wantBranch != b {
				want.Path = s.WorktreePath // feat/y's default path is elsewhere
			}
			if all[creates] != want {
				t.Errorf("recreated with %+v, want %+v", all[creates], want)
			}
			if fetched := slices.Contains(re.refs.fetched, "feat/y"); fetched != tt.wantFetchY {
				t.Errorf("fetched %q, want a fetch of feat/y %v", re.refs.fetched, tt.wantFetchY)
			}
			items := e.items(s.ID).Items
			wantNote := strings.ReplaceAll(tt.wantNote, "<b>", b)
			if !slices.ContainsFunc(items, func(it Item) bool { return it.Kind == KindNote && strings.Contains(it.Text, wantNote) }) {
				t.Errorf("want the note %q\n%s", wantNote, describeItems(items))
			}
		})
	}
}

// The other members follow the same rule: one a cleanup removed on feat/y comes back on
// feat/y at its path; when another linked worktree has the branch checked out (its last
// HEAD, or the created-for branch with nothing recorded) the thread takes that one over
// and the timeline says so.
func TestStartRemakesMemberOnLastHead(t *testing.T) {
	tests := []struct {
		name string
		last string // recorded for r1's worktree; "" none
		// other is a linked worktree of r1 put on this branch before the start; "" none.
		other    string
		wantMade string // the branch r1's worktree is made on; "" none made
		wantNote string // "<wt>" is r1's removed worktree, "<other>" the other one
	}{
		{name: "made again on its last head", last: "feat/y", wantMade: "feat/y",
			wantNote: "recreated from branch feat/y, where this thread had moved from feat/f (<wt>)"},
		{name: "not recorded: the created-for branch", wantMade: "feat/f",
			wantNote: "recreated from branch feat/f (<wt>)"},
		{name: "another worktree has its last head", last: "feat/y", other: "feat/y",
			wantNote: "The worktree of project repo this thread worked in (<wt>) was removed, and another worktree has branch feat/y checked out (<other>), so the thread now works there."},
		{name: "another worktree has the created-for branch", other: "feat/f",
			wantNote: "another worktree has branch feat/f checked out (<other>)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			refs := &recreateRefs{}
			refs.set([]string{"refs/heads/feat/f", "refs/heads/feat/y"}, nil)
			e, rr := multiEnv(t, func(o *Options) {
				o.Projects.(*recordingProjects).MakeDirs = true
				o.RefExists, o.FetchBranch = refs.exists, refs.fetch
			})
			s := e.create(CreateOptions{ProjectID: "r2", ProjectIDs: []string{"r1", "r2"}, InitialPrompt: "first", NewWorktree: &NewWorktree{Branch: "feat/f"}})
			e.waitItems(s.ID, "the first turn", turnCount(1))
			if err := e.m.Close(e.ctx(), s.ID); err != nil {
				t.Fatal(err)
			}
			tc, err := e.m.Checkouts(e.ctx(), CheckoutsRef{ID: s.ID})
			if err != nil {
				t.Fatal(err)
			}
			wt := tc.Checkouts[0].Path
			if tt.last != "" {
				e.m.RememberHead(project.Worktree{ProjectID: "r1", Path: wt, Branch: tt.last})
			}
			if err := os.RemoveAll(wt); err != nil {
				t.Fatal(err)
			}
			r, _ := rr.Snapshot().Project("r1")
			r.Worktrees = slices.DeleteFunc(slices.Clone(r.Worktrees), func(w project.Worktree) bool { return w.Path == wt })
			other := filepath.Join(t.TempDir(), "other")
			if tt.other != "" {
				if err := os.MkdirAll(other, 0o755); err != nil {
					t.Fatal(err)
				}
				r.Worktrees = append(r.Worktrees, project.Worktree{ProjectID: "r1", Path: other, Branch: tt.other})
			}
			rr.Put(r)
			creates := len(rr.created())
			if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); err != nil {
				t.Fatal(err)
			}
			got := e.waitFor(s.ID, "connected", func(s Thread) bool { return s.State == StateConnected })
			made := rr.created()[creates:]
			switch {
			case tt.wantMade == "" && len(made) != 0:
				t.Errorf("CreateWorktree calls %+v, want none", made)
			case tt.wantMade != "":
				want := project.CreateWorktreeOptions{ProjectID: "r1", Branch: tt.wantMade, Fetch: true, BaseFromOrigin: true}
				if tt.wantMade == tt.last {
					want.Path = wt
				}
				if len(made) != 1 || made[0] != want {
					t.Errorf("CreateWorktree calls %+v, want %+v", made, want)
				}
			}
			wantPath := wt
			if tt.other != "" {
				wantPath = other
			}
			if p, _ := got.CheckoutPath("r1"); !samePath(p, wantPath) || len(got.LastHeads) != 0 {
				t.Errorf("r1's checkout %q (last heads %v), want %q and none", p, got.LastHeads, wantPath)
			}
			wantNote := strings.NewReplacer("<wt>", filepath.Clean(wt), "<other>", other).Replace(tt.wantNote)
			items := e.items(s.ID).Items
			if !slices.ContainsFunc(items, func(it Item) bool { return it.Kind == KindNote && strings.Contains(it.Text, wantNote) }) {
				t.Errorf("want the note %q\n%s", wantNote, describeItems(items))
			}
		})
	}
}
