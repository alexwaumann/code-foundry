package command_test

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// thread.snooze.default (cmd+shift+s) is thread.snooze given the default preset: the setting
// threads.default_snooze reaches it as its to arg's default (Overrides.ArgDefaults), and it
// asks what thread.snooze asks: nothing, a snooze cuts nothing off
// (docs/notes/snooze-without-teardown.md).
func TestThreadSnoozeDefault(t *testing.T) {
	a := idle("s-aaaa11112222", "one")
	busy := &v1.Thread{Id: "s-cccc55556666", Name: "three", State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_BUSY}
	inView := func(id string) command.Context { return command.Context{ActiveView: "thread", ActiveThreadID: id} }
	now := time.Now()
	tomorrow := time.Date(now.Year(), now.Month(), now.Day()+1, 9, 0, 0, 0, time.Local)
	tests := []struct {
		name      string
		ctx       command.Context
		setting   string // threads.default_snooze, "" for none set
		args      map[string]string
		confirmed bool
		wantAsk   string
		wantErr   error
		wantSave  bool
		wantUntil func(time.Time) bool
	}{
		{name: "without a setting: tomorrow at 9:00 AM", ctx: inView("s-aaaa11112222"),
			wantUntil: func(u time.Time) bool { return u.Equal(tomorrow) }},
		{name: "the setting's preset", ctx: inView("s-aaaa11112222"), setting: "3h",
			wantUntil: func(u time.Time) bool { d := time.Until(u); return d > 179*time.Minute && d <= 3*time.Hour }},
		{name: "save for later", ctx: inView("s-aaaa11112222"), setting: "save", wantSave: true},
		{name: "a setting the arg does not take falls back to tomorrow", ctx: inView("s-aaaa11112222"), setting: "soon",
			wantUntil: func(u time.Time) bool { return u.Equal(tomorrow) }},
		{name: "to given wins over the setting", ctx: inView("s-aaaa11112222"), setting: "save", args: map[string]string{"to": "1h"},
			wantUntil: func(u time.Time) bool { return time.Until(u) <= time.Hour && time.Until(u) > 59*time.Minute }},
		{name: "a busy thread snoozes without asking, as thread.snooze does", ctx: inView("s-cccc55556666"),
			wantUntil: func(u time.Time) bool { return u.Equal(tomorrow) }},
		{name: "a busy thread saves without asking", ctx: inView("s-cccc55556666"), setting: "save", wantSave: true},
		{name: "from the CLI with an id", args: map[string]string{"id": "11112222"}, wantUntil: func(u time.Time) bool { return u.Equal(tomorrow) }},
		{name: "a to it does not know", ctx: inView("s-aaaa11112222"), args: map[string]string{"to": "soon"}, wantErr: command.ErrInvalidArgs},
		{name: "no thread in a window", ctx: command.Context{ActiveView: "pullrequests"}, wantErr: command.ErrUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newBulkRegistry(t, a, busy)
			if tt.setting != "" {
				reg.SetOverrides(command.Overrides{ArgDefaults: map[string]map[string]string{"thread.snooze.default": {"to": tt.setting}}})
			}
			_, err := reg.Invoke(context.Background(), tt.ctx, "thread.snooze.default", tt.args, command.Confirmed(tt.confirmed))
			var ce *command.ConfirmError
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			case tt.wantAsk != "":
				if !errors.As(err, &ce) || ce.Message != tt.wantAsk {
					t.Fatalf("err = %v, want the confirmation %q", err, tt.wantAsk)
				}
				return
			case err != nil:
				t.Fatal(err)
			}
			var reqs []*v1.SnoozeThreadRequest
			for _, r := range fake.Requests() {
				if r, ok := r.(*v1.SnoozeThreadRequest); ok {
					reqs = append(reqs, r)
				}
			}
			if len(reqs) != 1 {
				t.Fatalf("snooze requests = %v, want one", reqs)
			}
			r := reqs[0]
			if r.GetSave() != tt.wantSave {
				t.Errorf("save = %v, want %v", r.GetSave(), tt.wantSave)
			}
			if tt.wantUntil != nil && (r.GetUntil() == nil || !tt.wantUntil(r.GetUntil().AsTime())) {
				t.Errorf("until = %v", r.GetUntil().AsTime().Local())
			}
		})
	}
}

func TestThreadSnoozeDefaultSpec(t *testing.T) {
	reg, _ := newBulkRegistry(t)
	c, ok := reg.Get("thread.snooze.default")
	if !ok {
		t.Fatal("no thread.snooze.default")
	}
	if c.Title != "Snooze to Default" || !slices.Equal(c.Keybindings, []string{"cmd+shift+s"}) || !c.KeybindingsYield || !c.NoIndex {
		t.Errorf("thread.snooze.default = %+v", c)
	}
	if i := slices.IndexFunc(c.Args, func(a command.ArgSpec) bool { return a.Name == "to" }); i < 0 || !slices.Equal(c.Args[i].Enum, command.SnoozeDefaults) || c.Args[i].Default != "tomorrow" {
		t.Errorf("to = %+v", c.Args)
	}
}
