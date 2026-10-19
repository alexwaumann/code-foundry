package plugins_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The minimal example's registry-entry script turns plugin.json and a release's
// SHA256SUMS into a registry entry with every permission key and both artifacts.
func TestRegistryEntryScript(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the script")
	}
	dir := t.TempDir()
	sums := filepath.Join(dir, "SHA256SUMS")
	const a, b = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if err := os.WriteFile(sums, []byte(b+"  minimal-0.1.0-darwin-amd64.tar.gz\n"+a+"  minimal-0.1.0-darwin-arm64.tar.gz\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "minimal.json")
	cmd := exec.Command("go", "run", "scripts/registry-entry.go", "-repo", "octo/code-foundry-plugin-minimal", "-sums", sums, "-out", out)
	cmd.Dir = "examples/minimal"
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, b)
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	var e struct {
		Name, DisplayName, Repo, Version string
		Protocol                         int
		Permissions                      map[string]any
		Artifacts                        map[string]struct{ URL, SHA256 string }
	}
	if err := json.Unmarshal(raw, &e); err != nil {
		t.Fatal(err)
	}
	if e.Name != "minimal" || e.DisplayName != "Minimal" || e.Version != "0.1.0" || e.Protocol != 1 || e.Repo != "octo/code-foundry-plugin-minimal" {
		t.Errorf("entry %+v", e)
	}
	if len(e.Permissions) != 8 {
		t.Errorf("permissions %v: want all eight keys", e.Permissions)
	}
	arm := e.Artifacts["darwin/arm64"]
	if arm.SHA256 != a || arm.URL != "https://github.com/octo/code-foundry-plugin-minimal/releases/download/v0.1.0/minimal-0.1.0-darwin-arm64.tar.gz" || e.Artifacts["darwin/amd64"].SHA256 != b {
		t.Errorf("artifacts %+v", e.Artifacts)
	}
}

// Every action the example's workflows use is pinned to a full commit SHA with its
// version as a comment, and each workflow's work is a make target, which a repository
// without workflows runs by hand.
func TestExampleWorkflows(t *testing.T) {
	pinned := regexp.MustCompile(`^uses: [a-z0-9-]+/[a-z0-9-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$`)
	for file, target := range map[string]string{"ci.yml": "make check", "release.yml": "make release"} {
		b, err := os.ReadFile(filepath.Join("examples/minimal/.github/workflows", file))
		if err != nil {
			t.Fatal(err)
		}
		uses := 0
		for line := range strings.Lines(string(b)) {
			line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "- "))
			if strings.HasPrefix(line, "uses:") {
				uses++
				if !pinned.MatchString(line) {
					t.Errorf("%s: %q is not pinned to a commit SHA with a version comment", file, line)
				}
			}
		}
		if uses == 0 {
			t.Errorf("%s uses no actions", file)
		}
		if !strings.Contains(string(b), "run: "+target+"\n") {
			t.Errorf("%s does not run %s", file, target)
		}
	}
	mk, err := os.ReadFile("examples/minimal/Makefile")
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"check:", "release:", "dist:", "registry-entry:"} {
		if !strings.Contains(string(mk), "\n"+target+"\n") {
			t.Errorf("the Makefile has no %s target", target)
		}
	}
}

// The release script refuses a tag that is not v<plugin.json's version> before it tests,
// builds or publishes anything.
func TestReleaseScriptChecksTheTag(t *testing.T) {
	cmd := exec.Command("sh", "scripts/release.sh")
	cmd.Dir = "examples/minimal"
	cmd.Env = append(os.Environ(), "TAG=v9.9.9", "DRY_RUN=1", "GITHUB_REF_NAME=")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("release.sh accepted tag v9.9.9: %s", out)
	}
	if want := "tag 'v9.9.9', but plugin.json's version makes it v0.1.0"; !strings.Contains(string(out), want) {
		t.Errorf("output %q lacks %q", out, want)
	}
}
