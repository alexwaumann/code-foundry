package thread

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

func hasRestartNote(items []Item) bool {
	return slices.ContainsFunc(items, func(it Item) bool { return it.Kind == KindCommandOutput && it.Text == RestartNote })
}

// An idle thread restarts at once with the same conversation (--resume of its Claude
// session, the rest of the launch kept) and the current spawn extras; the timeline
// says so, and the effort is unchanged (no effort note).
func TestRestartIdle(t *testing.T) {
	re := newEnv(t)
	x := &scopedExtras{}
	x.set(extrasOf(hello("CF_HELLO=1")), SpawnExtras{})
	re.m.SetSpawnExtras(x.fn)
	s := re.create(CreateOptions{Model: "haiku", Effort: "low", PermissionMode: PermissionSupervised})
	re.waitFor(s.ID, "idle", func(s Thread) bool { return s.Status == StatusIdle })
	cid := argOf(re.argvOf(), "--session-id")
	re.writeTranscript(cid, userLine("earlier"))
	pid := re.pid(s.ID)
	x.set(SpawnExtras{}, SpawnExtras{})
	re.m.CheckSpawnExtras(re.ctx())
	if got, _ := re.m.Get(re.ctx(), s.ID); !got.PluginEnvStale {
		t.Fatal("not stale after the plugin went")
	}

	got, restarted, err := re.m.Restart(re.ctx(), s.ID)
	if err != nil || !restarted || got.ID != s.ID {
		t.Fatalf("restart %+v %v %v", got, restarted, err)
	}
	argv := re.waitArgv("the restart", func(a []string) bool { return argOf(a, "--resume") != "" })
	if argOf(argv, "--resume") != cid || slices.Contains(argv, "--session-id") || argOf(argv, "--model") != "haiku" ||
		argOf(argv, "--effort") != "low" || argOf(argv, "--permission-mode") != "manual" {
		t.Errorf("restart argv %q", argv)
	}
	items := re.waitItems(s.ID, "the restart note", hasRestartNote)
	if hasEffortNote("low")(items) {
		t.Errorf("an effort note without an effort change:\n%s", describeItems(items))
	}
	got = re.waitFor(s.ID, "restarted", func(s Thread) bool { return s.State == StateConnected && s.Status == StatusIdle })
	if got.PluginEnvStale || got.PluginEnvChange != "" {
		t.Errorf("still stale after the restart: %q", got.PluginEnvChange)
	}
	if re.pid(s.ID) == pid {
		t.Error("same process after the restart")
	}
	if _, ok := envValue(re.spec(s.ID).Env, "CF_HELLO"); ok {
		t.Error("the new process still has the removed variable")
	}
}

// A busy thread (here waiting on a permission request) is interrupted first, then
// restarted with the same conversation; a message sent meanwhile goes to the new
// process.
func TestRestartBusyInterrupts(t *testing.T) {
	re := newFixtureEnv(t, "interrupt-pending")
	s := re.create(CreateOptions{PermissionMode: PermissionSupervised, InitialPrompt: "write"})
	re.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })
	cid := argOf(re.argvOf(), "--session-id")
	re.writeTranscript(cid, userLine("write"))

	if _, restarted, err := re.m.Restart(re.ctx(), s.ID); err != nil || !restarted {
		t.Fatalf("restart: %v %v", restarted, err)
	}
	re.waitSent("interrupt", func(m map[string]any) bool {
		r, _ := m["request"].(map[string]any)
		return r["subtype"] == "interrupt"
	})
	if _, err := re.m.Send(re.ctx(), s.ID, Message{Text: "after the restart"}); err != nil {
		t.Fatalf("send during the restart: %v", err)
	}
	argv := re.waitArgv("the restart", func(a []string) bool { return argOf(a, "--resume") != "" })
	if argOf(argv, "--resume") != cid {
		t.Errorf("restart argv %q, want --resume %s", argv, cid)
	}
	items := re.waitItems(s.ID, "the request withdrawn and the restart note", func(items []Item) bool {
		return hasRestartNote(items) && slices.ContainsFunc(items, func(it Item) bool { return it.Request != nil && it.Request.State == RequestCancelled })
	})
	note := slices.IndexFunc(items, hasRestartNoteItem)
	msg := slices.IndexFunc(items, func(it Item) bool { return it.Kind == KindUserMessage && it.Text == "after the restart" })
	if note < 0 || msg < note {
		t.Errorf("the held message should follow the restart note:\n%s", describeItems(items))
	}
	re.waitFor(s.ID, "connected again", func(s Thread) bool { return s.State == StateConnected })
}

func hasRestartNoteItem(it Item) bool { return it.Kind == KindCommandOutput && it.Text == RestartNote }

// A thread whose Claude is not running is left as it is; an unknown one is NotFound.
func TestRestartNotRunning(t *testing.T) {
	re := newEnv(t)
	s := re.connected(CreateOptions{})
	if err := re.m.Close(re.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	argv := re.argvOf()
	got, restarted, err := re.m.Restart(re.ctx(), s.ID)
	if err != nil || restarted || got.State != StateDisconnected {
		t.Errorf("restart a stopped thread: %+v %v %v", got.State, restarted, err)
	}
	if !slices.Equal(re.argvOf(), argv) {
		t.Error("a stopped thread was started")
	}
	if _, _, err := re.m.Restart(re.ctx(), "s-nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown thread: %v", err)
	}
}

// A turn the interrupt does not end (this fake ignores it while a request is pending)
// does not hold the restart forever: after CloseTimeout it goes ahead, the open turn is
// closed and the new process resumes the conversation.
func TestRestartForcedAfterTimeout(t *testing.T) {
	re := newFixtureEnv(t, "write-allow", func(o *Options) { o.CloseTimeout = 300 * time.Millisecond })
	s := re.create(CreateOptions{PermissionMode: PermissionSupervised, InitialPrompt: "write"})
	re.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })
	cid := argOf(re.argvOf(), "--session-id")
	re.writeTranscript(cid, userLine("write"))
	if _, restarted, err := re.m.Restart(re.ctx(), s.ID); err != nil || !restarted {
		t.Fatalf("restart: %v %v", restarted, err)
	}
	re.waitArgv("the forced restart", func(a []string) bool { return argOf(a, "--resume") == cid })
	re.waitItems(s.ID, "the restart note", hasRestartNote)
	// Nothing is pending or running any more.
	re.waitFor(s.ID, "connected, nothing pending", func(s Thread) bool {
		return s.State == StateConnected && s.Status != StatusBusy && !strings.HasPrefix(s.StatusReason, "permission:")
	})
}
