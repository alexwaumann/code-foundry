// Package ripgreptest provides stand-ins for the ripgrep executable.
package ripgreptest

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// Fake writes an executable shell script at dir/name that prints out and exits 0, or,
// with exit != 0, prints nothing and exits with it. It returns the script's path.
func Fake(t testing.TB, dir, name, out string, exit int) string {
	t.Helper()
	script := "#!/bin/sh\ncat <<'RIPGREPTEST_EOF'\n" + out + "\nRIPGREPTEST_EOF\n"
	if exit != 0 {
		script = "#!/bin/sh\nexit " + strconv.Itoa(exit) + "\n"
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// VersionOutput is what a real ripgrep v prints for --version (its first lines).
func VersionOutput(v string) string {
	return "ripgrep " + v + " (rev e89fff89ac)\n\nfeatures:+pcre2"
}

// Real returns the path of a real ripgrep for tests that run it: $CODE_FOUNDRY_RG_BIN
// (`make go-test` sets it to the pinned binary `make ripgrep` fetched), else that pinned
// binary if it was fetched (scripts/ripgrep.sh --print-bin). It fails the test when there
// is none: text search tests must run in make check and CI, never skip quietly.
func Real(t testing.TB) string {
	t.Helper()
	if p := os.Getenv("CODE_FOUNDRY_RG_BIN"); p != "" {
		if !executable(p) {
			t.Fatalf("CODE_FOUNDRY_RG_BIN=%s is not an executable", p)
		}
		return p
	}
	_, file, _, ok := runtime.Caller(0)
	if ok {
		script := filepath.Join(filepath.Dir(file), "..", "..", "..", "scripts", "ripgrep.sh")
		if out, err := exec.Command(script, "--print-bin").Output(); err == nil {
			if p := strings.TrimSpace(string(out)); executable(p) {
				return p
			}
		}
	}
	t.Fatal("no ripgrep for this test: run `make ripgrep` (it fetches the pinned binary) or set CODE_FOUNDRY_RG_BIN")
	return ""
}

func executable(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0
}
