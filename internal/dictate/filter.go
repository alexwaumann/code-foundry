package dictate

import (
	"regexp"
	"strings"
	"unicode"
)

// maxLoopN is the longest n-gram collapseLoops looks for.
const maxLoopN = 8

var (
	silenceSet = func() map[string]bool {
		m := make(map[string]bool, len(silenceHallucinations))
		for _, s := range silenceHallucinations {
			m[normalize(s)] = true
		}
		return m
	}()
	// bracketed is a non-speech annotation: [BLANK_AUDIO], [Music], ♪ ... ♪.
	bracketed = regexp.MustCompile(`\[[^\]]*\]|[♪♫]+`)
	// annotation is a phrase that is only a stage direction: (music), *laughs*.
	annotation = regexp.MustCompile(`^(\([^)]*\)|\*[^*]*\*)$`)
)

// CleanPhrase returns what of whisper's text for one phrase should land in the composer:
// "" for silence hallucinations and non-speech annotations, and n-gram loops collapsed
// to one copy.
func CleanPhrase(text string) string {
	t := bracketed.ReplaceAllString(text, " ")
	t = strings.Join(strings.Fields(t), " ")
	if t == "" || annotation.MatchString(t) {
		return ""
	}
	t = collapseLoops(t)
	if IsHallucination(t) {
		return ""
	}
	return t
}

// IsHallucination reports whether text is one of the known silence hallucinations, a
// subtitle credit, or has no words at all.
func IsHallucination(text string) bool {
	n := normalize(text)
	if n == "" || silenceSet[n] {
		return true
	}
	lower := strings.ToLower(text)
	for _, m := range creditMarkers {
		if strings.Contains(lower, m) {
			return true
		}
	}
	return false
}

// normalize lower-cases text, drops everything but letters, digits and spaces, and
// collapses spaces.
func normalize(text string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(text) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		case unicode.IsSpace(r):
			b.WriteByte(' ')
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// collapseLoops keeps one copy of an n-gram (n ≤ maxLoopN words) repeated back to back
// more than a person would say it: four times for a single word, three for longer runs.
// Whisper's decoder falls into such loops on noise and long silences.
func collapseLoops(text string) string {
	words := strings.Fields(text)
	keys := make([]string, len(words))
	for i, w := range words {
		keys[i] = normalize(w)
	}
	for n := 1; n <= maxLoopN; n++ {
		limit := 3
		if n == 1 {
			limit = 4
		}
		var outW, outK []string
		for i := 0; i < len(words); {
			reps := 1
			if i+n <= len(words) {
				for j := i + n; j+n <= len(words) && equalRun(keys[i:i+n], keys[j:j+n]); j += n {
					reps++
				}
			}
			if reps >= limit {
				// The last copy: it carries the run's closing punctuation.
				last := i + (reps-1)*n
				outW = append(outW, words[last:last+n]...)
				outK = append(outK, keys[last:last+n]...)
				i += reps * n
				continue
			}
			outW = append(outW, words[i])
			outK = append(outK, keys[i])
			i++
		}
		words, keys = outW, outK
	}
	return strings.Join(words, " ")
}

func equalRun(a, b []string) bool {
	for i := range a {
		if a[i] != b[i] || a[i] == "" {
			return false
		}
	}
	return true
}

// promptTail is the end of text, at most limit bytes, cut at a word boundary: the
// previous phrase's tail that primes the next one.
func promptTail(text string, limit int) string {
	text = strings.TrimSpace(text)
	if len(text) <= limit {
		return text
	}
	t := text[len(text)-limit:]
	if i := strings.IndexByte(t, ' '); i >= 0 && i+1 < len(t) {
		t = t[i+1:]
	}
	return strings.ToValidUTF8(t, "")
}
