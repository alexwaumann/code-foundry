package command

import (
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

func TestPickPRWorktree(t *testing.T) {
	repos := []*v1.Repo{
		{Id: "other", GithubSlug: "x/y", Path: "/src/y", Worktrees: []*v1.Worktree{
			{Path: "/src/y", Branch: "feat/foo", IsMain: true},
		}},
		{Id: "r1", GithubSlug: "O/R", Path: "/src/r", Worktrees: []*v1.Worktree{
			{Path: "/src/r", Branch: "main", IsMain: true},
			{Path: "/wt/r/topic", Branch: "topic"},
			{Path: "/wt/r/detached", Detached: true},
		}},
		{Id: "r2", GithubSlug: "o/r", Path: "/src/r2", Worktrees: []*v1.Worktree{
			{Path: "/src/r2", Branch: "dev", IsMain: true},
			{Path: "/wt/r2/feat-foo", Branch: "feat/foo"},
		}},
		{Id: "nogh", Path: "/src/local", Worktrees: []*v1.Worktree{{Path: "/src/local", Branch: "feat/foo", IsMain: true}}},
	}
	type args struct {
		kind      prSessionKind
		repos     []*v1.Repo
		head      string
		crossRepo bool
		explicit  string
		active    string
	}
	tests := []struct {
		name     string
		args     args
		want     prWorktreePick
		wantCode connect.Code
	}{
		{name: "read: explicit wins, even outside the clones",
			args: args{kind: prSessionRead, repos: repos, head: "feat/foo", explicit: "/src/y/", active: "/wt/r/topic"},
			want: prWorktreePick{Path: "/src/y"}},
		{name: "read: active worktree of a clone (slug matched case-insensitively)",
			args: args{kind: prSessionRead, repos: repos, head: "feat/foo", active: "/wt/r/topic/"},
			want: prWorktreePick{RepoID: "r1", Path: "/wt/r/topic"}},
		{name: "read: active worktree of another repo is ignored, head branch next",
			args: args{kind: prSessionRead, repos: repos, head: "feat/foo", active: "/src/y"},
			want: prWorktreePick{RepoID: "r2", Path: "/wt/r2/feat-foo"}},
		{name: "read: no head worktree, the first clone's main worktree",
			args: args{kind: prSessionRead, repos: repos, head: "gone"},
			want: prWorktreePick{RepoID: "r1", Path: "/src/r"}},
		{name: "read: a detached worktree never matches",
			args: args{kind: prSessionRead, repos: repos, head: ""},
			want: prWorktreePick{RepoID: "r1", Path: "/src/r"}},
		{name: "read: main worktree missing (repo error), the repo path",
			args: args{kind: prSessionRead, repos: []*v1.Repo{{Id: "r1", GithubSlug: "o/r", Path: "/src/r"}}, head: "x"},
			want: prWorktreePick{RepoID: "r1", Path: "/src/r"}},
		{name: "read: no clone",
			args:     args{kind: prSessionRead, repos: repos[:1], head: "feat/foo"},
			wantCode: connect.CodeFailedPrecondition},
		{name: "fix: explicit",
			args: args{kind: prSessionFix, repos: repos, head: "feat/foo", explicit: "/elsewhere"},
			want: prWorktreePick{Path: "/elsewhere"}},
		{name: "fix: the active worktree does not count",
			args: args{kind: prSessionFix, repos: repos, head: "feat/foo", active: "/wt/r/topic"},
			want: prWorktreePick{RepoID: "r2", Path: "/wt/r2/feat-foo"}},
		{name: "fix: head branch in the main worktree",
			args: args{kind: prSessionFix, repos: repos, head: "main"},
			want: prWorktreePick{RepoID: "r1", Path: "/src/r"}},
		{name: "fix: fork pull request on a matching branch",
			args: args{kind: prSessionFix, repos: repos, head: "topic", crossRepo: true},
			want: prWorktreePick{RepoID: "r1", Path: "/wt/r/topic"}},
		{name: "fix: no worktree, same repository: create in the first clone",
			args: args{kind: prSessionFix, repos: repos, head: "new/branch"},
			want: prWorktreePick{RepoID: "r1", Create: true, MainPath: "/src/r"}},
		{name: "fix: no worktree, fork",
			args:     args{kind: prSessionFix, repos: repos, head: "new/branch", crossRepo: true},
			wantCode: connect.CodeFailedPrecondition},
		{name: "fix: no head branch",
			args:     args{kind: prSessionFix, repos: repos, head: ""},
			wantCode: connect.CodeFailedPrecondition},
		{name: "fix: no clone",
			args:     args{kind: prSessionFix, head: "x"},
			wantCode: connect.CodeFailedPrecondition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := tt.args
			got, err := pickPRWorktree(a.kind, a.repos, "o/r", 7, a.head, a.crossRepo, a.explicit, a.active)
			if tt.wantCode != 0 {
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}
