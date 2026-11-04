package main

import (
	"context"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// A 14-inch MacBook Pro: a 32 pt notch, the Dock at the bottom.
var notchedScreen = overlayScreen{
	Frame:   overlayRect{0, 0, 1512, 982},
	Visible: overlayRect{0, 70, 1512, 880},
	SafeTop: 32,
}

func TestOverlayFrame(t *testing.T) {
	tests := []struct {
		name string
		s    overlayScreen
		// plateTop is where the plate's top edge must land, in screen space.
		plateTop float64
		want     overlayRect
	}{
		{
			name:     "flat screen: under the 24 pt menu bar",
			s:        overlayScreen{Frame: overlayRect{0, 0, 1920, 1080}, Visible: overlayRect{0, 0, 1920, 1056}},
			plateTop: 1050,
			want:     overlayRect{888, 1011, 144, 52},
		},
		{
			name:     "notch: under the bar that covers it",
			s:        notchedScreen,
			plateTop: 944,
			want:     overlayRect{684, 905, 144, 52},
		},
		{
			name:     "notch with the menu bar hidden: visibleFrame reaches the top, the plate stays under the notch",
			s:        overlayScreen{Frame: notchedScreen.Frame, Visible: overlayRect{0, 0, 1512, 982}, SafeTop: 32},
			plateTop: 944,
			want:     overlayRect{684, 905, 144, 52},
		},
		{
			name:     "flat screen, menu bar hidden: 6 pt under the top edge",
			s:        overlayScreen{Frame: overlayRect{0, 0, 1920, 1080}, Visible: overlayRect{0, 0, 1920, 1080}},
			plateTop: 1074,
			want:     overlayRect{888, 1035, 144, 52},
		},
		{
			name:     "a screen left of and below the primary: negative coordinates",
			s:        overlayScreen{Frame: overlayRect{-1600, -900, 1600, 900}, Visible: overlayRect{-1600, -900, 1600, 876}},
			plateTop: -30,
			want:     overlayRect{-872, -69, 144, 52},
		},
		{
			name:     "odd width: whole points",
			s:        overlayScreen{Frame: overlayRect{0, 0, 1367, 768}, Visible: overlayRect{0, 0, 1367, 744}},
			plateTop: 738,
			want:     overlayRect{612, 699, 144, 52},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := overlayFrame(tt.s)
			if got != tt.want {
				t.Fatalf("frame %+v, want %+v", got, tt.want)
			}
			// The plate is centred in the window, so its top follows from the frame.
			if top := got.Y + got.Height/2 + overlayPlateHeight/2; top != tt.plateTop {
				t.Errorf("plate top %v, want %v", top, tt.plateTop)
			}
		})
	}
}

func TestOverlayScreenAt(t *testing.T) {
	primary := overlayScreen{Frame: overlayRect{0, 0, 1512, 982}}
	right := overlayScreen{Frame: overlayRect{1512, 0, 1920, 1080}}
	above := overlayScreen{Frame: overlayRect{0, 982, 1512, 900}}
	screens := []overlayScreen{primary, right, above}
	tests := []struct {
		name string
		x, y float64
		want overlayScreen
	}{
		{"on the primary", 100, 100, primary},
		{"on the right", 2000, 500, right},
		{"the top row of the right screen", 2000, 1080, right},
		{"the left column of the right screen", 1512, 100, right},
		{"the screen above", 100, 1500, above},
		{"on no screen: the primary", 5000, 5000, primary},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := overlayScreenAt(screens, tt.x, tt.y); got != tt.want {
				t.Errorf("screen %+v, want %+v", got, tt.want)
			}
		})
	}
}

// fakePanel records the window's calls; fakeLinger holds the clock the service arms.
type fakePanel struct {
	mu   sync.Mutex
	logs []string
}

func (p *fakePanel) show(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.logs = append(p.logs, "show:"+id)
}

func (p *fakePanel) hide() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.logs = append(p.logs, "hide")
}

func (p *fakePanel) got() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.logs)
}

func snapFor(id, client string, stopping bool) *v1.DictationSnapshot {
	s := snapState(v1.DictationState_DICTATION_STATE_LISTENING, false)
	s.Session = &v1.DictationSession{Id: id, ClientId: client, Stopping: stopping}
	return s
}

func TestOverlayService(t *testing.T) {
	type step func(o *OverlayService, fire func())
	see := func(s *v1.DictationSnapshot) step { return func(o *OverlayService, _ func()) { o.observe(s) } }
	done := func(id string) step { return func(o *OverlayService, _ func()) { o.PageDone(id) } }
	lost := func(o *OverlayService, _ func()) { o.lost() }
	linger := func(_ *OverlayService, fire func()) { fire() }

	tests := []struct {
		name  string
		steps []step
		want  []string
		// ready is what PageReady says after the steps.
		ready string
	}{
		{
			name:  "a composer's session never shows it",
			steps: []step{see(snapFor("c1", "thread:1@r1", false)), see(snapReady)},
		},
		{
			name:  "the CLI's session never shows it",
			steps: []step{see(snapFor("c1", "cli", false))},
		},
		{
			name:  "a system session shows it once and the page hides it",
			steps: []step{see(snapReady), see(snapFor("s1", "system", false)), see(snapFor("s1", "system", true)), see(snapReady), done("s1")},
			want:  []string{"show:s1", "hide"},
		},
		{
			name:  "a shown session is the page's answer on load",
			steps: []step{see(snapFor("s1", "system", false))},
			want:  []string{"show:s1"},
			ready: "s1",
		},
		{
			name:  "the page finishes before the snapshot says so: the clock never hides twice",
			steps: []step{see(snapFor("s1", "system", false)), done("s1"), see(snapReady), linger},
			want:  []string{"show:s1", "hide"},
		},
		{
			name:  "a page that never finishes is hidden after the session",
			steps: []step{see(snapFor("s1", "system", false)), see(snapReady), linger},
			want:  []string{"show:s1", "hide"},
		},
		{
			name:  "the stream dropping starts the same clock",
			steps: []step{see(snapFor("s1", "system", false)), lost, linger},
			want:  []string{"show:s1", "hide"},
		},
		{
			name:  "a reconnect that sees the session still open stops the clock",
			steps: []step{see(snapFor("s1", "system", false)), lost, see(snapFor("s1", "system", false)), linger},
			want:  []string{"show:s1"},
			ready: "s1",
		},
		{
			name:  "a hidden session is not shown again by a reconnect",
			steps: []step{see(snapFor("s1", "system", false)), done("s1"), see(snapFor("s1", "system", false))},
			want:  []string{"show:s1", "hide"},
		},
		{
			name:  "the next session takes over a window still playing the last, and the old page done is ignored",
			steps: []step{see(snapFor("s1", "system", false)), see(snapReady), see(snapFor("s2", "system", false)), done("s1"), linger},
			want:  []string{"show:s1", "show:s2"},
			ready: "s2",
		},
		{
			name:  "a stale clock does not hide the next session",
			steps: []step{see(snapFor("s1", "system", false)), lost, see(snapFor("s2", "system", false)), linger},
			want:  []string{"show:s1", "show:s2"},
			ready: "s2",
		},
		{
			name:  "a composer taking over ends it like any session end",
			steps: []step{see(snapFor("s1", "system", false)), see(snapFor("c1", "thread:1@r1", false)), done("s1")},
			want:  []string{"show:s1", "hide"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			panel := &fakePanel{}
			o := NewOverlayService(slog.New(slog.DiscardHandler))
			o.panel = panel
			// The fake clock: the armed callback, dropped when cancelled.
			var armed func()
			o.after = func(d time.Duration, fn func()) func() {
				if d != overlayLinger {
					t.Errorf("clock armed for %v", d)
				}
				armed = fn
				return func() { armed = nil }
			}
			fire := func() {
				if fn := armed; fn != nil {
					armed = nil
					fn()
				}
			}
			for _, s := range tt.steps {
				s(o, fire)
			}
			if got := panel.got(); !slices.Equal(got, tt.want) {
				t.Errorf("panel %v, want %v", got, tt.want)
			}
			if got := o.PageReady(); got != tt.ready {
				t.Errorf("PageReady = %q, want %q", got, tt.ready)
			}
		})
	}
}

// fakeOverlay counts what the watcher tells it.
type fakeOverlay struct {
	mu    sync.Mutex
	seen  []string
	drops int
}

func (f *fakeOverlay) observe(s *v1.DictationSnapshot) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seen = append(f.seen, s.GetState().String())
}

func (f *fakeOverlay) lost() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.drops++
}

// The watcher passes on snapshots, not heartbeats, and says when the stream ended.
func TestDictationWatcherTellsTheOverlay(t *testing.T) {
	log := &eventLog{}
	daemon := &fakeDaemon{log: log}
	overlay := &fakeOverlay{}
	w := dictationWatcher{
		dial:    func(context.Context) (dictationConn, error) { return daemon, nil },
		mic:     &fakeMic{log: log, perm: micGranted},
		log:     slog.New(slog.DiscardHandler),
		overlay: overlay,
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		s := daemon.stream(0)
		s <- snapReady
		s <- snapHeartbeat
		s <- snapReady
		close(s)
	}()
	if err := w.once(ctx); err != nil {
		t.Fatal(err)
	}
	overlay.mu.Lock()
	defer overlay.mu.Unlock()
	if len(overlay.seen) != 2 || overlay.drops != 1 {
		t.Errorf("seen %v, drops %d", overlay.seen, overlay.drops)
	}
}
