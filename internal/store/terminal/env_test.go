package terminal

import (
	"errors"
	"testing"
	"time"
)

func TestLookPath(t *testing.T) {
	exists := map[string]bool{"/usr/bin/git": true, "/opt/bin/claude": true, "/usr/bin/claude": true}
	isExec := func(p string) bool { return exists[p] }
	tests := []struct {
		name    string
		prog    string
		env     []string
		want    string
		wantErr bool
	}{
		{"absolute", "/bin/zsh", nil, "/bin/zsh", false},
		{"relative with slash", "./run.sh", nil, "./run.sh", false},
		{"found in PATH", "git", []string{"PATH=/bin:/usr/bin"}, "/usr/bin/git", false},
		{"first PATH match wins", "claude", []string{"PATH=/opt/bin:/usr/bin"}, "/opt/bin/claude", false},
		{"last PATH entry in env wins", "claude", []string{"PATH=/nowhere", "PATH=/usr/bin"}, "/usr/bin/claude", false},
		{"missing", "nope", []string{"PATH=/usr/bin"}, "", true},
		{"no PATH", "git", nil, "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := lookPath(tt.prog, tt.env, isExec)
			if (err != nil) != tt.wantErr || got != tt.want {
				t.Fatalf("lookPath = %q, %v; want %q, err=%v", got, err, tt.want, tt.wantErr)
			}
			if err != nil && !errors.Is(err, ErrInvalidSpec) {
				t.Errorf("err %v is not ErrInvalidSpec", err)
			}
		})
	}
}

func TestThrottle(t *testing.T) {
	t0 := time.Unix(100, 0)
	ms := time.Millisecond
	type step struct {
		at       time.Duration // since t0; negative means "trailing timer fired at -at"
		wantNow  bool
		wantWait time.Duration
	}
	tests := []struct {
		name  string
		steps []step
	}{
		{"first change publishes", []step{{0, true, 0}}},
		{"burst waits for remainder", []step{{0, true, 0}, {10 * ms, false, 40 * ms}, {30 * ms, false, 20 * ms}}},
		{"after interval publishes again", []step{{0, true, 0}, {50 * ms, true, 0}, {120 * ms, true, 0}}},
		{"trailing fire resets window", []step{{0, true, 0}, {10 * ms, false, 40 * ms}, {-50 * ms, false, 0}, {60 * ms, false, 40 * ms}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			th := throttle{interval: 50 * ms}
			for i, s := range tt.steps {
				if s.at < 0 {
					th.fired(t0.Add(-s.at))
					continue
				}
				now, wait := th.next(t0.Add(s.at))
				if now != s.wantNow || wait != s.wantWait {
					t.Fatalf("step %d at %v: next = (%v, %v), want (%v, %v)", i, s.at, now, wait, s.wantNow, s.wantWait)
				}
			}
		})
	}
}
