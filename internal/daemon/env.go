package daemon

import (
	"log/slog"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

// claudeSessionVars are variables a running Claude Code session sets for its children
// that are not CLAUDE_CODE_*: its pid, its effort level, and the SDK version of the
// host. They describe the parent session, so they must not leak into ours either
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
// session. Observed 2026-10-08: a daemon started from inside a Claude session passed
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

// sessionEnv is what every Claude session gets on top of the daemon's environment:
// this daemon's loopback endpoint and bearer token. The CLI prefers them over the
// Unix socket (client.EndpointFromEnv), which sandboxed sessions cannot connect to.
func sessionEnv(port int, token string) []string {
	return []string{
		paths.EnvEndpoint + "=http://127.0.0.1:" + strconv.Itoa(port),
		paths.EnvToken + "=" + token,
	}
}

// scrubEndpointEnv removes an inherited endpoint and token (a daemon started by hand
// from inside a session), so this daemon's plain terminals do not point the CLI at
// the other daemon. Sessions get this daemon's own values (sessionEnv).
func scrubEndpointEnv(log *slog.Logger) {
	var vars []string
	for _, k := range []string{paths.EnvEndpoint, paths.EnvToken} {
		if _, ok := os.LookupEnv(k); ok {
			_ = os.Unsetenv(k)
			vars = append(vars, k)
		}
	}
	if len(vars) > 0 {
		log.Info("removed an inherited daemon endpoint from the daemon environment", "vars", vars)
	}
}
