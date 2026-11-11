package main

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"testing"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

type fakeShotStream struct {
	reqs []*v1.ShotRequest
	msg  *v1.ShotRequest
	err  error
}

func (s *fakeShotStream) Receive() bool {
	if len(s.reqs) == 0 {
		return false
	}
	s.msg, s.reqs = s.reqs[0], s.reqs[1:]
	return true
}

func (s *fakeShotStream) Msg() *v1.ShotRequest { return s.msg }
func (s *fakeShotStream) Err() error           { return s.err }
func (s *fakeShotStream) Close() error         { return nil }

// Each request goes to the queue with its stream's context, which ends with the stream;
// a dropped stream is opened again, and its next requests come with the new one's.
func TestShotWatcherReconnects(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	streams := [][]*v1.ShotRequest{
		{shotReq("a"), {}, shotReq("b")},
		{shotReq("c")},
	}
	opens := 0
	var ids []string
	var ctxs []context.Context
	w := shotWatcher{
		open: func(context.Context) (shotStream, error) {
			opens++
			switch {
			case opens == 2:
				return nil, errors.New("no daemon")
			case opens > 3:
				cancel()
				return nil, errors.New("quitting")
			}
			reqs := streams[0]
			streams = streams[1:]
			return &fakeShotStream{reqs: reqs, err: errors.New("stream dropped")}, nil
		},
		log:   slog.New(slog.DiscardHandler),
		retry: time.Millisecond,
		take: func(ctx context.Context, r *v1.ShotRequest) {
			ids = append(ids, r.GetId())
			ctxs = append(ctxs, ctx)
		},
	}
	w.run(ctx)
	if want := []string{"a", "b", "c"}; !slices.Equal(ids, want) {
		t.Errorf("took %v, want %v (an empty message is not a request)", ids, want)
	}
	if opens != 4 {
		t.Errorf("opened %d times", opens)
	}
	for i, c := range ctxs {
		if c.Err() == nil {
			t.Errorf("request %s: its stream's context outlived the stream", ids[i])
		}
	}
	if ctxs[0] != ctxs[1] || ctxs[1] == ctxs[2] {
		t.Error("a stream's requests share its context, the next stream's have their own")
	}
}
