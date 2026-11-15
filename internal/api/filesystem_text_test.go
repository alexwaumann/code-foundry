package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/ripgrep"
	"github.com/alexwaumann/code-foundry/internal/ripgrep/ripgreptest"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// textHome is a home with a git project "p" (an ignored .env.local the setting's pattern
// includes, an ignored node_modules) and a project "n" without git, served by a Filesystem
// running engine.
func textHome(t *testing.T, engine *ripgrep.Engine) (proj string, c codefoundryv1connect.FilesystemServiceClient) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "home")
	for p, s := range map[string]string{
		"proj/.gitignore":           ".env.local\nnode_modules/\n",
		"proj/src/app.ts":           "const Needle = 1\nneedle()\n",
		"proj/.env.local":           "TOKEN=needle\n",
		"proj/node_modules/x/i.js":  "needle\n",
		"plain/readme.txt":          "a needle in plain\n",
		"plain/node_modules/y/i.js": "needle\n",
	} {
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	proj = filepath.Join(root, "proj")
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
	h := NewFilesystem(root, fake, testGrants(root)).WithIncludeIgnored(func() []string { return []string{".env*"} }).WithRipgrep(engine)
	route := h.Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return proj, codefoundryv1connect.NewFilesystemServiceClient(srv.Client(), srv.URL)
}

func realEngine(t *testing.T) *ripgrep.Engine {
	bin := ripgreptest.Real(t)
	return ripgrep.NewEngine(func() (ripgrep.Binary, error) { return ripgrep.Binary{Path: bin}, nil })
}

// searchText collects a SearchText stream: its files as "project:path(!ignored):line:text"
// rows, and the summary, which must come last and alone.
func searchText(t *testing.T, c codefoundryv1connect.FilesystemServiceClient, req *v1.SearchTextRequest) ([]string, *v1.TextFileMatch, *v1.SearchTextSummary, error) {
	t.Helper()
	stream, err := c.SearchText(context.Background(), connect.NewRequest(req))
	if err != nil {
		return nil, nil, nil, err
	}
	defer func() { _ = stream.Close() }()
	var rows []string
	var first *v1.TextFileMatch
	var sum *v1.SearchTextSummary
	for stream.Receive() {
		m := stream.Msg()
		if sum != nil {
			t.Fatalf("a message after the summary: %v", m)
		}
		if m.GetSummary() != nil && len(m.GetFiles()) > 0 {
			t.Fatalf("summary and files in one message: %v", m)
		}
		sum = m.GetSummary()
		for _, f := range m.GetFiles() {
			if first == nil {
				first = f
			}
			ign := ""
			if f.GetIgnored() {
				ign = "!"
			}
			for _, l := range f.GetLines() {
				rows = append(rows, fmt.Sprintf("%s:%s%s:%d:%s", f.GetProjectId(), f.GetPath(), ign, l.GetLine(), l.GetText()))
			}
		}
	}
	if err := stream.Err(); err != nil {
		return rows, first, nil, err
	}
	if sum == nil {
		t.Fatal("the stream ended without a summary")
	}
	return rows, first, sum, nil
}

func TestSearchText(t *testing.T) {
	proj, c := textHome(t, realEngine(t))
	two := []*v1.FileSource{{ProjectId: "p"}, {ProjectId: "n"}}

	rows, first, sum, err := searchText(t, c, &v1.SearchTextRequest{Sources: two, Query: "needle"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"p:.env.local!:1:TOKEN=needle", "p:src/app.ts:1:const Needle = 1", "p:src/app.ts:2:needle()", "n:readme.txt:1:a needle in plain"}
	if !slices.Equal(rows, want) {
		t.Errorf("rows\n got %q\nwant %q", rows, want)
	}
	if first.GetCheckout() != proj || len(first.GetLines()[0].GetRanges()) != 1 || first.GetLines()[0].GetRanges()[0].GetStart() != 6 || first.GetLineCount() != 1 {
		t.Errorf("first file: %v", first)
	}
	if sum.GetLines() != 4 || sum.GetFiles() != 3 || sum.GetCaseSensitive() || sum.GetTruncated() {
		t.Errorf("summary %v", sum)
	}

	rows, _, sum, err = searchText(t, c, &v1.SearchTextRequest{Sources: two, Query: "Needle"})
	if err != nil || !slices.Equal(rows, []string{"p:src/app.ts:1:const Needle = 1"}) || !sum.GetCaseSensitive() {
		t.Errorf("smart case: %q %v %v", rows, sum, err)
	}
	rows, _, _, err = searchText(t, c, &v1.SearchTextRequest{Sources: two, Query: `ne+dle\(`, Regex: true})
	if err != nil || !slices.Equal(rows, []string{"p:src/app.ts:2:needle()"}) {
		t.Errorf("regex: %q %v", rows, err)
	}
	rows, _, sum, err = searchText(t, c, &v1.SearchTextRequest{Sources: two})
	if err != nil || len(rows) != 0 || sum.GetFiles() != 0 {
		t.Errorf("empty query: %q %v %v", rows, sum, err)
	}

	errs := []struct {
		name string
		req  *v1.SearchTextRequest
		code connect.Code
		msg  string
	}{
		{"invalid regex", &v1.SearchTextRequest{Sources: two, Query: "(needle", Regex: true}, connect.CodeInvalidArgument, "invalid regular expression: unclosed group"},
		{"two lines", &v1.SearchTextRequest{Sources: two, Query: "a\nb"}, connect.CodeInvalidArgument, "more than one line"},
		{"too long", &v1.SearchTextRequest{Sources: two, Query: strings.Repeat("x", 501)}, connect.CodeInvalidArgument, "at most 500"},
		{"no sources", &v1.SearchTextRequest{Query: "x"}, connect.CodeInvalidArgument, "sources is required"},
		{"too many sources", &v1.SearchTextRequest{Sources: slices.Repeat([]*v1.FileSource{{ProjectId: "p"}}, 17), Query: "x"}, connect.CodeInvalidArgument, "at most 16"},
		{"unknown project", &v1.SearchTextRequest{Sources: []*v1.FileSource{{ProjectId: "zz"}}, Query: "x"}, connect.CodeNotFound, "not found"},
		{"outside home", &v1.SearchTextRequest{Sources: []*v1.FileSource{{ProjectId: "p", Path: "/etc"}}, Query: "x"}, connect.CodeInvalidArgument, "outside your home"},
	}
	for _, tt := range errs {
		_, _, _, err := searchText(t, c, tt.req)
		if connect.CodeOf(err) != tt.code || !strings.Contains(err.Error(), tt.msg) {
			t.Errorf("%s: %v, want %v with %q", tt.name, err, tt.code, tt.msg)
		}
	}
}

func TestSearchTextMissingRipgrep(t *testing.T) {
	_, c := textHome(t, ripgrep.NewEngine(func() (ripgrep.Binary, error) {
		return ripgrep.Binary{}, fmt.Errorf("%w (no /x/code-foundry-rg)", ripgrep.ErrMissing)
	}))
	_, _, _, err := searchText(t, c, &v1.SearchTextRequest{Sources: []*v1.FileSource{{ProjectId: "p"}}, Query: "needle"})
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeFailedPrecondition || !strings.HasPrefix(ce.Message(), "text search is unavailable") {
		t.Errorf("SearchText = %v, want FailedPrecondition with ripgrep's message", err)
	}
}
