package gh

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// TokenSource resolves the GitHub API token. HTTPRunner caches what it returns and asks
// again only when the cached token is rejected (HTTP 401), has aged past
// HTTPOptions.TokenTTL, or the store re-checks authentication.
type TokenSource interface {
	// Token returns a github.com token. A failure that means "no usable token" (gh not
	// installed, not logged in) wraps ErrNoToken.
	Token(ctx context.Context) (string, error)
}

// ErrNoToken is wrapped by TokenSource errors that mean there is no token to use, as
// opposed to cancellation.
var ErrNoToken = errors.New("no github token")

// DefaultTokenTimeout bounds one `gh auth token` invocation.
const DefaultTokenTimeout = 15 * time.Second

// GhToken resolves the token with `gh auth token --hostname github.com`, so the daemon
// sees exactly the account (and GH_TOKEN override) gh itself uses. github.com only.
type GhToken struct {
	// Path is the gh executable; LookPath() when empty.
	Path string
	// Timeout bounds the invocation; DefaultTokenTimeout when zero.
	Timeout time.Duration
}

// ghFallbacks are where Homebrew installs gh. A daemon auto-started by a Finder-launched
// app inherits launchd's minimal PATH, which contains neither.
var ghFallbacks = []string{"/opt/homebrew/bin/gh", "/usr/local/bin/gh"}

// LookPath finds gh on $PATH, then in the Homebrew locations.
func LookPath() (string, error) {
	if p, err := exec.LookPath("gh"); err == nil {
		return p, nil
	}
	for _, p := range ghFallbacks {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", fmt.Errorf("gh: executable not found on $PATH or in %v: %w", ghFallbacks, exec.ErrNotFound)
}

// ghEnv keeps gh non-interactive and its output machine-readable.
var ghEnv = []string{
	"GH_PROMPT_DISABLED=1",
	"GH_NO_UPDATE_NOTIFIER=1",
	"GH_SPINNER_DISABLED=1",
	"NO_COLOR=1",
	"CLICOLOR=0",
	"GH_PAGER=",
}

// Token implements TokenSource.
func (g GhToken) Token(ctx context.Context) (string, error) {
	path := g.Path
	if path == "" {
		p, err := LookPath()
		if err != nil {
			return "", fmt.Errorf("%w: %w", ErrNoToken, err)
		}
		path = p
	}
	timeout := g.Timeout
	if timeout <= 0 {
		timeout = DefaultTokenTimeout
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, path, "auth", "token", "--hostname", "github.com")
	cmd.Env = append(os.Environ(), ghEnv...)
	cmd.WaitDelay = 2 * time.Second
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	runErr := cmd.Run()
	if err := ctx.Err(); err != nil {
		return "", fmt.Errorf("gh auth token: %w", err)
	}
	if cctx.Err() != nil {
		return "", fmt.Errorf("%w: gh auth token did not finish within %v", ErrNoToken, timeout)
	}
	return parseTokenOutput(out.Bytes(), errb.Bytes(), runErr)
}

// parseTokenOutput maps `gh auth token`'s result to a token or an ErrNoToken error.
// gh exits 1 with "no oauth token found for github.com" when logged out.
func parseTokenOutput(stdout, stderr []byte, runErr error) (string, error) {
	tok := strings.TrimSpace(string(stdout))
	if runErr == nil && tok != "" && !strings.ContainsAny(tok, " \t\r\n") {
		return tok, nil
	}
	msg := firstLine(strings.TrimPrefix(strings.TrimSpace(string(stderr)), "gh: "))
	switch {
	case msg != "":
	case runErr != nil:
		msg = runErr.Error()
	default:
		msg = "gh auth token printed no token"
	}
	return "", fmt.Errorf("%w: %s", ErrNoToken, msg)
}
