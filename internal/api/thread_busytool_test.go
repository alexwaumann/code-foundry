package api

import (
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestThreadToProtoBusyTool(t *testing.T) {
	tests := []struct {
		name string
		in   thread.Thread
		want string
	}{
		{"running tool", thread.Thread{ID: "s1", Status: thread.StatusBusy, BusyTool: "Bash make check"}, "Bash make check"},
		{"none", thread.Thread{ID: "s1", Status: thread.StatusIdle}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := threadToProto(tt.in).GetBusyTool(); got != tt.want {
				t.Errorf("busy_tool %q, want %q", got, tt.want)
			}
		})
	}
}
