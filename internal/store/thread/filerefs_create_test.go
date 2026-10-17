package thread

import (
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// File references reach claude as absolute paths in the worktree of the project they
// name, for every way Create picks the thread's worktrees.
func TestCreateRewritesFileRefs(t *testing.T) {
	const prompt = "read @cf-file://r1/README.md and @cf-file://r2/docs/a%20b.md and @cf-file://r9/x.go"
	tests := []struct {
		name string
		o    CreateOptions
		// want builds the expected prompt from the thread and the workspace env.
		want func(s Thread, e *wsEnv) string
	}{
		{name: "existing worktree: only the thread's project resolves",
			o: CreateOptions{ProjectID: "r1"},
			want: func(s Thread, _ *wsEnv) string {
				return "read @" + s.WorktreePath + "/README.md and @docs/a b.md and @x.go"
			}},
		{name: "no project: nothing resolves",
			o: CreateOptions{NoProject: true},
			want: func(Thread, *wsEnv) string {
				return "read @README.md and @docs/a b.md and @x.go"
			}},
		{name: "new worktree: the created worktree",
			o: CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{}},
			want: func(s Thread, _ *wsEnv) string {
				return "read @" + s.WorktreePath + "/README.md and @docs/a b.md and @x.go"
			}},
		{name: "workspace thread: every member",
			o: CreateOptions{WorkspaceID: "login", ProjectID: "r2"},
			want: func(s Thread, e *wsEnv) string {
				return "read @" + e.wt + "/README.md and @" + e.wt2 + "/docs/a b.md and @x.go"
			}},
		{name: "new workspace: the new members' worktrees",
			o: CreateOptions{NewWorkspace: &NewWorkspace{Projects: []string{"r1", "r2"}}},
			want: func(s Thread, e *wsEnv) string {
				w, _ := e.ws.Snapshot().Workspace(s.WorkspaceID)
				m1, _ := w.Member("r1")
				m2, _ := w.Member("r2")
				return "read @" + m1.WorktreePath + "/README.md and @" + m2.WorktreePath + "/docs/a b.md and @x.go"
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newWSEnv(t, func(o *Options) {
				o.Projects.(*projecttest.Fake).WorktreeRoot = t.TempDir()
			})
			e.namer = func(string) (string, error) { return "refs", nil }
			o := tt.o
			o.InitialPrompt = prompt
			s, err := e.m.Create(e.ctx(), o)
			if err != nil {
				t.Fatal(err)
			}
			want := tt.want(s, e)
			e.waitSent("the prompt", func(m map[string]any) bool { return userTextOf(m) == want })
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
