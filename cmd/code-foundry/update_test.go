package main

import (
	"slices"
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

// Only a first install into the default home's app directory touches the shell setup;
// an update of an install, or an install into a scratch home, never re-points the link.
func TestInstallerShellArgs(t *testing.T) {
	const def = "/Users/u/.code-foundry/app"
	skip := []string{"--skip-link", "--skip-path"}
	tests := []struct {
		name           string
		appDir, target string
		want           []string
	}{
		{"dev CLI, default home", "", def, nil},
		{"dev CLI, default home, trailing slash", "", def + "/", nil},
		{"dev CLI, CODE_FOUNDRY_HOME elsewhere", "", "/tmp/x/app", skip},
		{"dev CLI, CODE_FOUNDRY_APP_DIR elsewhere", "", "/Users/u/apps/cf", skip},
		{"installed CLI, default install", def, def, skip},
		{"installed CLI, side install", "/tmp/x/app", "/tmp/x/app", skip},
	}
	for _, tt := range tests {
		if got := installerShellArgs(tt.appDir, tt.target, def); !slices.Equal(got, tt.want) {
			t.Errorf("%s: %v, want %v", tt.name, got, tt.want)
		}
	}
}
