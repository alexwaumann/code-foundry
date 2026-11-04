package dictate

import (
	"strings"
	"unicode"
)

// Spoken says which spoken commands a phrase goes through (docs/notes/dictation-spoken-text.md).
// The English word lists and the rules for what goes with a command are ported from Hex
// (spoken_formatting.rs and spoken_symbols.rs; MIT, see gui/frontend/public/HEX-LICENSE.md).
type Spoken struct {
	// Symbols is dictation.spoken_symbols: "my underscore variable" is my_variable.
	Symbols bool
	// Formatting is dictation.spoken_formatting: "new line" is a line break.
	Formatting bool
}

// Apply is text with the chosen commands applied. Formatting goes first: a symbol's rules
// know a line break that is already there. A phrase is the only text a command sees, so
// "quote" and its "unquote" must fall in the same phrase.
func (s Spoken) Apply(text string) string {
	if s.Formatting {
		text = applyFormatting(text)
	}
	if s.Symbols {
		text = applySymbols(text)
	}
	return text
}

// join says which neighbour a symbol attaches to.
type join int

const (
	joinNext     join = iota // the next word: "#release"
	joinBoth                 // both words: "my_variable"
	joinPrevious             // the previous word, with one space after: "done, thanks"
)

var spokenSymbols = []struct {
	words  []string
	symbol rune
	join   join
}{
	{[]string{"hashtag"}, '#', joinNext},
	{[]string{"hash", "sign"}, '#', joinNext},
	{[]string{"at", "sign"}, '@', joinNext},
	{[]string{"underscore"}, '_', joinBoth},
	{[]string{"hyphen"}, '-', joinBoth},
	{[]string{"slash"}, '/', joinBoth},
	{[]string{"comma"}, ',', joinPrevious},
	{[]string{"semicolon"}, ';', joinPrevious},
	{[]string{"colon"}, ':', joinPrevious},
}

// command is what a formatting phrase does.
type command int

const (
	commandLine command = iota
	commandParagraph
	commandOpenQuote
	commandCloseQuote
)

var spokenCommands = []struct {
	words   []string
	command command
}{
	{[]string{"new", "paragraph"}, commandParagraph},
	{[]string{"new", "line"}, commandLine},
	{[]string{"line", "break"}, commandLine},
	{[]string{"open", "quote"}, commandOpenQuote},
	{[]string{"close", "quote"}, commandCloseQuote},
}

func isWordRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) }

func wordStart(text []rune, i int) bool { return i == 0 || !isWordRune(text[i-1]) }

// isSpace is any space but a line break, which a command has put there on purpose.
func isSpace(r rune) bool { return unicode.IsSpace(r) && r != '\n' }

// wordEnd is where the whole word starting at start ends, or -1. Case does not count.
func wordEnd(text []rune, start int, word string) int {
	i := start
	for _, want := range word {
		if i >= len(text) || unicode.ToLower(text[i]) != want {
			return -1
		}
		i++
	}
	if i < len(text) && isWordRune(text[i]) {
		return -1
	}
	return i
}

// wordsEnd is wordEnd for words with spaces between them.
func wordsEnd(text []rune, start int, words []string) int {
	i := start
	for n, word := range words {
		if n > 0 {
			from := i
			for i < len(text) && unicode.IsSpace(text[i]) {
				i++
			}
			if i == from {
				return -1
			}
		}
		if i = wordEnd(text, i, word); i < 0 {
			return -1
		}
	}
	return i
}

// trimEnd drops the spaces and also from the end of out, never below floor.
func trimEnd(out []rune, floor int, also string) []rune {
	for len(out) > floor {
		if last := out[len(out)-1]; !isSpace(last) && !strings.ContainsRune(also, last) {
			break
		}
		out = out[:len(out)-1]
	}
	return out
}

// skip is the first index from i that is not a space or one of also.
func skip(text []rune, i int, also string) int {
	for i < len(text) && (isSpace(text[i]) || strings.ContainsRune(also, text[i])) {
		i++
	}
	return i
}

func applySymbols(transcript string) string {
	text := []rune(transcript)
	out := make([]rune, 0, len(text))
	// Where the last symbol written ends, so trimming never removes it.
	floor := 0
	for i := 0; i < len(text); {
		if wordStart(text, i) {
			if next, ok := writeSymbol(text, i, &out, &floor); ok {
				i = next
				continue
			}
		}
		out = append(out, text[i])
		i++
	}
	return string(out)
}

// writeSymbol writes the symbol whose words start at i, if there is one, and returns where
// the text goes on. The commas, periods and spaces around it go with it.
func writeSymbol(text []rune, i int, out *[]rune, floor *int) (int, bool) {
	for _, s := range spokenSymbols {
		end := wordsEnd(text, i, s.words)
		if end < 0 {
			continue
		}
		if s.join != joinNext {
			*out = trimEnd(*out, *floor, ",")
		}
		*out = append(*out, s.symbol)
		*floor = len(*out)
		next := skip(text, end, ",.")
		if s.join == joinPrevious && next < len(text) && !strings.ContainsRune("\n,.;:!?)]\"", text[next]) {
			*out = append(*out, ' ')
		}
		return next, true
	}
	return 0, false
}

func applyFormatting(transcript string) string {
	text := []rune(transcript)
	out := make([]rune, 0, len(text))
	// Where the "unquote" closing an open "quote" starts; -1 when none is open.
	unquote := -1
	for i := 0; i < len(text); {
		if i == unquote {
			unquote = -1
			i = writeCommand(text, wordEnd(text, i, "unquote"), commandCloseQuote, &out)
			continue
		}
		if wordStart(text, i) {
			if end, c, ok := commandAt(text, i); ok {
				i = writeCommand(text, end, c, &out)
				continue
			}
			if end := wordEnd(text, i, "quote"); end >= 0 && unquote < 0 {
				if at := unquoteAfter(text, end); at >= 0 {
					unquote = at
					i = writeCommand(text, end, commandOpenQuote, &out)
					continue
				}
			}
		}
		out = append(out, text[i])
		i++
	}
	return string(out)
}

func commandAt(text []rune, i int) (end int, c command, ok bool) {
	for _, s := range spokenCommands {
		if end := wordsEnd(text, i, s.words); end >= 0 {
			return end, s.command, true
		}
	}
	return 0, 0, false
}

// unquoteAfter is where the first whole-word "unquote" after from starts when some words
// come between, else -1: "quote unquote experts" is a figure of speech, not a quote.
func unquoteAfter(text []rune, from int) int {
	words := false
	for i := from; i < len(text); i++ {
		if wordStart(text, i) && wordEnd(text, i, "unquote") >= 0 {
			if words {
				return i
			}
			return -1
		}
		words = words || isWordRune(text[i])
	}
	return -1
}

// writeCommand writes c, whose words end at end, and returns where the text goes on.
func writeCommand(text []rune, end int, c command, out *[]rune) int {
	switch c {
	case commandLine, commandParagraph:
		*out = trimEnd(*out, 0, ",;")
		*out = append(*out, '\n')
		if c == commandParagraph {
			*out = append(*out, '\n')
		}
		return skip(text, end, ",.;:")
	case commandOpenQuote:
		*out = trimEnd(*out, 0, "")
		if n := len(*out); n > 0 && !strings.ContainsRune("\n([\"", (*out)[n-1]) {
			*out = append(*out, ' ')
		}
		*out = append(*out, '"')
		return skip(text, end, ",.")
	default:
		*out = trimEnd(*out, 0, ",")
		*out = append(*out, '"')
		next := skip(text, end, "")
		if next < len(text) && isWordRune(text[next]) {
			*out = append(*out, ' ')
		}
		return next
	}
}
