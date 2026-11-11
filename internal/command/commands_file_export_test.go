package command_test

import (
	"context"
	"encoding/base64"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/preview"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// exportHome is a home with a config home, a checkout and a folder beside it, and
// file.export registered for a thread whose cwd is cwd (a checkout under home, or home
// itself for a thread without a project).
type exportHome struct {
	root, checkout string
	reg            *command.Registry
}

func newExportHome(t *testing.T, noProject bool) exportHome {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := exportHome{root: root, checkout: filepath.Join(root, "src", "app")}
	for _, d := range []string{"src/app/out", "src/app/.git", "src/other", ".code-foundry", ".ssh", "Library/LaunchAgents"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for rel, body := range map[string]string{"src/app/rows.csv": "old\n", "src/other/secret.txt": "keep", "src/app/.git/config": "[core]\n"} {
		if err := os.WriteFile(filepath.Join(root, rel), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for link, target := range map[string]string{
		"src/app/away":      "src/other",
		"src/app/away.txt":  "src/other/secret.txt",
		"src/app/inner":     "src/app/out",
		"src/app/dangling":  "src/app/nothing",
		"src/app/config.cf": ".code-foundry",
	} {
		if err := os.Symlink(filepath.Join(root, target), filepath.Join(root, link)); err != nil {
			t.Fatal(err)
		}
	}
	cwd := h.checkout
	if noProject {
		cwd = root
	}
	grants := preview.NewGrants(preview.NewFloor(root, paths.New(filepath.Join(root, ".code-foundry"))))
	fs := api.NewFilesystem(root, projecttest.New(nil), grants)
	h.reg = command.NewRegistry()
	err = command.RegisterFileExport(h.reg, command.FileExportDeps{
		Thread: &commandtest.Thread{Current: &v1.Thread{Id: "s-1", WorktreePath: cwd}},
		Files:  fs,
	})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

var (
	exportCLI  = command.Context{ActiveThreadID: "s-1", Origin: command.OriginCLI}
	exportPage = command.Context{ActiveThreadID: "s-1", Origin: command.OriginPage}
)

func (h exportHome) read(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(h.root, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestFileExportPaths(t *testing.T) {
	tests := []struct {
		name, path string
		noProject  bool
		// wrote is the file it makes, relative to home; "" when it refuses.
		wrote string
		// why is part of the refusal.
		why string
	}{
		{name: "a file name", path: "new.csv", wrote: "src/app/new.csv"},
		{name: "a folder of the checkout", path: "out/new.csv", wrote: "src/app/out/new.csv"},
		{name: "a link to a folder inside it", path: "inner/new.csv", wrote: "src/app/out/new.csv"},
		{name: "a path that comes back in", path: "out/../new.csv", wrote: "src/app/new.csv"},
		{name: "no project: its cwd, home", path: "new.csv", noProject: true, wrote: "new.csv"},
		{name: "no project: a folder of home", path: "src/new.csv", noProject: true, wrote: "src/new.csv"},
		{name: "empty", path: " ", why: "needs a file name"},
		{name: "absolute", path: "/tmp/new.csv", why: "not relative"},
		{name: "the home folder", path: "~/new.csv", why: "not relative"},
		{name: "up and out", path: "../other/new.csv", why: "outside the thread's checkout"},
		{name: "a link to a folder outside", path: "away/new.csv", why: "leads outside"},
		{name: "a link to a file outside", path: "away.txt", why: "leads outside"},
		{name: "a link into the config home", path: "config.cf/token", why: "Code Foundry's own data"},
		{name: "a link to nothing", path: "dangling", why: "leads nowhere"},
		{name: "git's folder", path: ".git/config", why: "starting with a dot"},
		{name: "a dot file", path: ".env", why: "starting with a dot"},
		{name: "a missing folder", path: "missing/new.csv", why: "does not exist"},
		{name: "the checkout itself", path: "out", why: "directory"},
		{name: "no project: credentials", path: ".ssh/authorized_keys", noProject: true, why: "starting with a dot"},
		{name: "no project: the config home", path: ".code-foundry/x", noProject: true, why: "starting with a dot"},
		{name: "no project: ~/Library", path: "Library/LaunchAgents/x.plist", noProject: true, why: "protected folder"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newExportHome(t, tt.noProject)
			res, err := h.reg.Invoke(context.Background(), exportCLI, "file.export", map[string]string{"path": tt.path, "text": "a,b\n"})
			if tt.wrote == "" {
				if err == nil || !strings.Contains(err.Error(), tt.why) {
					t.Fatalf("err = %v, want one saying %q", err, tt.why)
				}
				if got := h.read(t, "src/other/secret.txt"); got != "keep" {
					t.Errorf("the file outside became %q", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want := filepath.Join(h.root, tt.wrote)
			if got := res.JSON.(command.FileExportResult); got.Size != 4 || got.Replaced || !strings.HasSuffix(want, filepath.Base(got.Path)) {
				t.Errorf("JSON = %+v, want a new file at %s", got, want)
			}
			if !strings.Contains(res.Message, "saved ") {
				t.Errorf("message = %q", res.Message)
			}
			if got := h.read(t, tt.wrote); got != "a,b\n" {
				t.Errorf("%s = %q", tt.wrote, got)
			}
		})
	}
}

func TestFileExportContents(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G', 0, 1, 2}
	tests := []struct {
		name string
		args map[string]string
		want string
		why  string
	}{
		{name: "text", args: map[string]string{"text": "héllo"}, want: "héllo"},
		{name: "empty text", args: map[string]string{"text": ""}, want: ""},
		{name: "bytes", args: map[string]string{"base64": base64.StdEncoding.EncodeToString(png)}, want: string(png)},
		{name: "none", args: map[string]string{}, why: "needs the contents"},
		{name: "both", args: map[string]string{"text": "a", "base64": "YQ=="}, why: "once"},
		{name: "not base64", args: map[string]string{"base64": "not base64!"}, why: "is not base64"},
		{name: "at the cap", args: map[string]string{"text": strings.Repeat("x", command.MaxExportBytes)}, want: strings.Repeat("x", command.MaxExportBytes)},
		{name: "past the cap", args: map[string]string{"text": strings.Repeat("x", command.MaxExportBytes+1)}, why: "at most 256.0 KiB"},
		{name: "past the cap in bytes", args: map[string]string{"base64": base64.StdEncoding.EncodeToString(make([]byte, command.MaxExportBytes+1))}, why: "at most"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newExportHome(t, false)
			args := maps.Clone(tt.args)
			args["path"] = "new.bin"
			_, err := h.reg.Invoke(context.Background(), exportCLI, "file.export", args)
			if tt.why != "" {
				var ae *command.ArgError
				if !errors.As(err, &ae) || !strings.Contains(err.Error(), tt.why) {
					t.Fatalf("err = %v, want an arg error saying %q", err, tt.why)
				}
				if _, serr := os.Stat(filepath.Join(h.checkout, "new.bin")); serr == nil {
					t.Error("a file was made")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := h.read(t, "src/app/new.bin"); got != tt.want {
				t.Errorf("file has %d bytes, want %d", len(got), len(tt.want))
			}
		})
	}
}

// An existing file is a confirmation that names its path; the yes is bound to the file
// it named.
func TestFileExportReplaceAsks(t *testing.T) {
	ctx := context.Background()
	args := map[string]string{"path": "rows.csv", "text": "new\n"}
	ask := func(t *testing.T, h exportHome, uctx command.Context) *command.ConfirmError {
		t.Helper()
		_, err := h.reg.Invoke(ctx, uctx, "file.export", args)
		var ce *command.ConfirmError
		if !errors.As(err, &ce) {
			t.Fatalf("err = %v, want a confirmation", err)
		}
		return ce
	}
	yes := func(h exportHome, uctx command.Context, ce *command.ConfirmError) (command.Result, error) {
		a := maps.Clone(args)
		maps.Copy(a, ce.Bind)
		return h.reg.Invoke(ctx, uctx, "file.export", a, command.Confirmed(true))
	}

	t.Run("asks with the path, and replaces on a yes", func(t *testing.T) {
		h := newExportHome(t, false)
		ce := ask(t, h, exportCLI)
		path := filepath.Join(h.checkout, "rows.csv")
		if !strings.Contains(ce.Message, "Replace "+path+"?") || ce.Label != "Replace" {
			t.Errorf("confirmation = %q (%q)", ce.Message, ce.Label)
		}
		if got := h.read(t, "src/app/rows.csv"); got != "old\n" {
			t.Fatalf("asking wrote %q", got)
		}
		res, err := yes(h, exportCLI, ce)
		if err != nil {
			t.Fatal(err)
		}
		if got := res.JSON.(command.FileExportResult); !got.Replaced || got.Path != path {
			t.Errorf("JSON = %+v", got)
		}
		if got := h.read(t, "src/app/rows.csv"); got != "new\n" {
			t.Errorf("rows.csv = %q", got)
		}
	})
	t.Run("a page's question is the same one, with the call under it", func(t *testing.T) {
		h := newExportHome(t, false)
		ce := ask(t, h, exportPage)
		if !strings.Contains(ce.Message, "Replace ") || !strings.Contains(ce.Message, `file.export --path "rows.csv" --text <4 bytes>`) {
			t.Errorf("confirmation = %q", ce.Message)
		}
		if _, err := yes(h, exportPage, ce); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("a file that changed after the question is not replaced", func(t *testing.T) {
		h := newExportHome(t, false)
		ce := ask(t, h, exportPage)
		later := time.Now().Add(time.Minute)
		p := filepath.Join(h.checkout, "rows.csv")
		if err := os.WriteFile(p, []byte("theirs\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, later, later); err != nil {
			t.Fatal(err)
		}
		if _, err := yes(h, exportPage, ce); connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "changed since you were asked") {
			t.Fatalf("err = %v", err)
		}
		if got := h.read(t, "src/app/rows.csv"); got != "theirs\n" {
			t.Errorf("rows.csv = %q", got)
		}
	})
	t.Run("the CLI's --yes replaces what is there", func(t *testing.T) {
		h := newExportHome(t, false)
		if _, err := h.reg.Invoke(ctx, exportCLI, "file.export", args, command.Confirmed(true)); err != nil {
			t.Fatal(err)
		}
		if got := h.read(t, "src/app/rows.csv"); got != "new\n" {
			t.Errorf("rows.csv = %q", got)
		}
	})
	t.Run("a page's yes to make a file does not replace one that appeared", func(t *testing.T) {
		h := newExportHome(t, false)
		a := map[string]string{"path": "late.csv", "text": "new\n"}
		_, err := h.reg.Invoke(ctx, exportPage, "file.export", a)
		var ce *command.ConfirmError
		if !errors.As(err, &ce) || !strings.HasPrefix(ce.Message, "Run this?") {
			t.Fatalf("err = %v, want the page's question", err)
		}
		if err := os.WriteFile(filepath.Join(h.checkout, "late.csv"), []byte("theirs\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		// The yes to "Run this?" re-invokes with no binding: the file there now asks again.
		_, err = h.reg.Invoke(ctx, exportPage, "file.export", a, command.Confirmed(true))
		if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "exists now") {
			t.Fatalf("err = %v", err)
		}
		if got := h.read(t, "src/app/late.csv"); got != "theirs\n" {
			t.Errorf("late.csv = %q", got)
		}
	})
	t.Run("a hand-made binding is refused", func(t *testing.T) {
		h := newExportHome(t, false)
		a := maps.Clone(args)
		a["replaces"] = "anything"
		_, err := h.reg.Invoke(ctx, exportPage, "file.export", a, command.Confirmed(true))
		if !strings.Contains(fmtErr(err), "set by the confirmation") {
			t.Fatalf("err = %v", err)
		}
	})
}

// A page asks first even for a new file: it writes outside the app's state. The question
// shows the contents' size, not the contents, and where the file goes.
func TestFileExportPageQuestion(t *testing.T) {
	h := newExportHome(t, false)
	_, err := h.reg.Invoke(context.Background(), exportPage, "file.export", map[string]string{"path": "new.csv", "text": strings.Repeat("x", 3000)})
	var ce *command.ConfirmError
	if !errors.As(err, &ce) {
		t.Fatalf("err = %v, want the page's question", err)
	}
	want := "Run this?\nfile.export --path \"new.csv\" --text <2.9 KiB> --thread \"s-1\"\nSaves 2.9 KiB to " + filepath.Join(h.checkout, "new.csv")
	if ce.Message != want {
		t.Errorf("question =\n%s\nwant\n%s", ce.Message, want)
	}
	// A refusal comes before any question.
	_, err = h.reg.Invoke(context.Background(), exportPage, "file.export", map[string]string{"path": "../x.csv", "text": "x"})
	if errors.As(err, &ce) || err == nil {
		t.Fatalf("err = %v, want a refusal", err)
	}
}

// A thread whose checkout is not made yet has nowhere to save.
func TestFileExportNoCheckoutYet(t *testing.T) {
	reg := command.NewRegistry()
	if err := command.RegisterFileExport(reg, command.FileExportDeps{
		Thread: &commandtest.Thread{Current: &v1.Thread{Id: "s-1"}},
	}); err != nil {
		t.Fatal(err)
	}
	_, err := reg.Invoke(context.Background(), exportCLI, "file.export", map[string]string{"path": "a.csv", "text": "x"})
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "no checkout yet") {
		t.Fatalf("err = %v", err)
	}
}

func fmtErr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
