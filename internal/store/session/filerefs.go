package session

import (
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"
)

// File references in a first prompt.
//
// The GUI composer sends a file tag as "@cf-file://<repoId>/<relative/path>": it
// cannot know the absolute path of a worktree the daemon has not created yet (a
// new-worktree or new-workspace thread). The token starts at "cf-file://" and ends at
// the next whitespace or the end of the prompt; <relative/path> is percent-encoded
// (the GUI encodes at least spaces and "%"), "/"-separated, relative to the project's
// checkout, with a trailing "/" for a directory. Create rewrites every token once the
// thread's worktrees exist and before claude starts: <repoId> names the thread's own
// project (its cwd) or, in a workspace thread, a member, and the token becomes
// "<that member's worktree>/<decoded path>", so "@cf-file://r-1/src/a.ts" reaches
// claude as "@/Users/me/.../src/a.ts". A token whose repo is not part of the thread,
// or whose path has a ".." segment, cannot be decoded, or decodes to a control
// character, becomes the relative path alone ("@src/a.ts") and is logged.

// fileRefScheme starts a file reference token.
const fileRefScheme = "cf-file://"

// rewriteFileRefs replaces every cf-file:// token in prompt with an absolute path in
// the worktree resolve returns for its repo id (see the comment above). It also
// returns the tokens that could not be resolved, as written, for the caller to log.
// A token without a "/" after the repo id is left alone.
func rewriteFileRefs(prompt string, resolve func(repoID string) (worktree string, ok bool)) (string, []string) {
	if !strings.Contains(prompt, fileRefScheme) {
		return prompt, nil
	}
	var b strings.Builder
	var dropped []string
	rest := prompt
	for {
		i := strings.Index(rest, fileRefScheme)
		if i < 0 {
			b.WriteString(rest)
			break
		}
		b.WriteString(rest[:i])
		tok := rest[i:]
		if end := strings.IndexFunc(tok, unicode.IsSpace); end >= 0 {
			tok = tok[:end]
		}
		rest = rest[i+len(tok):]

		repoID, raw, ok := strings.Cut(tok[len(fileRefScheme):], "/")
		if !ok || repoID == "" {
			b.WriteString(tok)
			continue
		}
		rel, safe := decodeRel(raw)
		var worktree string
		if safe {
			worktree, safe = resolve(repoID)
		}
		if !safe || worktree == "" {
			dropped = append(dropped, tok)
			b.WriteString(rel)
			continue
		}
		b.WriteString(strings.TrimSuffix(worktree, "/"))
		b.WriteByte('/')
		b.WriteString(rel)
	}
	return b.String(), dropped
}

// decodeRel percent-decodes a token's relative path and reports whether it is safe to
// join to a worktree: decodable, no ".." segment, no control characters. Leading
// slashes are dropped. An unsafe path is returned decoded when it decodes to valid
// text without control characters, else as written.
func decodeRel(raw string) (string, bool) {
	rel, err := url.PathUnescape(raw)
	if err != nil || !utf8.ValidString(rel) || strings.ContainsFunc(rel, unicode.IsControl) {
		return strings.TrimLeft(raw, "/"), false
	}
	rel = strings.TrimLeft(rel, "/")
	for seg := range strings.SplitSeq(rel, "/") {
		if seg == ".." {
			return rel, false
		}
	}
	return rel, true
}

// stripFileRefs is prompt with every file reference reduced to its relative path, for
// text that is not claude's prompt (the namer's input).
func stripFileRefs(prompt string) string {
	out, _ := rewriteFileRefs(prompt, func(string) (string, bool) { return "", false })
	return out
}
