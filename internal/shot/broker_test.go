package shot

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// png is a PNG's signature and a little body: the broker checks the signature only.
func png(n int) []byte { return append(bytes.Clone(pngMagic), make([]byte, n)...) }

// next is the capturer's next request, or a failure after a second.
func next(t *testing.T, reqs <-chan *v1.ShotRequest) *v1.ShotRequest {
	t.Helper()
	select {
	case r := <-reqs:
		return r
	case <-time.After(time.Second):
		t.Fatal("no request reached the capturer")
		return nil
	}
}

func TestShoot(t *testing.T) {
	tests := []struct {
		name string
		// capture plays the capturer: it gets the broker, its requests and its disconnect.
		capture func(t *testing.T, b *Broker, reqs <-chan *v1.ShotRequest, disconnect func())
		noCap   bool
		want    Result
		wantErr error
	}{
		{name: "no capturer", noCap: true, wantErr: ErrNoCapturer},
		{name: "the PNG comes back with the content height", capture: func(t *testing.T, b *Broker, reqs <-chan *v1.ShotRequest, _ func()) {
			r := next(t, reqs)
			if r.GetWidth() != 420 || r.GetInstance() != "hello/main/global" || r.GetId() == "" {
				t.Errorf("request %v", r)
			}
			if err := b.Publish(r.GetId(), png(4), "", 1640); err != nil {
				t.Errorf("publish: %v", err)
			}
		}, want: Result{PNG: png(4), ContentHeight: 1640}},
		{name: "the app's reason", capture: func(t *testing.T, b *Broker, reqs <-chan *v1.ShotRequest, _ func()) {
			if err := b.Publish(next(t, reqs).GetId(), nil, "the surface sent no view", 0); err != nil {
				t.Errorf("publish: %v", err)
			}
		}, wantErr: &CaptureError{Reason: "the surface sent no view"}},
		{name: "timeout", capture: func(t *testing.T, _ *Broker, reqs <-chan *v1.ShotRequest, _ func()) { next(t, reqs) }, wantErr: ErrTimeout},
		{name: "oversize PNG fails the publish and the shot", capture: func(t *testing.T, b *Broker, reqs <-chan *v1.ShotRequest, _ func()) {
			if err := b.Publish(next(t, reqs).GetId(), png(2000), "", 10); !errors.Is(err, ErrTooLarge) {
				t.Errorf("publish: %v, want ErrTooLarge", err)
			}
		}, wantErr: ErrTooLarge},
		{name: "not a PNG", capture: func(t *testing.T, b *Broker, reqs <-chan *v1.ShotRequest, _ func()) {
			if err := b.Publish(next(t, reqs).GetId(), []byte("GIF89a"), "", 10); !errors.Is(err, ErrNotPNG) {
				t.Errorf("publish: %v, want ErrNotPNG", err)
			}
		}, wantErr: ErrNotPNG},
		{name: "the capturer disconnects mid-request", capture: func(t *testing.T, _ *Broker, reqs <-chan *v1.ShotRequest, disconnect func()) {
			next(t, reqs)
			disconnect()
		}, wantErr: ErrGone},
		{name: "a new capturer replaces the one owing the answer", capture: func(t *testing.T, b *Broker, reqs <-chan *v1.ShotRequest, _ func()) {
			next(t, reqs)
			_, _, disconnect := b.Connect()
			t.Cleanup(disconnect)
		}, wantErr: ErrGone},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := New(WithTimeout(300*time.Millisecond), WithMaxPNG(1024))
			if !tt.noCap {
				reqs, _, disconnect := b.Connect()
				t.Cleanup(disconnect)
				go tt.capture(t, b, reqs, disconnect)
			}
			got, err := b.Shoot(context.Background(), &v1.ShotRequest{Instance: "hello/main/global", Width: 420, Height: 900})
			var ce *CaptureError
			switch {
			case errors.As(tt.wantErr, &ce):
				var got *CaptureError
				if !errors.As(err, &got) || got.Reason != ce.Reason {
					t.Fatalf("err = %v, want the app's %q", err, ce.Reason)
				}
			case !errors.Is(err, tt.wantErr):
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if !bytes.Equal(got.PNG, tt.want.PNG) || got.ContentHeight != tt.want.ContentHeight {
				t.Errorf("result %v, want %v", got, tt.want)
			}
		})
	}
}

func TestPublishUnknownID(t *testing.T) {
	b := New()
	for _, id := range []string{"", "shot-nope"} {
		if err := b.Publish(id, png(1), "", 0); !errors.Is(err, ErrUnknownID) {
			t.Errorf("Publish(%q) = %v, want ErrUnknownID", id, err)
		}
	}
	// A late answer to a shot that timed out finds no one.
	b = New(WithTimeout(20 * time.Millisecond))
	reqs, _, disconnect := b.Connect()
	defer disconnect()
	if _, err := b.Shoot(context.Background(), &v1.ShotRequest{}); !errors.Is(err, ErrTimeout) {
		t.Fatalf("shoot: %v", err)
	}
	if err := b.Publish(next(t, reqs).GetId(), png(1), "", 0); !errors.Is(err, ErrUnknownID) {
		t.Errorf("late publish = %v, want ErrUnknownID", err)
	}
}

// Two shots at once each get their own answer, whatever order the capturer answers in.
func TestTwoShotsAtOnce(t *testing.T) {
	b := New(WithTimeout(2 * time.Second))
	reqs, _, disconnect := b.Connect()
	defer disconnect()
	var wg sync.WaitGroup
	got := make([]Result, 2)
	errs := make([]error, 2)
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got[i], errs[i] = b.Shoot(context.Background(), &v1.ShotRequest{Width: int32(300 + i)})
		}()
	}
	r1, r2 := next(t, reqs), next(t, reqs)
	if r1.GetId() == r2.GetId() {
		t.Fatalf("both requests have id %s", r1.GetId())
	}
	// Answer in reverse, each with its width as the content height.
	for _, r := range []*v1.ShotRequest{r2, r1} {
		if err := b.Publish(r.GetId(), png(1), "", int(r.GetWidth())); err != nil {
			t.Fatal(err)
		}
	}
	wg.Wait()
	for i := range 2 {
		if errs[i] != nil || got[i].ContentHeight != 300+i {
			t.Errorf("shot %d: %v, %v", i, got[i], errs[i])
		}
	}
}

func TestBusyAndCancelled(t *testing.T) {
	b := New(WithTimeout(time.Second))
	_, _, disconnect := b.Connect()
	defer disconnect()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// queueLen requests sit unread; each ends with its caller's context.
	for range queueLen {
		if _, err := b.Shoot(ctx, &v1.ShotRequest{}); !errors.Is(err, context.Canceled) {
			t.Fatalf("shoot: %v, want context.Canceled", err)
		}
	}
	if _, err := b.Shoot(ctx, &v1.ShotRequest{}); !errors.Is(err, ErrBusy) {
		t.Errorf("shoot past the queue: %v, want ErrBusy", err)
	}
}

func TestConnected(t *testing.T) {
	b := New()
	if b.Connected() {
		t.Fatal("connected before Connect")
	}
	_, gone1, disconnect1 := b.Connect()
	_, gone2, disconnect2 := b.Connect()
	select {
	case <-gone1:
	default:
		t.Error("the first capturer was not told it was replaced")
	}
	disconnect1() // the replaced one leaving does not disconnect the new one
	if !b.Connected() {
		t.Error("the second capturer was dropped by the first's disconnect")
	}
	disconnect2()
	disconnect2()
	if b.Connected() {
		t.Error("connected after the last disconnect")
	}
	select {
	case <-gone2:
	default:
		t.Error("gone not closed on disconnect")
	}
}
