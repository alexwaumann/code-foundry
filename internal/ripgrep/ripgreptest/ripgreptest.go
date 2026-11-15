// Package ripgreptest provides stand-ins for the ripgrep executable.
package ripgreptest

import (
	"os"
	"path/filepath"
	"strconv"
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
