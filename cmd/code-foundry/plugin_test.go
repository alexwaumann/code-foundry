package main

import (
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Only a follower's own flag follows: plugin dev --watch is the daemon's watch, and
// plugin surface --watch streams the surface.
func TestWantsFollow(t *testing.T) {
	flag := func(name, value string) *argFlag {
		return &argFlag{spec: &v1.ArgSpec{Name: name}, value: value, set: true}
	}
	tests := []struct {
		name        string
		cmd         string
		flags       []*argFlag
		interactive bool
		want        bool
	}{
		{"dev --watch from an agent", "plugin.dev", []*argFlag{flag("watch", "true")}, false, false},
		{"dev --watch --follow=false on a terminal", "plugin.dev", []*argFlag{flag("watch", "true"), flag("follow", "false")}, true, false},
		{"dev --watch on a terminal", "plugin.dev", []*argFlag{flag("watch", "true")}, true, true},
		{"dev --follow", "plugin.dev", []*argFlag{flag("follow", "true")}, false, true},
		{"logs --follow", "plugin.logs", []*argFlag{flag("follow", "true")}, false, true},
		{"surface --watch", "plugin.surface", []*argFlag{flag("watch", "true")}, false, true},
		{"surface --watch=false", "plugin.surface", []*argFlag{flag("watch", "false")}, true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cl := &cli{interactive: func() bool { return tt.interactive }}
			if got := cl.wantsFollow(cliFollowers[tt.cmd], tt.flags); got != tt.want {
				t.Errorf("wantsFollow = %v, want %v", got, tt.want)
			}
		})
	}
}
