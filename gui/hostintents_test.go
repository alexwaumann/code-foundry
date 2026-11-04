package main

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

type fakeIntentStream struct {
	intents []*v1.UiIntent
	msg     *v1.UiIntent
	err     error
}

func (s *fakeIntentStream) Receive() bool {
	if len(s.intents) == 0 {
		return false
	}
	s.msg, s.intents = s.intents[0], s.intents[1:]
	return true
}

func (s *fakeIntentStream) Msg() *v1.UiIntent { return s.msg }
func (s *fakeIntentStream) Err() error        { return s.err }
func (s *fakeIntentStream) Close() error      { return nil }

func showView(name string) *v1.UiIntent {
	return &v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: name}}}
}

func TestHostIntentWatcher(t *testing.T) {
	tests := []struct {
		name    string
		intents []*v1.UiIntent
		want    int
	}{
		{"dictation.allow", []*v1.UiIntent{showView(viewDictationAllow)}, 1},
		{"twice", []*v1.UiIntent{showView(viewDictationAllow), showView(viewDictationAllow)}, 2},
		{"another view", []*v1.UiIntent{showView("dictation.toggle")}, 0},
		{"another intent", []*v1.UiIntent{{Intent: &v1.UiIntent_OpenPalette_{OpenPalette: &v1.UiIntent_OpenPalette{}}}}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var asked int
			w := hostIntentWatcher{
				open: func(context.Context) (intentStream, error) {
					return &fakeIntentStream{intents: tt.intents}, nil
				},
				log:   slog.New(slog.DiscardHandler),
				allow: func() { asked++ },
			}
			if err := w.once(context.Background()); err != nil {
				t.Fatal(err)
			}
			if asked != tt.want {
				t.Errorf("asked %d times, want %d", asked, tt.want)
			}
		})
	}
}

// A stream that fails is opened again, until the app quits.
func TestHostIntentWatcherReconnects(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	opens := 0
	w := hostIntentWatcher{
		open: func(context.Context) (intentStream, error) {
			opens++
			if opens == 3 {
				cancel()
			}
			return nil, errors.New("no daemon")
		},
		log:   slog.New(slog.DiscardHandler),
		retry: time.Millisecond,
	}
	w.run(ctx)
	if opens != 3 {
		t.Errorf("opened %d times", opens)
	}
}
