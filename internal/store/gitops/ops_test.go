package gitops

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

// fakeRunner answers gh, open and editor commands (and selected git subcommands) with
// canned results and runs every other git command for real.
type fakeRunner struct {
	reply map[string]Result
	block map[string]chan struct{}

	mu    sync.Mutex
	calls []Cmd
}

// key is the git subcommand ("fetch"), "gh <verb> <verb>", or the binary's base name.
func runnerKey(c Cmd) string {
	switch base := filepath.Base(c.Name); {
	case base == "git" && len(c.Args) > 0:
		return c.Args[0]
	case base == "gh" && len(c.Args) > 1:
		return "gh " + c.Args[0] + " " + c.Args[1]
	default:
		return base
	}
}

func (f *fakeRunner) Run(ctx context.Context, c Cmd) Result {
	k := runnerKey(c)
	f.mu.Lock()
	f.calls = append(f.calls, c)
	ch := f.block[k]
	res, canned := f.reply[k]
	f.mu.Unlock()
	if ch != nil {
		select {
		case <-ch:
		case <-ctx.Done():
			return Result{ExitCode: -1, Err: ctx.Err()}
		}
	}
	if canned {
		if res.Err != nil && res.ExitCode == 0 {
			res.ExitCode = 1
		}
		return res
	}
	if filepath.Base(c.Name) == "git" {
		return ExecRunner{}.Run(ctx, c)
	}
	return Result{}
}

func (f *fakeRunner) called(key string) []Cmd {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Cmd
	for _, c := range f.calls {
		if runnerKey(c) == key {
			out = append(out, c)
		}
	}
	return out
}

var errExit = errors.New("exit status 1")

func TestCreatePR(t *testing.T) {
	const url = "https://github.com/me/a/pull/42"
	tests := []struct {
		name     string
		opts     CreatePROptions
		gh       Result
		wantOK   bool
		summary  string
		wantURL  string
		wantArgs []string
	}{
		{
			name:     "defaults: title from last commit, empty body",
			gh:       Result{Stdout: "\nhttps://github.com/me/a/pull/42\n", Combined: "Creating pull request\nhttps://github.com/me/a/pull/42\n"},
			wantOK:   true,
			summary:  "created pull request #42",
			wantURL:  url,
			wantArgs: []string{"pr", "create", "--head", "feat", "--title", "feat: add thing", "--body", "", "--repo", "me/a"},
		},
		{
			name:     "draft with title, body and base",
			opts:     CreatePROptions{Title: "My PR", Body: "Details", Draft: true, Base: "develop"},
			gh:       Result{Stdout: url + "\n"},
			wantOK:   true,
			summary:  "created draft pull request #42",
			wantURL:  url,
			wantArgs: []string{"pr", "create", "--head", "feat", "--title", "My PR", "--body", "Details", "--draft", "--base", "develop", "--repo", "me/a"},
		},
		{
			name:    "already exists is success",
			gh:      Result{Combined: "a pull request for branch \"feat\" into branch \"main\" already exists:\n" + url + "\n", Err: errExit},
			wantOK:  true,
			summary: "pull request #42 already exists",
			wantURL: url,
		},
		{
			name:    "gh failure",
			gh:      Result{Combined: "GraphQL: Head sha can't be blank (createPullRequest)\n", Err: errExit},
			summary: "GraphQL: Head sha can't be blank (createPullRequest)",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fr := &fakeRunner{reply: map[string]Result{"gh pr create": tt.gh}}
			w := newWorld(t, Options{Runner: fr, Gh: "/usr/local/bin/gh"})
			git(t, w.a, "switch", "-q", "-c", "feat")
			commit(t, w.a, "f.txt", "x\n", "feat: add thing")
			tt.opts.WorktreePath = w.a
			op := mustOp(t)(w.m.CreatePR(context.Background(), tt.opts))
			if op.OK() != tt.wantOK || op.Summary != tt.summary || op.URL != tt.wantURL {
				t.Errorf("op ok=%v summary=%q url=%q, want ok=%v %q %q\n%s", op.OK(), op.Summary, op.URL, tt.wantOK, tt.summary, tt.wantURL, op.Output)
			}
			calls := fr.called("gh pr create")
			if len(calls) != 1 {
				t.Fatalf("gh pr create calls = %d", len(calls))
			}
			if tt.wantArgs != nil && !slices.Equal(calls[0].Args, tt.wantArgs) {
				t.Errorf("gh args = %q\nwant %q", calls[0].Args, tt.wantArgs)
			}
			// The branch was pushed (with upstream) before gh ran.
			if got := git(t, w.a, "rev-parse", "--abbrev-ref", "feat@{upstream}"); got != "origin/feat" {
				t.Errorf("upstream = %q", got)
			}
			if !strings.Contains(op.Output, "$ git push -u origin feat") || !strings.Contains(op.Output, "$ gh pr create") {
				t.Errorf("transcript:\n%s", op.Output)
			}
		})
	}
}

func TestCreatePRStopsWhenPushFails(t *testing.T) {
	fr := &fakeRunner{reply: map[string]Result{"push": {Combined: "fatal: could not read from remote\n", Err: errExit}}}
	w := newWorld(t, Options{Runner: fr, Gh: "gh"})
	op := mustOp(t)(w.m.CreatePR(context.Background(), CreatePROptions{WorktreePath: w.a}))
	wantFailed(t, op, "could not read from remote")
	if n := len(fr.called("gh pr create")); n != 0 {
		t.Errorf("gh ran %d times after a failed push", n)
	}
}

func TestOpenPR(t *testing.T) {
	const url = "https://github.com/me/a/pull/9"
	fr := &fakeRunner{reply: map[string]Result{"gh pr view": {Stdout: url + "\n"}}}
	w := newWorld(t, Options{Runner: fr, Gh: "gh"})
	op := mustOp(t)(w.m.OpenPR(context.Background(), w.a))
	wantOK(t, op, "opened pull request #9")
	if op.URL != url {
		t.Errorf("url = %q", op.URL)
	}
	view := fr.called("gh pr view")
	if len(view) != 1 || !slices.Equal(view[0].Args, []string{"pr", "view", "main", "--json", "url,number", "--jq", ".url", "--repo", "me/a"}) {
		t.Errorf("gh pr view calls = %+v", view)
	}
	if open := fr.called("open"); len(open) != 1 || !slices.Equal(open[0].Args, []string{url}) {
		t.Errorf("open calls = %+v", open)
	}

	fr.reply["gh pr view"] = Result{Combined: "no pull requests found for branch \"main\"\n", Err: errExit}
	wantFailed(t, mustOp(t)(w.m.OpenPR(context.Background(), w.a)), "no pull requests found")
}

func TestRevealOpenURLEditor(t *testing.T) {
	fr := &fakeRunner{}
	editor := "zed"
	w := newWorld(t, Options{Runner: fr, Editor: func() string { return editor }})
	w.m.opts.editorEnv = &editorEnv{
		getenv:   func(string) string { return "" },
		lookPath: func(n string) (string, error) { return "/opt/bin/" + n, nil },
		exists:   func(string) bool { return false },
	}
	ctx := context.Background()

	wantOK(t, mustOp(t)(w.m.Reveal(ctx, w.a)), "revealed "+w.a+" in Finder")
	if c := fr.called("open"); len(c) != 1 || !slices.Equal(c[0].Args, []string{"-R", w.a}) {
		t.Errorf("open -R calls = %+v", c)
	}

	op := mustOp(t)(w.m.OpenEditor(ctx, w.a))
	wantOK(t, op, "opened a in zed")
	if c := fr.called("zed"); len(c) != 1 || c[0].Name != "/opt/bin/zed" || !slices.Equal(c[0].Args, []string{w.a}) {
		t.Errorf("editor calls = %+v", c)
	}
	// The setting is read on every call.
	editor = "open -a 'Visual Studio Code'"
	wantOK(t, mustOp(t)(w.m.OpenEditor(ctx, w.a)), "opened a in Visual Studio Code")
	editor = "code 'unterminated"
	if _, err := w.m.OpenEditor(ctx, w.a); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("bad editor setting err = %v", err)
	}
	fr.reply = map[string]Result{"code": {ExitCode: -1, Err: errors.New(`exec: "code": executable file not found in $PATH`)}}
	editor = "code"
	wantFailed(t, mustOp(t)(w.m.OpenEditor(ctx, w.a)), "executable file not found")

	op = mustOp(t)(w.m.OpenURL(ctx, "https://github.com/me/a/pull/1"))
	wantOK(t, op, "opened https://github.com/me/a/pull/1")
	if op.WorktreePath != "" || op.URL != "https://github.com/me/a/pull/1" {
		t.Errorf("open url op = %+v", op)
	}
	for _, bad := range []string{"", "file:///etc/passwd", "javascript:alert(1)", "github.com/x", "https://"} {
		if _, err := w.m.OpenURL(ctx, bad); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("OpenURL(%q) err = %v, want ErrInvalidArgument", bad, err)
		}
	}
}
