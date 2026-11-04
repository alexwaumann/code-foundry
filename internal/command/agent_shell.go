package command

import "strings"

// shellWord is one word of a simple command as the shell would pass it. bare: nothing
// in it was quoted.
type shellWord struct {
	text string
	bare bool
}

// shellWords splits line the way bash and zsh split one simple command, or reports false
// for anything that is not provably just that. It is the edge of what the daemon approves
// without asking (Registry.ApprovedVerb), so it lists what is safe, not what is dangerous:
//
//   - Outside quotes only plainByte characters, spaces and tabs. So no expansion, operator,
//     redirection, glob, comment, escape or newline, and no byte outside ASCII.
//   - Inside single quotes anything but NUL: the shell takes it as it is. That is the one
//     place a metacharacter is allowed, a prompt with a newline among them.
//   - Inside double quotes only plainByte characters, spaces and tabs: $, ` and \ work
//     there, and the rest is kept out so that one rule covers the whole of a double quote.
//   - No word starts with an unquoted =: zsh expands =name to a path.
//
// An unterminated quote is false.
func shellWords(line string) ([]shellWord, bool) {
	if strings.IndexByte(line, 0) >= 0 {
		return nil, false
	}
	var (
		words []shellWord
		b     strings.Builder
		open  bool // a word has started
		bare  = true
	)
	end := func() {
		if open {
			words = append(words, shellWord{text: b.String(), bare: bare})
		}
		b.Reset()
		open, bare = false, true
	}
	for i := 0; i < len(line); i++ {
		c := line[i]
		switch {
		case c == ' ' || c == '\t':
			end()
		case c == '\'' || c == '"':
			n := strings.IndexByte(line[i+1:], c)
			if n < 0 {
				return nil, false
			}
			text := line[i+1 : i+1+n]
			if c == '"' && !doubleQuotable(text) {
				return nil, false
			}
			b.WriteString(text)
			open, bare = true, false
			i += n + 1
		case c == '=' && !open:
			return nil, false
		case plainByte(c):
			b.WriteByte(c)
			open = true
		default:
			return nil, false
		}
	}
	end()
	return words, true
}

// plainByte reports whether c means only itself to bash and zsh, wherever it stands
// (but for a leading =, which shellWords refuses).
func plainByte(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return strings.IndexByte("_-./:,+=@%", c) >= 0
}

func doubleQuotable(s string) bool {
	for i := 0; i < len(s); i++ {
		if !plainByte(s[i]) && s[i] != ' ' && s[i] != '\t' {
			return false
		}
	}
	return true
}
