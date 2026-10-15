package main

import (
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
)

// After an update the CLI names what a restart would cut off (command.RestartCost: turns,
// prompts, background work); idle and stopped threads start again with their next
// message.
func TestActiveThreads(t *testing.T) {
	tests := []struct {
		c    command.RestartCost
		want string
	}{
		{command.RestartCost{}, "nothing running"},
		{command.RestartCost{Threads: 1, MidTurn: 1}, "restarting cuts off 1 thread working or waiting on you"},
		{command.RestartCost{Threads: 2, MidTurn: 1, Shells: 1}, "restarting cuts off 1 thread working or waiting on you and 1 background shell"},
	}
	for _, tt := range tests {
		if got := activeThreads(tt.c); got != tt.want {
			t.Errorf("activeThreads(%+v) = %q, want %q", tt.c, got, tt.want)
		}
	}
}
