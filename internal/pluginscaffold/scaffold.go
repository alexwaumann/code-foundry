// Package pluginscaffold starts a plugin repository from the embedded minimal example
// (plugins.Minimal), for `code-foundry plugin new` (docs/notes/plugin-new.md): it
// writes the template's files with "minimal" replaced by the plugin's name, then has the
// injected go step make the module and fetch the SDK at this daemon's pin.
package pluginscaffold

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/plugins"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// SDKModule is the module a plugin requires.
const SDKModule = "github.com/alexwaumann/code-foundry/pluginsdk"

// DirPrefix starts a plugin repository's name: code-foundry-plugin-<name>.
const DirPrefix = "code-foundry-plugin-"

// GoTimeout bounds the go step: the first fetch of the SDK can take a minute through the
// Go proxy, and a minute and a half more when it falls back to GitHub (GoCommands).
const GoTimeout = 5 * time.Minute

// ErrInvalid marks a request refused before anything was written.
var ErrInvalid = errors.New("invalid argument")

// GoFunc runs script (shell commands joined by &&) in dir and returns its combined
// output.
type GoFunc func(ctx context.Context, dir, script string) ([]byte, error)

// Request is one plugin to scaffold.
type Request struct {
	// Template is the template's files at its root (fs.Sub of plugins.Minimal).
	Template fs.FS
	// Name is the plugin's name.
	Name string
	// Parent is the absolute folder the repository is made in.
	Parent string
	// Owner is the GitHub owner for the module path; "" makes a bare module path.
	Owner string
	// Pin is the SDK version to go get (skills.SDKPin).
	Pin string
	// Home is the folder Parent must be inside ("" checks nothing).
	Home string
	// Go runs the go step; nil skips it.
	Go GoFunc
}

// Result is what Scaffold made.
type Result struct {
	// Dir is the repository folder, Module its module path.
	Dir    string `json:"dir"`
	Module string `json:"module"`
	// Files are the files written, relative to Dir.
	Files []string `json:"files"`
	// GoError is why the go step failed ("" when it ran); the files stay.
	GoError string `json:"goError,omitempty"`
	// Finish are the commands that finish the module by hand when GoError is set.
	Finish []string `json:"finish,omitempty"`
}

// Module is the module path for a plugin: github.com/<owner>/code-foundry-plugin-<name>,
// or the bare repository name without an owner.
func Module(name, owner string) string {
	if owner == "" {
		return DirPrefix + name
	}
	return "github.com/" + owner + "/" + DirPrefix + name
}

// Title is name in Title Case, hyphens as spaces: "pr-board" is "Pr Board".
func Title(name string) string {
	words := strings.Split(name, "-")
	for i, w := range words {
		if w != "" {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " ")
}

// GoCommands are the commands that make the module and fetch the SDK at pin. The fetch
// tries the Go proxy, then GitHub itself: for a commit nobody has asked the proxy for yet
// (a build minutes old) the proxy answers for the repository's root module alone, and go
// get fails with "does not contain package …/pluginsdk" until the proxy has the nested one
// (docs/notes/plugin-author-spike.md).
func GoCommands(module, pin string) []string {
	get := "go get " + SDKModule + "@" + pin
	return []string{"go mod init " + module, get + " || GOPROXY=direct " + get, "go mod tidy"}
}

// goScript is cmds as one shell line that stops at the first to fail; each is grouped,
// since one may hold an || of its own.
func goScript(cmds []string) string {
	parts := make([]string, len(cmds))
	for i, c := range cmds {
		parts[i] = "{ " + c + "; }"
	}
	return strings.Join(parts, " && ")
}

// Scaffold makes <Parent>/code-foundry-plugin-<Name> from the template, then runs the go
// step. It refuses a bad name, a folder outside Home and a target that is not empty
// before it writes anything. A failed go step keeps the files and is reported in
// Result.GoError, not as an error.
func Scaffold(ctx context.Context, req Request) (Result, error) {
	files, err := render(req.Template, req.Name)
	if err != nil {
		return Result{}, err
	}
	if !filepath.IsAbs(req.Parent) {
		return Result{}, fmt.Errorf("%w: %q is not an absolute path", ErrInvalid, req.Parent)
	}
	if req.Owner != "" && !ownerOK(req.Owner) {
		return Result{}, fmt.Errorf("%w: owner %q is not a GitHub user or organisation name", ErrInvalid, req.Owner)
	}
	dir := filepath.Join(filepath.Clean(req.Parent), DirPrefix+req.Name)
	real, err := resolve(dir)
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if req.Home != "" && !fsx.Within(req.Home, real) {
		return Result{}, fmt.Errorf("%w: %s is outside your home directory", ErrInvalid, real)
	}
	created, err := prepare(dir)
	if err != nil {
		return Result{}, err
	}
	res := Result{Dir: dir, Module: Module(req.Name, req.Owner)}
	for _, f := range files {
		if err := write(dir, f); err != nil {
			undo(dir, created)
			return Result{}, err
		}
		res.Files = append(res.Files, f.path)
	}
	if req.Go == nil {
		return res, nil
	}
	cmds := GoCommands(res.Module, req.Pin)
	gctx, cancel := context.WithTimeout(ctx, GoTimeout)
	defer cancel()
	if out, err := req.Go(gctx, dir, goScript(cmds)); err != nil {
		// Start the module over by hand: a second go mod init refuses an existing go.mod.
		_ = os.Remove(filepath.Join(dir, "go.mod"))
		_ = os.Remove(filepath.Join(dir, "go.sum"))
		res.GoError = goError(err, out)
		res.Finish = cmds
	}
	return res, nil
}

// Scaffolder is the daemon's Scaffold: the embedded template, the user's home and this
// build's SDK pin.
type Scaffolder struct {
	// Template is the template's files (nil: the minimal example, plugins.Minimal).
	Template fs.FS
	Home     string
	Pin      string
	Go       GoFunc
}

// New scaffolds plugin name in parent with owner's module path (see Scaffold).
func (s Scaffolder) New(ctx context.Context, name, parent, owner string) (Result, error) {
	tmpl := s.Template
	if tmpl == nil {
		sub, err := fs.Sub(plugins.Minimal, plugins.MinimalRoot)
		if err != nil {
			return Result{}, fmt.Errorf("pluginscaffold: %w", err)
		}
		tmpl = sub
	}
	return Scaffold(ctx, Request{Template: tmpl, Name: name, Parent: parent, Owner: owner, Pin: s.Pin, Home: s.Home, Go: s.Go})
}

// ShellGo is the daemon's go step: $SHELL -lc script in dir, so go is found on the
// user's login PATH. It runs in its own process group, which the context's end kills
// whole: killing only the shell leaves go holding the output pipe until it finishes.
func ShellGo(ctx context.Context, dir, script string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, cmp.Or(os.Getenv("SHELL"), "/bin/zsh"), "-lc", script)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return out, fmt.Errorf("timed out after %s", GoTimeout)
	}
	return out, err
}

// file is one template file to write.
type file struct {
	path string // slash-separated, relative to the repository
	data []byte
}

// render reads the template with the name filled in, and checks the name with the
// SDK's rules on the manifest it makes.
func render(tmpl fs.FS, name string) ([]file, error) {
	title := Title(name)
	var files []file
	err := fs.WalkDir(tmpl, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(tmpl, p)
		if err != nil {
			return err
		}
		b = bytes.ReplaceAll(b, []byte("Minimal"), []byte(title))
		b = bytes.ReplaceAll(b, []byte("minimal"), []byte(name))
		files = append(files, file{p, b})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("pluginscaffold: template: %w", err)
	}
	var manifest []byte
	for _, f := range files {
		if f.path == pluginsdk.ManifestFile {
			manifest = f.data
		}
	}
	if manifest == nil {
		return nil, fmt.Errorf("pluginscaffold: template has no %s", pluginsdk.ManifestFile)
	}
	if _, _, err := pluginsdk.LoadManifest(manifest); err != nil {
		return nil, fmt.Errorf("%w: plugin name %q: %v", ErrInvalid, name, err)
	}
	return files, nil
}

// ownerOK reports whether owner can be a GitHub login: letters, digits and single
// hyphens, not at either end.
func ownerOK(owner string) bool {
	if len(owner) > 39 || strings.HasPrefix(owner, "-") || strings.HasSuffix(owner, "-") || strings.Contains(owner, "--") {
		return false
	}
	for _, r := range owner {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return owner != ""
}

// resolve is p with the symlinks of its deepest existing ancestor resolved, for the
// home check on a folder that may not exist yet.
func resolve(p string) (string, error) {
	var rest []string
	for {
		real, err := filepath.EvalSymlinks(p)
		if err == nil {
			return filepath.Join(append([]string{real}, rest...)...), nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(p)
		if parent == p {
			return "", err
		}
		rest = append([]string{filepath.Base(p)}, rest...)
		p = parent
	}
}

// prepare makes dir, or accepts it when it is an empty folder; created reports a new
// one.
func prepare(dir string) (created bool, err error) {
	entries, err := os.ReadDir(dir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return false, fmt.Errorf("pluginscaffold: %w", err)
		}
		return true, nil
	case err != nil:
		return false, fmt.Errorf("%w: %v", ErrInvalid, err)
	case len(entries) > 0:
		return false, fmt.Errorf("%w: %s exists and is not empty", ErrInvalid, dir)
	}
	return false, nil
}

func write(dir string, f file) error {
	p := filepath.Join(dir, filepath.FromSlash(f.path))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return fmt.Errorf("pluginscaffold: %w", err)
	}
	if err := os.WriteFile(p, f.data, 0o644); err != nil {
		return fmt.Errorf("pluginscaffold: %w", err)
	}
	return nil
}

// undo removes a partial write: the folder it made, or everything in the empty
// folder it was given.
func undo(dir string, created bool) {
	if created {
		_ = os.RemoveAll(dir)
		return
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		_ = os.RemoveAll(filepath.Join(dir, e.Name()))
	}
}

// goError is err with the end of the go step's output.
func goError(err error, out []byte) string {
	msg := err.Error()
	tail := strings.TrimSpace(string(out))
	if lines := strings.Split(tail, "\n"); len(lines) > 10 {
		tail = strings.Join(lines[len(lines)-10:], "\n")
	}
	if tail != "" {
		msg += ": " + tail
	}
	return msg
}
