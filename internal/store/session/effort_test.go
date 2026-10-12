package session

import (
	"encoding/json"
	"errors"
	"os"
	"slices"
	"testing"
	"time"
)

// argvOf is the fake claude's latest argv (each spawn overwrites it).
func (re *renderedEnv) argvOf() []string {
	var argv []string
	if b, err := os.ReadFile(re.argv); err == nil {
		_ = json.Unmarshal(b, &argv)
	}
	return argv
}

// waitArgv waits until the latest spawn's argv satisfies cond.
func (re *renderedEnv) waitArgv(what string, cond func([]string) bool) []string {
	re.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		argv := re.argvOf()
		if cond(argv) {
			return argv
		}
		if time.Now().After(deadline) {
			re.t.Fatalf("timed out waiting for %s; argv %q", what, argv)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func hasEffortNote(effort string) func([]Item) bool {
	return func(items []Item) bool {
		return slices.ContainsFunc(items, func(it Item) bool { return it.Kind == KindCommandOutput && it.Text == "Set effort to "+effort })
	}
}

// An idle thread restarts at once: the new process resumes the conversation with the
// new effort and keeps the rest of the launch; a send during the restart waits for it.
func TestRenderedSetEffortIdleRestarts(t *testing.T) {
	re := newRenderedEnv(t, "text-table")
	s := re.create(CreateOptions{Model: "haiku", Effort: "low", PermissionMode: PermissionSupervised})
	re.waitFor(s.ID, "idle", func(s Session) bool { return s.Status == StatusIdle })
	first := re.argvOf()
	cid := argOf(first, "--session-id")
	if argOf(first, "--effort") != "low" || cid == "" {
		t.Fatalf("first argv %q", first)
	}
	re.writeTranscript(cid, userLine("earlier"))

	got, err := re.m.SetEffort(re.ctx(), s.ID, "high")
	if err != nil || got.Effort != "high" || !got.EffortPending {
		t.Fatalf("set effort %+v %v", got, err)
	}
	// Sent while the restart runs: held, then sent to the new process.
	it, err := re.m.Send(re.ctx(), s.ID, Message{Text: "hello again"})
	if err != nil || it.Kind != KindUserMessage {
		t.Fatalf("send during the restart: %+v %v", it, err)
	}
	argv := re.waitArgv("the restart", func(a []string) bool { return argOf(a, "--effort") == "high" })
	if argOf(argv, "--resume") != cid || slices.Contains(argv, "--session-id") || argOf(argv, "--model") != "haiku" ||
		argOf(argv, "--permission-mode") != "manual" || !slices.Contains(argv, "--include-partial-messages") {
		t.Errorf("restart argv %q", argv)
	}
	items := re.waitItems(s.ID, "the effort note and the turn", func(items []Item) bool {
		return hasEffortNote("high")(items) && hasTurnEnd(items)
	})
	note := slices.IndexFunc(items, func(it Item) bool { return it.Kind == KindCommandOutput })
	msg := slices.IndexFunc(items, func(it Item) bool { return it.Kind == KindUserMessage })
	if note < 0 || msg < note {
		t.Errorf("the note should come before the held message:\n%s", describeItems(items))
	}
	got = re.waitFor(s.ID, "applied", func(s Session) bool { return !s.EffortPending && s.Status == StatusIdle })
	if got.State != StateConnected || got.Effort != "high" {
		t.Errorf("after the restart %+v", got)
	}
	// The row keeps the effort for later spawns.
	if err := re.m.Close(re.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := re.m.Get(re.ctx(), s.ID); got.Effort != "high" || got.EffortPending || got.DisconnectReason != ReasonClosed {
		t.Errorf("closed %+v", got)
	}
}

// A busy thread keeps its process until the turn ends; then it restarts.
func TestRenderedSetEffortWaitsForTheTurn(t *testing.T) {
	re := newRenderedEnv(t, "write-allow")
	s := re.create(CreateOptions{Effort: "low", PermissionMode: PermissionSupervised, InitialPrompt: "write"})
	re.waitFor(s.ID, "permission", func(s Session) bool { return s.Status == StatusNeedsAttention })
	got, err := re.m.SetEffort(re.ctx(), s.ID, "max")
	if err != nil || !got.EffortPending || got.Effort != "max" {
		t.Fatalf("set effort %+v %v", got, err)
	}
	time.Sleep(50 * time.Millisecond)
	if e := argOf(re.argvOf(), "--effort"); e != "low" {
		t.Fatalf("restarted mid-turn: effort %q", e)
	}
	// Changing it back while busy cancels the change.
	if got, _ = re.m.SetEffort(re.ctx(), s.ID, "low"); got.EffortPending {
		t.Errorf("back to the running effort is still pending")
	}
	if got, _ = re.m.SetEffort(re.ctx(), s.ID, "max"); !got.EffortPending {
		t.Errorf("pending lost")
	}
	p := re.items(s.ID).Pending
	if _, err := re.m.Respond(re.ctx(), s.ID, p[0].RequestID, Decision{Allow: true}); err != nil {
		t.Fatal(err)
	}
	re.waitArgv("the restart after the turn", func(a []string) bool { return argOf(a, "--effort") == "max" })
	re.waitItems(s.ID, "the effort note", hasEffortNote("max"))
	re.waitFor(s.ID, "applied", func(s Session) bool { return !s.EffortPending && s.State == StateConnected })
}

func TestRenderedSetEffortRefusals(t *testing.T) {
	re := newRenderedEnv(t, "text-table")
	s := re.create(CreateOptions{})
	re.waitFor(s.ID, "idle", func(s Session) bool { return s.Status == StatusIdle })
	if _, err := re.m.SetEffort(re.ctx(), s.ID, "huge"); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("bad effort: %v", err)
	}
	term := re.create(CreateOptions{Render: RenderTerminal})
	if _, err := re.m.SetEffort(re.ctx(), term.ID, "high"); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("terminal thread: %v", err)
	}
	if err := re.m.Close(re.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := re.m.SetEffort(re.ctx(), s.ID, "high"); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("disconnected thread: %v", err)
	}
}

func TestDenyMessage(t *testing.T) {
	tests := []struct {
		kind   ItemKind
		reason string
		want   string
	}{
		{KindPermission, "", rejectStop},
		{KindPermission, "  use the staging branch ", rejectWithReason + "use the staging branch"},
		{KindQuestion, "", "The user declined to answer the questions."},
		{KindQuestion, "ask me later", "The user declined to answer the questions. They said:\nask me later"},
	}
	for _, tt := range tests {
		if got := denyMessage(tt.kind, tt.reason); got != tt.want {
			t.Errorf("denyMessage(%s, %q) = %q, want %q", tt.kind, tt.reason, got, tt.want)
		}
	}
}

// A mode change Claude reports (allow for session applying a setMode suggestion) is
// recorded on the row; modes the app does not offer are ignored.
func TestRenderedFollowsClaudesModeChange(t *testing.T) {
	re := newRenderedEnv(t, "text-table")
	s := re.create(CreateOptions{PermissionMode: PermissionSupervised})
	re.waitFor(s.ID, "idle", func(s Session) bool { return s.Status == StatusIdle })
	re.m.mu.Lock()
	r := re.m.recs[s.ID].run
	re.m.mu.Unlock()
	r.onModeChange("acceptEdits")
	if got, _ := re.m.Get(re.ctx(), s.ID); got.PermissionMode != PermissionAcceptEdits {
		t.Fatalf("mode %v", got.PermissionMode)
	}
	r.onModeChange("plan")
	r.onModeChange("")
	if got, _ := re.m.Get(re.ctx(), s.ID); got.PermissionMode != PermissionAcceptEdits {
		t.Errorf("mode after unknown wire modes %v", got.PermissionMode)
	}
}
