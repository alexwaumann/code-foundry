package thread

import (
	"errors"
	"strings"
	"testing"
)

// CreateOptions.SystemPromptAppend is the thread's own append from its first spawn on
// (theme.ask's context): after ThreadPrompt, kept on the row, and out of the first message.
func TestCreateSystemPromptAppend(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{SystemPromptAppend: "The user asked on the Themes page.", InitialPrompt: "a warm dark theme"})
	if got, want := argOf(e.spec(s.ID).Argv, "--append-system-prompt"), ThreadPrompt+"\n\nThe user asked on the Themes page."; got != want {
		t.Errorf("prompt = %q\nwant %q", got, want)
	}
	got, err := e.m.Get(e.ctx(), s.ID)
	if err != nil || got.SystemPromptAppend != "The user asked on the Themes page." {
		t.Errorf("thread append = %q, %v", got.SystemPromptAppend, err)
	}
	if strings.Contains(got.Name, "Themes page") {
		t.Errorf("name %q has the context", got.Name)
	}
	for _, bad := range []string{"a\x00b", strings.Repeat("a", maxSystemPromptAppend+1)} {
		if _, err := e.m.Create(e.ctx(), CreateOptions{SystemPromptAppend: bad}); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("append of %d bytes: err = %v", len(bad), err)
		}
	}
}
