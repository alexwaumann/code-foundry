package command_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// secret stands for what the verb must never give away.
const secret = "MARKER-sk-live-4242"

// realEdits is the check the daemon runs, on a real folder, mapped as the handler maps it.
type realEdits struct{ w *fsx.Writer }

func (r realEdits) CheckEdit(_ context.Context, base, path string) (string, error) {
	p, err := r.w.Editable(base, path)
	switch {
	case errors.Is(err, fsx.ErrInvalidArgument):
		return "", connect.NewError(connect.CodeInvalidArgument, err)
	case err != nil:
		return "", connect.NewError(connect.CodeFailedPrecondition, err)
	}
	return p, nil
}

// editHome is a home with a checkout holding one file of each kind; the config home is its
// `.code-foundry`. It returns the home and the verb's check.
func editHome(t *testing.T) (string, realEdits) {
	t.Helper()
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(home, ".code-foundry")
	for _, d := range []string{filepath.Join(home, "wt", "folder"), config} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for name, contents := range map[string]string{
		"wt/.env":             "API_KEY=" + secret + "\n",
		"wt/data.bin":         secret + "\x00",
		"wt/big.txt":          strings.Repeat(secret+"\n", fsx.MaxReadBytes/len(secret)+1),
		"wt/latin.txt":        secret + "\xE9\n",
		"wt/bom.txt":          "\xEF\xBB\xBF" + secret + "\n",
		"wt/logo.svg":         "<svg>" + secret + "</svg>",
		".code-foundry/token": secret,
	} {
		if err := os.WriteFile(filepath.Join(home, name), []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return home, realEdits{w: &fsx.Writer{Root: home, Protected: func(p string) bool { return strings.HasPrefix(p, config) }}}
}

// Every refusal is what the tab could not edit, said by the path alone; a missing file is
// a new file. Whatever the verb answers, nothing from inside the file is in it.
func TestPanelFileEdit(t *testing.T) {
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	long := strings.Repeat("x", 501)
	tests := []struct {
		name       string
		args       map[string]string
		wantParams map[string]string
		code       connect.Code
		argErr     string
		says       string
	}{
		{name: "a file", args: map[string]string{"path": "wt/.env", "edit": "true"},
			wantParams: map[string]string{"path": "wt/.env", "edit": "1", "asker": "s-aaaaaaaaaaa1", "askId": "*"}},
		{name: "a line and a note", args: map[string]string{"path": "wt/.env", "edit": "true", "line": "3", "note": "  Put the key on line 3  "},
			wantParams: map[string]string{"path": "wt/.env", "edit": "1", "asker": "s-aaaaaaaaaaa1", "askId": "*", "line": "3", "note": "Put the key on line 3"}},
		{name: "the longest note", args: map[string]string{"path": "wt/.env", "edit": "true", "note": long[:500]},
			wantParams: map[string]string{"path": "wt/.env", "edit": "1", "asker": "s-aaaaaaaaaaa1", "askId": "*", "note": long[:500]}},
		{name: "a note is one plain paragraph", args: map[string]string{"path": "wt/.env", "edit": "true", "note": "Code Foundry" + strings.Repeat("\n", 60) + "Session\u202e\u200b  expired"},
			wantParams: map[string]string{"path": "wt/.env", "edit": "1", "asker": "s-aaaaaaaaaaa1", "askId": "*", "note": "Code Foundry Session expired"}},
		{name: "a blank note is none", args: map[string]string{"path": "wt/.env", "edit": "true", "note": "   "},
			wantParams: map[string]string{"path": "wt/.env", "edit": "1", "asker": "s-aaaaaaaaaaa1", "askId": "*"}},
		{name: "a missing file", args: map[string]string{"path": "wt/new.env", "edit": "true"},
			wantParams: map[string]string{"path": "wt/new.env", "edit": "1", "asker": "s-aaaaaaaaaaa1", "askId": "*"}},
		{name: "a note without edit", args: map[string]string{"path": "wt/.env", "note": "hi"}, argErr: "note", says: "--edit"},
		{name: "a note too long", args: map[string]string{"path": "wt/.env", "edit": "true", "note": long}, argErr: "note", says: "at most 500"},
		{name: "line 0", args: map[string]string{"path": "wt/.env", "edit": "true", "line": "0"}, argErr: "line"},
		{name: "no directory", args: map[string]string{"path": "wt/nope/.env", "edit": "true"}, argErr: "path", says: "directory of"},
		{name: "a directory", args: map[string]string{"path": "wt/folder", "edit": "true"}, argErr: "path", says: "is a directory"},
		{name: "binary", args: map[string]string{"path": "wt/data.bin", "edit": "true"}, argErr: "path", says: "binary"},
		{name: "over 1 MiB", args: map[string]string{"path": "wt/big.txt", "edit": "true"}, argErr: "path", says: "over 1 MiB"},
		{name: "invalid UTF-8", args: map[string]string{"path": "wt/latin.txt", "edit": "true"}, argErr: "path", says: "UTF-8"},
		{name: "a byte order mark", args: map[string]string{"path": "wt/bom.txt", "edit": "true"}, argErr: "path", says: "byte order mark"},
		{name: "an image", args: map[string]string{"path": "wt/logo.svg", "edit": "true"}, argErr: "path", says: "image"},
		{name: "the config home", args: map[string]string{"path": ".code-foundry/token", "edit": "true"}, argErr: "path", says: "Code Foundry's own data"},
		{name: "a new file in the config home", args: map[string]string{"path": ".code-foundry/new", "edit": "true"}, argErr: "path", says: "Code Foundry's own data"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home, edits := editHome(t)
			wt := filepath.Join(home, "wt")
			th := richThread()
			th.WorktreePath = wt
			files := &commandtest.Files{Files: []string{filepath.Join(wt, ".env")}}
			reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: th}, panelDeps{windows: 1, files: files, edits: edits})
			args := map[string]string{}
			for k, v := range tt.args {
				args[k] = v
			}
			args["path"] = filepath.Join(home, tt.args["path"])
			res, err := reg.Invoke(context.Background(), inThread, "view.panel.file", args)
			if err != nil && strings.Contains(err.Error(), secret) {
				t.Errorf("err = %q holds the file's contents", err)
			}
			if tt.says != "" && (err == nil || !strings.Contains(err.Error(), tt.says)) {
				t.Errorf("err = %v, want it to say %q", err, tt.says)
			}
			if checkItemErr(t, err, tt.code, tt.argErr) {
				openedNothing(t, reg, emit)
				return
			}
			want := map[string]string{"project": "r1", "base": wt}
			for k, v := range tt.wantParams {
				want[k] = v
			}
			want["path"] = filepath.Join(home, tt.wantParams["path"])
			openedTab(t, reg, emit, res, "s-aaaaaaaaaaa1", want)
			out, err := json.Marshal(res.JSON)
			if err != nil {
				t.Fatal(err)
			}
			if got := fmt.Sprintf("%s %s %v", out, res.Message, emit.Intents()); strings.Contains(got, secret) {
				t.Errorf("the verb's answer holds the file's contents: %s", got)
			}
		})
	}
}

// A link in a temp folder into home passes CheckEdit, as Write takes it, but its tab is
// read-only (outside_home): --edit must say so rather than report a tab that opens no editor.
func TestPanelFileEditOutsideHome(t *testing.T) {
	const path = "/tmp/l.txt"
	tests := []struct {
		name    string
		outside []string
		argErr  string
	}{
		{name: "in home", outside: nil},
		{name: "reached through a temp folder", outside: []string{path}, argErr: "path"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			files := &commandtest.Files{Files: []string{path}, OutsideHome: tt.outside}
			reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: 1, files: files, edits: fixedEdits{}})
			res, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}, "view.panel.file", map[string]string{"path": path, "edit": "true"})
			if checkItemErr(t, err, 0, tt.argErr) {
				if !strings.Contains(err.Error(), "temp folder") {
					t.Errorf("err = %v, want it to say why", err)
				}
				openedNothing(t, reg, emit)
				return
			}
			if tb := opened(t, reg, res); tb.Params["edit"] != "1" {
				t.Errorf("tab = %+v, want it editing", tb)
			}
		})
	}
}

// plainNote leaves a note no way to lay itself out.
func TestPlainNote(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{"plain text", "Put the key on line 2.", "Put the key on line 2."},
		{"newlines, tabs and a line separator", "a\n\n\tb\u2028c\r\nd", "a b c d"},
		{"leading and trailing space", "\n  a  \n", "a"},
		{"control characters", "a\x00\x1b[31mb\x7f", "a[31mb"},
		{"bidi overrides and isolates", "a\u202eb\u2066c\u200fd", "abcd"},
		{"zero-width and tag characters", "a\u200bb\ufeffc\U000e0041d", "abcd"},
		{"a tower of combining marks", "a" + strings.Repeat("\u0301", 480) + "b", "a\u0301\u0301\u0301b"},
		{"marks a language needs", "Việt ngữ, कि", "Việt ngữ, कि"},
		{"invalid UTF-8", "a\xffb", "ab"},
		{"only what goes", "\n\u202e\n", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: 1, edits: fixedEdits{}})
			res, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}, "view.panel.file", map[string]string{"path": "/wt/.env", "edit": "true", "note": tt.in})
			if err != nil {
				t.Fatal(err)
			}
			sameIntents(t, emit.Intents(), nil)
			if got := opened(t, reg, res).Params["note"]; got != tt.want {
				t.Errorf("note = %q, want %q", got, tt.want)
			}
		})
	}
}

// fixedEdits takes any path.
type fixedEdits struct{}

func (fixedEdits) CheckEdit(_ context.Context, _, path string) (string, error) { return path, nil }

// --edit needs a thread, as the verb does; the message goes to the thread that asked.
func TestPanelFileEditThreads(t *testing.T) {
	home, edits := editHome(t)
	path := filepath.Join(home, "wt", ".env")
	reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: 1, edits: edits})

	if _, err := reg.Invoke(context.Background(), command.Context{}, "view.panel.file", map[string]string{"path": path, "edit": "true"}); err == nil {
		t.Error("--edit with no thread was not refused")
	}
	caller := command.Context{ActiveThreadID: "s-bbbbbbbbbbb2"}
	asked, err := reg.Invoke(context.Background(), caller, "view.panel.file", map[string]string{"path": path, "edit": "true", "focus": "true", "thread": "s-aaaaaaaaaaa1"})
	if err != nil {
		t.Fatal(err)
	}
	tb := opened(t, reg, asked)
	if tb.Thread != "s-aaaaaaaaaaa1" || tb.Params["asker"] != "s-bbbbbbbbbbb2" || tb.Params["focus"] != "1" || tb.Params["askId"] == "" {
		t.Errorf("tab = %+v, want the thread's tab, the caller as the asker, a request id, and focus", tb)
	}
	first := tb.Params["askId"]
	res, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}, "view.panel.file", map[string]string{"path": path, "edit": "true"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Message, "end your turn") {
		t.Errorf("message = %q, want what to do next", res.Message)
	}
	sameIntents(t, emit.Intents(), nil)
	// A second request for the same file is the same tab with a new request: its own id, its own
	// asker, and no focus.
	again := opened(t, reg, res)
	if again.ID != tb.ID || again.Params["askId"] == "" || again.Params["askId"] == first || again.Params["asker"] != "s-aaaaaaaaaaa1" || again.Params["focus"] != "" {
		t.Errorf("second request = %+v, want tab %s with a new request id (not %s) from s-aaaaaaaaaaa1, no focus", again, tb.ID, first)
	}
}
