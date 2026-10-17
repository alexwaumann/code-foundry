package thread

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCleanRequestID(t *testing.T) {
	tests := []struct {
		in, want string
		bad      bool
	}{
		{in: "", want: ""},
		{in: "  k1 ", want: "k1"},
		{in: strings.Repeat("é", MaxRequestIDLen), want: strings.Repeat("é", MaxRequestIDLen)},
		{in: strings.Repeat("a", MaxRequestIDLen+1), bad: true},
		{in: "a\nb", bad: true},
	}
	for _, tt := range tests {
		got, err := CleanRequestID(tt.in)
		if tt.bad != errors.Is(err, ErrInvalidArgument) || got != tt.want {
			t.Errorf("CleanRequestID(%q) = %q, %v", tt.in, got, err)
		}
	}
}

func TestCreateOnce(t *testing.T) {
	var now atomic.Pointer[time.Time]
	t0 := time.Now()
	now.Store(&t0)
	e := newEnv(t, func(o *Options) { o.Now = func() time.Time { return *now.Load() } })
	count := func() int { return len(e.m.Snapshot().Threads) }
	once := func(key string, o CreateOptions) (Thread, bool) {
		t.Helper()
		if o.WorktreePath == "" {
			o.WorktreePath = e.wt
		}
		s, reused, err := e.m.CreateOnce(e.ctx(), key, o)
		if err != nil {
			t.Fatal(err)
		}
		return s, reused
	}
	first, reused := once("k1", CreateOptions{Name: "first"})
	if reused {
		t.Fatal("the first create was reused")
	}
	again, reused := once("k1", CreateOptions{Name: "second"})
	if !reused || again.ID != first.ID || again.Name != "first" || count() != 1 {
		t.Fatalf("repeat = %s %q reused %v, %d threads", again.ID, again.Name, reused, count())
	}
	if _, reused := once(" k1 ", CreateOptions{}); !reused {
		t.Error("the key with spaces around it was not the same key")
	}
	if _, reused := once("k2", CreateOptions{}); reused || count() != 2 {
		t.Errorf("another key: reused %v, %d threads", reused, count())
	}
	if _, reused := once("k1", CreateOptions{CreatedBy: first.ID}); reused || count() != 3 {
		t.Errorf("the same key of another creator: reused %v, %d threads", reused, count())
	}
	if _, reused := once("", CreateOptions{}); reused || count() != 4 {
		t.Errorf("no key: reused %v, %d threads", reused, count())
	}
	if _, _, err := e.m.CreateOnce(e.ctx(), strings.Repeat("a", 200), CreateOptions{WorktreePath: e.wt}); !errors.Is(err, ErrInvalidArgument) || count() != 4 {
		t.Errorf("a long key: %v, %d threads", err, count())
	}

	// Kept across a restart; forgotten after a day.
	e.restart(func(o *Options) { o.Now = func() time.Time { return *now.Load() } })
	if s, reused := once("k1", CreateOptions{}); !reused || s.ID != first.ID {
		t.Errorf("after a restart: %s reused %v", s.ID, reused)
	}
	later := t0.Add(RequestIDTTL + time.Minute)
	now.Store(&later)
	if s, reused := once("k1", CreateOptions{}); reused || s.ID == first.ID {
		t.Errorf("after a day: %s reused %v", s.ID, reused)
	}
	n := count()
	if _, reused := once("k1", CreateOptions{}); !reused || count() != n {
		t.Errorf("the renewed key: reused %v, %d threads (want %d)", reused, count(), n)
	}

	// A removed thread forgets its key.
	s, _ := once("k3", CreateOptions{})
	if err := e.m.Remove(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if s2, reused := once("k3", CreateOptions{}); reused || s2.ID == s.ID {
		t.Errorf("after remove: %s reused %v", s2.ID, reused)
	}
}

// Two creates with one key at once make one thread: the second waits for the first.
func TestCreateOnceConcurrent(t *testing.T) {
	e := newEnv(t)
	var wg sync.WaitGroup
	ids := make([]string, 4)
	reused := make([]bool, 4)
	for i := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s, r, err := e.m.CreateOnce(e.ctx(), "same", CreateOptions{WorktreePath: e.wt})
			if err != nil {
				t.Error(err)
			}
			ids[i], reused[i] = s.ID, r
		}()
	}
	wg.Wait()
	made := 0
	for i, id := range ids {
		if id != ids[0] {
			t.Errorf("ids = %v", ids)
		}
		if !reused[i] {
			made++
		}
	}
	if made != 1 || len(e.m.Snapshot().Threads) != 1 {
		t.Errorf("%d creates made a thread, %d threads", made, len(e.m.Snapshot().Threads))
	}
}
