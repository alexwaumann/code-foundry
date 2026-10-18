package plugins_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
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
