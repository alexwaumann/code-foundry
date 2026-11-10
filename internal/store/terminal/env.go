package terminal

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// defaultEnv is applied over the inherited environment and under Spec.Env. The emulator
// is xterm-compatible with truecolor; the GUI renders with xterm.js.
var defaultEnv = []string{"TERM=xterm-256color", "COLORTERM=truecolor"}

// envValue returns the value of key in env ("" if unset).
func envValue(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		if k, v, ok := strings.Cut(env[i], "="); ok && k == key {
			return v
		}
	}
	return ""
}

// lookPath resolves a program name against the PATH of the terminal's environment
// (not the daemon's: a Finder-launched daemon has a minimal PATH). Names containing a
// slash are returned as-is; relative ones resolve against cwd at exec time.
func lookPath(name string, env []string, isExec func(string) bool) (string, error) {
	if strings.Contains(name, "/") {
		return name, nil
	}
	for _, dir := range filepath.SplitList(envValue(env, "PATH")) {
		if dir == "" {
			dir = "."
		}
		p := filepath.Join(dir, name)
		if isExec(p) {
			return p, nil
		}
	}
	return "", fmt.Errorf("%w: %q not found in PATH", ErrInvalidSpec, name)
}

func isExecutable(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0
}
