package scripts

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fakeRelease publishes a fake CodeFoundry.app for tag into a local release directory
// (the CODE_FOUNDRY_RELEASE_DIR layout) and returns the zip's path. bundleVersion is the
// version the bundle claims (normally tag).
func fakeRelease(t *testing.T, relDir, tag, bundleVersion string) string {
	t.Helper()
	build := t.TempDir()
	app := filepath.Join(build, "CodeFoundry.app")
	macos := filepath.Join(app, "Contents", "MacOS")
	if err := os.MkdirAll(macos, 0o755); err != nil {
		t.Fatal(err)
	}
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>CodeFoundry</string>
<key>CFBundleShortVersionString</key><string>%s</string>
<key>CodeFoundryVersion</key><string>%s</string>
</dict></plist>
`, strings.TrimPrefix(bundleVersion, "v"), bundleVersion)
	write := func(p, s string, mode os.FileMode) {
		if err := os.WriteFile(p, []byte(s), mode); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(app, "Contents", "Info.plist"), plist, 0o644)
	write(filepath.Join(macos, "CodeFoundry"), "#!/bin/sh\necho gui\n", 0o755)
	write(filepath.Join(macos, "code-foundry"), "#!/bin/sh\necho \"code-foundry "+bundleVersion+"\"\n", 0o755)

	dir := filepath.Join(relDir, tag)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	zip := filepath.Join(dir, "CodeFoundry-darwin-arm64.zip")
	if out, err := exec.Command("/usr/bin/ditto", "-c", "-k", "--keepParent", app, zip).CombinedOutput(); err != nil {
		t.Fatalf("ditto: %v\n%s", err, out)
	}
	b, err := os.ReadFile(zip)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	write(filepath.Join(dir, "checksums.txt"), hex.EncodeToString(sum[:])+"  CodeFoundry-darwin-arm64.zip\n", 0o644)
	write(filepath.Join(relDir, "latest"), tag+"\n", 0o644)
	return zip
}

type installEnv struct {
	home, rel string
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
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (e installEnv) app() string { return filepath.Join(e.home, "Applications", "CodeFoundry.app") }

func (e installEnv) installedVersion(t *testing.T) string {
	t.Helper()
	out, err := exec.Command("/usr/bin/plutil", "-extract", "CodeFoundryVersion", "raw", "-o", "-", filepath.Join(e.app(), "Contents", "Info.plist")).Output()
	if err != nil {
		t.Fatalf("read installed version: %v", err)
	}
	return strings.TrimSpace(string(out))
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

	// Upgrade without a TTY: no prompt, old bundle swapped out, nothing left behind.
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
	entries, _ := os.ReadDir(filepath.Join(e.home, "Applications"))
	if len(entries) != 1 {
		var names []string
		for _, en := range entries {
			names = append(names, en.Name())
		}
		t.Fatalf("leftovers in ~/Applications: %v", names)
	}

	// An explicit older version is a downgrade the user asked for.
	out, err = e.run(t, "--version", "v0.1.0")
	if err != nil || e.installedVersion(t) != "v0.1.0" {
		t.Fatalf("--version: %v\n%s", err, out)
	}
}

func TestInstallSkipPathAndCustomDirs(t *testing.T) {
	e := newInstallEnv(t)
	fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")
	apps := filepath.Join(e.home, "Apps")
	bin := filepath.Join(e.home, "bin")
	out, err := e.run(t, "--skip-path", "--app-dir", apps, "--bin-dir", bin)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if e.markers(t) != 0 {
		t.Fatal("--skip-path edited ~/.zshrc")
	}
	target, err := os.Readlink(filepath.Join(bin, "code-foundry"))
	if err != nil || target != filepath.Join(apps, "CodeFoundry.app", "Contents", "MacOS", "code-foundry") {
		t.Fatalf("link -> %q, %v", target, err)
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
				zip := fakeRelease(t, e.rel, "v0.2.0", "v0.2.0")
				f, err := os.OpenFile(zip, os.O_APPEND|os.O_WRONLY, 0)
				if err != nil {
					t.Fatal(err)
				}
				_, _ = f.WriteString("tampered")
				_ = f.Close()
			},
			want: "checksum mismatch",
		},
		{
			name:    "bundle version differs from the tag",
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
	zip := fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")
	// Simulate an archive that arrived through a quarantining app; ditto propagates the
	// attribute to what it extracts.
	if out, err := exec.Command("/usr/bin/xattr", "-w", "com.apple.quarantine", "0081;00000000;Safari;", zip).CombinedOutput(); err != nil {
		t.Fatalf("xattr -w: %v\n%s", err, out)
	}
	if out, err := e.run(t); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	out, _ := exec.Command("/usr/bin/xattr", "-r", e.app()).CombinedOutput()
	if strings.Contains(string(out), "com.apple.quarantine") {
		t.Fatalf("installed bundle is quarantined:\n%s", out)
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
