package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

func TestScanDevIgnores(t *testing.T) {
	dir := t.TempDir()
	for _, f := range []string{"main.go", "src/a.go", ".env", ".git/HEAD", "bin/x", "dist/x.tar.gz",
		"node_modules/m/i.js", "web/node_modules/n.js", "web/app.ts", "out/plugin", "sub/bin/y", "sub/.cache/z"} {
		write(t, filepath.Join(dir, f), "x")
	}
	if err := os.Symlink(filepath.Join(dir, "main.go"), filepath.Join(dir, "link.go")); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		skip string
		want []string
	}{
		{"", []string{"main.go", "out/plugin", "src/a.go", "web/app.ts"}},
		{"out", []string{"main.go", "src/a.go", "web/app.ts"}},
	}
	for _, tt := range tests {
		t.Run("skip="+tt.skip, func(t *testing.T) {
			s, err := scanDev(dir, tt.skip, nil)
			if err != nil {
				t.Fatal(err)
			}
			if got := slices.Sorted(maps.Keys(s)); !slices.Equal(got, tt.want) {
				t.Errorf("scanned %q, want %q", got, tt.want)
			}
		})
	}
}

func TestExecSkip(t *testing.T) {
	for _, tt := range []struct {
		exec []string
		want string
	}{
		{[]string{"bin/plugin"}, "bin"},
		{[]string{"./build/out/p", "-v"}, "build"},
		{[]string{"./run.sh"}, "run.sh"},
		{[]string{"node"}, ""},
		{[]string{"/usr/bin/env"}, ""},
		{[]string{"../x/p"}, ""},
		{nil, ""},
	} {
		if got := execSkip(tt.exec); got != tt.want {
			t.Errorf("execSkip(%q) = %q, want %q", tt.exec, got, tt.want)
		}
	}
}

func TestScanDevTooManyFiles(t *testing.T) {
	dir := t.TempDir()
	for i := range devWatchMaxFiles + 1 {
		write(t, filepath.Join(dir, fmt.Sprintf("d%d/f%d", i%50, i)), "x")
	}
	if _, err := scanDev(dir, "", nil); !errors.Is(err, errTooManyFiles) {
		t.Fatalf("scan: %v", err)
	}
}

func TestScanDevReusesHashes(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "a"), "one")
	first, err := scanDev(dir, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	// Same size and mtime: the cached hash stands (the file is not read again).
	sig := first["a"]
	sig.hash[0] ^= 1
	cached := devScan{"a": sig}
	again, _ := scanDev(dir, "", cached)
	if again["a"].hash != sig.hash {
		t.Error("rehashed a file whose size and mtime did not change")
	}
	// An identical rewrite changes the mtime, not the content.
	time.Sleep(10 * time.Millisecond)
	write(t, filepath.Join(dir, "a"), "one")
	rewritten, _ := scanDev(dir, "", first)
	if !rewritten.sameContent(first) || rewritten["a"].mtime.Equal(first["a"].mtime) {
		t.Errorf("identical rewrite: same content %v", rewritten.sameContent(first))
	}
}

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

// devRig is a Manager with one dev plugin "w" (the test binary in helper mode "ok",
// helper_test.go) whose folder the tests edit, and scan ticks the test sends.
type devRig struct {
	t      *testing.T
	opts   Options
	m      *Manager
	dir    string
	ticks  chan time.Time
	ticked chan struct{}
}

func newDevRig(t *testing.T, build string, mod func(*Options)) *devRig {
	t.Helper()
	root := t.TempDir()
	r := &devRig{t: t, dir: filepath.Join(root, "src", "w"), ticks: make(chan time.Time), ticked: make(chan struct{})}
	r.opts = Options{
		Dir: filepath.Join(root, "plugins"), DataDir: filepath.Join(root, "data"), LogDir: filepath.Join(root, "logs"),
		DB: dbtest.Open(t), Commands: command.NewRegistry(), Log: slog.New(slog.DiscardHandler), Bus: bus.New(),
		Shell: "/bin/sh", InitTimeout: 5 * time.Second, ShutdownTimeout: time.Second, KillGrace: time.Second,
		DevBackoffMax: 20 * time.Millisecond, BackoffBase: 20 * time.Millisecond,
	}
	if mod != nil {
		mod(&r.opts)
	}
	r.manifest(pluginsdk.Permissions{})
	write(t, filepath.Join(r.dir, "main.go"), "package main\n")
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(r.dir, "bin", "plugin"), fmt.Sprintf("#!/bin/sh\nCF_PLUGIN_HELPER=ok exec '%s'\n", self))
	if err := os.Chmod(filepath.Join(r.dir, "bin", "plugin"), 0o755); err != nil {
		t.Fatal(err)
	}
	r.start()
	ctx := context.Background()
	if _, err := r.m.Dev(ctx, r.dir, true, false, false); err != nil {
		t.Fatal(err)
	}
	r.waitState(StateRunning)
	if _, err := r.m.SetDevWatch(ctx, "w", true, build); err != nil {
		t.Fatalf("watch: %v\n%s", err, r.logText())
	}
	return r
}

func (r *devRig) manifest(perms pluginsdk.Permissions) {
	b, _ := json.Marshal(pluginsdk.Manifest{Name: "w", Version: "0.1.0", Protocol: 1, Exec: []string{"bin/plugin"}, Permissions: perms})
	write(r.t, filepath.Join(r.dir, "plugin.json"), string(b))
}

func (r *devRig) start() {
	m, err := New(r.opts)
	if err != nil {
		r.t.Fatal(err)
	}
	m.devw.ticker = func(time.Duration) (<-chan time.Time, func()) { return r.ticks, func() {} }
	m.devw.ticked = r.ticked
	if err := m.Start(context.Background()); err != nil {
		r.t.Fatal(err)
	}
	r.m = m
	r.t.Cleanup(func() { _ = m.Close() })
}

// tick sends one scan tick and returns once the watcher handled it (a build included).
func (r *devRig) tick() {
	r.t.Helper()
	for _, ch := range []func() bool{
		func() bool {
			select {
			case r.ticks <- time.Now():
				return true
			case <-time.After(20 * time.Second):
				return false
			}
		},
		func() bool {
			select {
			case <-r.ticked:
				return true
			case <-time.After(20 * time.Second):
				return false
			}
		},
	} {
		if !ch() {
			r.t.Fatalf("the watcher did not handle a tick\n%s", r.logText())
		}
	}
}

func (r *devRig) builds() int { return strings.Count(r.logText(), "host building: ") }

func (r *devRig) logText() string {
	lines, _ := r.m.Logs("w", 0)
	var b strings.Builder
	for _, l := range lines {
		fmt.Fprintln(&b, strings.Join(slices.DeleteFunc([]string{l.Source, l.Level, l.Text}, func(s string) bool { return s == "" }), " "))
	}
	return b.String()
}

func (r *devRig) plugin() Plugin {
	p, _ := r.m.Snapshot().Plugin("w")
	return p
}

func (r *devRig) waitState(s State) Plugin {
	r.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		p := r.plugin()
		if p.State == s {
			return p
		}
		if time.Now().After(deadline) {
			r.t.Fatalf("waiting for %s; last %s %q\n%s", s, p.State, p.LastError, r.logText())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestDevWatchChanges(t *testing.T) {
	tests := []struct {
		name   string
		edit   func(dir string)
		builds int
	}{
		{"edit", func(d string) { write(t, filepath.Join(d, "main.go"), "package main // edited\n") }, 1},
		{"add", func(d string) { write(t, filepath.Join(d, "pkg", "new.go"), "package pkg\n") }, 1},
		{"delete", func(d string) { _ = os.Remove(filepath.Join(d, "main.go")) }, 1},
		{"rename", func(d string) { _ = os.Rename(filepath.Join(d, "main.go"), filepath.Join(d, "app.go")) }, 1},
		{"identical rewrite", func(d string) {
			time.Sleep(10 * time.Millisecond)
			write(t, filepath.Join(d, "main.go"), "package main\n")
		}, 0},
		{"build output", func(d string) { write(t, filepath.Join(d, "bin", "other"), "x") }, 0},
		{"dot file", func(d string) { write(t, filepath.Join(d, ".DS_Store"), "x") }, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newDevRig(t, "echo compiled", nil)
			before := r.builds()
			pid := r.plugin().PID
			tt.edit(r.dir)
			r.tick() // sees the change
			r.tick() // agrees: builds
			if got := r.builds() - before; got != tt.builds {
				t.Fatalf("%d builds, want %d\n%s", got, tt.builds, r.logText())
			}
			if tt.builds == 0 {
				return
			}
			p := r.waitState(StateRunning)
			if p.PID == pid || !strings.Contains(r.logText(), "build compiled") || !strings.Contains(r.logText(), "; restarted") {
				t.Errorf("not restarted: pid %d → %d\n%s", pid, p.PID, r.logText())
			}
			if p.DevBuild.State != DevBuildOK || !p.DevWatch || p.DevBuild.Command != "echo compiled" {
				t.Errorf("plugin %+v", p.DevBuild)
			}
		})
	}
}

// A change acts only once two scans in a row agree: an edit still going on waits.
func TestDevWatchDebounce(t *testing.T) {
	r := newDevRig(t, "true", nil)
	before := r.builds()
	write(t, filepath.Join(r.dir, "main.go"), "package main // 1\n")
	r.tick() // pending: 1
	write(t, filepath.Join(r.dir, "main.go"), "package main // 2\n")
	r.tick() // pending: 2 (did not agree with 1)
	if got := r.builds() - before; got != 0 {
		t.Fatalf("built %d times before two scans agreed", got)
	}
	r.tick() // agrees with 2: builds
	if got := r.builds() - before; got != 1 {
		t.Fatalf("%d builds, want 1\n%s", got, r.logText())
	}
	// DevSettle with nothing changed builds nothing.
	if err := r.m.DevSettle(context.Background(), "w"); err != nil {
		t.Fatal(err)
	}
	if got := r.builds() - before; got != 1 {
		t.Fatalf("settle without a change built: %d", got)
	}
}

// DevSettle builds a change at once, without waiting for ticks, and returns once the
// plugin runs again.
func TestDevSettleBuildsNow(t *testing.T) {
	r := newDevRig(t, "echo ok", nil)
	before, pid := r.builds(), r.plugin().PID
	write(t, filepath.Join(r.dir, "main.go"), "package main // settle\n")
	if err := r.m.DevSettle(context.Background(), "w"); err != nil {
		t.Fatal(err)
	}
	p := r.plugin()
	if r.builds()-before != 1 || p.State != StateRunning || p.PID == pid {
		t.Errorf("after settle: %d builds, %s pid %d (was %d)\n%s", r.builds()-before, p.State, p.PID, pid, r.logText())
	}
}

func TestDevWatchBuildFails(t *testing.T) {
	tests := []struct {
		name, build string
		timeout     time.Duration
		log         []string
		exit        int
	}{
		{"exit", "echo 'main.go:3: undefined: x' >&2; exit 2", 0,
			[]string{"build main.go:3: undefined: x", "build failed (exit 2); the running plugin is unchanged"}, 2},
		{"timeout", "echo slow; sleep 30", 300 * time.Millisecond,
			[]string{"build slow", "build failed: timed out after 300ms; the running plugin is unchanged"}, -1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newDevRig(t, "true", func(o *Options) { o.DevBuildTimeout = tt.timeout })
			pid := r.plugin().PID
			// The build command is the plugin's: change it the way `plugin dev --build` does.
			if _, err := r.m.SetDevWatch(context.Background(), "w", true, tt.build); err == nil ||
				!strings.Contains(err.Error(), tt.log[0][len("build "):]) {
				t.Fatalf("first build: %v", err)
			}
			for _, want := range tt.log {
				if !strings.Contains(r.logText(), want) {
					t.Errorf("log lacks %q\n%s", want, r.logText())
				}
			}
			p := r.plugin()
			if p.State != StateRunning || p.PID != pid || p.DevBuild.State != DevBuildFailed || p.DevBuild.ExitCode != tt.exit {
				t.Errorf("after a failed build: %s pid %d (was %d) build %+v", p.State, p.PID, pid, p.DevBuild)
			}
			// Nothing changed since: a settle reports the failure.
			err := r.m.DevSettle(context.Background(), "w")
			if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "build failed: code-foundry plugin logs w") {
				t.Errorf("settle: %v", err)
			}
		})
	}
}

func TestDevWatchOff(t *testing.T) {
	r := newDevRig(t, "true", nil)
	w := r.m.devWatcher("w")
	p, err := r.m.SetDevWatch(context.Background(), "w", false, "")
	if err != nil || p.DevWatch {
		t.Fatalf("off: %+v %v", p.DevWatch, err)
	}
	select {
	case <-w.done:
	case <-time.After(5 * time.Second):
		t.Fatal("the watcher did not stop")
	}
	if r.m.devWatcher("w") != nil {
		t.Error("still watched")
	}
	if err := r.m.DevSettle(context.Background(), "w"); err != nil {
		t.Errorf("settle unwatched: %v", err)
	}
	// Disabling stops it too.
	if _, err := r.m.SetDevWatch(context.Background(), "w", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := r.m.Disable(context.Background(), "w"); err != nil {
		t.Fatal(err)
	}
	if r.m.devWatcher("w") != nil {
		t.Error("watched while disabled")
	}
}

// The watch is kept in the database: a new daemon watches again (without building
// until something changes).
func TestDevWatchResumesAfterStart(t *testing.T) {
	r := newDevRig(t, "echo again", nil)
	if err := r.m.Close(); err != nil {
		t.Fatal(err)
	}
	r.start()
	p := r.waitState(StateRunning)
	if !p.DevWatch || p.DevBuild.Command != "echo again" || r.m.devWatcher("w") == nil {
		t.Fatalf("after restart: watch %v build %+v", p.DevWatch, p.DevBuild)
	}
	before := r.builds()
	r.tick()
	r.tick()
	if r.builds() != before {
		t.Fatal("built at start without a change")
	}
	write(t, filepath.Join(r.dir, "main.go"), "package main // after restart\n")
	r.tick()
	r.tick()
	if r.builds()-before != 1 {
		t.Fatalf("%d builds after an edit\n%s", r.builds()-before, r.logText())
	}
}

// A manifest asking for more permissions turns the plugin off (as any restart does); the
// log and the settle say how to consent, and the watch stops until then.
func TestDevWatchPermissionsGrew(t *testing.T) {
	r := newDevRig(t, "true", nil)
	r.manifest(pluginsdk.Permissions{Secrets: true})
	err := r.m.DevSettle(context.Background(), "w")
	want := "code-foundry plugin dev " + r.plugin().DevPath + " --yes"
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("settle: %v", err)
	}
	if !strings.Contains(r.logText(), "its permissions grew, so it was disabled: run `"+want+"`") {
		t.Errorf("log:\n%s", r.logText())
	}
	p := r.plugin()
	if p.Enabled || p.DevWatch || r.m.devWatcher("w") != nil {
		t.Errorf("after growing: enabled %v watch %v", p.Enabled, p.DevWatch)
	}
	// Consenting again resumes the watch.
	if _, err := r.m.Dev(context.Background(), r.dir, true, false, false); err != nil {
		t.Fatal(err)
	}
	if p := r.waitState(StateRunning); !p.DevWatch || r.m.devWatcher("w") == nil {
		t.Errorf("after consent: watch %v", p.DevWatch)
	}
}

func TestSetDevWatchRefusesInstalled(t *testing.T) {
	r := newDevRig(t, "true", nil)
	_, err := r.m.SetDevWatch(context.Background(), "nope", true, "")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown: %v", err)
	}
	r.m.mu.Lock()
	r.m.entries["w"].dev = false
	r.m.mu.Unlock()
	if _, err := r.m.SetDevWatch(context.Background(), "w", true, ""); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("installed: %v", err)
	}
}
