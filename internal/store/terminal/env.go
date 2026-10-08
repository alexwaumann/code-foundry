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

// mergeEnv applies overrides to base in order. "KEY=VALUE" sets KEY; a bare "KEY"
// removes it. Later entries win. Order of first appearance is preserved.
func mergeEnv(base []string, overrides ...[]string) []string {
	idx := make(map[string]int, len(base))
	out := make([]string, 0, len(base)+8)
	set := func(kv string) {
		key, _, hasEq := strings.Cut(kv, "=")
		if key == "" {
			return
		}
		i, seen := idx[key]
		switch {
		case !hasEq && seen:
			out[i] = ""
			delete(idx, key)
		case !hasEq:
		case seen:
			out[i] = kv
		default:
			idx[key] = len(out)
			out = append(out, kv)
		}
	}
	for _, kv := range base {
		set(kv)
	}
	for _, o := range overrides {
		for _, kv := range o {
			set(kv)
		}
	}
	res := out[:0]
	for _, kv := range out {
		if kv != "" {
			res = append(res, kv)
		}
	}
	return res
}

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
