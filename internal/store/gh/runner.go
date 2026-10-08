package gh

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Runner executes GitHub requests. ExecRunner shells out to gh; tests use fakes.
type Runner interface {
	// GraphQL runs a query and returns the raw "data" object. GraphQL-level errors are
	// returned as errors (classified like gh's own failures).
	GraphQL(ctx context.Context, query string, vars map[string]any) (json.RawMessage, error)
	// AuthStatus reports gh's authentication state for github.com.
	AuthStatus(ctx context.Context) (AuthStatus, error)
}

// AuthStatus is the active github.com account as reported by `gh auth status`.
type AuthStatus struct {
	LoggedIn    bool
	Login       string
	TokenSource string
	// Error is gh's reason when the account exists but its token failed validation.
	Error string
}

// DefaultCallTimeout bounds one gh invocation.
const DefaultCallTimeout = 30 * time.Second

// ExecRunner runs the gh CLI.
type ExecRunner struct {
	// Path is the gh executable; "gh" (resolved on $PATH) when empty.
	Path string
	// Timeout bounds each invocation; DefaultCallTimeout when zero.
	Timeout time.Duration
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

// graphQLArgs builds `gh api graphql` arguments. Strings use -f (raw, never
// type-converted, so a repo named "true" or "123" stays a string); numbers and bools use
// -F. Variables are sorted for deterministic argv. Nil values are omitted.
func graphQLArgs(query string, vars map[string]any) ([]string, error) {
	args := []string{"api", "graphql", "-f", "query=" + query}
	keys := make([]string, 0, len(vars))
	for k := range vars {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		switch v := vars[k].(type) {
		case nil:
		case string:
			args = append(args, "-f", k+"="+v)
		case int:
			args = append(args, "-F", k+"="+strconv.Itoa(v))
		case bool:
			args = append(args, "-F", k+"="+strconv.FormatBool(v))
		default:
			return nil, fmt.Errorf("gh: unsupported variable %s of type %T", k, v)
		}
	}
	return args, nil
}

// GraphQL implements Runner.
func (r ExecRunner) GraphQL(ctx context.Context, query string, vars map[string]any) (json.RawMessage, error) {
	args, err := graphQLArgs(query, vars)
	if err != nil {
		return nil, err
	}
	stdout, stderr, code, err := r.run(ctx, args...)
	if err != nil {
		return nil, err
	}
	return parseGraphQLOutput(code, stdout, stderr)
}

// AuthStatus implements Runner. `gh auth status --json` exits 0 regardless of the auth
// state, so the JSON is authoritative.
func (r ExecRunner) AuthStatus(ctx context.Context) (AuthStatus, error) {
	stdout, stderr, code, err := r.run(ctx, "auth", "status", "--json", "hosts", "--hostname", "github.com")
	if err != nil {
		return AuthStatus{}, err
	}
	if code != 0 {
		return AuthStatus{}, classifyFailure(code, stdout, stderr)
	}
	return parseAuthStatus(stdout)
}

// run executes gh and returns its output and exit code. err is set only when gh could
// not be run to completion (missing binary, timeout, cancellation).
func (r ExecRunner) run(ctx context.Context, args ...string) (stdout, stderr []byte, code int, err error) {
	path := r.Path
	if path == "" {
		path = "gh"
	}
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = DefaultCallTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = append(os.Environ(), ghEnv...)
	cmd.Stdin = nil
	cmd.WaitDelay = 2 * time.Second
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	runErr := cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, nil, -1, fmt.Errorf("gh %s: %w", args[0], ctxErr)
	}
	var exitErr *exec.ExitError
	switch {
	case runErr == nil:
		return out.Bytes(), errb.Bytes(), 0, nil
	case errors.As(runErr, &exitErr):
		return out.Bytes(), errb.Bytes(), exitErr.ExitCode(), nil
	default:
		return nil, nil, -1, fmt.Errorf("run gh: %w", runErr)
	}
}

// graphQLResponse is the envelope gh prints for `gh api graphql`.
type graphQLResponse struct {
	Data   json.RawMessage `json:"data"`
	Errors []graphQLError  `json:"errors"`
}

type graphQLError struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// parseGraphQLOutput turns gh's exit code and output into data or a classified error.
// gh exits 1 when the response has GraphQL errors and prints the body on stdout either
// way, so the body's errors are preferred over stderr when present.
func parseGraphQLOutput(code int, stdout, stderr []byte) (json.RawMessage, error) {
	var resp graphQLResponse
	jsonErr := json.Unmarshal(stdout, &resp)
	if jsonErr == nil && len(resp.Errors) > 0 {
		return nil, classifyGraphQLErrors(resp.Errors)
	}
	if code != 0 {
		return nil, classifyFailure(code, stdout, stderr)
	}
	if jsonErr != nil {
		return nil, fmt.Errorf("gh: decode response: %w", jsonErr)
	}
	if len(resp.Data) == 0 || string(resp.Data) == "null" {
		return nil, errors.New("gh: response has no data")
	}
	return resp.Data, nil
}

func classifyGraphQLErrors(errs []graphQLError) error {
	msgs := make([]string, 0, len(errs))
	for _, e := range errs {
		msgs = append(msgs, e.Message)
	}
	msg := strings.Join(msgs, "; ")
	for _, e := range errs {
		switch e.Type {
		case "NOT_FOUND":
			return fmt.Errorf("%w: %s", ErrNotFound, msg)
		case "RATE_LIMITED":
			return &RateLimitError{Msg: msg}
		}
	}
	return fmt.Errorf("github graphql: %s", msg)
}

// RateLimitError is a rate-limit failure. errors.Is(err, ErrRateLimited) is true.
type RateLimitError struct {
	// Secondary is true for GitHub's secondary (abuse) limits, which have no reset time
	// and call for waiting at least a minute.
	Secondary bool
	Msg       string
}

func (e *RateLimitError) Error() string {
	kind := "primary"
	if e.Secondary {
		kind = "secondary"
	}
	return fmt.Sprintf("%s (%s): %s", ErrRateLimited, kind, e.Msg)
}

// Is reports ErrRateLimited.
func (e *RateLimitError) Is(target error) bool { return target == ErrRateLimited }

// ghExitAuth is gh's documented exit code for "authentication required".
const ghExitAuth = 4

// classifyFailure maps a failed gh invocation to a typed error from its exit code and
// stderr. The patterns are gh's and GitHub's actual messages (see testdata/stderr_*).
func classifyFailure(code int, stdout, stderr []byte) error {
	msg := strings.TrimSpace(string(stderr))
	if msg == "" {
		msg = strings.TrimSpace(string(stdout))
	}
	msg = strings.TrimPrefix(msg, "gh: ")
	lower := strings.ToLower(msg)
	has := func(subs ...string) bool {
		for _, s := range subs {
			if strings.Contains(lower, s) {
				return true
			}
		}
		return false
	}
	first := firstLine(msg)
	switch {
	case code == ghExitAuth,
		has("gh auth login", "bad credentials", "http 401", "authentication required",
			"requires authentication", "token is invalid", "token has expired"):
		return fmt.Errorf("%w: %s", ErrNotAuthenticated, first)
	case has("secondary rate limit", "abuse detection", "http 429"):
		return &RateLimitError{Secondary: true, Msg: first}
	case has("api rate limit exceeded", "rate limit exceeded"):
		return &RateLimitError{Msg: first}
	case has("could not resolve to a", "http 404", "not found"):
		return fmt.Errorf("%w: %s", ErrNotFound, first)
	case has("http 502", "http 504", "couldn't respond to your request in time"):
		return fmt.Errorf("%w: %s", ErrServerTimeout, first)
	case has("error connecting to", "no such host", "connection refused", "network is unreachable",
		"i/o timeout", "tls handshake timeout", "connection reset", "http 503"):
		return fmt.Errorf("%w: %s", ErrNetwork, first)
	}
	if first == "" {
		first = "no output"
	}
	return fmt.Errorf("gh exited %d: %s", code, first)
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return strings.TrimSpace(line)
}

// authStatusJSON is `gh auth status --json hosts`.
type authStatusJSON struct {
	Hosts map[string][]struct {
		State       string `json:"state"`
		Error       string `json:"error"`
		Active      bool   `json:"active"`
		Host        string `json:"host"`
		Login       string `json:"login"`
		TokenSource string `json:"tokenSource"`
	} `json:"hosts"`
}

// parseAuthStatus picks the active github.com account.
func parseAuthStatus(stdout []byte) (AuthStatus, error) {
	var st authStatusJSON
	if err := json.Unmarshal(stdout, &st); err != nil {
		return AuthStatus{}, fmt.Errorf("gh auth status: decode: %w", err)
	}
	for _, acct := range st.Hosts["github.com"] {
		if !acct.Active {
			continue
		}
		return AuthStatus{
			LoggedIn:    acct.State == "success",
			Login:       acct.Login,
			TokenSource: acct.TokenSource,
			Error:       firstLine(acct.Error),
		}, nil
	}
	return AuthStatus{Error: "no github.com account"}, nil
}
