package thread

import (
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Provisional names (docs/notes/provisional-names.md).
//
// The namer can take a while or fail (a rate limit), so a thread with a first prompt
// and no explicit name gets a provisional name from the prompt at once: Thread.Name with
// NameProvisional set. The namer still runs and replaces it (AutoNamed, the flag
// cleared); a rename clears the flag and is never overwritten. A new worktree's branch
// never uses it: the slug still waits on the namer (waitSlug).

// namedForGood reports whether s has a name the namer must not replace: the user's,
// the namer's, or a fork's.
func (s *Thread) namedForGood() bool {
	return s.Name != "" && !s.NameProvisional
}

// nameProvisionally gives an unnamed s the provisional name of its first prompt
// (provisionalName); nothing when the prompt leaves none. Reports whether it did.
func (s *Thread) nameProvisionally(composer, text string) bool {
	if s.Name != "" {
		return false
	}
	if n := provisionalName(composer, text); n != "" {
		s.Name, s.AutoNamed, s.NameProvisional = n, false, true
		return true
	}
	return false
}

// applyNamerTitle names s with the namer's title unless it is named for good (a rename
// meanwhile wins). Reports whether it did.
func (s *Thread) applyNamerTitle(title string) bool {
	if s.namedForGood() {
		return false
	}
	s.Name, s.AutoNamed, s.NameProvisional = title, true, false
	return true
}

// nameFromFirstMessage gives a thread created without a prompt the provisional name of
// the first message sent to it (Send). A thread that has a user message already, or
// whose namer has run, keeps its name; so does one woken by the daemon (OriginWake).
func (m *Manager) nameFromFirstMessage(id string, log *threadLog, o *outgoing) {
	if o.origin != OriginUser || log.hasUserMessage() {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok || m.closed || rec.namingTried || !rec.s.nameProvisionally(o.composer, o.text) {
		return
	}
	m.commitLocked(rec, true)
}

// hasUserMessage reports whether the log has a message from the user.
func (t *threadLog) hasUserMessage() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return slices.ContainsFunc(t.items, func(it Item) bool { return it.Kind == KindUserMessage })
}

// maxProvisionalName bounds a provisional name in runes, the "…" included.
const maxProvisionalName = 48

// provisionalEllipsis ends a provisional name cut for length.
const provisionalEllipsis = "…"

// Token grammars (gui lib/prompt.ts). A composer token is a Markdown link to a cf-*://
// URL: "![name](cf-attachment://id)" for an image or PDF chip, "[/deploy](cf-skill://…)"
// for a skill, "[a.ts](cf-file://…)" for a file. What Claude gets instead (projectPrompt,
// and what the CLI or an agent may type) is "[Image: name; ref=path]" or "[PDF: …]" for an
// attachment and "@cf-file://<project>/<path>" for a file.
var (
	// 1 "!" for an attachment, 2 the label.
	composerToken = regexp.MustCompile(`(!?)\[([^\[\]\n]*)\]\(cf-[a-z][a-z0-9-]*://[^\s()]*\)`)
	// An attachment as projected.
	projectedAttachment = regexp.MustCompile(`\[(?:Image|PDF): [^\[\]\n]*\]`)
	// 1 the URL's path after the project slot, of a file reference as projected.
	projectedRef = regexp.MustCompile(`@cf-[a-z][a-z0-9-]*://[^\s/]*/?(\S*)`)
	// A Markdown heading or numbered list marker: "## ", "1. ", "2) ".
	lineMarker = regexp.MustCompile(`^(?:#{1,6}|[0-9]+[.)]) `)
)

// provisionalName is the name a thread gets from its first prompt until the namer
// answers: composer is the composer's text (tokens as typed), else text is the prompt as
// sent (the CLI's). Tokens become their labels (an attachment goes), whitespace
// collapses, and the first line with text is cut at its first sentence end and then, at
// a word boundary, to maxProvisionalName runes with a trailing "…". "" when nothing is
// left (a prompt of only an image).
func provisionalName(composer, text string) string {
	src := composer
	if strings.TrimSpace(src) == "" {
		src = text
	}
	src = composerToken.ReplaceAllStringFunc(src, func(tok string) string {
		m := composerToken.FindStringSubmatch(tok)
		if m[1] == "!" {
			return " "
		}
		return m[2]
	})
	src = projectedAttachment.ReplaceAllString(src, " ")
	src = projectedRef.ReplaceAllStringFunc(src, func(tok string) string {
		return refLabel(projectedRef.FindStringSubmatch(tok)[1])
	})
	for line := range strings.SplitSeq(src, "\n") {
		if l := provisionalLine(line); l != "" {
			return truncateName(firstSentence(l))
		}
	}
	return ""
}

// provisionalLine is one prompt line as a name candidate: control characters gone,
// whitespace collapsed, a Markdown heading, quote or list marker dropped; "" for a line
// with no text or a code fence.
func provisionalLine(line string) string {
	line = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == utf8.RuneError {
			return ' '
		}
		return r
	}, line)
	line = strings.Join(strings.Fields(line), " ")
	if strings.HasPrefix(line, "```") || strings.HasPrefix(line, "~~~") {
		return ""
	}
	for {
		trimmed := lineMarker.ReplaceAllString(line, "")
		for _, p := range []string{">", "- ", "* ", "+ "} {
			trimmed = strings.TrimSpace(strings.TrimPrefix(trimmed, p))
		}
		if trimmed == line {
			break
		}
		line = trimmed
	}
	if !strings.ContainsFunc(line, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) }) {
		return ""
	}
	return line
}

// firstSentence is line up to its first sentence end: ".", "!" or "?" followed by a
// space, or a full-width "。", "！" or "？". A period after an abbreviation ("e.g.",
// "v1.2.", "etc.") or a sentence of one word ("Hi.") does not end it. A trailing period,
// colon, semicolon or comma goes; "?" and "!" stay.
func firstSentence(line string) string {
	for i, r := range line {
		if !strings.ContainsRune(".!?。！？", r) {
			continue
		}
		next := i + utf8.RuneLen(r)
		fullWidth := r == '。' || r == '！' || r == '？'
		if !fullWidth && (next >= len(line) || line[next] != ' ') {
			continue
		}
		head := line[:i]
		word := head[strings.LastIndexByte(head, ' ')+1:]
		if !fullWidth && (!strings.Contains(head, " ") || r == '.' && abbreviation(word)) {
			continue
		}
		line = line[:next]
		break
	}
	return strings.TrimRight(line, ".:;, 。：；，")
}

// abbreviation reports whether word, the text before a period, is an abbreviation
// rather than a sentence's last word: dotted letters ("e.g", "i.e", "U.S") or a common
// one. A version ("v1.2") is a word.
func abbreviation(word string) bool {
	switch strings.ToLower(word) {
	case "etc", "vs", "approx", "mr", "mrs", "ms", "dr", "no", "fig", "cf":
		return true
	}
	if !strings.Contains(word, ".") {
		return false
	}
	for seg := range strings.SplitSeq(word, ".") {
		if len(seg) > 3 || strings.ContainsFunc(seg, func(r rune) bool { return !unicode.IsLetter(r) }) {
			return false
		}
	}
	return true
}

// truncateName cuts s to maxProvisionalName runes at the last word boundary that fits,
// with "…". When that boundary would keep less than half the room (a first word longer
// than all of it, or a short word and then a URL or a path: "Review https://…" would be
// "Review…"; CJK text has few spaces) it cuts mid-word instead, never inside a
// character's combining marks or an emoji sequence (clusterStart).
func truncateName(s string) string {
	if utf8.RuneCountInString(s) <= maxProvisionalName {
		return s
	}
	limit := maxProvisionalName - utf8.RuneCountInString(provisionalEllipsis)
	end, n := 0, 0 // byte offset of the limit-th rune
	for i := range s {
		if n == limit {
			end = i
			break
		}
		n++
	}
	midWord := s[:clusterStart(s, end)]
	cut := s[:end]
	if s[end] != ' ' {
		if sp := strings.LastIndexByte(cut, ' '); sp > 0 && utf8.RuneCountInString(cut[:sp]) >= limit/2 {
			cut = cut[:sp]
		} else {
			cut = midWord
		}
	}
	cut = strings.TrimRightFunc(cut, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsPunct(r) && r != ')' && r != '"' })
	if cut == "" {
		cut = midWord
	}
	return cut + provisionalEllipsis
}

// clusterStart moves a cut at byte offset end of s back to the start of the
// user-perceived character there, so a cut keeps "é" spelled e + U+0301 whole, and an
// emoji with its skin tone, variation selector, tags or ZWJ sequence, and a flag's pair
// of regional indicators. An approximation of grapheme clusters (UAX #29) for those
// cases; end itself when nothing before it would be left.
func clusterStart(s string, end int) int {
	extends := func(r rune) bool {
		return unicode.In(r, unicode.Mn, unicode.Me, unicode.Mc) || r == '‍' ||
			r >= '︀' && r <= '️' || r >= 0x1f3fb && r <= 0x1f3ff || r >= 0xe0020 && r <= 0xe007f
	}
	regional := func(r rune) bool { return r >= 0x1f1e6 && r <= 0x1f1ff }
	i := end
	for i > 0 {
		next, _ := utf8.DecodeRuneInString(s[i:])
		prev, size := utf8.DecodeLastRuneInString(s[:i])
		if extends(next) || prev == '‍' {
			i -= size
			continue
		}
		if regional(next) {
			// A flag is a pair: the cut splits one when an odd run of indicators ends here.
			k, j := 0, i
			for j > 0 {
				r, sz := utf8.DecodeLastRuneInString(s[:j])
				if !regional(r) {
					break
				}
				k, j = k+1, j-sz
			}
			if k%2 == 1 {
				i -= size
			}
		}
		break
	}
	if i == 0 {
		return end
	}
	return i
}

// refLabel is what a projected file reference shows: its base name, a directory's with
// a trailing "/" (tagLabel in lib/prompt.ts), percent-decoded when it decodes.
func refLabel(raw string) string {
	if dec, err := url.PathUnescape(raw); err == nil && utf8.ValidString(dec) {
		raw = dec
	}
	dir := strings.HasSuffix(raw, "/")
	raw = strings.TrimSuffix(raw, "/")
	if i := strings.LastIndexByte(raw, '/'); i >= 0 {
		raw = raw[i+1:]
	}
	if raw != "" && dir {
		raw += "/"
	}
	return raw
}
