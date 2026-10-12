package session

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/alexwaumann/code-foundry/internal/model"
)

// Namer turns a session's first user message into a short kebab-case name.
type Namer func(ctx context.Context, firstMessage string) (string, error)

// maxNamingInput bounds how much of the first message goes into the naming prompt.
const maxNamingInput = 2000

// namingEffort is the effort of every naming call. A 3-5 word slug needs no thinking,
// and low keeps the call fast and cheap whatever the model; it is not a setting.
const namingEffort = "low"

// namingArgs is the naming command for model m, before "--" and the prompt. Both
// variants pass --model and --effort low. The hardened one (minimal false) is:
//
//	-p --model <model> --effort low --no-session-persistence --safe-mode --tools ""
//
// The flags:
//
//   - -p runs once and prints the answer; --no-session-persistence keeps the call out
//     of Claude's transcript directories (and so out of the usage fold).
//   - --safe-mode starts without the user's customizations: CLAUDE.md, skills, plugins,
//     hooks and, most importantly, MCP servers (user, project and claude.ai
//     connectors). Admin-managed (policy) settings, and with them an organization's
//     managed MCP servers, still apply. It replaces --strict-mcp-config, which Claude
//     refuses outright when an enterprise managed-mcp.json is present ("You cannot use
//     --strict-mcp-config when an enterprise MCP config is present"). No managed
//     setting gates --safe-mode in Claude Code 2.1.296.
//   - --tools "" removes every built-in tool. It is the important hardening: with no
//     tools the user's text cannot make the call do anything but answer. Measured
//     without --safe-mode, --tools "" still leaves MCP tools (claude.ai connectors)
//     available, so it is not enough on its own. No managed setting refuses it.
//
// --tools is variadic, so it comes last and the prompt must follow "--" or Claude
// reads it as a tool name ("Input must be provided ..."); --strict-mcp-config used to
// end the list.
//
// The minimal variant (minimal true) is the fallback when Claude refuses a flag of the
// hardened one (an organization's managed settings, or a Claude too old for
// --safe-mode):
//
//	-p --model <model> --effort low --no-session-persistence
//
// It runs in /tmp without persistence, and -p mode cannot ask for permission, so a
// tool call that needs approval is denied; read-only tools and the user's MCP servers
// are available, which is the accepted cost of naming at all on such machines.
func namingArgs(m string, minimal bool) []string {
	args := []string{"-p", "--model", m, "--effort", namingEffort, "--no-session-persistence"}
	if !minimal {
		args = append(args, "--safe-mode", "--tools", "")
	}
	return args
}

// maxNamingErrDetail bounds the claude output kept in a naming error. Large enough
// for Claude's longest policy refusal, which names the flags and the setting.
const maxNamingErrDetail = 4096

// sessionKey carries the session id into the namer for its log lines.
type sessionKey struct{}

// withNamingSession returns ctx tagged with the session a naming call is for.
func withNamingSession(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, sessionKey{}, id)
}

// namingSession returns the session id withNamingSession put in ctx, or "".
func namingSession(ctx context.Context) string {
	id, _ := ctx.Value(sessionKey{}).(string)
	return id
}

// namingModelKey carries the naming model into the namer.
type namingModelKey struct{}

// WithNamingModel returns ctx asking ClaudeNamer to name with model m (a model
// registry value). The daemon sets it per call from sessions.naming_model, so the setting
// applies without a restart.
func WithNamingModel(ctx context.Context, m string) context.Context {
	return context.WithValue(ctx, namingModelKey{}, m)
}

// NamingModel returns the model ClaudeNamer uses for a call with ctx: the
// WithNamingModel value when the model registry lists it, else model.NamingDefault.
func NamingModel(ctx context.Context) string {
	if m, _ := ctx.Value(namingModelKey{}).(string); model.Known(m) {
		return m
	}
	return model.NamingDefault
}

// ClaudeNamer names sessions with an independent, non-interactive claude call:
//
//	claude -p --model <model> --effort low --no-session-persistence --safe-mode --tools "" -- <prompt>
//
// run in cwd (/tmp) so it never touches a project; see namingArgs for why each flag
// is there. The model is NamingModel(ctx), read per call (model.NamingDefault unless
// the caller set one with WithNamingModel); the effort is always low. When Claude
// refuses one of the hardened flags (isFlagRefused: an organization's managed
// settings, or an unknown option) the call is retried once as
//
//	claude -p --model <model> --effort low --no-session-persistence -- <prompt>
//
// and every later call in this daemon run goes straight to that command. Each
// finished call is logged at info with its arguments (the prompt elided), the
// refusal at warn with Claude's full message. Measured at ~1.5-1.8s.
func ClaudeNamer(claude, cwd string, log *slog.Logger) Namer {
	if log == nil {
		log = slog.Default()
	}
	var minimal atomic.Bool
	return func(ctx context.Context, msg string) (string, error) {
		if len(msg) > maxNamingInput {
			msg = msg[:maxNamingInput]
		}
		prompt := "Give a 3-5 word kebab-case slug (lowercase words joined by hyphens) that names " +
			"the coding task in the request below. Reply with only the slug.\n\nRequest:\n" + msg
		session := namingSession(ctx)
		m := NamingModel(ctx)
		args := namingArgs(m, minimal.Load())
		out, err := runNaming(ctx, log, session, claude, cwd, args, prompt)
		if err != nil && !minimal.Load() && isFlagRefused(err) {
			log.Warn("claude refused a naming flag; retrying with the minimal command for this daemon run",
				"session", session, "args", namingCommand(args), "err", err)
			minimal.Store(true)
			first := err
			if out, err = runNaming(ctx, log, session, claude, cwd, namingArgs(m, true), prompt); err != nil {
				err = fmt.Errorf("%w (after the hardened command failed: %v)", err, first)
			}
		}
		if err != nil {
			return "", err
		}
		slug := slugify(out)
		if slug == "" {
			return "", fmt.Errorf("claude -p: no usable name in %q", out)
		}
		return slug, nil
	}
}

// runNaming runs claude with args, "--" and the prompt in cwd and returns its stdout.
func runNaming(ctx context.Context, log *slog.Logger, session, claude, cwd string, args []string, prompt string) (string, error) {
	argv := append(append(slices.Clone(args), "--"), prompt)
	cmd := exec.CommandContext(ctx, claude, argv...)
	cmd.Dir = cwd
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	start := time.Now()
	out, err := cmd.Output()
	log.Info("naming command finished", "session", session, "cmd", claude+" "+namingCommand(args),
		"ok", err == nil, "took", time.Since(start).Round(time.Millisecond).String())
	if err != nil {
		// claude -p reports API errors (429, overloaded) on stdout and refusals on
		// stderr; keep both so isRateLimit and isFlagRefused can see them.
		detail := strings.TrimSpace(strings.TrimSpace(stderr.String()) + "\n" + strings.TrimSpace(string(out)))
		if len(detail) > maxNamingErrDetail {
			detail = detail[:maxNamingErrDetail] + "…"
		}
		return "", fmt.Errorf("claude -p: %w: %s", err, detail)
	}
	return string(out), nil
}

// namingCommand renders naming args for the log, quoting the empty --tools list,
// with the prompt elided.
func namingCommand(args []string) string {
	parts := make([]string, 0, len(args)+2)
	for _, a := range args {
		if a == "" {
			a = `""`
		}
		parts = append(parts, a)
	}
	return strings.Join(append(parts, "--", "<prompt>"), " ")
}

// isFlagRefused reports whether a naming error is Claude refusing a command-line
// flag rather than the call failing: an unknown option (commander's "error: unknown
// option '--x'", a Claude too old for a flag) or a flag forbidden by the
// organization's managed settings. Wordings, from Claude Code 2.1.296:
//
//	You cannot use --strict-mcp-config when an enterprise MCP config is present
//	You cannot dynamically configure MCP servers when an enterprise MCP config is present
//	--mcp-config is disabled by your organization's managed settings (disableSideloadFlags). ...
//	--chrome is blocked by your organization's MCP policy (...)
//
// The generic policy phrases count only next to a flag, so an API error such as a
// 403 "not allowed" does not drop the hardening for the rest of the daemon run.
func isFlagRefused(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, s := range []string{"unknown option", "enterprise mcp config", "disablesideloadflags"} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	if !flagToken.MatchString(msg) {
		return false
	}
	for _, s := range []string{"by your organization", "managed settings", "not allowed", "not permitted", "disabled by", "cannot use"} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

// flagToken matches a long option such as --strict-mcp-config.
var flagToken = regexp.MustCompile(`(^|[\s'"(])--[a-z]`)

// isRateLimit reports whether a naming error looks like an API rate limit, the one
// failure worth retrying.
func isRateLimit(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "429") || strings.Contains(msg, "rate limit") ||
		strings.Contains(msg, "rate_limit") || strings.Contains(msg, "ratelimit")
}

var slugJunk = regexp.MustCompile(`[^a-z0-9]+`)

// slugify reduces model output to a kebab-case slug of at most 5 words and 60
// characters, using the first non-empty line.
func slugify(s string) string {
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		words := strings.FieldsFunc(slugJunk.ReplaceAllString(strings.ToLower(line), " "), func(r rune) bool { return r == ' ' })
		if len(words) > 5 {
			words = words[:5]
		}
		out := strings.Join(words, "-")
		for len(out) > 60 {
			i := strings.LastIndexByte(out, '-')
			if i <= 0 {
				out = out[:60]
				break
			}
			out = out[:i]
		}
		return out
	}
	return ""
}

// firstUserText extracts the text a user typed from a transcript line, if the line
// is a real user prompt: type "user", not meta or sidechain, and text content (a
// string or text blocks) that is not a tool result or a slash-command wrapper
// ("<command-name>…", "<local-command-stdout>…").
func firstUserText(line []byte) (string, bool) {
	var rec struct {
		Type        string `json:"type"`
		IsMeta      bool   `json:"isMeta"`
		IsSidechain bool   `json:"isSidechain"`
		Message     struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &rec) != nil || rec.Type != "user" || rec.IsMeta || rec.IsSidechain || rec.Message.Role != "user" {
		return "", false
	}
	var text string
	var s string
	if json.Unmarshal(rec.Message.Content, &s) == nil {
		text = s
	} else {
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(rec.Message.Content, &blocks) != nil {
			return "", false
		}
		var parts []string
		for _, b := range blocks {
			switch b.Type {
			case "text":
				parts = append(parts, b.Text)
			case "tool_result":
				return "", false
			}
		}
		text = strings.Join(parts, "\n")
	}
	text = strings.TrimSpace(text)
	if text == "" || strings.HasPrefix(text, "<") {
		return "", false
	}
	return text, true
}
