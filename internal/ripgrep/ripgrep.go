// Package ripgrep finds the ripgrep executable the daemon runs for text search and checks
// that it works. A release ships it as code-foundry-rg beside the daemon (scripts/ripgrep.sh
// fetches it, scripts/package.sh packages it); the name cannot collide with a user's own
// rg. See docs/notes/file-search-3-ripgrep.md.
//
// Find, then Check before the first search:
//
//	bin, err := ripgrep.Find()      // ErrMissing when there is none
//	v, err := bin.Check(ctx)        // ErrBroken when it does not run as ripgrep
//	exec.CommandContext(ctx, bin.Path, "--json", ...)
package ripgrep

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	// BinName is the shipped executable, installed next to code-foundry.
	BinName = "code-foundry-rg"
	// EnvBin overrides where ripgrep is found (development: a build in another worktree,
	// or a stand-in). When set, nothing else is tried.
	EnvBin = "CODE_FOUNDRY_RG_BIN"
	// Version is the ripgrep version a release ships: RG_VERSION in scripts/ripgrep.sh
	// (a test keeps the two equal).
	Version = "15.2.0"
	// installMarker is the file whose presence makes a directory a release install
	// (update.VersionFile).
	installMarker = "VERSION"
	// checkTimeout bounds `--version`.
	checkTimeout = 5 * time.Second
)

var (
	// ErrMissing is no ripgrep to run. Its text is for the user: text search is off until
	// the app is updated or reinstalled.
	ErrMissing = errors.New("text search is unavailable: its search engine (ripgrep) is missing from this install; update or reinstall Code Foundry to restore it")
	// ErrBroken is a ripgrep that does not run or does not answer as ripgrep.
	ErrBroken = errors.New("text search is unavailable: its search engine (ripgrep) does not run; update or reinstall Code Foundry to restore it")
)

// Source says where a Binary was found.
type Source string

const (
	// SourceEnv is $CODE_FOUNDRY_RG_BIN.
	SourceEnv Source = "env"
	// SourceBundled is code-foundry-rg beside the running executable: a release install,
	// or ./bin after `make build`.
	SourceBundled Source = "bundled"
	// SourcePath is a development fallback: code-foundry-rg or rg on PATH, only when the
	// running executable is not a release install (go test, go run).
	SourcePath Source = "path"
)

// Binary is a ripgrep executable to run.
type Binary struct {
	Path   string
	Source Source
}

// Locator finds ripgrep. The zero value is not useful; Default fills it from the process.
type Locator struct {
	// ExeDir is the running executable's directory, symlinks resolved.
	ExeDir string
	// Installed is whether ExeDir is a release install. Only a non-install falls back to
	// PATH: an install that lost its ripgrep reports ErrMissing rather than silently
	// running whatever rg the user has.
	Installed bool
	// Getenv and LookPath default to os.Getenv and exec.LookPath.
	Getenv   func(string) string
	LookPath func(string) (string, error)
}

// Default is the Locator for this process.
func Default() Locator {
	dir := ""
	if exe, err := os.Executable(); err == nil {
		if r, err := filepath.EvalSymlinks(exe); err == nil {
			exe = r
		}
		dir = filepath.Dir(exe)
	}
	installed := false
	if dir != "" {
		fi, err := os.Stat(filepath.Join(dir, installMarker))
		installed = err == nil && fi.Mode().IsRegular()
	}
	return Locator{ExeDir: dir, Installed: installed}
}

// Find finds ripgrep for this process: Default().Find().
func Find() (Binary, error) { return Default().Find() }

// Find returns the ripgrep to run: $CODE_FOUNDRY_RG_BIN, else code-foundry-rg beside the
// running executable, else (not a release install) code-foundry-rg or rg on PATH. The
// error wraps ErrMissing.
func (l Locator) Find() (Binary, error) {
	getenv, lookPath := l.Getenv, l.LookPath
	if getenv == nil {
		getenv = os.Getenv
	}
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	if p := getenv(EnvBin); p != "" {
		if !isExecutable(p) {
			return Binary{}, fmt.Errorf("%w (%s=%s is not an executable)", ErrMissing, EnvBin, p)
		}
		return Binary{Path: p, Source: SourceEnv}, nil
	}
	var want string
	if l.ExeDir != "" {
		want = filepath.Join(l.ExeDir, BinName)
		if isExecutable(want) {
			return Binary{Path: want, Source: SourceBundled}, nil
		}
	}
	if !l.Installed {
		for _, name := range []string{BinName, "rg"} {
			if p, err := lookPath(name); err == nil {
				return Binary{Path: p, Source: SourcePath}, nil
			}
		}
	}
	if want == "" {
		return Binary{}, fmt.Errorf("%w (the running executable's directory is unknown)", ErrMissing)
	}
	return Binary{}, fmt.Errorf("%w (no %s)", ErrMissing, want)
}

// isExecutable reports whether p is a regular file someone may execute (os/exec's own
// test; symlinks followed).
func isExecutable(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0
}

// Check runs `<b> --version` and returns the version it reports ("15.2.0"). The error
// wraps ErrBroken. A version other than Version is not an error: a dev fallback on PATH
// may be any ripgrep; callers that care compare.
func (b Binary) Check(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, b.Path, "--version")
	cmd.Env = append(os.Environ(), "RIPGREP_CONFIG_PATH=") // a user's rg config must not change what runs
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("%w (%s --version: %w)", ErrBroken, b.Path, err)
	}
	v, err := ParseVersion(string(out))
	if err != nil {
		return "", fmt.Errorf("%w (%s: %w)", ErrBroken, b.Path, err)
	}
	return v, nil
}

// versionLine is ripgrep's first `--version` line: "ripgrep 15.2.0 (rev e89fff89ac)",
// "ripgrep 14.1.1", or "ripgrep 13.0.0 (rev af6b6c543b) -SIMD -AVX (compiled)".
var versionLine = regexp.MustCompile(`^ripgrep (\d+\.\d+\.\d+)(?:[ -]|$)`)

// ParseVersion returns the version in ripgrep's `--version` output.
func ParseVersion(out string) (string, error) {
	first, _, _ := strings.Cut(out, "\n")
	first = strings.TrimSpace(first)
	m := versionLine.FindStringSubmatch(first)
	if m == nil {
		if first == "" {
			return "", errors.New("--version printed nothing")
		}
		return "", fmt.Errorf("--version printed %q, not ripgrep's version line", first)
	}
	return m[1], nil
}

// Engine finds and checks ripgrep once, on first use, and keeps the outcome for the
// daemon's lifetime: text search asks it on every query without running anything again.
// An install that is missing or broken stays so until the daemon restarts (an update or
// reinstall restarts it). Safe for concurrent use.
type Engine struct {
	find func() (Binary, error)
	once sync.Once
	bin  Binary
	ver  string
	err  error
}

// NewEngine returns an Engine that finds ripgrep with find (nil: Find).
func NewEngine(find func() (Binary, error)) *Engine {
	if find == nil {
		find = Find
	}
	return &Engine{find: find}
}

// Get returns the binary and its version, finding and checking it on the first call
// (the first caller's context does not bound the check: one cancelled keystroke must not
// mark ripgrep broken for good). The error wraps ErrMissing or ErrBroken.
func (e *Engine) Get() (Binary, string, error) {
	e.once.Do(func() {
		bin, err := e.find()
		if err != nil {
			e.err = err
			return
		}
		e.bin = bin
		e.ver, e.err = bin.Check(context.Background())
	})
	return e.bin, e.ver, e.err
}
