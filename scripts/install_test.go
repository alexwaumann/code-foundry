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

// pointer writes a release dir pointer file (latest or latest-tip) holding tag.
func pointer(t *testing.T, relDir, file, tag string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(relDir, file), []byte(tag+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// The tip channel takes the higher of latest-tip and latest in a local release dir, so
// a stable promoted after the last tip wins; the default channel reads latest only.
func TestInstallTipChannelReleaseDir(t *testing.T) {
	tests := []struct {
		name          string
		stable, tip   string // pointer contents; "" leaves the file out
		args          []string
		want, wantOut string
	}{
		{"stable is the default", "v0.14.41", "v0.15.0-tip.2", nil, "v0.14.41", ""},
		{"explicit stable", "v0.14.41", "v0.15.0-tip.2", []string{"--channel", "stable"}, "v0.14.41", ""},
		{"tip ahead of stable", "v0.14.41", "v0.15.0-tip.2", []string{"--channel", "tip"}, "v0.15.0-tip.2", "tip channel: v0.15.0-tip.2"},
		{"promotion after the last tip", "v0.15.0", "v0.15.0-tip.3", []string{"--channel=tip"}, "v0.15.0", "tip channel: v0.15.0"},
		{"numeric tip order", "v0.15.0-tip.2", "v0.15.0-tip.10", []string{"--channel", "tip"}, "v0.15.0-tip.10", ""},
		{"no tip yet", "v0.14.41", "", []string{"--channel", "tip"}, "v0.14.41", ""},
		{"only a tip", "", "v0.1.0-tip.1", []string{"--channel", "tip"}, "v0.1.0-tip.1", ""},
		{"--version takes a tip tag", "v0.15.0", "v0.15.0-tip.3", []string{"--version", "v0.15.0-tip.2"}, "v0.15.0-tip.2", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newInstallEnv(t)
			for _, tag := range []string{"v0.1.0-tip.1", "v0.14.41", "v0.15.0-tip.2", "v0.15.0-tip.3", "v0.15.0-tip.10", "v0.15.0"} {
				fakeRelease(t, e.rel, tag, tag)
			}
			_ = os.Remove(filepath.Join(e.rel, "latest"))
			if tt.stable != "" {
				pointer(t, e.rel, "latest", tt.stable)
			}
			if tt.tip != "" {
				pointer(t, e.rel, "latest-tip", tt.tip)
			}
			out, err := e.run(t, append([]string{"--skip-path"}, tt.args...)...)
			if err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
			if v := e.installedVersion(t); v != tt.want {
				t.Fatalf("installed %s, want %s\n%s", v, tt.want, out)
			}
			if !strings.Contains(out, tt.wantOut) {
				t.Fatalf("output lacks %q:\n%s", tt.wantOut, out)
			}
		})
	}
}

func TestInstallTipChannelErrors(t *testing.T) {
	tests := []struct {
		name    string
		prepare func(t *testing.T, e installEnv)
		args    []string
		want    string
	}{
		{
			name:    "malformed latest-tip",
			prepare: func(t *testing.T, e installEnv) { pointer(t, e.rel, "latest-tip", "tip") },
			args:    []string{"--channel", "tip"},
			want:    "not a release version: 'tip'",
		},
		{
			name:    "nothing published",
			prepare: func(t *testing.T, e installEnv) { _ = os.Remove(filepath.Join(e.rel, "latest")) },
			args:    []string{"--channel", "tip"},
			want:    "no release published",
		},
		{
			name:    "unknown channel",
			prepare: func(*testing.T, installEnv) {},
			args:    []string{"--channel", "beta"},
			want:    "unknown channel",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newInstallEnv(t)
			fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")
			tt.prepare(t, e)
			out, err := e.run(t, tt.args...)
			if err == nil || !strings.Contains(out, tt.want) {
				t.Fatalf("err = %v, want output containing %q:\n%s", err, tt.want, out)
			}
		})
	}
}

// fakeGh writes an authenticated gh that serves releases from $FAKE_REL: `api
// …/releases/latest` prints $FAKE_STABLE, `api …/releases` prints $FAKE_TAGS one per
// line (what the --jq filter would print), and `release download <tag> … --dir D`
// copies $FAKE_REL/<tag>/*. Each api call's arguments are appended to the returned log.
func fakeGh(t *testing.T, dir string) (gh, log string) {
	t.Helper()
	gh = filepath.Join(dir, "gh")
	log = filepath.Join(dir, "gh.log")
	script := `#!/bin/sh
case "$1" in
auth) exit 0 ;;
api)
	echo "$*" >>"` + log + `"
	case "$*" in
	*releases/latest*) echo "$FAKE_STABLE" ;;
	*) printf '%s\n' $FAKE_TAGS ;;
	esac
	;;
release)
	tag="$3"
	while [ $# -gt 0 ]; do
		[ "$1" = --dir ] && out="$2"
		shift
	done
	cp "$FAKE_REL/$tag/"* "$out/"
	;;
*) exit 1 ;;
esac
`
	if err := os.WriteFile(gh, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return gh, log
}

// Against GitHub, tip lists every non-draft release and takes the highest semver.
func TestInstallTipChannelGitHub(t *testing.T) {
	tests := []struct {
		name, channel, tags, want string
	}{
		{"stable uses releases/latest", "stable", "v0.15.0-tip.2 v0.14.41", "v0.14.41"},
		{"tip ahead", "tip", "v0.15.0-tip.9 v0.15.0-tip.10 v0.14.42-tip.1 v0.14.41", "v0.15.0-tip.10"},
		{"promoted stable wins", "tip", "v0.15.0 v0.15.0-tip.3 v0.15.0-tip.2 v0.14.41", "v0.15.0"},
		{"prerelease ordering", "tip", "v1.0.0-alpha v1.0.0-1 v0.14.41", "v1.0.0-alpha"},
		{"other tags are skipped", "tip", "nightly v0.14.41 v0.15.0-tip.2", "v0.15.0-tip.2"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newInstallEnv(t)
			for _, tag := range strings.Fields(tt.tags) {
				if tag != "nightly" {
					fakeRelease(t, e.rel, tag, tag)
				}
			}
			gh, log := fakeGh(t, e.home)
			e.env = []string{
				"CODE_FOUNDRY_RELEASE_DIR=", // the GitHub path
				"CODE_FOUNDRY_GH=" + gh,
				"FAKE_REL=" + e.rel,
				"FAKE_STABLE=v0.14.41",
				"FAKE_TAGS=" + tt.tags,
			}
			out, err := e.run(t, "--skip-path", "--channel", tt.channel)
			if err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
			if v := e.installedVersion(t); v != tt.want {
				t.Fatalf("installed %s, want %s\n%s", v, tt.want, out)
			}
			calls, _ := os.ReadFile(log)
			if tt.channel == "tip" && (!strings.Contains(string(calls), "--paginate") || !strings.Contains(string(calls), "select(.draft | not)")) {
				t.Fatalf("tip did not list non-draft releases with pagination: %s", calls)
			}
		})
	}
}

// The in-app updater's two halves: --stage-only leaves the install alone and app.new in
// place; --apply-staged swaps it in without a release source.
func TestInstallStageThenApply(t *testing.T) {
	e := newInstallEnv(t)
	fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")
	if out, err := e.run(t); err != nil {
		t.Fatalf("baseline install: %v\n%s", err, out)
	}
	fakeRelease(t, e.rel, "v0.2.0", "v0.2.0")

	out, err := e.run(t, "--stage-only", "--yes", "--skip-path", "--skip-link")
	if err != nil || !strings.Contains(out, "==> downloaded v0.2.0 to "+e.app()+".new") {
		t.Fatalf("stage: %v\n%s", err, out)
	}
	if v := e.installedVersion(t); v != "v0.1.0" {
		t.Fatalf("--stage-only changed the install to %s", v)
	}
	if b, err := os.ReadFile(filepath.Join(e.app()+".new", "VERSION")); err != nil || strings.TrimSpace(string(b)) != "v0.2.0" {
		t.Fatalf("staged VERSION %q, %v", b, err)
	}

	// No release source needed: an unauthenticated gh and no release dir.
	e.env = []string{"CODE_FOUNDRY_RELEASE_DIR=", "CODE_FOUNDRY_GH=/nonexistent/gh"}
	out, err = e.run(t, "--apply-staged", "--version", "v0.2.0", "--yes", "--skip-path", "--skip-link")
	if err != nil {
		t.Fatalf("apply: %v\n%s", err, out)
	}
	if v := e.installedVersion(t); v != "v0.2.0" {
		t.Fatalf("installed %s after --apply-staged\n%s", v, out)
	}
	if names := dirNames(t, filepath.Dir(e.app())); strings.Join(names, " ") != "app" {
		t.Fatalf("~/.code-foundry holds %v, want just app", names)
	}
	if got := e.cli(t); got != "code-foundry v0.2.0" {
		t.Fatalf("linked CLI says %q", got)
	}
}

func TestInstallApplyStagedDefaultsToStagedVersion(t *testing.T) {
	e := newInstallEnv(t)
	fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")
	if out, err := e.run(t); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	fakeRelease(t, e.rel, "v0.2.0", "v0.2.0")
	if out, err := e.run(t, "--stage-only"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if out, err := e.run(t, "--apply-staged"); err != nil || e.installedVersion(t) != "v0.2.0" {
		t.Fatalf("%v\n%s", err, out)
	}
}

// A first --stage-only (nothing installed yet) sets up neither the link nor PATH.
func TestInstallStageOnlyFresh(t *testing.T) {
	e := newInstallEnv(t)
	fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")
	out, err := e.run(t, "--stage-only")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if _, err := os.Stat(e.app()); !os.IsNotExist(err) {
		t.Fatalf("app dir exists after --stage-only (%v)", err)
	}
	if _, err := os.Lstat(filepath.Join(e.home, ".local", "bin", "code-foundry")); !os.IsNotExist(err) {
		t.Fatalf("--stage-only linked the CLI (%v)", err)
	}
	if e.markers(t) != 0 {
		t.Fatal("--stage-only edited ~/.zshrc")
	}
}

func TestInstallStageAndApplyErrors(t *testing.T) {
	tests := []struct {
		name     string
		prepare  func(t *testing.T, e installEnv)
		args     []string
		want     string
		wantErr  bool
		wantNew  bool   // app.new exists afterwards
		wantOnly string // a second fragment of the output
	}{
		{
			name:    "already installed: nothing staged",
			prepare: func(*testing.T, installEnv) {},
			args:    []string{"--stage-only"},
			want:    "already installed",
		},
		{
			name: "failed download leaves no stage",
			prepare: func(t *testing.T, e installEnv) {
				tgz := fakeRelease(t, e.rel, "v0.2.0", "v0.2.0")
				_ = os.WriteFile(tgz, []byte("tampered"), 0o644)
			},
			args:    []string{"--stage-only"},
			want:    "checksum mismatch",
			wantErr: true,
		},
		{
			name: "a failed download removes an older stage",
			prepare: func(t *testing.T, e installEnv) {
				fakeRelease(t, e.rel, "v0.2.0", "v0.2.0")
				if out, err := e.run(t, "--stage-only"); err != nil {
					t.Fatalf("%v\n%s", err, out)
				}
				tgz := fakeRelease(t, e.rel, "v0.3.0", "v0.3.0")
				_ = os.WriteFile(tgz, []byte("tampered"), 0o644)
			},
			args:    []string{"--stage-only"},
			want:    "checksum mismatch",
			wantErr: true,
		},
		{
			name:    "apply with nothing staged",
			prepare: func(*testing.T, installEnv) {},
			args:    []string{"--apply-staged", "--version", "v0.2.0"},
			want:    "no staged download of v0.2.0 in ",
			wantErr: true,
		},
		{
			name:    "apply without --version or a stage",
			prepare: func(*testing.T, installEnv) {},
			args:    []string{"--apply-staged"},
			want:    "no staged download in ",
			wantErr: true,
		},
		{
			name: "apply another version than staged",
			prepare: func(t *testing.T, e installEnv) {
				fakeRelease(t, e.rel, "v0.2.0", "v0.2.0")
				if out, err := e.run(t, "--stage-only"); err != nil {
					t.Fatalf("%v\n%s", err, out)
				}
			},
			args:     []string{"--apply-staged", "--version", "v0.3.0"},
			want:     "no staged download of v0.3.0 in ",
			wantErr:  true,
			wantNew:  true,
			wantOnly: "(it holds v0.2.0); run again without --apply-staged",
		},
		{
			name:    "both flags",
			prepare: func(*testing.T, installEnv) {},
			args:    []string{"--stage-only", "--apply-staged"},
			want:    "--stage-only and --apply-staged exclude each other",
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newInstallEnv(t)
			fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")
			if out, err := e.run(t); err != nil {
				t.Fatalf("baseline install: %v\n%s", err, out)
			}
			tt.prepare(t, e)
			out, err := e.run(t, tt.args...)
			if (err != nil) != tt.wantErr || !strings.Contains(out, tt.want) || !strings.Contains(out, tt.wantOnly) {
				t.Fatalf("err = %v (want error %v), want output containing %q and %q:\n%s", err, tt.wantErr, tt.want, tt.wantOnly, out)
			}
			if v := e.installedVersion(t); v != "v0.1.0" {
				t.Fatalf("installed %s", v)
			}
			if _, err := os.Stat(e.app() + ".new"); (err == nil) != tt.wantNew {
				t.Fatalf("app.new exists = %v, want %v", err == nil, tt.wantNew)
			}
		})
	}
}

// The code-foundry link is someone's working command: an install never re-points a link
// that leads to another existing install unless --force says so (a TTY would ask), and a
// rerun that installs nothing never re-points it at all.
func TestInstallLinkGuard(t *testing.T) {
	tests := []struct {
		name     string
		existing string // "other": a link to another install; "dangling"; "file"; "same"; "": none
		args     []string
		rerun    bool // install once first (link set up), then point the link away and rerun
		want     string
		wantOut  string
	}{
		{name: "no link: created", want: "app"},
		{name: "link to another install: kept", existing: "other", want: "other", wantOut: "warning: left "},
		{name: "link to another install with --force: replaced", existing: "other", args: []string{"--force"}, want: "app"},
		{name: "dangling link: replaced", existing: "dangling", want: "app"},
		{name: "a plain file: kept", existing: "file", want: "file", wantOut: "a file that is not a link"},
		{name: "link to this install by another path: re-pointed without asking", existing: "same", want: "app"},
		{name: "already installed: never re-pointed", existing: "other", rerun: true, want: "other", wantOut: "already installed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newInstallEnv(t)
			fakeRelease(t, e.rel, "v0.1.0", "v0.1.0")
			bin := filepath.Join(e.home, ".local", "bin")
			link := filepath.Join(bin, "code-foundry")
			other := filepath.Join(e.home, "other", "code-foundry")
			targets := map[string]string{
				"app": filepath.Join(e.app(), "code-foundry"), "other": other,
				"dangling": filepath.Join(e.home, "gone", "code-foundry"),
				// The same install through a symlinked directory.
				"same": filepath.Join(e.home, "alias", "app", "code-foundry"),
			}
			if err := os.MkdirAll(bin, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Dir(other), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(other, []byte("#!/bin/sh\necho other\n"), 0o755); err != nil {
				t.Fatal(err)
			}
			if tt.rerun || tt.existing == "same" {
				if out, err := e.run(t, "--skip-path"); err != nil {
					t.Fatalf("first install: %v\n%s", err, out)
				}
				_ = os.Remove(link)
			}
			if tt.existing == "same" {
				if err := os.Symlink(filepath.Join(e.home, ".code-foundry"), filepath.Join(e.home, "alias")); err != nil {
					t.Fatal(err)
				}
			}
			switch tt.existing {
			case "":
			case "file":
				if err := os.WriteFile(link, []byte("#!/bin/sh\n"), 0o755); err != nil {
					t.Fatal(err)
				}
			default:
				if err := os.Symlink(targets[tt.existing], link); err != nil {
					t.Fatal(err)
				}
			}
			out, err := e.run(t, append([]string{"--skip-path"}, tt.args...)...)
			if err != nil {
				t.Fatalf("install: %v\n%s", err, out)
			}
			if e.installedVersion(t) != "v0.1.0" {
				t.Fatal("not installed")
			}
			if !strings.Contains(out, tt.wantOut) {
				t.Errorf("output lacks %q:\n%s", tt.wantOut, out)
			}
			got, err := os.Readlink(link)
			if tt.want == "file" {
				if err == nil {
					t.Fatalf("the file became a link to %s", got)
				}
				return
			}
			if err != nil || got != targets[tt.want] {
				t.Fatalf("link -> %q (%v), want %q\n%s", got, err, targets[tt.want], out)
			}
		})
	}
}
