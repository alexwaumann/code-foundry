package thread

import (
	"strings"
	"testing"
)

// Every thread's system prompt points at the skills the daemon ships; a workspace
// thread's adds its line. Static: claude caches the system prompt, so nothing per spawn
// may be in it.
func TestSystemPrompt(t *testing.T) {
	if got := systemPrompt(""); got != ThreadPrompt {
		t.Errorf("project thread: %q", got)
	}
	for _, want := range []string{"code-foundry-orchestrate", "code-foundry-help", "delegate work to other threads"} {
		if !strings.Contains(ThreadPrompt, want) {
			t.Errorf("ThreadPrompt does not name %q: %q", want, ThreadPrompt)
		}
	}
	ws := workspacePrompt("login")
	if got := systemPrompt(ws); got != ThreadPrompt+" "+ws {
		t.Errorf("workspace thread: %q", got)
	}
	if strings.ContainsAny(ThreadPrompt, "\n$`") {
		t.Errorf("ThreadPrompt is one static line: %q", ThreadPrompt)
	}
}
