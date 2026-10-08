package bus

import (
	"sync"
	"testing"
)

type evA struct{ N int }
type evB struct{ S string }

func TestRoutesByType(t *testing.T) {
	b := New()
	a := Subscribe[evA](b, 4)
	defer a.Close()
	bs := Subscribe[evB](b, 4)
	defer bs.Close()

	if got := Publish(b, evA{N: 1}); got != 1 {
		t.Fatalf("Publish evA delivered to %d, want 1", got)
	}
	if got := Publish(b, evB{S: "x"}); got != 1 {
		t.Fatalf("Publish evB delivered to %d, want 1", got)
	}
	if ev := <-a.C(); ev.N != 1 {
		t.Fatalf("a got %+v", ev)
	}
	if ev := <-bs.C(); ev.S != "x" {
		t.Fatalf("b got %+v", ev)
	}
	select {
	case ev := <-a.C():
		t.Fatalf("a got unexpected %+v", ev)
	default:
	}
}

func TestFanOut(t *testing.T) {
	b := New()
	subs := []*Subscription[evA]{Subscribe[evA](b, 1), Subscribe[evA](b, 1), Subscribe[evA](b, 1)}
	if got := Publish(b, evA{N: 7}); got != len(subs) {
		t.Fatalf("delivered %d, want %d", got, len(subs))
	}
	for i, s := range subs {
		if ev := <-s.C(); ev.N != 7 {
			t.Fatalf("sub %d got %+v", i, ev)
		}
		s.Close()
	}
}

func TestNoSubscribers(t *testing.T) {
	b := New()
	if got := Publish(b, evA{}); got != 0 {
		t.Fatalf("delivered %d, want 0", got)
	}
	if b.Dropped() != 0 {
		t.Fatalf("Dropped() = %d, want 0", b.Dropped())
	}
}

func TestSlowSubscriberDropsWithoutBlocking(t *testing.T) {
	tests := []struct {
		name      string
		buf       int
		publish   int
		wantDrops uint64
	}{
		{"fits", 4, 4, 0},
		{"overflow by one", 4, 5, 1},
		{"overflow many", 2, 10, 8},
		{"default buffer", 0, DefaultBuffer + 3, 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := New()
			slow := Subscribe[evA](b, tt.buf)
			defer slow.Close()
			fast := Subscribe[evA](b, tt.publish)
			defer fast.Close()
			for i := range tt.publish {
				Publish(b, evA{N: i})
			}
			if got := slow.Dropped(); got != tt.wantDrops {
				t.Errorf("slow.Dropped() = %d, want %d", got, tt.wantDrops)
			}
			if got := fast.Dropped(); got != 0 {
				t.Errorf("fast.Dropped() = %d, want 0", got)
			}
			if got := b.Dropped(); got != tt.wantDrops {
				t.Errorf("bus.Dropped() = %d, want %d", got, tt.wantDrops)
			}
			// The slow subscriber keeps the oldest events, in order.
			if ev := <-slow.C(); ev.N != 0 {
				t.Errorf("first event = %d, want 0", ev.N)
			}
		})
	}
}

func TestCloseIsIdempotentAndUnsubscribes(t *testing.T) {
	b := New()
	s := Subscribe[evA](b, 1)
	s.Close()
	s.Close()
	if _, ok := <-s.C(); ok {
		t.Fatal("channel not closed")
	}
	if got := Publish(b, evA{}); got != 0 {
		t.Fatalf("delivered %d after Close, want 0", got)
	}
	if b.Dropped() != 0 {
		t.Fatalf("closed subscriber counted a drop")
	}
}

func TestConcurrentPublishAndClose(t *testing.T) {
	b := New()
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for i := range 1000 {
				Publish(b, evA{N: i})
			}
		})
	}
	for range 8 {
		wg.Go(func() {
			for range 100 {
				s := Subscribe[evA](b, 2)
				s.Close()
			}
		})
	}
	wg.Wait()
}
