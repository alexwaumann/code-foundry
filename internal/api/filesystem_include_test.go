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
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// includeHome is a home with a git project "proj" whose ignored files are .env,
// notes/todo.md (notes/ is ignored as a whole) and node_modules/x/.env, a project without
// git, and a Filesystem whose setting patterns are *all.
func includeHome(t *testing.T, all *[]string) (*projecttest.Fake, codefoundryv1connect.FilesystemServiceClient) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "home")
	files := map[string]string{
		"proj/.gitignore":          ".env*\nnotes/\nnode_modules/\n",
		"proj/src/app.ts":          "x",
		"proj/.env":                "x",
		"proj/notes/todo.md":       "x",
		"proj/node_modules/x/.env": "x",
		"plain/.env":               "x",
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
		{"init", "-q"}, {"add", "."},
		{"-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"},
	} {
		cmd := exec.Command("git", append([]string{"-C", proj}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	fake := projecttest.New(nil)
	fake.Put(project.Project{ID: "p", Name: "proj", Path: proj, Git: true, Worktrees: []project.Worktree{{ProjectID: "p", Path: proj, IsMain: true}}})
	plain := filepath.Join(root, "plain")
	fake.Put(project.Project{ID: "n", Name: "plain", Path: plain, Worktrees: []project.Worktree{{ProjectID: "n", Path: plain, IsMain: true}}})
	h := NewFilesystem(root, fake, testGrants(root)).WithIncludeIgnored(func() []string { return *all })
	route := h.Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return fake, codefoundryv1connect.NewFilesystemServiceClient(srv.Client(), srv.URL)
}

// SearchFiles lists the ignored files the setting's and the project's patterns include,
// marked ignored, and the same for one source or several.
func TestSearchFilesIncludesIgnored(t *testing.T) {
	all := []string{".env*"}
	fake, c := includeHome(t, &all)
	ctx := context.Background()
	type hit struct {
		path    string
		ignored bool
	}
	search := func(req *v1.SearchFilesRequest) []hit {
		t.Helper()
		res, err := c.SearchFiles(ctx, connect.NewRequest(req))
		if err != nil {
			t.Fatal(err)
		}
		var out []hit
		for _, m := range res.Msg.GetMatches() {
			out = append(out, hit{m.GetPath(), m.GetIgnored()})
		}
		slices.SortFunc(out, func(a, b hit) int {
			if a.path < b.path {
				return -1
			}
			return 1
		})
		return out
	}
	files := &v1.SearchFilesRequest{ProjectId: "p", FilesOnly: true}
	if got, want := search(files), []hit{{".env", true}, {".gitignore", false}, {"src/app.ts", false}}; !slices.Equal(got, want) {
		t.Errorf("setting only: %v, want %v", got, want)
	}
	p, _ := fake.Snapshot().Project("p")
	p.IncludeIgnored = []string{"notes/"}
	fake.Put(p)
	want := []hit{{".env", true}, {".gitignore", false}, {"notes/todo.md", true}, {"src/app.ts", false}}
	if got := search(files); !slices.Equal(got, want) {
		t.Errorf("with the project's: %v, want %v", got, want)
	}
	if got := search(&v1.SearchFilesRequest{Sources: []*v1.FileSource{{ProjectId: "p"}, {ProjectId: "n"}}, FilesOnly: true}); !slices.Contains(got, hit{"notes/todo.md", true}) || !slices.Contains(got, hit{".env", false}) {
		t.Errorf("two sources (plain's .env is no ignored file): %v", got)
	}
	if got := search(&v1.SearchFilesRequest{ProjectId: "p", Query: "notes"}); !slices.Contains(got, hit{"notes", true}) {
		t.Errorf("an included file's folder is listed and marked: %v", got)
	}
	all = nil
	if got, want := search(files), []hit{{".gitignore", false}, {"notes/todo.md", true}, {"src/app.ts", false}}; !slices.Equal(got, want) {
		t.Errorf("setting cleared: %v, want %v", got, want)
	}
}

func TestSuggestIncludeIgnored(t *testing.T) {
	all := []string{".env*"}
	_, c := includeHome(t, &all)
	ctx := context.Background()
	res, err := c.SuggestIncludeIgnored(ctx, connect.NewRequest(&v1.SuggestIncludeIgnoredRequest{ProjectId: "p", Text: "notes/"}))
	if err != nil {
		t.Fatal(err)
	}
	got := res.Msg
	if len(got.GetSuggestions()) == 0 {
		t.Fatalf("no suggestions: %v", got)
	}
	s := got.GetSuggestions()[0]
	if s.GetPath() != "notes" || !s.GetIsDir() || s.GetFileCount() != 1 || !s.GetMatchesText() || s.GetIncluded() {
		t.Errorf("first suggestion = %v", s)
	}
	if got.GetTextFiles() != 1 || got.GetTextError() != "" {
		t.Errorf("text files %d, error %q", got.GetTextFiles(), got.GetTextError())
	}
	res, err = c.SuggestIncludeIgnored(ctx, connect.NewRequest(&v1.SuggestIncludeIgnoredRequest{ProjectId: "p", Text: ".env"}))
	if err != nil {
		t.Fatal(err)
	}
	if s := res.Msg.GetSuggestions(); len(s) != 1 || s[0].GetPath() != ".env" || !s[0].GetIncluded() {
		t.Errorf(".env: %v (node_modules/x/.env is inside a collapsed folder)", s)
	}
	res, err = c.SuggestIncludeIgnored(ctx, connect.NewRequest(&v1.SuggestIncludeIgnoredRequest{ProjectId: "p", Text: "../x"}))
	if err != nil || res.Msg.GetTextError() == "" || res.Msg.GetTextFiles() != 0 {
		t.Errorf("invalid text: %v, %v", res.Msg, err)
	}
	for _, tt := range []struct {
		req  *v1.SuggestIncludeIgnoredRequest
		code connect.Code
	}{
		{&v1.SuggestIncludeIgnoredRequest{ProjectId: "nope"}, connect.CodeNotFound},
		{&v1.SuggestIncludeIgnoredRequest{ProjectId: "n"}, connect.CodeFailedPrecondition},
		{&v1.SuggestIncludeIgnoredRequest{ProjectId: "p", Limit: -1}, connect.CodeInvalidArgument},
		{&v1.SuggestIncludeIgnoredRequest{}, connect.CodeInvalidArgument},
	} {
		if _, err := c.SuggestIncludeIgnored(ctx, connect.NewRequest(tt.req)); connect.CodeOf(err) != tt.code {
			t.Errorf("%v: %v, want %v", tt.req, err, tt.code)
		}
	}
}
