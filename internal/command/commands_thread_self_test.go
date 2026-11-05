package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// A thread putting itself away mid-turn (docs/notes/self-put-away.md): asked nothing, told
// it waits, and the daemon told who asks. Every other caller is as before.
func TestThreadPutsItselfAway(t *testing.T) {
	connected := v1.ThreadState_THREAD_STATE_CONNECTED
	busy := &v1.Thread{Name: "drv", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_BUSY, StatusReason: "working"}
	asking := &v1.Thread{Name: "drv", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, StatusReason: "permission: Bash ls"}
	background := &v1.Thread{Name: "drv", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_IDLE, BackgroundShellsRunning: 1}
	self := command.Context{ActiveThreadID: "s5"}
	other := command.Context{ActiveThreadID: "s9"}
	gui := command.Context{ActiveThreadID: "s5", ActiveView: "thread"}
	archive := map[string]string{"id": "s5", "archived": "true"}
	save := map[string]string{"id": "s5", "save": "true"}
	snooze := map[string]string{"id": "s5", "until": "2099-01-02T15:04:00Z"}

	tests := []struct {
		name    string
		verb    string
		ctx     command.Context
		args    map[string]string
		current *v1.Thread
		cascade []*v1.Thread
		wantAsk string // a part of the confirmation; "" when it ran
		wantMsg string // a part of the message
		wantBy  string
		wantDo  string // the --json action of a deferred one
	}{
		{name: "archive mid-turn", verb: "thread.archive", ctx: self, args: archive, current: busy,
			wantMsg: "will archive thread drv (s5) when this turn ends", wantBy: "s5", wantDo: "archive"},
		{name: "archive at a prompt of its own", verb: "thread.archive", ctx: self, args: archive, current: asking,
			wantMsg: "will archive thread drv (s5) when this turn ends", wantBy: "s5", wantDo: "archive"},
		{name: "snooze mid-turn", verb: "thread.snooze", ctx: self, args: snooze, current: busy,
			wantMsg: "will snooze thread drv (s5) until", wantBy: "s5", wantDo: "snooze"},
		{name: "snooze with the context's id mid-turn", verb: "thread.snooze", ctx: self, args: map[string]string{"until": "2099-01-02T15:04:00Z"}, current: busy,
			wantMsg: "when this turn ends", wantBy: "s5", wantDo: "snooze"},
		{name: "save mid-turn", verb: "thread.snooze", ctx: self, args: save, current: busy,
			wantMsg: "will save thread drv (s5) for later when this turn ends", wantBy: "s5", wantDo: "save"},
		// Deferring spares the thread its own turn, not the threads below it.
		{name: "archive still asks about hidden children working", verb: "thread.archive", ctx: self, args: archive, current: busy,
			cascade: []*v1.Thread{{Id: "s6", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_BUSY}},
			wantAsk: "1 hidden child thread is still working"},
		// Not mid-turn it is the plain call, and background work is cut off by it: it asks.
		{name: "archive after the turn asks about background work", verb: "thread.archive", ctx: self, args: archive, current: background,
			wantAsk: "background shell is running"},
		{name: "snooze after the turn asks about background work", verb: "thread.snooze", ctx: self, args: snooze, current: background,
			wantAsk: "background shell is running"},
		// Another thread's call cuts the turn off, and the GUI's: both still ask.
		{name: "another thread archiving asks", verb: "thread.archive", ctx: other, args: archive, current: busy, wantAsk: "archiving ends the turn"},
		{name: "another thread snoozing asks", verb: "thread.snooze", ctx: other, args: snooze, current: busy, wantAsk: "snoozing ends the turn"},
		{name: "the GUI archiving asks", verb: "thread.archive", ctx: gui, args: archive, current: busy, wantAsk: "archiving ends the turn"},
		{name: "the GUI snoozing asks", verb: "thread.snooze", ctx: gui, args: snooze, current: busy, wantAsk: "snoozing ends the turn"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current, b.Deferred, b.Cascade = tt.current, true, map[string][]*v1.Thread{"s5": tt.cascade}
			res, err := reg.Invoke(context.Background(), tt.ctx, tt.verb, tt.args)
			if tt.wantAsk != "" {
				var ce *command.ConfirmError
				if !errors.As(err, &ce) || !strings.Contains(ce.Message, tt.wantAsk) {
					t.Fatalf("err = %v, want a confirmation with %q", err, tt.wantAsk)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(res.Message, tt.wantMsg) {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			d, ok := res.JSON.(command.Deferred)
			if !ok || !d.Deferred || d.ID != "s5" || d.Action != tt.wantDo {
				t.Errorf("json = %+v, want deferred %s of s5", res.JSON, tt.wantDo)
			}
			if tt.wantDo == "snooze" && d.Until == "" {
				t.Errorf("json = %+v, want the wake time", d)
			}
			by := ""
			for _, m := range b.Requests() {
				switch r := m.(type) {
				case *v1.ArchiveThreadRequest:
					by = r.GetByThreadId()
				case *v1.SnoozeThreadRequest:
					by = r.GetByThreadId()
				}
			}
			if by != tt.wantBy {
				t.Errorf("by_thread_id = %q, want %q", by, tt.wantBy)
			}
		})
	}
}

// Who asks reaches the daemon only from the CLI: the GUI's context thread is the one in
// view, not a caller. A confirmed call from the GUI is the plain call.
func TestPutAwayByThread(t *testing.T) {
	tests := []struct {
		name string
		ctx  command.Context
		want string
	}{
		{"the thread itself", command.Context{ActiveThreadID: "s5"}, "s5"},
		{"another thread", command.Context{ActiveThreadID: "s9"}, "s9"},
		{"the GUI", command.Context{ActiveThreadID: "s5", ActiveView: "thread"}, ""},
		{"a terminal outside any thread", command.Context{}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			if _, err := reg.Invoke(context.Background(), tt.ctx, "thread.archive", map[string]string{"id": "s5", "archived": "true"}, command.Confirmed(true)); err != nil {
				t.Fatal(err)
			}
			for _, m := range b.Requests() {
				if r, ok := m.(*v1.ArchiveThreadRequest); ok && r.GetByThreadId() != tt.want {
					t.Errorf("by_thread_id = %q, want %q", r.GetByThreadId(), tt.want)
				}
			}
		})
	}
}

// Among ids, the thread's own archive is deferred like a lone one, and says so; the rest
// happen now. It takes no question of its own, the others' still count.
func TestThreadArchivesItselfAmongIDs(t *testing.T) {
	reg, b, _ := newLifecycleRegistry(t)
	b.Deferred = true
	b.Current = &v1.Thread{State: v1.ThreadState_THREAD_STATE_DISCONNECTED}
	res, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s5"}, "thread.archive", map[string]string{"ids": "s5,s6"}, command.Confirmed(true))
	if err != nil {
		t.Fatal(err)
	}
	out, ok := res.JSON.(command.ThreadsResult)
	if !ok || len(out.Done) != 2 || len(out.Deferred) != 1 || out.Deferred[0] != "s5" {
		t.Errorf("json = %+v", res.JSON)
	}
	if !strings.Contains(res.Message, "s5: when this turn ends") {
		t.Errorf("message = %q", res.Message)
	}
}
