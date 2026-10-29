package dictate

import "testing"

func TestCleanPhrase(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"Let's add a retry to the fetch step.", "Let's add a retry to the fetch step."},
		{"  spaced   out  ", "spaced out"},
		// Silence hallucinations, whole phrase only.
		{"Thank you.", ""},
		{" Thanks for watching!", ""},
		{"THANK YOU VERY MUCH.", ""},
		{"you", ""},
		{"Bye.", ""},
		{"Thank you, that fixed it.", "Thank you, that fixed it."},
		{"Tell them thanks for watching the build.", "Tell them thanks for watching the build."},
		// Subtitle credits anywhere.
		{"Subtitles by the Amara.org community", ""},
		{"Transcribed by ESO, translated by —", ""},
		// Non-speech annotations.
		{"[BLANK_AUDIO]", ""},
		{"[Music] ♪ ♪", ""},
		{"(music)", ""},
		{"*laughs*", ""},
		{"[Music] Rename the store.", "Rename the store."},
		{"...", ""},
		// Loops collapse to one copy (the last, with its punctuation).
		{"and then and then and then and then.", "and then."},
		{"I think, I think, I think we should ship it.", "I think we should ship it."},
		{"no no no", "no no no"},
		{"very very very very good", "very good"},
		{"Thank you. Thank you. Thank you. Thank you.", ""},
		{"the the cat", "the the cat"},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := CleanPhrase(tt.in); got != tt.want {
				t.Fatalf("CleanPhrase(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestHallucinationListIsNormalized(t *testing.T) {
	for _, s := range silenceHallucinations {
		if normalize(s) != s {
			t.Errorf("%q normalizes to %q: write the entry normalized", s, normalize(s))
		}
	}
}

func TestPromptTail(t *testing.T) {
	tests := []struct {
		in    string
		limit int
		want  string
	}{
		{"short", 200, "short"},
		{"one two three four", 10, "four"},
		{"one two three four", 11, "three four"},
		{"averyveryverylongword", 5, "gword"},
		{"  padded  ", 200, "padded"},
	}
	for _, tt := range tests {
		if got := promptTail(tt.in, tt.limit); got != tt.want {
			t.Errorf("promptTail(%q, %d) = %q, want %q", tt.in, tt.limit, got, tt.want)
		}
	}
}
