package session

import (
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/repo/repotest"
)

// File references reach claude as absolute paths in the worktree of the project they
// name, for every way Create picks the thread's worktrees.
func TestCreateRewritesFileRefs(t *testing.T) {
	const prompt = "read @cf-file://r1/README.md and @cf-file://r2/docs/a%20b.md and @cf-file://r9/x.go"
	tests := []struct {
		name string
		o    CreateOptions
		// want builds the expected prompt from the session and the workspace env.
		want func(s Session, e *wsEnv) string
	}{
		{name: "existing worktree: only the thread's project resolves",
			o: CreateOptions{RepoID: "r1"},
			want: func(s Session, _ *wsEnv) string {
				return "read @" + s.WorktreePath + "/README.md and @docs/a b.md and @x.go"
			}},
		{name: "new worktree: the created worktree",
			o: CreateOptions{RepoID: "r1", NewWorktree: &NewWorktree{}},
			want: func(s Session, _ *wsEnv) string {
				return "read @" + s.WorktreePath + "/README.md and @docs/a b.md and @x.go"
			}},
		{name: "workspace thread: every member",
			o: CreateOptions{WorkspaceID: "login", RepoID: "r2"},
			want: func(s Session, e *wsEnv) string {
				return "read @" + e.wt + "/README.md and @" + e.wt2 + "/docs/a b.md and @x.go"
			}},
		{name: "new workspace: the new members' worktrees",
			o: CreateOptions{NewWorkspace: &NewWorkspace{Repos: []string{"r1", "r2"}}},
			want: func(s Session, e *wsEnv) string {
				w, _ := e.ws.Snapshot().Workspace(s.WorkspaceID)
				m1, _ := w.Member("r1")
				m2, _ := w.Member("r2")
				return "read @" + m1.WorktreePath + "/README.md and @" + m2.WorktreePath + "/docs/a b.md and @x.go"
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newWSEnv(t, func(o *Options) {
				o.Repos.(*repotest.Fake).WorktreeRoot = t.TempDir()
			})
			e.namer = func(string) (string, error) { return "refs", nil }
			o := tt.o
			o.InitialPrompt = prompt
			s, err := e.m.Create(e.ctx(), o)
			if err != nil {
				t.Fatal(err)
			}
			spec, ok := e.terms.Spec(s.TerminalID)
			if !ok {
				t.Fatal("no terminal")
			}
			if got, want := spec.Argv[len(spec.Argv)-1], tt.want(s, e); got != want {
				t.Errorf("prompt argument\n got %q\nwant %q", got, want)
			}
			e.mu.Lock()
			named := slices.Clone(e.named)
			e.mu.Unlock()
			for _, msg := range named { // the namer ran before the worktrees existed
				if strings.Contains(msg, fileRefScheme) {
					t.Errorf("namer saw a raw file reference: %q", msg)
				}
			}
		})
	}
}
