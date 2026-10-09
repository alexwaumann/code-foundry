package command

import (
	"strings"
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
			{Path: "/src/r", Branch: "main", Head: "aaa", IsMain: true, Status: &v1.GitStatus{Upstream: "origin/main"}},
			{Path: "/wt/r/topic", Branch: "topic"},
			{Path: "/wt/r/detached", Detached: true},
			{Path: "/wt/r/feature", Branch: "feature", Status: &v1.GitStatus{Upstream: "origin/feature"}},
			{Path: "/wt/r/contrib-main", Branch: "contrib-main", Status: &v1.GitStatus{Upstream: "contrib/main"}},
		}},
		{Id: "r2", GithubSlug: "o/r", Path: "/src/r2", Worktrees: []*v1.Worktree{
			{Path: "/src/r2", Branch: "dev", IsMain: true},
			{Path: "/wt/r2/feat-foo", Branch: "feat/foo"},
			{Path: "/wt/r2/at-sha", Detached: true, Head: "f00d"},
		}},
		{Id: "nogh", Path: "/src/local", Worktrees: []*v1.Worktree{{Path: "/src/local", Branch: "feat/foo", IsMain: true}}},
	}
	same := func(ref string) prHead { return prHead{Ref: ref, SHA: "f00d"} } // a same-repository head ignores the sha
	fork := func(ref, sha string) prHead { return prHead{Ref: ref, SHA: sha, Cross: true} }
	type args struct {
		kind     prSessionKind
		repos    []*v1.Repo
		head     prHead
		explicit string
		active   string
	}
	tests := []struct {
		name     string
		args     args
		want     prWorktreePick
		wantCode connect.Code
		wantMsg  string
	}{
		{name: "read: explicit wins, even outside the clones",
			args: args{kind: prSessionRead, repos: repos, head: same("feat/foo"), explicit: "/src/y/", active: "/wt/r/topic"},
			want: prWorktreePick{Path: "/src/y"}},
		{name: "read: active worktree of a clone (slug matched case-insensitively)",
			args: args{kind: prSessionRead, repos: repos, head: same("feat/foo"), active: "/wt/r/topic/"},
			want: prWorktreePick{RepoID: "r1", Path: "/wt/r/topic"}},
		{name: "read: active worktree of another repo is ignored, head branch next",
			args: args{kind: prSessionRead, repos: repos, head: same("feat/foo"), active: "/src/y"},
			want: prWorktreePick{RepoID: "r2", Path: "/wt/r2/feat-foo"}},
		{name: "read: no head worktree, the first clone's main worktree",
			args: args{kind: prSessionRead, repos: repos, head: same("gone")},
			want: prWorktreePick{RepoID: "r1", Path: "/src/r"}},
		{name: "read: a detached worktree never matches a same-repository head",
			args: args{kind: prSessionRead, repos: repos, head: same("")},
			want: prWorktreePick{RepoID: "r1", Path: "/src/r"}},
		{name: "read: a fork's head on a same-named branch is not matched",
			args: args{kind: prSessionRead, repos: repos, head: fork("topic", "")},
			want: prWorktreePick{RepoID: "r1", Path: "/src/r"}},
		{name: "read: a fork's head by commit",
			args: args{kind: prSessionRead, repos: repos, head: fork("topic", "f00d")},
			want: prWorktreePick{RepoID: "r2", Path: "/wt/r2/at-sha"}},
		{name: "read: main worktree missing (repo error), the repo path",
			args: args{kind: prSessionRead, repos: []*v1.Repo{{Id: "r1", GithubSlug: "o/r", Path: "/src/r"}}, head: same("x")},
			want: prWorktreePick{RepoID: "r1", Path: "/src/r"}},
		{name: "read: no clone",
			args:     args{kind: prSessionRead, repos: repos[:1], head: same("feat/foo")},
			wantCode: connect.CodeFailedPrecondition, wantMsg: "no registered repository is a clone of o/r"},
		{name: "fix: explicit",
			args: args{kind: prSessionFix, repos: repos, head: same("feat/foo"), explicit: "/elsewhere"},
			want: prWorktreePick{Path: "/elsewhere"}},
		{name: "fix: the active worktree does not count",
			args: args{kind: prSessionFix, repos: repos, head: same("feat/foo"), active: "/wt/r/topic"},
			want: prWorktreePick{RepoID: "r2", Path: "/wt/r2/feat-foo"}},
		{name: "fix: head branch in the main worktree",
			args: args{kind: prSessionFix, repos: repos, head: same("main")},
			want: prWorktreePick{RepoID: "r1", Path: "/src/r"}},
		{name: "fix: a fork from the contributor's main is not our main, but the worktree tracking the fork",
			args: args{kind: prSessionFix, repos: repos, head: fork("main", "beef")},
			want: prWorktreePick{RepoID: "r1", Path: "/wt/r/contrib-main"}},
		{name: "fix: a fork's head by commit, case-insensitively",
			args: args{kind: prSessionFix, repos: repos, head: fork("whatever", "F00D")},
			want: prWorktreePick{RepoID: "r2", Path: "/wt/r2/at-sha"}},
		{name: "fix: a fork's head by commit with no head ref",
			args: args{kind: prSessionFix, repos: repos, head: fork("", "aaa")},
			want: prWorktreePick{RepoID: "r1", Path: "/src/r"}},
		{name: "fix: a fork on a same-named branch is not matched",
			args:     args{kind: prSessionFix, repos: repos, head: fork("topic", "beef")},
			wantCode: connect.CodeFailedPrecondition, wantMsg: "#7 comes from a fork and no worktree of o/r has its head checked out: check it out (for example `gh pr checkout 7` in a worktree) and pass --worktree"},
		{name: "fix: a fork never matches origin/<head>",
			args:     args{kind: prSessionFix, repos: repos, head: fork("feature", "beef")},
			wantCode: connect.CodeFailedPrecondition, wantMsg: "gh pr checkout 7"},
		{name: "fix: no worktree, same repository: create in the first clone",
			args: args{kind: prSessionFix, repos: repos, head: same("new/branch")},
			want: prWorktreePick{RepoID: "r1", Create: true, MainPath: "/src/r"}},
		{name: "fix: no worktree, fork",
			args:     args{kind: prSessionFix, repos: repos, head: fork("new/branch", "beef")},
			wantCode: connect.CodeFailedPrecondition, wantMsg: "comes from a fork"},
		{name: "fix: no head branch",
			args:     args{kind: prSessionFix, repos: repos, head: same("")},
			wantCode: connect.CodeFailedPrecondition, wantMsg: "#7 has no head branch to check out: pass --worktree"},
		{name: "fix: no clone",
			args:     args{kind: prSessionFix, head: same("x")},
			wantCode: connect.CodeFailedPrecondition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := tt.args
			got, err := pickPRWorktree(a.kind, a.repos, "o/r", 7, a.head, a.explicit, a.active)
			if tt.wantCode != 0 {
				if connect.CodeOf(err) != tt.wantCode || !strings.Contains(err.Error(), tt.wantMsg) {
					t.Fatalf("err = %v, want code %v and %q", err, tt.wantCode, tt.wantMsg)
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
