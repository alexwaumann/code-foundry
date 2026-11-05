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

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// secret stands for what the verb must never give away.
const secret = "MARKER-sk-live-4242"

// realEdits is the check the daemon runs, on a real folder, mapped as the handler maps it.
type realEdits struct{ w *fsx.Writer }

func (r realEdits) CheckEdit(_ context.Context, base, path string) (string, bool, error) {
	t, err := r.w.Editable(base, path)
	switch {
	case errors.Is(err, fsx.ErrInvalidArgument):
		return "", false, connect.NewError(connect.CodeInvalidArgument, err)
	case err != nil:
		return "", false, connect.NewError(connect.CodeFailedPrecondition, err)
	}
	return t.Path, t.Missing, nil
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
			wantParams: map[string]string{"path": "wt/.env", "edit": "1", "thread": "s-aaaaaaaaaaa1"}},
		{name: "a line and a note", args: map[string]string{"path": "wt/.env", "edit": "true", "line": "3", "note": "  Put the key on line 3  "},
			wantParams: map[string]string{"path": "wt/.env", "edit": "1", "thread": "s-aaaaaaaaaaa1", "line": "3", "note": "Put the key on line 3"}},
		{name: "the longest note", args: map[string]string{"path": "wt/.env", "edit": "true", "note": long[:500]},
			wantParams: map[string]string{"path": "wt/.env", "edit": "1", "thread": "s-aaaaaaaaaaa1", "note": long[:500]}},
		{name: "a blank note is none", args: map[string]string{"path": "wt/.env", "edit": "true", "note": "   "},
			wantParams: map[string]string{"path": "wt/.env", "edit": "1", "thread": "s-aaaaaaaaaaa1"}},
		{name: "a missing file", args: map[string]string{"path": "wt/new.env", "edit": "true"},
			wantParams: map[string]string{"path": "wt/new.env", "edit": "1", "thread": "s-aaaaaaaaaaa1", "create": "1"}},
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
				sameIntents(t, emit.Intents(), nil)
				return
			}
			want := map[string]string{"project": "r1", "base": wt}
			for k, v := range tt.wantParams {
				want[k] = v
			}
			want["path"] = filepath.Join(home, tt.wantParams["path"])
			sameIntents(t, emit.Intents(), []*v1.UiIntent{showViewWith(command.ViewPanelFile, "s-aaaaaaaaaaa1", want)})
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

// --edit needs a thread, as the verb does; the message goes to the thread that asked.
func TestPanelFileEditThreads(t *testing.T) {
	home, edits := editHome(t)
	path := filepath.Join(home, "wt", ".env")
	reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: 1, edits: edits})

	if _, err := reg.Invoke(context.Background(), command.Context{}, "view.panel.file", map[string]string{"path": path, "edit": "true"}); err == nil {
		t.Error("--edit with no thread was not refused")
	}
	caller := command.Context{ActiveThreadID: "s-bbbbbbbbbbb2"}
	if _, err := reg.Invoke(context.Background(), caller, "view.panel.file", map[string]string{"path": path, "edit": "true", "focus": "true", "thread": "s-aaaaaaaaaaa1"}); err != nil {
		t.Fatal(err)
	}
	res, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}, "view.panel.file", map[string]string{"path": path, "edit": "true"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Message, "end your turn") {
		t.Errorf("message = %q, want what to do next", res.Message)
	}
	intents := emit.Intents()[:2]
	if len(intents) != 2 {
		t.Fatalf("intents = %v, want the focus and the show", intents)
	}
	show := intents[1].GetShowView()
	if show.GetThreadId() != "s-aaaaaaaaaaa1" || show.GetParams()["thread"] != "s-bbbbbbbbbbb2" || show.GetParams()["focus"] != "1" {
		t.Errorf("show = %v, want the panel's thread, the caller as the asker, and focus", show)
	}
}
