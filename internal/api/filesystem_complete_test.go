package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/repo/repotest"
)

// completionHome is a home directory with a git project "proj" (skills, a command, an
// ignored file), a project without git "plain", user skills, and a directory outside.
func completionHome(t *testing.T) (root, outside string, c codefoundryv1connect.FilesystemServiceClient) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root, outside = filepath.Join(base, "home"), filepath.Join(base, "outside")
	files := map[string]string{
		"proj/.gitignore":                          "*.log\n",
		"proj/README.md":                           "x\n",
		"proj/src/index.ts":                        "x\n",
		"proj/debug.log":                           "x\n",
		"proj/.claude/skills/demo/SKILL.md":        "---\ndescription: A demo skill.\n---\n",
		"proj/.claude/commands/fix.md":             "Fix the bug.\n",
		"plain/notes.md":                           "x\n",
		"plain/.claude/skills/plainskill/SKILL.md": "---\ndescription: Plain.\n---\n",
		".claude/skills/commit/SKILL.md":           "---\ndescription: Commit.\n---\n",
		".claude/commands/user-cmd.md":             "User command.\n",
		".claude/commands/nested/skip.md":          "Not listed for the user.\n",
		"../outside/x.md":                          "x\n",
	}
	for p, s := range files {
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	proj := filepath.Join(root, "proj")
	for _, args := range [][]string{
		{"init", "-q"},
		{"add", "."},
		{"-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"},
	} {
		cmd := exec.Command("git", append([]string{"-C", proj}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	fake := repotest.New(nil)
	fake.Put(repo.Repo{ID: "p", Path: proj, Git: true, Worktrees: []repo.Worktree{{RepoID: "p", Path: proj, IsMain: true}}})
	plain := filepath.Join(root, "plain")
	fake.Put(repo.Repo{ID: "n", Path: plain, Worktrees: []repo.Worktree{{RepoID: "n", Path: plain, IsMain: true}}})

	route := NewFilesystem(root, fake).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return root, outside, codefoundryv1connect.NewFilesystemServiceClient(srv.Client(), srv.URL)
}

func TestFilesystemListSkills(t *testing.T) {
	root, outside, c := completionHome(t)
	type item struct {
		name, desc string
		scope      v1.SkillScope
		repo, rel  string
	}
	P, U := v1.SkillScope_SKILL_SCOPE_PROJECT, v1.SkillScope_SKILL_SCOPE_USER
	tests := []struct {
		name string
		req  *v1.ListSkillsRequest
		want []item
		code connect.Code
	}{
		{name: "project main worktree", req: &v1.ListSkillsRequest{Sources: []*v1.SkillSource{{RepoId: "p"}}}, want: []item{
			{"demo", "A demo skill.", P, "p", "proj/.claude/skills/demo/SKILL.md"},
			{"fix", "Fix the bug.", P, "p", "proj/.claude/commands/fix.md"},
		}},
		{name: "sources in request order, user last", req: &v1.ListSkillsRequest{
			Sources:     []*v1.SkillSource{{RepoId: "n"}, {RepoId: "p", Path: filepath.Join(root, "proj")}},
			IncludeUser: true,
		}, want: []item{
			{"plainskill", "Plain.", P, "n", "plain/.claude/skills/plainskill/SKILL.md"},
			{"demo", "A demo skill.", P, "p", "proj/.claude/skills/demo/SKILL.md"},
			{"fix", "Fix the bug.", P, "p", "proj/.claude/commands/fix.md"},
			{"commit", "Commit.", U, "", ".claude/skills/commit/SKILL.md"},
			{"user-cmd", "User command.", U, "", ".claude/commands/user-cmd.md"},
		}},
		{name: "user only", req: &v1.ListSkillsRequest{IncludeUser: true}, want: []item{
			{"commit", "Commit.", U, "", ".claude/skills/commit/SKILL.md"},
			{"user-cmd", "User command.", U, "", ".claude/commands/user-cmd.md"},
		}},
		{name: "unknown repo", req: &v1.ListSkillsRequest{Sources: []*v1.SkillSource{{RepoId: "zz"}}}, code: connect.CodeNotFound},
		{name: "missing repo id", req: &v1.ListSkillsRequest{Sources: []*v1.SkillSource{{Path: root}}}, code: connect.CodeInvalidArgument},
		{name: "outside home", req: &v1.ListSkillsRequest{Sources: []*v1.SkillSource{{RepoId: "p", Path: outside}}}, code: connect.CodeInvalidArgument},
		{name: "relative path", req: &v1.ListSkillsRequest{Sources: []*v1.SkillSource{{RepoId: "p", Path: "proj"}}}, code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := c.ListSkills(context.Background(), connect.NewRequest(tt.req))
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code {
					t.Fatalf("err = %v, want code %v", err, tt.code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var got []item
			for _, s := range res.Msg.GetSkills() {
				rel, _ := filepath.Rel(root, s.GetPath())
				got = append(got, item{s.GetName(), s.GetDescription(), s.GetScope(), s.GetRepoId(), rel})
			}
			if !slices.Equal(got, tt.want) {
				t.Fatalf("skills = %v\nwant %v", got, tt.want)
			}
		})
	}
}

func TestFilesystemSearchFiles(t *testing.T) {
	root, outside, c := completionHome(t)
	// A link under home to a directory outside it, and one to a checkout inside.
	for link, target := range map[string]string{"escape": outside, "projlink": filepath.Join(root, "proj")} {
		if err := os.Symlink(target, filepath.Join(root, link)); err != nil {
			t.Fatal(err)
		}
	}
	tests := []struct {
		name          string
		req           *v1.SearchFilesRequest
		want          []string // "/" suffix for directories
		wantTruncated bool
		code          connect.Code
	}{
		{name: "git: tracked files", req: &v1.SearchFilesRequest{RepoId: "p", Query: "index"}, want: []string{"src/index.ts"}},
		{name: "git: directories", req: &v1.SearchFilesRequest{RepoId: "p", Query: "src"}, want: []string{"src/", "src/index.ts"}},
		{name: "git: ignored files excluded", req: &v1.SearchFilesRequest{RepoId: "p", Query: "debug"}},
		{name: "git: empty query, limited", req: &v1.SearchFilesRequest{RepoId: "p", Limit: 2},
			want: []string{".claude/", ".gitignore"}, wantTruncated: true},
		{name: "explicit path", req: &v1.SearchFilesRequest{RepoId: "p", Path: filepath.Join(root, "proj"), Query: "readme"},
			want: []string{"README.md"}},
		{name: "no git: walk skips dot-directories", req: &v1.SearchFilesRequest{RepoId: "n", Query: "md"},
			want: []string{"notes.md"}},
		{name: "unknown repo", req: &v1.SearchFilesRequest{RepoId: "zz"}, code: connect.CodeNotFound},
		{name: "missing repo id", req: &v1.SearchFilesRequest{Query: "x"}, code: connect.CodeInvalidArgument},
		{name: "outside home", req: &v1.SearchFilesRequest{RepoId: "p", Path: outside}, code: connect.CodeInvalidArgument},
		{name: "symlink under home to outside", req: &v1.SearchFilesRequest{RepoId: "p", Path: filepath.Join(root, "escape")}, code: connect.CodeInvalidArgument},
		{name: "dot-dot out of home", req: &v1.SearchFilesRequest{RepoId: "p", Path: root + "/proj/../../outside"}, code: connect.CodeInvalidArgument},
		{name: "symlink to a checkout under home", req: &v1.SearchFilesRequest{RepoId: "p", Path: filepath.Join(root, "projlink"), Query: "readme"},
			want: []string{"README.md"}},
		{name: "missing checkout", req: &v1.SearchFilesRequest{RepoId: "p", Path: filepath.Join(root, "gone")}, code: connect.CodeNotFound},
		{name: "a file is not a checkout", req: &v1.SearchFilesRequest{RepoId: "p", Path: filepath.Join(root, "proj", "README.md")}, code: connect.CodeInvalidArgument},
		{name: "negative limit", req: &v1.SearchFilesRequest{RepoId: "p", Limit: -1}, code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := c.SearchFiles(context.Background(), connect.NewRequest(tt.req))
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code {
					t.Fatalf("err = %v, want code %v", err, tt.code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, m := range res.Msg.GetMatches() {
				p := m.GetPath()
				if m.GetIsDir() {
					p += "/"
				}
				got = append(got, p)
			}
			if !slices.Equal(got, tt.want) {
				t.Fatalf("matches = %q, want %q", got, tt.want)
			}
			if res.Msg.GetTruncated() != tt.wantTruncated {
				t.Fatalf("truncated = %v, want %v", res.Msg.GetTruncated(), tt.wantTruncated)
			}
		})
	}
}
