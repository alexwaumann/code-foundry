package thread

import (
	"testing"
	"time"
)

// Viewed follows the thread's viewers (WatchItems), whatever presence says.
func TestViewed(t *testing.T) {
	e, _ := attendedEnv(t, false)
	s := e.create(CreateOptions{})
	if e.m.Viewed(s.ID) {
		t.Fatal("viewed before any viewer")
	}
	closeA := openViewer(t, e, s.ID)
	closeB := openViewer(t, e, s.ID)
	if !e.m.Viewed(s.ID) {
		t.Fatal("not viewed with two viewers")
	}
	closeA()
	time.Sleep(20 * time.Millisecond)
	if !e.m.Viewed(s.ID) {
		t.Fatal("not viewed with one viewer left")
	}
	closeB()
	deadline := time.Now().Add(5 * time.Second)
	for e.m.Viewed(s.ID) {
		if time.Now().After(deadline) {
			t.Fatal("still viewed after the last viewer left")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if e.m.Viewed("s-000000000000") {
		t.Error("an unknown thread is viewed")
	}
}
