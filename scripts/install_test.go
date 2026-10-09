package scripts

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fakeRelease publishes a fake release for tag into a local release directory (the
// CODE_FOUNDRY_RELEASE_DIR layout) and returns the tarball's path. The tarball holds
// code-foundry, "Code Foundry" and VERSION at the top level, like scripts/package.sh
// writes it; appVersion is what VERSION and the fake CLI claim (normally tag).
func fakeRelease(t *testing.T, relDir, tag, appVersion string) string {
	t.Helper()
	build := t.TempDir()
	write := func(p, s string, mode os.FileMode) {
		if err := os.WriteFile(p, []byte(s), mode); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(build, "VERSION"), appVersion+"\n", 0o644)
	write(filepath.Join(build, "Code Foundry"), "#!/bin/sh\necho gui\n", 0o755)
	write(filepath.Join(build, "code-foundry"), "#!/bin/sh\necho \"code-foundry "+appVersion+"\"\n", 0o755)

	dir := filepath.Join(relDir, tag)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	tgz := filepath.Join(dir, "code-foundry-darwin-arm64.tar.gz")
	if out, err := exec.Command("/usr/bin/tar", "-czf", tgz, "-C", build, "code-foundry", "Code Foundry", "VERSION").CombinedOutput(); err != nil {
		t.Fatalf("tar: %v\n%s", err, out)
	}
	b, err := os.ReadFile(tgz)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	write(filepath.Join(dir, "checksums.txt"), hex.EncodeToString(sum[:])+"  code-foundry-darwin-arm64.tar.gz\n", 0o644)
	write(filepath.Join(relDir, "latest"), tag+"\n", 0o644)
	return tgz
}

type installEnv struct {
	home, rel string
	env       []string // extra environment
}

// run runs install.sh non-interactively (no TTY) with HOME and the release dir set.
func (e installEnv) run(t *testing.T, args ...string) (string, error) {
	t.Helper()
	script, _ := filepath.Abs("install.sh")
	cmd := exec.Command("/bin/bash", append([]string{script}, args...)...)
	cmd.Env = []string{
		"HOME=" + e.home,
		"PATH=/usr/bin:/bin:/usr/sbin:/sbin",
		"TMPDIR=" + os.TempDir(),
		"CODE_FOUNDRY_RELEASE_DIR=" + e.rel,
	}
	cmd.Env = append(cmd.Env, e.env...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// app is the default app directory: $HOME/.code-foundry/app.
func (e installEnv) app() string { return filepath.Join(e.home, ".code-foundry", "app") }

func (e installEnv) installedVersion(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(e.app(), "VERSION"))
	if err != nil {
		t.Fatalf("read installed version: %v", err)
	}
	return strings.TrimSpace(string(b))
}

func (e installEnv) cli(t *testing.T) string {
	t.Helper()
	out, err := exec.Command(filepath.Join(e.home, ".local", "bin", "code-foundry")).Output()
	if err != nil {
		t.Fatalf("run linked CLI: %v", err)
	}
	return strings.TrimSpace(string(out))
}

func (e installEnv) markers(t *testing.T) int {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(e.home, ".zshrc"))
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(b), "# Added by the Code Foundry installer")
}

func newInstallEnv(t *testing.T) installEnv {
	// Short paths under /tmp keep the output readable.
	root, err := os.MkdirTemp("/tmp", "cf-install-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	e := installEnv{home: filepath.Join(root, "home"), rel: filepath.Join(root, "release")}
	if err := os.MkdirAll(e.home, 0o755); err != nil {
		t.Fatal(err)
	}
	return e
}

func TestInstallFreshUpgradeIdempotent(t *testing.T) {
	e := newInstallEnv(t)
	fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")

	out, err := e.run(t)
	if err != nil {
		t.Fatalf("fresh install: %v\n%s", err, out)
	}
	if v := e.installedVersion(t); v != "v0.1.0" {
		t.Fatalf("installed %s", v)
	}
	if got := e.cli(t); got != "code-foundry v0.1.0" {
		t.Fatalf("linked CLI says %q", got)
	}
	if n := e.markers(t); n != 1 {
		t.Fatalf("zshrc markers = %d, want 1\n%s", n, out)
	}
	zshrc, _ := os.ReadFile(filepath.Join(e.home, ".zshrc"))
	if !strings.Contains(string(zshrc), `export PATH="$HOME/.local/bin:$PATH"`) {
		t.Fatalf("zshrc:\n%s", zshrc)
	}

	// Same version again: no reinstall, PATH setup stays single.
	out, err = e.run(t)
	if err != nil || !strings.Contains(out, "already installed") {
		t.Fatalf("rerun: %v\n%s", err, out)
	}
	if n := e.markers(t); n != 1 {
		t.Fatalf("zshrc markers after rerun = %d", n)
	}

	// Upgrade without a TTY: no prompt, old version swapped out, nothing left behind.
	fakeRelease(t, e.rel, "v0.2.0", "v0.2.0")
	out, err = e.run(t)
	if err != nil || !strings.Contains(out, "upgrading Code Foundry v0.1.0 -> v0.2.0") {
		t.Fatalf("upgrade: %v\n%s", err, out)
	}
	if v := e.installedVersion(t); v != "v0.2.0" {
		t.Fatalf("installed %s after upgrade", v)
	}
	if got := e.cli(t); got != "code-foundry v0.2.0" {
		t.Fatalf("linked CLI says %q after upgrade", got)
	}
	if names := dirNames(t, filepath.Dir(e.app())); strings.Join(names, " ") != "app" {
		t.Fatalf("~/.code-foundry holds %v, want just app (no app.new / app.old)", names)
	}
	if names := dirNames(t, e.app()); strings.Join(names, "|") != "Code Foundry|VERSION|code-foundry" {
		t.Fatalf("app dir holds %v", names)
	}

	// An explicit older version is a downgrade the user asked for.
	out, err = e.run(t, "--version", "v0.1.0")
	if err != nil || e.installedVersion(t) != "v0.1.0" {
		t.Fatalf("--version: %v\n%s", err, out)
	}
}

func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, en := range entries {
		names = append(names, en.Name())
	}
	return names
}

func TestInstallSkipPathAndCustomDirs(t *testing.T) {
	e := newInstallEnv(t)
	fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")
	app := filepath.Join(e.home, "Apps", "cf") + "/" // a trailing slash is dropped
	bin := filepath.Join(e.home, "bin")
	out, err := e.run(t, "--skip-path", "--app-dir", app, "--bin-dir", bin)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if e.markers(t) != 0 {
		t.Fatal("--skip-path edited ~/.zshrc")
	}
	target, err := os.Readlink(filepath.Join(bin, "code-foundry"))
	if err != nil || target != filepath.Join(e.home, "Apps", "cf", "code-foundry") {
		t.Fatalf("link -> %q, %v", target, err)
	}
}

// Updates of an existing install (in-app, `code-foundry update`) leave the link alone:
// it may point at another install.
func TestInstallSkipLink(t *testing.T) {
	e := newInstallEnv(t)
	fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")
	side := filepath.Join(e.home, "side", "app")
	out, err := e.run(t, "--skip-path", "--skip-link", "--app-dir", side)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if _, err := os.Lstat(filepath.Join(e.home, ".local", "bin", "code-foundry")); !os.IsNotExist(err) {
		t.Fatalf("--skip-link created the link (%v)\n%s", err, out)
	}
	if strings.Contains(out, "linked") {
		t.Fatalf("output mentions a link:\n%s", out)
	}
}

// The default app dir follows CODE_FOUNDRY_HOME, then CODE_FOUNDRY_APP_DIR overrides it.
func TestInstallDefaultAppDir(t *testing.T) {
	tests := []struct {
		name string
		env  func(e installEnv) []string
		want func(e installEnv) string
	}{
		{"home", func(installEnv) []string { return nil }, func(e installEnv) string { return e.app() }},
		{
			"CODE_FOUNDRY_HOME",
			func(e installEnv) []string { return []string{"CODE_FOUNDRY_HOME=" + filepath.Join(e.home, "cfhome")} },
			func(e installEnv) string { return filepath.Join(e.home, "cfhome", "app") },
		},
		{
			"CODE_FOUNDRY_APP_DIR wins",
			func(e installEnv) []string {
				return []string{"CODE_FOUNDRY_HOME=" + filepath.Join(e.home, "cfhome"), "CODE_FOUNDRY_APP_DIR=" + filepath.Join(e.home, "elsewhere")}
			},
			func(e installEnv) string { return filepath.Join(e.home, "elsewhere") },
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newInstallEnv(t)
			e.env = tt.env(e)
			fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")
			if out, err := e.run(t); err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
			want := tt.want(e)
			if b, err := os.ReadFile(filepath.Join(want, "VERSION")); err != nil || strings.TrimSpace(string(b)) != "v0.1.0" {
				t.Fatalf("VERSION in %s: %q, %v", want, b, err)
			}
			if target, _ := os.Readlink(filepath.Join(e.home, ".local", "bin", "code-foundry")); target != filepath.Join(want, "code-foundry") {
				t.Fatalf("link -> %q", target)
			}
		})
	}
}

// The app dir is replaced as a whole, so a directory that is not an install is refused.
func TestInstallRefusesForeignAppDir(t *testing.T) {
	e := newInstallEnv(t)
	fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")
	dir := filepath.Join(e.home, "bin")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "precious"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := e.run(t, "--app-dir", dir)
	if err == nil || !strings.Contains(out, "not a Code Foundry install") {
		t.Fatalf("err = %v\n%s", err, out)
	}
	if _, err := os.Stat(filepath.Join(dir, "precious")); err != nil {
		t.Fatalf("foreign dir touched: %v", err)
	}
}

// A run killed between its two renames leaves only app.old; the next run restores it
// before deciding what is installed.
func TestInstallRestoresInterruptedSwap(t *testing.T) {
	e := newInstallEnv(t)
	fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")
	if out, err := e.run(t); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if err := os.Rename(e.app(), e.app()+".old"); err != nil {
		t.Fatal(err)
	}
	out, err := e.run(t)
	if err != nil || !strings.Contains(out, "already installed") {
		t.Fatalf("err = %v\n%s", err, out)
	}
	if v := e.installedVersion(t); v != "v0.1.0" {
		t.Fatalf("installed %s", v)
	}
}

func TestInstallRejectsBadArchives(t *testing.T) {
	tests := []struct {
		name    string
		prepare func(t *testing.T, e installEnv)
		want    string
	}{
		{
			name: "checksum mismatch",
			prepare: func(t *testing.T, e installEnv) {
				tgz := fakeRelease(t, e.rel, "v0.2.0", "v0.2.0")
				f, err := os.OpenFile(tgz, os.O_APPEND|os.O_WRONLY, 0)
				if err != nil {
					t.Fatal(err)
				}
				_, _ = f.WriteString("tampered")
				_ = f.Close()
			},
			want: "checksum mismatch",
		},
		{
			name:    "VERSION differs from the tag",
			prepare: func(t *testing.T, e installEnv) { fakeRelease(t, e.rel, "v0.2.0", "v0.1.9") },
			want:    "expected v0.2.0",
		},
		{
			name: "malformed latest tag",
			prepare: func(t *testing.T, e installEnv) {
				fakeRelease(t, e.rel, "v0.2.0", "v0.2.0")
				_ = os.WriteFile(filepath.Join(e.rel, "latest"), []byte("latest\n"), 0o644)
			},
			want: "not a release version",
		},
		{
			name:    "no release published",
			prepare: func(t *testing.T, e installEnv) { _ = os.MkdirAll(e.rel, 0o755) },
			want:    "no release published",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newInstallEnv(t)
			fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")
			if out, err := e.run(t); err != nil {
				t.Fatalf("baseline install: %v\n%s", err, out)
			}
			if tt.name == "no release published" {
				_ = os.RemoveAll(e.rel)
			}
			tt.prepare(t, e)
			out, err := e.run(t)
			if err == nil || !strings.Contains(out, tt.want) {
				t.Fatalf("err = %v, want output containing %q:\n%s", err, tt.want, out)
			}
			// The existing install is untouched.
			if v := e.installedVersion(t); v != "v0.1.0" {
				t.Fatalf("installed %s after a failed upgrade", v)
			}
		})
	}
}

func TestInstallRemovesQuarantine(t *testing.T) {
	e := newInstallEnv(t)
	tgz := fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")
	// Simulate an archive that arrived through a quarantining app; tar propagates the
	// attribute to what it extracts.
	if out, err := exec.Command("/usr/bin/xattr", "-w", "com.apple.quarantine", "0081;00000000;Safari;", tgz).CombinedOutput(); err != nil {
		t.Fatalf("xattr -w: %v\n%s", err, out)
	}
	if out, err := e.run(t); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	out, _ := exec.Command("/usr/bin/xattr", "-r", e.app()).CombinedOutput()
	if strings.Contains(string(out), "com.apple.quarantine") {
		t.Fatalf("installed app is quarantined:\n%s", out)
	}
}

func TestInstallRefusesWithoutGh(t *testing.T) {
	e := newInstallEnv(t)
	script, _ := filepath.Abs("install.sh")
	cmd := exec.Command("/bin/bash", script)
	// No release dir, and a gh that is not authenticated.
	fakeGh := filepath.Join(e.home, "gh")
	if err := os.WriteFile(fakeGh, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd.Env = []string{"HOME=" + e.home, "PATH=/usr/bin:/bin", "CODE_FOUNDRY_GH=" + fakeGh}
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "gh auth login") {
		t.Fatalf("err = %v\n%s", err, out)
	}
}
