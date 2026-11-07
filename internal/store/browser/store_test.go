package browser_test

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/browser"
	"github.com/alexwaumann/code-foundry/internal/store/browser/browsertest"
)

type fixture struct {
	t       *testing.T
	s       *browser.Store
	c       *browsertest.Chrome
	enabled atomic.Bool
}

func newFixture(t *testing.T, idle time.Duration) *fixture {
	t.Helper()
	f := &fixture{t: t, c: browsertest.New()}
	f.enabled.Store(true)
	f.s = browser.New(browser.Options{
		Dir: t.TempDir(), Launch: f.c.Launch, Enabled: f.enabled.Load, Idle: idle,
		Reveal: func(string) error { return nil }, Log: slog.New(slog.DiscardHandler),
	})
	t.Cleanup(f.s.Close)
	return f
}

// next takes from a viewer until ok says the state is the one, or fails.
func next(t *testing.T, v *browser.Viewer, what string, ok func(browser.State) bool) browser.State {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case <-v.Wake():
			st, _, err := v.Take()
			if err != nil {
				t.Fatalf("%s: view ended: %v", what, err)
			}
			if st != nil && ok(*st) {
				return *st
			}
		case <-deadline:
			t.Fatalf("waiting for %s", what)
		}
	}
}

func ready(st browser.State) bool { return st.Phase == browser.PhaseReady }

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("waiting for %s", what)
}

func TestOffMeansNothingRuns(t *testing.T) {
	f := newFixture(t, time.Hour)
	f.enabled.Store(false)
	if _, err := f.s.Watch("thread:a", 640, 480, ""); !errors.Is(err, browser.ErrDisabled) {
		t.Fatalf("Watch: %v", err)
	}
	if err := f.s.Relaunch(context.Background()); !errors.Is(err, browser.ErrDisabled) {
		t.Fatalf("Relaunch: %v", err)
	}
	if _, err := f.s.Navigate(context.Background(), "thread:a", "example.com"); err == nil {
		t.Fatal("Navigate ran with the setting off")
	}
	if n := f.c.Launches(); n != 0 || f.s.Running() {
		t.Fatalf("launches %d", n)
	}
}

func TestStartsOnFirstViewOnlyAndTurningOffStopsIt(t *testing.T) {
	f := newFixture(t, time.Hour)
	if f.c.Launches() != 0 {
		t.Fatal("started before any view")
	}
	v, err := f.s.Watch("thread:a", 640, 480, "")
	if err != nil {
		t.Fatal(err)
	}
	next(t, v, "ready", ready)
	v2, err := f.s.Watch("thread:b", 640, 480, "")
	if err != nil {
		t.Fatal(err)
	}
	next(t, v2, "ready", ready)
	if n := f.c.Launches(); n != 1 {
		t.Fatalf("launches %d: one Chrome per daemon", n)
	}
	f.enabled.Store(false)
	f.s.ConfigChanged()
	eventually(t, "Chrome to stop", f.c.Stopped)
	if f.s.Running() {
		t.Fatal("still running")
	}
	select {
	case <-v.Wake():
	case <-time.After(time.Second):
		t.Fatal("the view was not told")
	}
	if _, _, err := v.Take(); !errors.Is(err, browser.ErrDisabled) {
		t.Fatalf("view ended with %v", err)
	}
}

func TestNoChromeSaysSo(t *testing.T) {
	f := newFixture(t, time.Hour)
	f.c.FailLaunch(browser.ErrNoChrome)
	v, err := f.s.Watch("thread:a", 640, 480, "")
	if err != nil {
		t.Fatal(err)
	}
	st := next(t, v, "the refusal", func(st browser.State) bool { return st.Phase == browser.PhaseUnavailable })
	if !strings.HasPrefix(st.Message, "No Google Chrome on this Mac") {
		t.Fatalf("message %q", st.Message)
	}
}

func TestIdleStopsChromeAndANewViewReturnsToTheAddress(t *testing.T) {
	f := newFixture(t, 30*time.Millisecond)
	v, err := f.s.Watch("thread:a", 640, 480, "https://example.com/x")
	if err != nil {
		t.Fatal(err)
	}
	next(t, v, "ready", ready)
	eventually(t, "the navigation", func() bool { return len(f.c.Calls("Page.navigate")) == 1 })
	f.c.Emit("Page.frameNavigated", "session-target-1", map[string]any{"frame": map[string]any{"url": "https://example.com/x"}})
	next(t, v, "the address", func(st browser.State) bool { return st.URL == "https://example.com/x" })
	time.Sleep(100 * time.Millisecond)
	if !f.s.Running() {
		t.Fatal("stopped while a view was open")
	}
	v.Close()
	eventually(t, "the idle stop", func() bool { return !f.s.Running() && f.c.Stopped() })
	v2, err := f.s.Watch("thread:a", 640, 480, "")
	if err != nil {
		t.Fatal(err)
	}
	next(t, v2, "ready", ready)
	eventually(t, "the way back", func() bool {
		calls := f.c.Calls("Page.navigate")
		return len(calls) == 2 && calls[1].Params["url"] == "https://example.com/x"
	})
	if n := f.c.Launches(); n != 2 {
		t.Fatalf("launches %d", n)
	}
}

func TestReturningWithinTheIdlePeriodKeepsChrome(t *testing.T) {
	f := newFixture(t, 200*time.Millisecond)
	v, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v, "ready", ready)
	v.Close()
	v2, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v2, "ready", ready)
	time.Sleep(300 * time.Millisecond)
	if !f.s.Running() || f.c.Launches() != 1 {
		t.Fatalf("running %v, launches %d", f.s.Running(), f.c.Launches())
	}
}

func TestCrashShowsAndStaysDownUntilRelaunch(t *testing.T) {
	f := newFixture(t, time.Hour)
	v, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v, "ready", ready)
	f.c.Crash()
	next(t, v, "the crash", func(st browser.State) bool { return st.Phase == browser.PhaseCrashed && st.Message != "" })
	v2, err := f.s.Watch("thread:b", 640, 480, "")
	if err != nil {
		t.Fatal(err)
	}
	next(t, v2, "the crash", func(st browser.State) bool { return st.Phase == browser.PhaseCrashed })
	if n := f.c.Launches(); n != 1 {
		t.Fatalf("a new view relaunched a crashed Chrome: %d", n)
	}
	if err := f.s.Relaunch(context.Background()); err != nil {
		t.Fatal(err)
	}
	next(t, v, "ready again", ready)
	next(t, v2, "ready again", ready)
	if n := f.c.Launches(); n != 2 {
		t.Fatalf("launches %d", n)
	}
}

func TestChromeThatNeverAnswersIsStopped(t *testing.T) {
	c := browsertest.New()
	c.Silent()
	s := browser.New(browser.Options{
		Dir: t.TempDir(), Launch: c.Launch, Enabled: func() bool { return true }, StartTimeout: 50 * time.Millisecond,
		Log: slog.New(slog.DiscardHandler),
	})
	t.Cleanup(s.Close)
	v, err := s.Watch("thread:a", 640, 480, "")
	if err != nil {
		t.Fatal(err)
	}
	next(t, v, "the refusal", func(st browser.State) bool { return st.Phase == browser.PhaseUnavailable })
	if !c.Stopped() {
		t.Fatal("left running")
	}
}

func TestOnlyTheNewestFrameWaitsAndDroppedFramesAreAcked(t *testing.T) {
	f := newFixture(t, time.Hour)
	v, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v, "ready", ready)
	eventually(t, "the cast", func() bool { return len(f.c.Calls("Page.startScreencast")) == 1 })
	eventually(t, "the first shot", func() bool { return len(f.c.Calls("Page.captureScreenshot")) == 1 })
	time.Sleep(20 * time.Millisecond)
	_, _, _ = v.Take()
	s := "session-target-1"
	for i := 1; i <= 5; i++ {
		f.c.Frame(s, i, []byte{byte(i)}, 640, 480)
	}
	eventually(t, "the older frames' acks", func() bool { return len(f.c.Calls("Page.screencastFrameAck")) == 4 })
	_, frame, err := v.Take()
	if err != nil || frame == nil {
		t.Fatalf("frame %v, err %v", frame, err)
	}
	if frame.JPEG[0] != 5 || frame.Width != 640 || frame.Height != 480 {
		t.Fatalf("frame %+v", frame)
	}
	if n := len(f.c.Calls("Page.screencastFrameAck")); n != 4 {
		t.Fatalf("the newest was acked before it was taken: %d", n)
	}
	frame.Taken()
	frame.Taken()
	eventually(t, "the last ack", func() bool { return len(f.c.Calls("Page.screencastFrameAck")) == 5 })
	if n := len(f.c.Calls("Page.screencastFrameAck")); n != 5 {
		t.Fatalf("acks %d", n)
	}
}

func TestHiddenSurfaceStopsTheCast(t *testing.T) {
	f := newFixture(t, time.Hour)
	v, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v, "ready", ready)
	eventually(t, "the cast", func() bool { return len(f.c.Calls("Page.startScreencast")) == 1 })
	v2, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v2, "ready", ready)
	v.Close()
	time.Sleep(50 * time.Millisecond)
	if n := len(f.c.Calls("Page.stopScreencast")); n != 0 {
		t.Fatalf("stopped with a view left: %d", n)
	}
	v2.Close()
	eventually(t, "the stop", func() bool { return len(f.c.Calls("Page.stopScreencast")) == 1 })
}

func TestStoppingWithFramesInFlightDoesNotHang(t *testing.T) {
	f := newFixture(t, time.Hour)
	v, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v, "ready", ready)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := range 200 {
			f.c.Frame("session-target-1", i, []byte{1}, 640, 480)
		}
	}()
	f.s.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("hung")
	}
}

func TestBadAddressesNeverReachChrome(t *testing.T) {
	f := newFixture(t, time.Hour)
	v, err := f.s.Watch("thread:a", 640, 480, "file:///etc/hosts")
	if err != nil {
		t.Fatalf("a refused address must not end the view: %v", err)
	}
	st := next(t, v, "ready", ready)
	if st.Notice == "" {
		t.Fatal("the surface does not say so")
	}
	for _, u := range []string{"javascript:alert(1)", "chrome://settings", "devtools://x", "data:text/html,x", "file:///x"} {
		if _, err := f.s.Navigate(context.Background(), "thread:a", u); !errors.Is(err, browser.ErrBadURL) {
			t.Fatalf("Navigate(%s): %v", u, err)
		}
	}
	if n := len(f.c.Calls("Page.navigate")); n != 0 {
		t.Fatalf("navigated %d times", n)
	}
}

func TestAnAddressNobodySeesStartsNothing(t *testing.T) {
	f := newFixture(t, time.Hour)
	if _, err := f.s.Navigate(context.Background(), "thread:a", "https://example.com"); !errors.Is(err, browser.ErrNoSurface) {
		t.Fatalf("Navigate: %v", err)
	}
	if n := f.c.Launches(); n != 0 {
		t.Fatalf("launches %d", n)
	}
}

func TestBadInputIsRefused(t *testing.T) {
	f := newFixture(t, time.Hour)
	v, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v, "ready", ready)
	ctx := context.Background()
	for _, e := range []browser.InputEvent{
		{},
		{Mouse: &browser.MouseEvent{Type: "bogus", Button: "left"}},
		{Mouse: &browser.MouseEvent{Type: "mouseMoved", Button: "bogus"}},
		{Key: &browser.KeyEvent{Type: "bogus"}},
	} {
		if err := f.s.Input(ctx, "thread:a", []browser.InputEvent{e}); !errors.Is(err, browser.ErrBadInput) {
			t.Fatalf("Input(%+v): %v", e, err)
		}
	}
}

func TestPageLandingOnAForbiddenSchemeIsSentAway(t *testing.T) {
	f := newFixture(t, time.Hour)
	v, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v, "ready", ready)
	f.c.Emit("Page.frameNavigated", "session-target-1", map[string]any{"frame": map[string]any{"url": "file:///etc/hosts"}})
	next(t, v, "the notice", func(st browser.State) bool { return st.Notice != "" })
	eventually(t, "the way out", func() bool {
		calls := f.c.Calls("Page.navigate")
		return len(calls) == 1 && calls[0].Params["url"] == "about:blank"
	})
}

func TestWhatCannotShowSaysSo(t *testing.T) {
	f := newFixture(t, time.Hour)
	v, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v, "ready", ready)
	f.c.Emit("Page.frameNavigated", "session-target-1", map[string]any{"frame": map[string]any{"url": "https://example.com/a.pdf", "mimeType": "application/pdf"}})
	next(t, v, "the notice", func(st browser.State) bool { return strings.Contains(st.Notice, "PDF") })
}

func TestAFailedNavigationSaysWhy(t *testing.T) {
	tests := []struct{ code, want string }{
		{"net::ERR_NAME_NOT_RESOLVED", "net::ERR_NAME_NOT_RESOLVED"},
		{"net::ERR_INVALID_AUTH_CREDENTIALS", "user name and password"},
	}
	for _, tt := range tests {
		f := newFixture(t, time.Hour)
		f.c.Reply("Page.navigate", func(browsertest.Call) (any, error) { return map[string]string{"errorText": tt.code}, nil })
		v, _ := f.s.Watch("thread:a", 640, 480, "")
		next(t, v, "ready", ready)
		if _, err := f.s.Navigate(context.Background(), "thread:a", "https://example.com"); err != nil {
			t.Fatal(err)
		}
		next(t, v, "the notice", func(st browser.State) bool { return strings.Contains(st.Notice, tt.want) })
	}
}

func TestADownloadIsNotAFailure(t *testing.T) {
	f := newFixture(t, time.Hour)
	f.c.Reply("Page.navigate", func(browsertest.Call) (any, error) { return map[string]string{"errorText": "net::ERR_ABORTED"}, nil })
	v, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v, "ready", ready)
	if _, err := f.s.Navigate(context.Background(), "thread:a", "https://example.com/a.zip"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := v.Take(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if st, _, _ := v.Take(); st != nil && st.Notice != "" {
		t.Fatalf("notice %q", st.Notice)
	}
}

func TestWhatAPageSaysIsBounded(t *testing.T) {
	f := newFixture(t, time.Hour)
	v, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v, "ready", ready)
	long := make([]byte, 100<<10)
	for i := range long {
		long[i] = 'x'
	}
	f.c.Emit("Page.javascriptDialogOpening", "session-target-1", map[string]any{
		"url": "https://example.com/private?token=abc", "message": string(long), "type": "alert",
	})
	st := next(t, v, "the dialog", func(st browser.State) bool { return st.Dialog != nil })
	if len(st.Dialog.Message) > 5<<10 {
		t.Fatalf("message of %d bytes", len(st.Dialog.Message))
	}
	if st.Dialog.Origin != "https://example.com" {
		t.Fatalf("origin %q", st.Dialog.Origin)
	}
	f.c.Emit("Page.frameNavigated", "session-target-1", map[string]any{"frame": map[string]any{"url": "data:text/html," + string(long)}})
	st = next(t, v, "the long address", func(st browser.State) bool { return strings.HasPrefix(st.URL, "data:") })
	if len(st.URL) > 9<<10 {
		t.Fatalf("address of %d bytes", len(st.URL))
	}
}

func TestAnAnswerMustMatchWhatIsAsked(t *testing.T) {
	f := newFixture(t, time.Hour)
	v, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v, "ready", ready)
	ctx := context.Background()
	if err := f.s.AnswerDialog(ctx, "thread:a", "1", true, ""); !errors.Is(err, browser.ErrNotPending) {
		t.Fatalf("AnswerDialog: %v", err)
	}
	if err := f.s.AnswerFile(ctx, "thread:a", "1", []string{"/etc/hosts"}); !errors.Is(err, browser.ErrNotPending) {
		t.Fatalf("AnswerFile: %v", err)
	}
	if err := f.s.PickSelect(ctx, "thread:a", "1", 0); !errors.Is(err, browser.ErrNotPending) {
		t.Fatalf("PickSelect: %v", err)
	}
	if n := len(f.c.Calls("DOM.setFileInputFiles")); n != 0 {
		t.Fatalf("set files %d times", n)
	}
}

func TestAPathChromeReportsNeverLeavesOurFolders(t *testing.T) {
	f := newFixture(t, time.Hour)
	v, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v, "ready", ready)
	if err := f.s.Input(context.Background(), "thread:a", []browser.InputEvent{{Mouse: &browser.MouseEvent{Type: "mouseReleased", Button: "left"}}}); err != nil {
		t.Fatal(err)
	}
	f.c.Emit("Page.downloadWillBegin", "session-target-1", map[string]any{"frameId": "target-1", "guid": "g", "suggestedFilename": "a.txt"})
	f.c.Emit("Browser.downloadProgress", "", map[string]any{"guid": "g", "state": "completed", "filePath": "/etc/hosts"})
	st := next(t, v, "the download", func(st browser.State) bool { return len(st.Downloads) == 1 && st.Downloads[0].State == "canceled" })
	if st.Downloads[0].Path != "" {
		t.Fatalf("path %q", st.Downloads[0].Path)
	}
	if err := f.s.RevealDownload("thread:a", "g"); !errors.Is(err, browser.ErrNotPending) {
		t.Fatalf("revealed outside the folder: %v", err)
	}
}
