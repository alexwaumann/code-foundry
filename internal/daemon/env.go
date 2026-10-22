package daemon

import (
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

// claudeSessionVars are variables a running Claude Code session sets for its children
// that are not CLAUDE_CODE_*: its pid, its effort level, and the SDK version of the
// host. They describe the parent thread, so they must not leak into ours either
// (CLAUDE_EFFORT, for one, would override the effort the user picked).
var claudeSessionVars = []string{"CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_AGENT_SDK_VERSION"}

// inheritedClaudeVars returns the names in environ that come from an enclosing Claude
// Code session: CLAUDECODE, every CLAUDE_CODE_*, and claudeSessionVars. Sorted.
func inheritedClaudeVars(environ []string) []string {
	var out []string
	for _, kv := range environ {
		k, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(k, "CLAUDE_CODE_") || slices.Contains(claudeSessionVars, k) {
			out = append(out, k)
		}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// scrubClaudeEnv removes inherited Claude session variables from the daemon's own
// environment, so every terminal and claude process it starts is a fresh top-level
// thread. Observed 2026-10-08: a daemon started from inside a Claude session passed
// CLAUDE_CODE_CHILD_SESSION to its children, which disabled transcript saving (and
// with it session discovery and resume). Values are not logged: some are tokens.
func scrubClaudeEnv(log *slog.Logger) []string {
	vars := inheritedClaudeVars(os.Environ())
	for _, k := range vars {
		_ = os.Unsetenv(k)
	}
	if len(vars) > 0 {
		log.Info("removed inherited Claude Code variables from the daemon environment", "vars", vars)
	}
	return vars
}

// threadEnv is what every Claude session gets on top of the daemon's environment:
// this daemon's loopback endpoint and bearer token. The CLI prefers them over the
// Unix socket (client.EndpointFromEnv), which sandboxed threads cannot connect to.
func threadEnv(port int, token string) []string {
	return []string{
		paths.EnvEndpoint + "=http://127.0.0.1:" + strconv.Itoa(port),
		paths.EnvToken + "=" + token,
	}
}

// scrubEndpointEnv removes an inherited endpoint, token and thread id (a daemon
// started by hand from inside a thread), so this daemon's plain terminals and action
// runs do not point the CLI at the other daemon or at a thread of it. Threads get this
// daemon's own values (threadEnv, and their own paths.EnvThread).
func scrubEndpointEnv(log *slog.Logger) {
	var vars []string
	for _, k := range []string{paths.EnvEndpoint, paths.EnvToken, paths.EnvThread, paths.EnvThreadLegacy, paths.EnvPages} {
		if _, ok := os.LookupEnv(k); ok {
			_ = os.Unsetenv(k)
			vars = append(vars, k)
		}
	}
	if len(vars) > 0 {
		log.Info("removed an inherited daemon endpoint from the daemon environment", "vars", vars)
	}
}

// addCLIToPath puts the directory of $CODE_FOUNDRY_BIN (paths.EnvBin) in front of the
// daemon's own PATH unless it is on it already, so every Claude process, terminal,
// action run and plugin the daemon starts finds `code-foundry` by name. Observed
// 2026-10-18: a daemon run as <dir>/code-foundry with <dir> not on PATH gave its
// thread's Bash "command not found: code-foundry" (exit 127). It returns the
// directory it added, "" for none.
func addCLIToPath(log *slog.Logger) string {
	path, dir := pathWithCLIDir(os.Getenv("PATH"), os.Getenv(paths.EnvBin))
	if dir == "" {
		return ""
	}
	if err := os.Setenv("PATH", path); err != nil {
		log.Warn("put the CLI's directory on PATH", "dir", dir, "err", err)
		return ""
	}
	log.Info("put the CLI's directory on PATH", "dir", dir)
	return dir
}

// pathWithCLIDir is path with the directory of the CLI at bin in front, and that
// directory; path unchanged and "" when bin is empty or its directory is already an
// entry of path (compared cleaned; a relative bin is made absolute first).
func pathWithCLIDir(path, bin string) (string, string) {
	if bin == "" {
		return path, ""
	}
	abs, err := filepath.Abs(bin)
	if err != nil {
		return path, ""
	}
	dir := filepath.Dir(abs)
	for _, e := range filepath.SplitList(path) {
		if e != "" && filepath.Clean(e) == dir {
			return path, ""
		}
	}
	if path == "" {
		return dir, dir
	}
	return dir + string(os.PathListSeparator) + path, dir
}
