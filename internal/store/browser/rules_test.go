package browser_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/browser"
	"github.com/alexwaumann/code-foundry/internal/store/browser/browsertest"
)

const (
	page  = "session-target-1"
	popup = "session-popup"
)

// surfaceFixture is a fixture with its folder known and a page showing.
func surfaceFixture(t *testing.T) (*fixture, *browser.Viewer, string) {
	t.Helper()
	dir := t.TempDir()
	f := &fixture{t: t, c: browsertest.New()}
	f.enabled.Store(true)
	f.s = browser.New(browser.Options{
		Dir: dir, Launch: f.c.Launch, Enabled: f.enabled.Load, Idle: time.Hour,
		Reveal: func(string) error { return nil }, Log: slog.New(slog.DiscardHandler),
	})
	t.Cleanup(f.s.Close)
	v, err := f.s.Watch("thread:a", 640, 480, "")
	if err != nil {
		t.Fatal(err)
	}
	next(t, v, "ready", ready)
	eventually(t, "the page", func() bool { return len(f.c.Calls("Page.addScriptToEvaluateOnNewDocument")) == 1 })
	return f, v, dir
}

func committed(c *browsertest.Chrome, session, url string) {
	c.Emit("Page.frameNavigated", session, map[string]any{"frame": map[string]any{"id": "main", "url": url}})
}

// openPopup stacks a popup on the page and waits for it to show.
func openPopup(t *testing.T, f *fixture, v *browser.Viewer) {
	t.Helper()
	f.c.Reply("Target.attachToTarget", func(c browsertest.Call) (any, error) {
		if c.Params["targetId"] == "popup" {
			return map[string]string{"sessionId": popup}, nil
		}
		return map[string]string{"sessionId": "session-" + c.Params["targetId"].(string)}, nil
	})
	f.c.Emit("Target.targetCreated", "", map[string]any{"targetInfo": map[string]any{"targetId": "popup", "type": "page", "url": "https://other.example/", "openerId": "target-1"}})
	next(t, v, "the popup", func(st browser.State) bool { return st.Popup })
}

func TestADialogOfAPageBehindAPopupIsDismissedThereAndNeverShown(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	openPopup(t, f, v)
	committed(f.c, popup, "https://popup.example/")
	next(t, v, "the popup's address", func(st browser.State) bool { return st.URL == "https://popup.example/" })

	f.c.Emit("Page.javascriptDialogOpening", page, map[string]any{"url": "https://opener.example/", "message": "password?", "type": "prompt"})
	eventually(t, "the opener's answer", func() bool { return len(f.c.Calls("Page.handleJavaScriptDialog")) == 1 })
	if c := f.c.Calls("Page.handleJavaScriptDialog")[0]; c.Session != page || c.Params["accept"] != false {
		t.Fatalf("answered %+v", c)
	}

	f.c.Emit("Page.javascriptDialogOpening", popup, map[string]any{"url": "https://popup.example/", "message": "sure?", "type": "confirm"})
	st := next(t, v, "the popup's dialog", func(st browser.State) bool { return st.Dialog != nil })
	if st.Dialog.Message != "sure?" {
		t.Fatalf("showing %q", st.Dialog.Message)
	}
	if err := f.s.AnswerDialog(context.Background(), "thread:a", st.Dialog.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	calls := f.c.Calls("Page.handleJavaScriptDialog")
	if c := calls[len(calls)-1]; c.Session != popup || c.Params["accept"] != true {
		t.Fatalf("answered %+v", c)
	}
}

func TestADialogDoesNotOutliveItsPageOnScreen(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	openPopup(t, f, v)
	f.c.Emit("Page.javascriptDialogOpening", popup, map[string]any{"url": "https://popup.example/", "message": "sure?", "type": "confirm"})
	next(t, v, "the dialog", func(st browser.State) bool { return st.Dialog != nil })
	f.c.Emit("Target.targetDestroyed", "", map[string]any{"targetId": "popup"})
	next(t, v, "the opener again", func(st browser.State) bool { return !st.Popup && st.Dialog == nil })
}

func TestGoTakesOneStepOnly(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	_ = v
	ctx := context.Background()
	f.c.Reply("Page.getNavigationHistory", func(browsertest.Call) (any, error) {
		return map[string]any{"currentIndex": 1, "entries": []map[string]any{{"id": 1, "url": "https://a.example/"}, {"id": 2, "url": "https://b.example/"}}}, nil
	})
	for _, delta := range []int{-1 << 31, -1000, -2, 0, 2, 1000, 1<<31 - 1} {
		t.Run(strconv.Itoa(delta), func(t *testing.T) {
			if err := f.s.Go(ctx, "thread:a", delta); !errors.Is(err, browser.ErrBadInput) {
				t.Fatalf("Go: %v", err)
			}
		})
	}
	if n := len(f.c.Calls("Page.navigateToHistoryEntry")); n != 0 {
		t.Fatalf("moved %d times", n)
	}
	if err := f.s.Go(ctx, "thread:a", -1); err != nil {
		t.Fatal(err)
	}
	if n := len(f.c.Calls("Page.navigateToHistoryEntry")); n != 1 {
		t.Fatalf("back moved %d times", n)
	}
}

func TestClosingATabCountsItsViewersOutSoTheIdleStopFires(t *testing.T) {
	f := newFixture(t, 30*time.Millisecond)
	v, err := f.s.Watch("thread:a", 640, 480, "")
	if err != nil {
		t.Fatal(err)
	}
	next(t, v, "ready", ready)
	if err := f.s.CloseSurface(context.Background(), "thread:a"); err != nil {
		t.Fatal(err)
	}
	v.Close() // the stream's own defer, later
	eventually(t, "the idle stop", func() bool { return !f.s.Running() && f.c.Stopped() })
}

func TestClosingOneOfTwoTabsKeepsChrome(t *testing.T) {
	f := newFixture(t, 30*time.Millisecond)
	a, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, a, "ready", ready)
	b, _ := f.s.Watch("thread:b", 640, 480, "")
	next(t, b, "ready", ready)
	if err := f.s.CloseSurface(context.Background(), "thread:a"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if !f.s.Running() {
		t.Fatal("stopped with a view open")
	}
	b.Close()
	eventually(t, "the idle stop", func() bool { return !f.s.Running() })
}

func TestARelaunchNobodyWatchesStillStopsWhenIdle(t *testing.T) {
	f := newFixture(t, 30*time.Millisecond)
	v, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v, "ready", ready)
	v.Close()
	eventually(t, "the idle stop", func() bool { return !f.s.Running() })
	if err := f.s.Relaunch(context.Background()); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the second idle stop", func() bool { return !f.s.Running() })
}

func TestRelaunchAfterACrashDoesNotGoBackToThePage(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	committed(f.c, page, "https://www.crashing.example/boom")
	next(t, v, "the address", func(st browser.State) bool { return strings.HasSuffix(st.URL, "/boom") })
	f.c.Crash()
	st := next(t, v, "the crash", func(st browser.State) bool { return st.Phase == browser.PhaseCrashed })
	if !strings.Contains(st.Notice, "crashing.example") {
		t.Fatalf("notice %q", st.Notice)
	}
	if err := f.s.Relaunch(context.Background()); err != nil {
		t.Fatal(err)
	}
	st = next(t, v, "ready again", ready)
	if !strings.Contains(st.Notice, "crashing.example") {
		t.Fatalf("notice %q", st.Notice)
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(f.c.Calls("Page.navigate")); n != 0 {
		t.Fatalf("went back: %+v", f.c.Calls("Page.navigate"))
	}
}

func TestAPasteRunsNoScriptInThePage(t *testing.T) {
	f, _, _ := surfaceFixture(t)
	if err := f.s.Paste(context.Background(), "thread:a", "hunter2"); err != nil {
		t.Fatal(err)
	}
	for _, c := range f.c.Calls("Runtime.evaluate") {
		if c.Session == page {
			t.Fatalf("evaluated in the page: %+v", c.Params)
		}
		if c.Params["userGesture"] != nil {
			t.Fatalf("made up a gesture: %+v", c.Params)
		}
	}
	keys := 0
	for _, c := range f.c.Calls("Input.dispatchKeyEvent") {
		if c.Session == page {
			keys++
		}
	}
	if keys != 2 {
		t.Fatalf("%d key events in the page", keys)
	}
	for _, c := range f.c.Calls("") {
		if c.Session == page && strings.Contains(fmt.Sprint(c.Params), "hunter2") {
			t.Fatalf("the text went to the page in %s", c.Method)
		}
	}
}

func TestAnIdleStopDoesNotReturnToAnAddressTheRuleRefuses(t *testing.T) {
	f := newFixture(t, 30*time.Millisecond)
	v, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v, "ready", ready)
	committed(f.c, page, "data:text/html,hello")
	next(t, v, "the page", func(st browser.State) bool { return strings.HasPrefix(st.URL, "data:") })
	v.Close()
	eventually(t, "the idle stop", func() bool { return !f.s.Running() })
	v2, _ := f.s.Watch("thread:a", 640, 480, "")
	next(t, v2, "ready", ready)
	time.Sleep(50 * time.Millisecond)
	if n := len(f.c.Calls("Page.navigate")); n != 0 {
		t.Fatalf("went to %+v", f.c.Calls("Page.navigate"))
	}
}

func TestWhatTheAddressShows(t *testing.T) {
	for _, tt := range []struct {
		name, url        string
		wantURL          string
		wantSite         string
		wantSecurity     string
		certState        string
		unreachableFrame bool
	}{
		{name: "https", url: "https://a.b.example.co.uk/x", wantURL: "https://a.b.example.co.uk/x", wantSite: "example.co.uk"},
		{name: "plain http", url: "http://example.com/", wantURL: "http://example.com/", wantSite: "example.com", wantSecurity: "insecure"},
		{name: "a user name the page chose", url: "http://bank.example.com%2Flogin:x@evil.test/a", wantURL: "http://evil.test/a", wantSite: "evil.test", wantSecurity: "insecure"},
		{name: "a user name on https", url: "https://user:secret@example.com/a?b=c@d", wantURL: "https://example.com/a?b=c@d", wantSite: "example.com"},
		{name: "a long host", url: "https://login.bank.example.com.a.b.c.d.e.f.evil.co/", wantURL: "https://login.bank.example.com.a.b.c.d.e.f.evil.co/", wantSite: "evil.co"},
		{name: "an ip", url: "http://127.0.0.1:8000/", wantURL: "http://127.0.0.1:8000/", wantSite: "127.0.0.1", wantSecurity: "insecure"},
		{name: "a private suffix", url: "https://mine.github.io/", wantURL: "https://mine.github.io/", wantSite: "mine.github.io"},
		{name: "a failed certificate", url: "https://example.com/", wantURL: "https://example.com/", wantSite: "example.com", wantSecurity: "cert", certState: "insecure-broken"},
		{name: "data", url: "data:text/html,hi", wantURL: "data:text/html,hi", wantSecurity: "insecure"},
		{name: "the blank start", url: "about:blank", wantURL: "about:blank"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f, v, _ := surfaceFixture(t)
			committed(f.c, page, tt.url)
			if tt.certState != "" {
				f.c.Emit("Security.visibleSecurityStateChanged", page, map[string]any{"visibleSecurityState": map[string]any{"securityState": tt.certState}})
			}
			st := next(t, v, "the address", func(st browser.State) bool { return st.URL == tt.wantURL && st.Security == tt.wantSecurity })
			if st.Site != tt.wantSite {
				t.Fatalf("site %q, want %q", st.Site, tt.wantSite)
			}
		})
	}
}

func TestAnErrorPageShowsTheAddressThatFailedAndACleanPageClearsTheMark(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	f.c.Emit("Page.frameNavigated", page, map[string]any{"frame": map[string]any{"url": "chrome-error://chromewebdata/", "unreachableUrl": "https://bad.example/"}})
	f.c.Emit("Security.visibleSecurityStateChanged", page, map[string]any{"visibleSecurityState": map[string]any{"securityState": "insecure-broken"}})
	next(t, v, "the failed address", func(st browser.State) bool { return st.URL == "https://bad.example/" && st.Security == "cert" })
	committed(f.c, page, "https://good.example/")
	f.c.Emit("Security.visibleSecurityStateChanged", page, map[string]any{"visibleSecurityState": map[string]any{"securityState": "secure"}})
	next(t, v, "the good page", func(st browser.State) bool { return st.URL == "https://good.example/" && st.Security == "" })
}

func TestASubframesPushStateIsNotThePagesAddress(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	committed(f.c, page, "https://real.example/")
	next(t, v, "the address", func(st browser.State) bool { return st.URL == "https://real.example/" })
	f.c.Emit("Page.navigatedWithinDocument", page, map[string]any{"frameId": "a-subframe", "url": "https://bank.example/login"})
	f.c.Emit("Page.navigatedWithinDocument", page, map[string]any{"frameId": "target-1", "url": "https://real.example/next"})
	st := next(t, v, "the page's own move", func(st browser.State) bool { return strings.HasSuffix(st.URL, "/next") })
	if st.Site != "real.example" {
		t.Fatalf("site %q", st.Site)
	}
}

func TestAPopupShowsWhatItCommittedNotWhereItIsHeaded(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	f.c.Reply("Page.getFrameTree", func(browsertest.Call) (any, error) {
		return map[string]any{"frameTree": map[string]any{"frame": map[string]any{"url": "about:blank"}}}, nil
	})
	openPopup(t, f, v)
	st := next(t, v, "the committed address", func(st browser.State) bool { return st.Popup && st.URL == "about:blank" })
	if st.Security != "insecure" {
		t.Fatalf("a blank popup an opener can write into reads %q", st.Security)
	}
}

func TestDialogAndChooserNameTheRegistrableDomain(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	committed(f.c, page, "https://a.b.c.evil.co.uk/x")
	f.c.Emit("Page.javascriptDialogOpening", page, map[string]any{"url": "https://user:pw@a.b.c.evil.co.uk/x", "message": "hi", "type": "alert"})
	st := next(t, v, "the dialog", func(st browser.State) bool { return st.Dialog != nil })
	if st.Dialog.Origin != "https://a.b.c.evil.co.uk" || st.Dialog.Site != "evil.co.uk" {
		t.Fatalf("dialog %+v", st.Dialog)
	}
	f.c.Emit("Page.javascriptDialogClosed", page, map[string]any{})
	f.c.Emit("Page.fileChooserOpened", page, map[string]any{"mode": "selectSingle", "backendNodeId": 1})
	st = next(t, v, "the chooser", func(st browser.State) bool { return st.FileChooser != nil })
	if st.FileChooser.Site != "evil.co.uk" {
		t.Fatalf("chooser %+v", st.FileChooser)
	}
}

// download begins a download of the page session, as a subframe's would.
func download(c *browsertest.Chrome, session, guid, name string) {
	p := map[string]any{"frameId": "a-subframe", "guid": guid, "url": "https://files.example/" + name, "suggestedFilename": name}
	c.Emit("Page.downloadWillBegin", session, p)
	c.Emit("Browser.downloadWillBegin", "", p)
}

// finished is Chrome having saved a download in incoming.
func finished(t *testing.T, c *browsertest.Chrome, dir, guid string) {
	t.Helper()
	path := filepath.Join(dir, "incoming", guid)
	if err := os.WriteFile(path, []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	c.Emit("Browser.downloadProgress", "", map[string]any{"guid": guid, "state": "completed", "filePath": path, "receivedBytes": 4, "totalBytes": 4})
}

func click(t *testing.T, f *fixture) {
	t.Helper()
	// A commit already sent would take the gesture with it: this call's reply comes after it.
	if err := f.s.Input(context.Background(), "thread:a", []browser.InputEvent{{Mouse: &browser.MouseEvent{Type: "mouseMoved", Button: "none"}}}); err != nil {
		t.Fatal(err)
	}
	err := f.s.Input(context.Background(), "thread:a", []browser.InputEvent{
		{Mouse: &browser.MouseEvent{Type: "mouseReleased", Button: "left", X: 1, Y: 1}},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func states(st browser.State) map[string]int {
	out := map[string]int{}
	for _, d := range st.Downloads {
		out[d.State]++
	}
	return out
}

func downloaded(t *testing.T, dir string) []string {
	t.Helper()
	es, err := os.ReadDir(filepath.Join(dir, "downloads"))
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range es {
		out = append(out, e.Name())
	}
	return out
}

func TestAClickLetsOneDownloadThroughAndTheRestAsk(t *testing.T) {
	f, v, dir := surfaceFixture(t)
	committed(f.c, page, "https://page.example/")
	click(t, f)
	download(f.c, page, "g1", "first.zip")
	download(f.c, page, "g2", "second.zip")
	st := next(t, v, "both", func(st browser.State) bool { return len(st.Downloads) == 2 })
	if st.Downloads[0].State != browser.DownloadInProgress || st.Downloads[1].State != browser.DownloadAsking {
		t.Fatalf("%+v", st.Downloads)
	}
	if st.Downloads[1].Site != "page.example" {
		t.Fatalf("site %q", st.Downloads[1].Site)
	}
	finished(t, f.c, dir, "g1")
	st = next(t, v, "the first", func(st browser.State) bool { return states(st)[browser.DownloadCompleted] == 1 })
	if got := downloaded(t, dir); len(got) != 1 || got[0] != "first.zip" {
		t.Fatalf("folder %v", got)
	}
	if st.Downloads[0].Path != filepath.Join(dir, "downloads", "first.zip") {
		t.Fatalf("path %q", st.Downloads[0].Path)
	}
	finished(t, f.c, dir, "g2")
	time.Sleep(30 * time.Millisecond)
	if got := downloaded(t, dir); len(got) != 1 {
		t.Fatalf("an unanswered download landed: %v", got)
	}
}

func TestAnAnsweredDownloadLandsAndARefusedOneIsGone(t *testing.T) {
	f, v, dir := surfaceFixture(t)
	committed(f.c, page, "https://page.example/")
	ctx := context.Background()
	download(f.c, page, "yes", "yes.zip")
	download(f.c, page, "no", "no.zip")
	next(t, v, "two questions", func(st browser.State) bool { return states(st)[browser.DownloadAsking] == 2 })
	finished(t, f.c, dir, "yes")
	finished(t, f.c, dir, "no")
	eventually(t, "both staged", func() bool {
		_, a := os.Stat(filepath.Join(dir, "incoming", "yes"))
		_, b := os.Stat(filepath.Join(dir, "incoming", "no"))
		return a == nil && b == nil
	})
	time.Sleep(30 * time.Millisecond) // the progress events have reached the store
	if err := f.s.AnswerDownload(ctx, "thread:a", "yes", true); err != nil {
		t.Fatal(err)
	}
	if err := f.s.AnswerDownload(ctx, "thread:a", "no", false); err != nil {
		t.Fatal(err)
	}
	next(t, v, "the answers", func(st browser.State) bool {
		s := states(st)
		return s[browser.DownloadCompleted] == 1 && s[browser.DownloadBlocked] == 1
	})
	eventually(t, "the refused file gone", func() bool {
		_, err := os.Stat(filepath.Join(dir, "incoming", "no"))
		return errors.Is(err, os.ErrNotExist)
	})
	if got := downloaded(t, dir); len(got) != 1 || got[0] != "yes.zip" {
		t.Fatalf("folder %v", got)
	}
	if err := f.s.AnswerDownload(ctx, "thread:a", "yes", true); !errors.Is(err, browser.ErrNotPending) {
		t.Fatalf("a second answer: %v", err)
	}
}

func TestAHiddenPageDownloadsNothing(t *testing.T) {
	for _, tt := range []struct {
		name string
		hide func(t *testing.T, f *fixture, v *browser.Viewer)
	}{
		{"no viewer", func(_ *testing.T, _ *fixture, v *browser.Viewer) { v.Close() }},
		{"behind its popup", func(t *testing.T, f *fixture, v *browser.Viewer) { openPopup(t, f, v) }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f, v, dir := surfaceFixture(t)
			committed(f.c, page, "https://page.example/")
			click(t, f) // a gesture does not outlive being on screen
			tt.hide(t, f, v)
			download(f.c, page, "g", "hidden.zip")
			eventually(t, "the cancel", func() bool {
				c := f.c.Calls("Browser.cancelDownload")
				return len(c) == 1 && c[0].Params["guid"] == "g"
			})
			finished(t, f.c, dir, "g")
			eventually(t, "the file gone", func() bool {
				_, err := os.Stat(filepath.Join(dir, "incoming", "g"))
				return errors.Is(err, os.ErrNotExist)
			})
			if got := downloaded(t, dir); len(got) != 0 {
				t.Fatalf("folder %v", got)
			}
		})
	}
}

func TestAFloodIsLimitedAndEveryFileIsOnTheList(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	committed(f.c, page, "https://page.example/")
	for i := range 47 {
		download(f.c, page, "g"+strconv.Itoa(i), "bulk"+strconv.Itoa(i)+".bin")
	}
	st := next(t, v, "all of them", func(st browser.State) bool { return len(st.Downloads) == 47 })
	s := states(st)
	if s[browser.DownloadAsking] != 5 || s[browser.DownloadBlocked] != 42 {
		t.Fatalf("%v", s)
	}
	if n := len(f.c.Calls("Browser.cancelDownload")); n > 42 {
		t.Fatalf("%d cancels", n)
	}
	eventually(t, "the cancels", func() bool { return len(f.c.Calls("Browser.cancelDownload")) == 42 })
}

func TestTheCountLimitHoldsUntilTheUserMovesOn(t *testing.T) {
	f, v, dir := surfaceFixture(t)
	committed(f.c, page, "https://page.example/")
	for i := range 20 {
		click(t, f)
		guid := "g" + strconv.Itoa(i)
		download(f.c, page, guid, guid+".bin")
		next(t, v, "it", func(st browser.State) bool { return states(st)[browser.DownloadInProgress] == 1 })
		finished(t, f.c, dir, guid)
		next(t, v, "its end", func(st browser.State) bool { return states(st)[browser.DownloadCompleted] == i+1 })
	}
	click(t, f)
	download(f.c, page, "over", "over.bin")
	next(t, v, "the refusal", func(st browser.State) bool { return states(st)[browser.DownloadBlocked] == 1 })

	// The page navigating itself is not the user moving on.
	committed(f.c, page, "https://page.example/again")
	click(t, f)
	download(f.c, page, "over2", "over2.bin")
	next(t, v, "the second refusal", func(st browser.State) bool { return states(st)[browser.DownloadBlocked] == 2 })

	if err := f.s.Reload(context.Background(), "thread:a"); err != nil {
		t.Fatal(err)
	}
	click(t, f)
	download(f.c, page, "fresh", "fresh.bin")
	next(t, v, "the fresh start", func(st browser.State) bool { return states(st)[browser.DownloadInProgress] == 1 })
}

func TestTheSizeLimitStopsADownload(t *testing.T) {
	for _, tt := range []struct {
		name     string
		gesture  bool
		received float64
	}{
		{"an unanswered download past what it may hold", false, 300 << 20},
		{"an allowed one past the page's limit", true, 5 << 30},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f, v, _ := surfaceFixture(t)
			committed(f.c, page, "https://page.example/")
			if tt.gesture {
				click(t, f)
			}
			download(f.c, page, "big", "big.bin")
			next(t, v, "it", func(st browser.State) bool { return len(st.Downloads) == 1 })
			f.c.Emit("Browser.downloadProgress", "", map[string]any{"guid": "big", "state": "inProgress", "receivedBytes": tt.received, "totalBytes": 0})
			next(t, v, "the stop", func(st browser.State) bool { return states(st)[browser.DownloadBlocked] == 1 })
			eventually(t, "the cancel", func() bool { return len(f.c.Calls("Browser.cancelDownload")) == 1 })
		})
	}
}

func TestADownloadNothingCanPlaceAsksNobody(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	committed(f.c, page, "https://page.example/")
	click(t, f)
	f.c.Emit("Browser.downloadWillBegin", "", map[string]any{"frameId": "deep-in-an-iframe", "guid": "g", "url": "https://iframe.example/a.bin", "suggestedFilename": "a.bin"})
	eventually(t, "the cancel", func() bool { return len(f.c.Calls("Browser.cancelDownload")) == 1 })
	if st := latest(f, v); len(st.Downloads) != 0 {
		t.Fatalf("a surface was asked: %+v", st.Downloads)
	}
}

// latest is the viewer's state after whatever is in flight has landed.
func latest(f *fixture, v *browser.Viewer) browser.State {
	f.t.Helper()
	var last browser.State
	for deadline := time.Now().Add(150 * time.Millisecond); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if st, _, _ := v.Take(); st != nil {
			last = *st
		}
	}
	return last
}

func TestTheListStaysBoundedAndCountsWhatDidNotFit(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	committed(f.c, page, "https://page.example/")
	for i := range 80 {
		download(f.c, page, "g"+strconv.Itoa(i), "bulk.bin")
	}
	st := next(t, v, "the overflow", func(st browser.State) bool { return st.DownloadsBlocked == 30 })
	if len(st.Downloads) != 50 {
		t.Fatalf("listed %d", len(st.Downloads))
	}
}

func TestChromeStoppingClosesTheList(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	committed(f.c, page, "https://page.example/")
	download(f.c, page, "g", "a.bin")
	next(t, v, "it", func(st browser.State) bool { return states(st)[browser.DownloadAsking] == 1 })
	f.c.Crash()
	next(t, v, "the end", func(st browser.State) bool { return states(st)[browser.DownloadCanceled] == 1 })
}

func TestNothingFromAPreviousRunStaysInIncoming(t *testing.T) {
	dir := t.TempDir()
	left := filepath.Join(dir, "incoming", "left-by-a-crash")
	if err := os.MkdirAll(filepath.Dir(left), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(left, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	c := browsertest.New()
	var on atomic.Bool
	on.Store(true)
	s := browser.New(browser.Options{Dir: dir, Launch: c.Launch, Enabled: on.Load, Idle: time.Hour, Log: slog.New(slog.DiscardHandler)})
	t.Cleanup(s.Close)
	v, err := s.Watch("thread:a", 640, 480, "")
	if err != nil {
		t.Fatal(err)
	}
	next(t, v, "ready", ready)
	if _, err := os.Stat(left); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("still there: %v", err)
	}
}
