package thread

import (
	"strings"
	"testing"
)

// Every thread's system prompt points at the guide; a workspace thread's adds its line.
// Static: claude caches the system prompt, so nothing per spawn may be in it.
func TestSystemPrompt(t *testing.T) {
	if got := systemPrompt(""); got != ThreadPrompt || !strings.Contains(got, "`code-foundry guide`") {
		t.Errorf("project thread: %q", got)
	}
	ws := workspacePrompt("login")
	if got := systemPrompt(ws); got != ThreadPrompt+" "+ws {
		t.Errorf("workspace thread: %q", got)
	}
	if strings.ContainsAny(ThreadPrompt, "\n$") {
		t.Errorf("ThreadPrompt is one static line: %q", ThreadPrompt)
	}
}
