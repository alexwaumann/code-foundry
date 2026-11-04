package dictate

import "testing"

func TestSpokenSymbols(t *testing.T) {
	tests := []struct{ in, want string }{
		{"hashtag release", "#release"},
		{"my underscore variable", "my_variable"},
		{"done comma thanks", "done, thanks"},
		{"tag it hash sign release", "tag it #release"},
		{"mail me at sign home", "mail me @home"},
		{"well hyphen known", "well-known"},
		{"and slash or", "and/or"},
		{"one semicolon two", "one; two"},
		{"the list colon apples", "the list: apples"},
		{"Done, Comma, thanks.", "Done, thanks."},
		{"the list COLON.", "the list:"},
		{"a comma comma b", "a,, b"},
		{"before a break comma\nafter", "before a break,\nafter"},
		// Left alone: other words, and Hex's Spanish words, which were not ported.
		{"commas", "commas"},
		{"slashed prices", "slashed prices"},
		{"hashtags everywhere", "hashtags everywhere"},
		{"a hash browns sign", "a hash browns sign"},
		{"the colonel", "the colonel"},
		{"Plain text, nothing to do.", "Plain text, nothing to do."},
		{"", ""},
		{"hola coma gracias", "hola coma gracias"},
		{"arroba casa", "arroba casa"},
		{"guion bajo", "guion bajo"},
		{"dos puntos", "dos puntos"},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := (Spoken{Symbols: true}).Apply(tt.in); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSpokenFormatting(t *testing.T) {
	tests := []struct{ in, want string }{
		{"Hello. New line. Next", "Hello.\nNext"},
		{"One. New paragraph. Two.", "One.\n\nTwo."},
		{"one, line break, two", "one\ntwo"},
		{"a NEW LINE new line b", "a\n\nb"},
		{"New line.", "\n"},
		{"New paragraph.", "\n\n"},
		{"The end, new line.", "The end\n"},
		{"New line. Next", "\nNext"},

		{"He said open quote hi close quote.", `He said "hi".`},
		{"He said, Open quote, hello, close quote, and left.", `He said, "hello", and left.`},
		{"open quote yes close quote then", `"yes" then`},
		{"He said open quote", `He said "`},
		{"Close quote.", `".`},

		{"He said quote hello unquote.", `He said "hello".`},
		{"Quote, something, unquote, and more", `"something", and more`},
		{"open quote a close quote and quote b unquote", `"a" and "b"`},
		// No pair in this phrase, so these are the words.
		{"Can I get a quote for this", "Can I get a quote for this"},
		{"quote unquote experts", "quote unquote experts"},
		{"an unquote alone", "an unquote alone"},
		{"quotes and quoted text unquoted", "quotes and quoted text unquoted"},

		{"The newline character", "The newline character"},
		{"a new liner", "a new liner"},
		{"renew line items", "renew line items"},
		{"line breaker", "line breaker"},
		{"open quotes", "open quotes"},
		{"Plain text, nothing to do.", "Plain text, nothing to do."},
		{"", ""},
		// Hex's Spanish phrases were not ported.
		{"Hola. Nuevo párrafo. Adiós.", "Hola. Nuevo párrafo. Adiós."},
		{"uno salto de línea dos", "uno salto de línea dos"},
		{"abre comillas hola", "abre comillas hola"},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := (Spoken{Formatting: true}).Apply(tt.in); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSpokenChoice(t *testing.T) {
	const in = "one comma two new line three"
	tests := []struct {
		name   string
		spoken Spoken
		want   string
	}{
		{"neither", Spoken{}, in},
		{"symbols", Spoken{Symbols: true}, "one, two new line three"},
		{"formatting", Spoken{Formatting: true}, "one comma two\nthree"},
		{"both", Spoken{Symbols: true, Formatting: true}, "one, two\nthree"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.spoken.Apply(in); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
	// A symbol at a line's end keeps its break, with no space between them.
	if got := (Spoken{Symbols: true, Formatting: true}).Apply("one comma new line two"); got != "one,\ntwo" {
		t.Errorf("got %q", got)
	}
}
