package plugin_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

type env struct {
	t       *testing.T
	root    string
	opts    plugin.Options
	reg     *command.Registry
	secrets *plugintest.Secrets
	m       *plugin.Manager
	sent    chan string
}

// newEnv makes a plugins dir with a registry holding thread.send (records) and
// thread.archive (asks for confirmation).
func newEnv(t *testing.T, mod func(*plugin.Options)) *env {
	t.Helper()
	root := t.TempDir()
	e := &env{t: t, root: root, reg: command.NewRegistry(), secrets: plugintest.NewSecrets(), sent: make(chan string, 8)}
	err := e.reg.RegisterAll(
		command.Command{Name: "thread.send", Title: "Send", Category: "Thread",
			Args: []command.ArgSpec{{Name: "id", Type: command.String, Context: command.ContextThread, Required: true},
				{Name: "text", Type: command.String, Required: true}},
			Run: func(_ context.Context, _ command.Context, a command.Args) (command.Result, error) {
				e.sent <- a.String("id") + ":" + a.String("text")
				return command.Result{Message: "sent to " + a.String("id")}, nil
			}},
		command.Command{Name: "thread.archive", Title: "Archive", Category: "Thread", Confirm: "Archive it?",
			Run: func(context.Context, command.Context, command.Args) (command.Result, error) {
				return command.Result{Message: "archived"}, nil
			}},
	)
	if err != nil {
		t.Fatal(err)
	}
	e.opts = plugin.Options{
		Dir: filepath.Join(root, "plugins"), DataDir: filepath.Join(root, "plugin-data"), LogDir: filepath.Join(root, "logs"),
		DB: dbtest.Open(t), Commands: e.reg, Log: slog.New(slog.DiscardHandler), Secrets: e.secrets, Bus: bus.New(), HostVersion: "test",
		APIEnv:      []string{"CODE_FOUNDRY_TOKEN=tok"},
		Environ:     append(os.Environ(), "CF_SECRET_PARENT=leak"),
		BackoffBase: 20 * time.Millisecond, BackoffMax: 80 * time.Millisecond, DevBackoffMax: 20 * time.Millisecond,
		InitTimeout: 5 * time.Second, ShutdownTimeout: time.Second, KillGrace: time.Second,
	}
	if err := os.MkdirAll(e.opts.Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if mod != nil {
		mod(&e.opts)
	}
	return e
}

func (e *env) start() *plugin.Manager {
	e.t.Helper()
	m, err := plugin.New(e.opts)
	if err != nil {
		e.t.Fatal(err)
	}
	if err := m.Start(context.Background()); err != nil {
		e.t.Fatal(err)
	}
	e.m = m
	e.t.Cleanup(func() { _ = m.Close() })
	return m
}

func testManifest(name string) pluginsdk.Manifest {
	return pluginsdk.Manifest{
		Name: name, DisplayName: "Test " + name, Version: "0.1.0", Protocol: 1, Exec: []string{"bin/plugin"},
		Permissions: pluginsdk.Permissions{Commands: []string{"thread.send", "thread.archive", "plugin.**"}, Secrets: true},
		Commands: []pluginsdk.CommandSpec{
			{Name: "greet", Title: "Greet", Args: []pluginsdk.ArgSpec{{Name: "name", Positional: true}}},
			{Name: "env", Title: "Env"},
			{Name: "send", Title: "Send", Args: []pluginsdk.ArgSpec{{Name: "text", Required: true}}},
			{Name: "archive", Title: "Archive"},
			{Name: "manage", Title: "Manage"},
			{Name: "flag", Title: "Flag"},
			{Name: "remember", Title: "Remember", Args: []pluginsdk.ArgSpec{{Name: "word", Required: true}}},
			{Name: "recall", Title: "Recall"},
			{Name: "slow", Title: "Slow", TimeoutSeconds: 1},
			{Name: "fail", Title: "Fail"},
		},
	}
}

// install writes a package at <dir>/<name> whose bin/plugin re-executes this test
// binary in mode.
func (e *env) install(dir, name, mode string, mf pluginsdk.Manifest) string {
	e.t.Helper()
	pkg := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Join(pkg, "bin"), 0o755); err != nil {
		e.t.Fatal(err)
	}
	b, _ := json.MarshalIndent(mf, "", "  ")
	if err := os.WriteFile(filepath.Join(pkg, "plugin.json"), b, 0o644); err != nil {
		e.t.Fatal(err)
	}
	e.setMode(pkg, mode)
	return pkg
}

func (e *env) setMode(pkg, mode string) {
	e.t.Helper()
	self, err := os.Executable()
	if err != nil {
		e.t.Fatal(err)
	}
	script := fmt.Sprintf("#!/bin/sh\nCF_PLUGIN_HELPER=%s exec '%s'\n", mode, self)
	tmp := filepath.Join(pkg, "bin", ".plugin.tmp")
	if err := os.WriteFile(tmp, []byte(script), 0o755); err != nil {
		e.t.Fatal(err)
	}
	if err := os.Rename(tmp, filepath.Join(pkg, "bin", "plugin")); err != nil {
		e.t.Fatal(err)
	}
}

// wait polls the snapshot until cond holds for the plugin.
func (e *env) wait(name string, what string, cond func(p plugin.Plugin) bool) plugin.Plugin {
	e.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		p, ok := e.m.Snapshot().Plugin(name)
		if ok && cond(p) {
			return p
		}
		if time.Now().After(deadline) {
			e.t.Fatalf("%s: waiting for %s; last: state=%s err=%q", name, what, p.State, p.LastError)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (e *env) waitState(name string, s plugin.State) plugin.Plugin {
	e.t.Helper()
	return e.wait(name, s.String(), func(p plugin.Plugin) bool { return p.State == s })
}

func (e *env) invoke(name string, args map[string]string, uctx command.Context) (command.Result, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return e.reg.Invoke(ctx, uctx, name, args)
}

func (e *env) logText(name string) string {
	lines, err := e.m.Logs(name, 0)
	if err != nil {
		e.t.Fatal(err)
	}
	var b strings.Builder
	for _, l := range lines {
		fmt.Fprintf(&b, "%s %s %s\n", l.Source, l.Level, l.Text)
	}
	return b.String()
}

func TestEnableConsentCommandsAndHost(t *testing.T) {
	e := newEnv(t, nil)
	e.install(e.opts.Dir, "hello", "ok", testManifest("hello"))
	m := e.start()

	p, ok := m.Snapshot().Plugin("hello")
	if !ok || p.State != plugin.StateDisabled || !p.NeedsConsent || p.Enabled {
		t.Fatalf("new plugin: %+v", p)
	}
	if _, ok := e.reg.Get("plugin.hello.greet"); ok {
		t.Fatal("commands registered before enable")
	}
	res, err := m.Enable(context.Background(), "hello", false)
	if err != nil || !res.NeedsConsent || !strings.Contains(res.Consent, "run Code Foundry commands: plugin.**, thread.archive, thread.send") ||
		!strings.Contains(res.Consent, "keep secrets") {
		t.Fatalf("enable without consent: %+v, %v", res, err)
	}
	if p, _ := m.Snapshot().Plugin("hello"); p.Enabled {
		t.Fatal("enabled without consent")
	}
	if _, err := m.Enable(context.Background(), "hello", true); err != nil {
		t.Fatal(err)
	}
	p = e.waitState("hello", plugin.StateRunning)
	if p.Granted == nil || !p.Granted.Secrets || p.NeedsConsent || p.PID == 0 || p.Protocol != 1 {
		t.Fatalf("running: %+v", p)
	}

	r, err := e.invoke("plugin.hello.greet", map[string]string{"name": "Ada"}, command.Context{})
	if err != nil || r.Message != "hello Ada" {
		t.Fatalf("greet = %+v, %v", r, err)
	}
	if js, _ := r.EncodeJSON(); js != `{"greeted":"Ada"}` {
		t.Errorf("greet json = %s", js)
	}
	if lst, _ := e.reg.Get("plugin.hello.greet"); lst.Category != "Test hello" {
		t.Errorf("category %q", lst.Category)
	}

	r, err = e.invoke("plugin.hello.send", map[string]string{"text": "hi"}, command.Context{ActiveThreadID: "t-1"})
	if err != nil || r.Message != "sent to t-1" {
		t.Fatalf("send = %+v, %v", r, err)
	}
	if got := <-e.sent; got != "t-1:hi" {
		t.Errorf("thread.send got %q", got)
	}

	tests := []struct{ cmd, want string }{
		{"plugin.hello.archive", fmt.Sprintf("code %d: thread.archive asks the user first: Archive it?", pluginsdk.CodeConfirmationRequired)},
		{"plugin.hello.manage", fmt.Sprintf("code %d: permission denied: plugins cannot run plugin.enable", pluginsdk.CodePermissionDenied)},
		{"plugin.hello.flag", fmt.Sprintf("code %d: thread/setFlag is not supported yet by this Code Foundry", pluginsdk.CodeMethodNotFound)},
		{"plugin.hello.remember", "remembered"},
		{"plugin.hello.recall", "s3cret"},
		{"plugin.hello.env", "hello  "}, // no token without the api permission, no parent env
	}
	for _, tt := range tests {
		args := map[string]string{}
		if tt.cmd == "plugin.hello.remember" {
			args["word"] = "s3cret"
		}
		r, err := e.invoke(tt.cmd, args, command.Context{})
		if err != nil || r.Message != tt.want {
			t.Errorf("%s = %q, %v; want %q", tt.cmd, r.Message, err, tt.want)
		}
	}
	if v, ok, _ := e.secrets.Get(context.Background(), "hello", "word"); !ok || v != "s3cret" {
		t.Errorf("keychain fake: %q %v", v, ok)
	}
	list, err := m.Secrets(context.Background(), "hello")
	if err != nil || len(list) != 1 || list[0].Key != "word" {
		t.Errorf("secrets list %+v, %v", list, err)
	}
	if _, err := e.invoke("plugin.hello.fail", nil, command.Context{}); err == nil || err.Error() != "it broke" {
		t.Errorf("fail: %v", err)
	}
	if _, err := e.invoke("plugin.hello.slow", nil, command.Context{}); err == nil || !strings.Contains(err.Error(), "did not answer slow within 1s") {
		t.Errorf("slow: %v", err)
	}

	logs := e.logText("hello")
	for _, want := range []string{"log info started data=true", "stderr  stray stdout line", "host  host/invoke thread.send",
		"host  ignored view/update: not supported yet", "host  secret set: word"} {
		if !strings.Contains(logs, want) {
			t.Errorf("log lacks %q:\n%s", want, logs)
		}
	}
	if strings.Contains(logs, "s3cret") {
		t.Error("a secret value reached the log")
	}
	if b, err := os.ReadFile(filepath.Join(e.opts.LogDir, "hello.log")); err != nil || !strings.Contains(string(b), "log info started") {
		t.Errorf("log file: %v\n%s", err, b)
	}

	if _, err := m.Disable(context.Background(), "hello"); err != nil {
		t.Fatal(err)
	}
	p, _ = m.Snapshot().Plugin("hello")
	if p.State != plugin.StateDisabled || p.Enabled || p.PID != 0 {
		t.Fatalf("disabled: %+v", p)
	}
	if _, ok := e.reg.Get("plugin.hello.greet"); ok {
		t.Error("commands still registered after disable")
	}
	// Consent is remembered: enabling again needs none.
	res, err = m.Enable(context.Background(), "hello", false)
	if err != nil || res.NeedsConsent {
		t.Fatalf("re-enable: %+v, %v", res, err)
	}
	e.waitState("hello", plugin.StateRunning)
}

func TestAPIPermissionGetsTheEndpoint(t *testing.T) {
	e := newEnv(t, nil)
	mf := testManifest("hello")
	mf.Permissions.API = true
	e.install(e.opts.Dir, "hello", "ok", mf)
	m := e.start()
	if _, err := m.Enable(context.Background(), "hello", true); err != nil {
		t.Fatal(err)
	}
	e.waitState("hello", plugin.StateRunning)
	r, err := e.invoke("plugin.hello.env", nil, command.Context{})
	if err != nil || r.Message != "hello tok " {
		t.Fatalf("env = %q, %v", r.Message, err)
	}
}

func TestSecretsNeedThePermission(t *testing.T) {
	e := newEnv(t, nil)
	mf := testManifest("hello")
	mf.Permissions.Secrets = false
	e.install(e.opts.Dir, "hello", "ok", mf)
	m := e.start()
	if _, err := m.Enable(context.Background(), "hello", true); err != nil {
		t.Fatal(err)
	}
	e.waitState("hello", plugin.StateRunning)
	r, err := e.invoke("plugin.hello.remember", map[string]string{"word": "x"}, command.Context{})
	if err != nil || !strings.Contains(r.Message, fmt.Sprintf("code %d: permission denied", pluginsdk.CodePermissionDenied)) {
		t.Fatalf("remember = %q, %v", r.Message, err)
	}
}

func TestCrashBackoffFailedRestart(t *testing.T) {
	e := newEnv(t, func(o *plugin.Options) { o.CrashLimit = 3 })
	pkg := e.install(e.opts.Dir, "hello", "crash", testManifest("hello"))
	m := e.start()
	var crashes []plugin.Plugin
	sub := bus.Subscribe[plugin.Event](e.opts.Bus, 256)
	defer sub.Close()
	if _, err := m.Enable(context.Background(), "hello", true); err != nil {
		t.Fatal(err)
	}
	p := e.waitState("hello", plugin.StateFailed)
	if p.Restarts != 3 || !strings.Contains(p.LastError, "crashed 3 times in 10m, last: exited with status 3: boom") || !strings.Contains(p.LastError, "boom: no config") {
		t.Fatalf("failed: restarts=%d err=%q", p.Restarts, p.LastError)
	}
	for len(sub.C()) > 0 {
		if c, ok := (<-sub.C()).(plugin.Changed); ok && c.Plugin.State == plugin.StateCrashed {
			crashes = append(crashes, c.Plugin)
		}
	}
	if len(crashes) < 2 {
		t.Fatalf("saw %d crashed states", len(crashes))
	}
	if d := time.Until(crashes[len(crashes)-1].NextRestartAt); d > 200*time.Millisecond {
		t.Errorf("backoff too long: %s", d)
	}
	// Commands stay registered while it is down and say why.
	if _, err := e.invoke("plugin.hello.greet", nil, command.Context{}); !errors.Is(err, command.ErrUnavailable) ||
		!strings.Contains(err.Error(), "plugin restart hello") {
		t.Fatalf("greet while failed: %v", err)
	}

	e.setMode(pkg, "ok")
	if _, err := m.Restart(context.Background(), "hello"); err != nil {
		t.Fatal(err)
	}
	p = e.waitState("hello", plugin.StateRunning)
	if p.Restarts != 0 || p.LastError != "" {
		t.Fatalf("after restart: %+v", p)
	}
}

func TestKilledPluginRestarts(t *testing.T) {
	e := newEnv(t, nil)
	e.install(e.opts.Dir, "hello", "ok", testManifest("hello"))
	m := e.start()
	if _, err := m.Enable(context.Background(), "hello", true); err != nil {
		t.Fatal(err)
	}
	first := e.waitState("hello", plugin.StateRunning)
	if err := syscall.Kill(first.PID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	p := e.wait("hello", "a new process", func(p plugin.Plugin) bool {
		return p.State == plugin.StateRunning && p.PID != first.PID && p.PID != 0
	})
	if p.Restarts != 1 || !strings.Contains(p.LastError, "killed by a signal") {
		t.Fatalf("after kill: restarts=%d err=%q", p.Restarts, p.LastError)
	}
	if r, err := e.invoke("plugin.hello.greet", map[string]string{"name": "x"}, command.Context{}); err != nil || r.Message != "hello x" {
		t.Fatalf("greet after restart: %v", err)
	}
}

func TestInitializeTimeout(t *testing.T) {
	e := newEnv(t, func(o *plugin.Options) { o.InitTimeout = 200 * time.Millisecond; o.CrashLimit = 1 })
	e.install(e.opts.Dir, "hello", "silent", testManifest("hello"))
	m := e.start()
	if _, err := m.Enable(context.Background(), "hello", true); err != nil {
		t.Fatal(err)
	}
	p := e.waitState("hello", plugin.StateFailed)
	if !strings.Contains(p.LastError, "did not answer initialize") {
		t.Fatalf("err %q", p.LastError)
	}
}

func TestMissedPingsRestart(t *testing.T) {
	e := newEnv(t, func(o *plugin.Options) {
		o.PingInterval, o.PingTimeout = 50*time.Millisecond, 50*time.Millisecond
		o.BackoffBase, o.BackoffMax = time.Hour, time.Hour
	})
	e.install(e.opts.Dir, "hello", "noping", testManifest("hello"))
	m := e.start()
	if _, err := m.Enable(context.Background(), "hello", true); err != nil {
		t.Fatal(err)
	}
	p := e.waitState("hello", plugin.StateCrashed)
	if p.LastError != "not answering pings" {
		t.Fatalf("err %q", p.LastError)
	}
	if !strings.Contains(e.logText("hello"), "missed ping 2") {
		t.Error("misses not logged")
	}
}

func TestPermissionGrowthDisables(t *testing.T) {
	e := newEnv(t, nil)
	pkg := e.install(e.opts.Dir, "hello", "ok", testManifest("hello"))
	m := e.start()
	if _, err := m.Enable(context.Background(), "hello", true); err != nil {
		t.Fatal(err)
	}
	e.waitState("hello", plugin.StateRunning)

	// Same permissions, new version: stays enabled (and restarts on the new manifest).
	mf := testManifest("hello")
	mf.Version = "0.2.0"
	e.install(filepath.Dir(pkg), "hello", "ok", mf)
	if err := m.Reload(context.Background()); err != nil {
		t.Fatal(err)
	}
	p := e.waitState("hello", plugin.StateRunning)
	if p.Manifest.Version != "0.2.0" || !p.Enabled {
		t.Fatalf("after update: %+v", p)
	}

	mf.Permissions.API = true
	e.install(filepath.Dir(pkg), "hello", "ok", mf)
	if err := m.Reload(context.Background()); err != nil {
		t.Fatal(err)
	}
	p, _ = m.Snapshot().Plugin("hello")
	if p.Enabled || p.State != plugin.StateDisabled || !p.NeedsConsent || !strings.Contains(p.DisabledReason, "permissions changed") {
		t.Fatalf("after growth: %+v", p)
	}
	if _, ok := e.reg.Get("plugin.hello.greet"); ok {
		t.Error("commands kept after the permission change")
	}
	res, err := m.Enable(context.Background(), "hello", false)
	if err != nil || !res.NeedsConsent || !strings.Contains(res.Consent, "full control") {
		t.Fatalf("re-enable: %+v %v", res, err)
	}
}

func TestBadManifests(t *testing.T) {
	e := newEnv(t, nil)
	bad := filepath.Join(e.opts.Dir, "broken")
	if err := os.MkdirAll(bad, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bad, "plugin.json"), []byte(`{"name":"broken","version":"1"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	e.install(e.opts.Dir, "renamed", "ok", testManifest("other"))
	m := e.start()
	tests := []struct{ name, want string }{
		{"broken", "version"},
		{"renamed", `the directory is "renamed" but plugin.json names "other"`},
	}
	for _, tt := range tests {
		p, ok := m.Snapshot().Plugin(tt.name)
		if !ok || p.State != plugin.StateFailed || !strings.Contains(p.LastError, tt.want) {
			t.Errorf("%s: %+v", tt.name, p)
		}
		if _, err := m.Enable(context.Background(), tt.name, true); !errors.Is(err, plugin.ErrFailedPrecondition) {
			t.Errorf("%s: enable: %v", tt.name, err)
		}
	}
	if _, err := m.Enable(context.Background(), "nope", true); !errors.Is(err, plugin.ErrNotFound) {
		t.Errorf("unknown: %v", err)
	}
}

func TestExecMissingFails(t *testing.T) {
	e := newEnv(t, nil)
	mf := testManifest("hello")
	mf.Exec = []string{"bin/missing"}
	e.install(e.opts.Dir, "hello", "ok", mf)
	m := e.start()
	if _, err := m.Enable(context.Background(), "hello", true); err != nil {
		t.Fatal(err)
	}
	p := e.waitState("hello", plugin.StateFailed)
	if !strings.Contains(p.LastError, "bin/missing") || p.Restarts != 1 {
		t.Fatalf("%+v", p)
	}
}

func TestDevLinkEnableAndRemove(t *testing.T) {
	e := newEnv(t, func(o *plugin.Options) { o.CrashLimit = 1 })
	src := e.install(filepath.Join(e.root, "src"), "hello", "crash", testManifest("hello"))
	m := e.start()

	res, err := m.Dev(context.Background(), src, false, true)
	if err != nil || !res.NeedsConsent || res.Plugin.Name != "hello" {
		t.Fatalf("dry run: %+v %v", res, err)
	}
	if _, err := os.Lstat(filepath.Join(e.opts.Dir, "hello")); !os.IsNotExist(err) {
		t.Fatal("dry run linked")
	}
	if _, err := m.Dev(context.Background(), src, true, false); err != nil {
		t.Fatal(err)
	}
	// A dev plugin never fails for crashing (CrashLimit 1 would fail it otherwise).
	p := e.wait("hello", "two crashes", func(p plugin.Plugin) bool { return p.Restarts >= 2 })
	if !p.Dev || p.State == plugin.StateFailed || p.DevPath == "" {
		t.Fatalf("dev: %+v", p)
	}
	e.setMode(src, "ok")
	e.waitState("hello", plugin.StateRunning)

	if _, err := m.Dev(context.Background(), "relative/dir", true, false); !errors.Is(err, plugin.ErrInvalidArgument) {
		t.Errorf("relative: %v", err)
	}
	// Removing the link removes the plugin on reload.
	if err := os.Remove(filepath.Join(e.opts.Dir, "hello")); err != nil {
		t.Fatal(err)
	}
	if err := m.Reload(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := m.Snapshot().Plugin("hello"); ok {
		t.Fatal("still listed")
	}
	if _, ok := e.reg.Get("plugin.hello.greet"); ok {
		t.Fatal("commands still registered")
	}
}

func TestDevOutsideHome(t *testing.T) {
	e := newEnv(t, nil)
	e.opts.Home = filepath.Join(e.root, "home")
	src := e.install(filepath.Join(e.root, "elsewhere"), "hello", "ok", testManifest("hello"))
	m := e.start()
	if _, err := m.Dev(context.Background(), src, true, false); !errors.Is(err, plugin.ErrInvalidArgument) || !strings.Contains(err.Error(), "outside your home") {
		t.Fatalf("err %v", err)
	}
}

func TestCloseStopsPlugins(t *testing.T) {
	e := newEnv(t, nil)
	e.install(e.opts.Dir, "hello", "ok", testManifest("hello"))
	m := e.start()
	if _, err := m.Enable(context.Background(), "hello", true); err != nil {
		t.Fatal(err)
	}
	p := e.waitState("hello", plugin.StateRunning)
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(p.PID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("process %d still alive: %v", p.PID, err)
	}
	if p, _ := m.Snapshot().Plugin("hello"); p.State != plugin.StateStopped {
		t.Fatalf("state %s", p.State)
	}
	// An enabled plugin starts with the next daemon.
	m2 := e.start()
	_ = m2
	e.waitState("hello", plugin.StateRunning)
}

func TestFollowLogs(t *testing.T) {
	e := newEnv(t, nil)
	e.install(e.opts.Dir, "hello", "ok", testManifest("hello"))
	m := e.start()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := m.FollowLogs(ctx, "hello", 10)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Enable(context.Background(), "hello", true); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(10 * time.Second)
	for {
		select {
		case l := <-ch:
			if l.Source == "host" && l.Text == "running" {
				cancel()
				for range ch {
				}
				return
			}
		case <-deadline:
			t.Fatal("no running line")
		}
	}
}

func TestPythonPlugin(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not installed")
	}
	e := newEnv(t, nil)
	dst := filepath.Join(e.opts.Dir, "pyecho")
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"plugin.json", "plugin.py"} {
		b, err := os.ReadFile(filepath.Join("testdata", "pyecho", f))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, f), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	m := e.start()
	if _, err := m.Enable(context.Background(), "pyecho", true); err != nil {
		t.Fatal(err)
	}
	e.waitState("pyecho", plugin.StateRunning)
	r, err := e.invoke("plugin.pyecho.echo", map[string]string{"text": "hi"}, command.Context{})
	if err != nil || r.Message != "echo: hi" {
		t.Fatalf("echo = %+v, %v", r, err)
	}
	r, err = e.invoke("plugin.pyecho.send", map[string]string{"text": "yo"}, command.Context{ActiveThreadID: "t-9"})
	if err != nil || r.Message != "sent: sent to t-9" {
		t.Fatalf("send = %+v, %v", r, err)
	}
	if !strings.Contains(e.logText("pyecho"), "stderr  pyecho ready") {
		t.Error("stderr not logged")
	}
	p, _ := m.Snapshot().Plugin("pyecho")
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(p.PID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("python still alive: %v", err)
	}
	if !slices.Contains([]plugin.State{plugin.StateStopped}, m.Snapshot().Plugins[0].State) {
		t.Errorf("state %s", m.Snapshot().Plugins[0].State)
	}
}
