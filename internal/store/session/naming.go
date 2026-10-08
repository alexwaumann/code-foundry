package session

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

// Namer turns a session's first user message into a short kebab-case name.
type Namer func(ctx context.Context, firstMessage string) (string, error)

// maxNamingInput bounds how much of the first message goes into the naming prompt.
const maxNamingInput = 2000

// ClaudeNamer names sessions with an independent, non-interactive claude call:
//
//	claude -p --model haiku --no-session-persistence --tools "" --strict-mcp-config <prompt>
//
// run in /tmp so it never touches the project. --no-session-persistence keeps it out
// of the transcript directories, and with no tools and no MCP servers the user's text
// cannot make it do anything but answer. Measured at ~1.5s.
func ClaudeNamer(claude, cwd string) Namer {
	return func(ctx context.Context, msg string) (string, error) {
		if len(msg) > maxNamingInput {
			msg = msg[:maxNamingInput]
		}
		prompt := "Give a 3-5 word kebab-case slug (lowercase words joined by hyphens) that names " +
			"the coding task in the request below. Reply with only the slug.\n\nRequest:\n" + msg
		cmd := exec.CommandContext(ctx, claude, "-p", "--model", "haiku", "--no-session-persistence",
			"--tools", "", "--strict-mcp-config", prompt)
		cmd.Dir = cwd
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("claude -p: %w: %s", err, strings.TrimSpace(stderr.String()))
		}
		slug := slugify(string(out))
		if slug == "" {
			return "", fmt.Errorf("claude -p: no usable name in %q", out)
		}
		return slug, nil
	}
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
