package browser_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/browser"
	"github.com/alexwaumann/code-foundry/internal/store/browser/browsertest"
)

// What a hostile page does to the store, on a fake Chrome. live_test.go runs the same on a real one.

const frameSession = "session-frame"

func secure(c *browsertest.Chrome, session, url, origin string) {
	c.Emit("Page.frameNavigated", session, map[string]any{"frame": map[string]any{"id": "main", "url": url, "securityOrigin": origin}})
}

func pushed(c *browsertest.Chrome, session, url string) {
	c.Emit("Page.navigatedWithinDocument", session, map[string]any{"frameId": "target-1", "url": url})
}

func calledOn(c *browsertest.Chrome, session string) []string {
	var out []string
	for _, x := range c.Calls("") {
		if x.Session == session {
			out = append(out, x.Method)
		}
	}
	return out
}

func TestNoSessionHandsItsConsoleToThePipe(t *testing.T) {
	f, _, _ := surfaceFixture(t)
	attachFrame(f, page, frameSession, "frame-1")
	eventually(t, "the frame", func() bool { return len(f.c.Calls("Runtime.runIfWaitingForDebugger")) == 1 })
	for _, method := range []string{"Runtime.enable", "Runtime.addBinding", "Log.enable", "Network.enable"} {
		if n := len(f.c.Calls(method)); n != 0 {
			t.Fatalf("%s called %d times", method, n)
		}
	}
}

func TestAPageThatFloodsThePipeIsClosedAndNoOtherIs(t *testing.T) {
	long := "https://evil.example/" + strings.Repeat("p", 2_000_000)
	tests := []struct {
		name  string
		flood func(c *browsertest.Chrome)
	}{
		{"long addresses", func(c *browsertest.Chrome) { pushed(c, page, long) }},
		{"long addresses in a subframe", func(c *browsertest.Chrome) {
			c.Emit("Page.navigatedWithinDocument", page, map[string]any{"frameId": "sub", "url": long})
		}},
		{"events it has no handler for", func(c *browsertest.Chrome) {
			c.Emit("Page.frameAttached", page, map[string]any{"frameId": strings.Repeat("x", 1<<20)})
		}},
		{"small events without end", func(c *browsertest.Chrome) {
			for i := range 1000 {
				c.Emit("Page.frameAttached", page, map[string]any{"frameId": i})
			}
		}},
		{"target info", func(c *browsertest.Chrome) {
			c.Emit("Target.targetInfoChanged", "", map[string]any{"targetInfo": map[string]any{"targetId": "target-1", "type": "page", "url": long}})
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, v, _ := surfaceFixture(t)
			other, err := f.s.Watch("thread:b", 640, 480, "")
			if err != nil {
				t.Fatal(err)
			}
			next(t, other, "the other page", ready)
			secure(f.c, page, "https://evil.example/", "https://evil.example")
			next(t, v, "the page", func(st browser.State) bool { return st.Site == "evil.example" })
			for range 20 {
				tt.flood(f.c)
			}
			st := next(t, v, "the notice", func(st browser.State) bool { return strings.Contains(st.Notice, "flooding") })
			if !strings.Contains(st.Notice, "evil.example") {
				t.Fatalf("notice %q", st.Notice)
			}
			eventually(t, "the close", func() bool { return len(f.c.Calls("Target.closeTarget")) == 1 })
			if c := f.c.Calls("Target.closeTarget")[0]; c.Params["targetId"] != "target-1" {
				t.Fatalf("closed %+v", c)
			}
		})
	}
}

func TestAPageLoadingIsNoFlood(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	for i := range 2000 {
		f.c.Emit("Page.frameAttached", page, map[string]any{"frameId": fmt.Sprint(i)})
	}
	pushed(f.c, page, "https://page.example/"+strings.Repeat("p", 1<<20))
	next(t, v, "the address", func(st browser.State) bool { return strings.HasPrefix(st.URL, "https://page.example/") })
	if n := len(f.c.Calls("Target.closeTarget")); n != 0 {
		t.Fatalf("closed %d", n)
	}
}

func TestAnIframesFloodIsChargedToItsPage(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	attachFrame(f, page, frameSession, "frame-1")
	eventually(t, "the frame", func() bool { return len(f.c.Calls("Runtime.runIfWaitingForDebugger")) == 1 })
	for range 20 {
		f.c.Emit("Page.navigatedWithinDocument", frameSession, map[string]any{"frameId": "frame-1", "url": strings.Repeat("p", 1<<20)})
	}
	next(t, v, "the notice", func(st browser.State) bool { return strings.Contains(st.Notice, "flooding") })
	eventually(t, "the close", func() bool { return len(f.c.Calls("Target.closeTarget")) == 1 })
}

func TestDocumentOpenInALoopStartsOneGoroutine(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	secure(f.c, page, "https://page.example/", "https://page.example")
	next(t, v, "the page", func(st browser.State) bool { return st.Site == "page.example" })
	before := runtime.NumGoroutine()
	var most atomic.Int64
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
				most.Store(max(most.Load(), int64(runtime.NumGoroutine())))
				runtime.Gosched()
			}
		}
	}()
	reads := len(f.c.Calls("Page.getNavigationHistory"))
	for range 2000 {
		f.c.Emit("Page.documentOpened", page, map[string]any{"frame": map[string]any{"id": "main", "url": "https://page.example/", "securityOrigin": "https://page.example"}})
		f.c.Emit("Page.frameStoppedLoading", page, map[string]any{"frameId": "target-1"})
	}
	if grew := most.Load() - int64(before); grew > 40 {
		t.Fatalf("%d goroutines for 4000 events", grew)
	}
	if n := len(f.c.Calls("Page.getNavigationHistory")) - reads; n > 20 {
		t.Fatalf("read the history %d times", n)
	}
}

func TestPacedWorkStillLands(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	f.c.Reply("Page.getNavigationHistory", func(browsertest.Call) (any, error) {
		return map[string]any{"currentIndex": 1, "entries": []map[string]any{{"id": 1, "url": "https://a.example/"}, {"id": 2, "url": "https://b.example/", "title": "After"}}}, nil
	})
	for range 50 {
		secure(f.c, page, "https://b.example/", "https://b.example")
	}
	next(t, v, "the last word", func(st browser.State) bool { return st.Title == "After" && st.CanGoBack })
}

func TestTheAddressReadsChromesOriginAndNotTheAddress(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	secure(f.c, page, "http://evil.test:81/", "http://evil.test:81")
	next(t, v, "the page", func(st browser.State) bool { return st.Site == "evil.test" })

	pushed(f.c, page, "http://evil.test:81/%zz")
	st := next(t, v, "the push", func(st browser.State) bool { return strings.HasSuffix(st.URL, "/%zz") })
	if st.Origin != "http://evil.test:81" || st.Site != "evil.test" {
		t.Fatalf("after /%%zz: origin %q site %q", st.Origin, st.Site)
	}

	f.c.Emit("Page.javascriptDialogOpening", page, map[string]any{"url": "http://evil.test:81/%zz", "message": "hi", "type": "alert"})
	st = next(t, v, "the dialog", func(st browser.State) bool { return st.Dialog != nil })
	if st.Dialog.Origin != "http://evil.test:81" || st.Dialog.Site != "evil.test" {
		t.Fatalf("dialog: %+v", st.Dialog)
	}
}

func TestADialogFromABlankFrameNamesThePage(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	secure(f.c, page, "http://evil.test/", "http://evil.test")
	f.c.Emit("Page.javascriptDialogOpening", page, map[string]any{"url": "about:blank", "message": "hi", "type": "alert"})
	st := next(t, v, "the dialog", func(st browser.State) bool { return st.Dialog != nil })
	if st.Dialog.Origin != "http://evil.test" || st.Dialog.Site != "evil.test" {
		t.Fatalf("dialog: %+v", st.Dialog)
	}
}

func TestABlankPageShowsTheOriginItInheritedAndIsNotSecure(t *testing.T) {
	tests := []struct {
		name               string
		url, origin        string
		wantOrigin, wantIs string
	}{
		{"an opener sent to about:blank by its popup", "about:blank", "https://evil.test", "https://evil.test", browser.SecurityInsecure},
		{"the same with nothing to inherit", "about:blank", "://", "", browser.SecurityInsecure},
		{"blob", "blob:https://evil.test/1", "https://evil.test", "https://evil.test", browser.SecurityInsecure},
		{"data", "data:text/html,x", "://", "", browser.SecurityInsecure},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, v, _ := surfaceFixture(t)
			secure(f.c, page, "https://evil.test/", "https://evil.test")
			next(t, v, "the page", func(st browser.State) bool { return st.Site == "evil.test" })
			secure(f.c, page, tt.url, tt.origin)
			st := next(t, v, "the blank", func(st browser.State) bool { return st.URL == tt.url })
			if st.Origin != tt.wantOrigin || st.Security != tt.wantIs {
				t.Fatalf("origin %q security %q", st.Origin, st.Security)
			}
		})
	}
}

func TestABlankPageIsAskedWhoItIsWhenChromeDoesNotSay(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	f.c.Reply("Runtime.evaluate", func(c browsertest.Call) (any, error) {
		if c.Params["expression"] == "self.origin" {
			return map[string]any{"result": map[string]any{"value": "http://evil.test:81"}}, nil
		}
		return map[string]any{"result": map[string]any{}}, nil
	})
	secure(f.c, page, "http://evil.test:81/", "http://evil.test:81")
	next(t, v, "the page", func(st browser.State) bool { return st.Site == "evil.test" })
	secure(f.c, page, "about:blank", "://")
	st := next(t, v, "the blank", func(st browser.State) bool { return st.URL == "about:blank" && st.Site == "evil.test" })
	if st.Origin != "http://evil.test:81" || st.Security != browser.SecurityInsecure {
		t.Fatalf("origin %q security %q", st.Origin, st.Security)
	}
}

func TestTheBlankASurfaceStartsOnIsNoPage(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	secure(f.c, page, "about:blank", "://")
	st := next(t, v, "the blank", func(st browser.State) bool { return st.URL == "about:blank" })
	if st.Security != "" || st.Origin != "" {
		t.Fatalf("security %q origin %q", st.Security, st.Origin)
	}
}

func TestAStaleReadOfAPopupNeverReplacesItsCommit(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	release := make(chan struct{})
	asked := make(chan struct{}, 1)
	f.c.Reply("Runtime.evaluate", func(c browsertest.Call) (any, error) {
		if c.Params["expression"] != addressRead {
			return map[string]any{"result": map[string]any{}}, nil
		}
		asked <- struct{}{}
		<-release
		return map[string]any{"result": map[string]any{"value": []string{"about:blank", "https://opener.example"}}}, nil
	})
	f.c.Reply("Target.attachToTarget", func(c browsertest.Call) (any, error) {
		if c.Params["targetId"] == "popup" {
			return map[string]string{"sessionId": popup}, nil
		}
		return map[string]string{"sessionId": "session-" + c.Params["targetId"].(string)}, nil
	})
	f.c.Emit("Target.targetCreated", "", map[string]any{"targetInfo": map[string]any{"targetId": "popup", "type": "page", "openerId": "target-1"}})
	<-asked
	secure(f.c, popup, "https://popup.example/", "https://popup.example")
	next(t, v, "the commit", func(st browser.State) bool { return st.URL == "https://popup.example/" })
	close(release)
	if st := latest(f, v); st.URL != "" && st.URL != "https://popup.example/" {
		t.Fatalf("went back to %q", st.URL)
	}
	f.c.Emit("Page.javascriptDialogOpening", popup, map[string]any{"url": "https://popup.example/", "message": "hi", "type": "alert"})
	st := next(t, v, "the dialog", func(st browser.State) bool { return st.Dialog != nil })
	if st.URL != "https://popup.example/" {
		t.Fatalf("address %q", st.URL)
	}
}

// attachFrame is Chrome putting a cross-site iframe on a session, paused.
func attachFrame(f *fixture, parent, session, id string) {
	f.c.Emit("Target.attachedToTarget", parent, map[string]any{
		"sessionId": session, "waitingForDebugger": true,
		"targetInfo": map[string]any{"targetId": id, "type": "iframe", "url": ""},
	})
}

func TestEveryIframeIsInterceptedBeforeItRuns(t *testing.T) {
	f, _, _ := surfaceFixture(t)
	if !slices.Contains(calledOn(f.c, page), "Target.setAutoAttach") {
		t.Fatal("the page does not attach to its iframes")
	}
	attachFrame(f, page, frameSession, "frame-1")
	const nested = "session-nested"
	eventually(t, "the frame", func() bool {
		return len(calledOn(f.c, frameSession)) > 0 && slices.Contains(calledOn(f.c, frameSession), "Runtime.runIfWaitingForDebugger")
	})
	attachFrame(f, frameSession, nested, "frame-2")
	eventually(t, "the nested frame", func() bool { return slices.Contains(calledOn(f.c, nested), "Runtime.runIfWaitingForDebugger") })
	for _, session := range []string{frameSession, nested} {
		calls := calledOn(f.c, session)
		run := slices.Index(calls, "Runtime.runIfWaitingForDebugger")
		for _, need := range []string{"Page.enable", "Page.setInterceptFileChooserDialog", "WebAuthn.enable", "Page.addScriptToEvaluateOnNewDocument", "Target.setAutoAttach"} {
			if i := slices.Index(calls, need); i < 0 || i > run {
				t.Fatalf("%s: %s at %d, running at %d: %v", session, need, i, run, calls)
			}
		}
	}
}

func TestAnIframeWhoseSetUpFailedStaysPaused(t *testing.T) {
	f, _, _ := surfaceFixture(t)
	f.c.Reply("Page.setInterceptFileChooserDialog", func(browsertest.Call) (any, error) { return nil, errors.New("no") })
	attachFrame(f, page, frameSession, "frame-1")
	eventually(t, "the try", func() bool { return slices.Contains(calledOn(f.c, frameSession), "Page.setInterceptFileChooserDialog") })
	time.Sleep(50 * time.Millisecond)
	if slices.Contains(calledOn(f.c, frameSession), "Runtime.runIfWaitingForDebugger") {
		t.Fatal("it ran with its file input loose")
	}
}

func TestAPageCannotMakeSessionsWithoutEnd(t *testing.T) {
	f, _, _ := surfaceFixture(t)
	for i := range 36 {
		attachFrame(f, page, fmt.Sprint("s", i), fmt.Sprint("f", i))
	}
	eventually(t, "the frames", func() bool { return len(f.c.Calls("Runtime.runIfWaitingForDebugger")) == 32 })
	time.Sleep(50 * time.Millisecond)
	if n := len(f.c.Calls("Runtime.runIfWaitingForDebugger")); n != 32 {
		t.Fatalf("%d frames", n)
	}
	// One going makes room.
	f.c.Emit("Target.detachedFromTarget", page, map[string]any{"sessionId": "s0"})
	attachFrame(f, page, "s-late", "f-late")
	eventually(t, "the late one", func() bool { return slices.Contains(calledOn(f.c, "s-late"), "Runtime.runIfWaitingForDebugger") })
}

func frameHeadsFor(c *browsertest.Chrome, url string, i int) {
	c.Emit("Page.frameStartedNavigating", page, map[string]any{"frameId": fmt.Sprint("f", i), "url": url, "navigationType": "differentDocument"})
}

func TestAPageSendingFramesToNewSitesInALoopIsClosed(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	secure(f.c, page, "https://page.example/", "https://page.example")
	next(t, v, "the page", func(st browser.State) bool { return st.Site == "page.example" })
	for i := range 200 {
		frameHeadsFor(f.c, fmt.Sprintf("https://x%d.example/", i), i)
	}
	next(t, v, "the notice", func(st browser.State) bool { return strings.Contains(st.Notice, "flooding") })
	eventually(t, "the close", func() bool { return len(f.c.Calls("Target.closeTarget")) == 1 })
}

func TestAPageWithManyFramesLoads(t *testing.T) {
	tests := []struct {
		name  string
		count int
		url   string
	}{
		{"on other sites", 30, "https://ads.example/x"},
		{"on its own site", 2000, "https://www.page.example/x"},
		{"with no site", 2000, "about:srcdoc"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, v, _ := surfaceFixture(t)
			secure(f.c, page, "https://page.example/", "https://page.example")
			next(t, v, "the page", func(st browser.State) bool { return st.Site == "page.example" })
			for i := range tt.count {
				frameHeadsFor(f.c, tt.url, i)
			}
			if st := latest(f, v); strings.Contains(st.Notice, "flooding") {
				t.Fatalf("closed for %d frames: %q", tt.count, st.Notice)
			}
		})
	}
}

func TestAFileInputInAnIframeAnswersThere(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	secure(f.c, page, "https://page.example/", "https://page.example")
	attachFrame(f, page, frameSession, "frame-1")
	eventually(t, "the frame", func() bool { return slices.Contains(calledOn(f.c, frameSession), "Runtime.runIfWaitingForDebugger") })
	f.c.Emit("Page.frameNavigated", frameSession, map[string]any{"frame": map[string]any{"id": "frame-1", "parentId": "main", "url": "https://ads.example/x", "securityOrigin": "https://ads.example"}})
	f.c.Emit("Page.fileChooserOpened", frameSession, map[string]any{"frameId": "frame-1", "mode": "selectSingle", "backendNodeId": 9})
	st := next(t, v, "the chooser", func(st browser.State) bool { return st.FileChooser != nil })
	if st.FileChooser.Site != "ads.example" {
		t.Fatalf("named %q, not the frame", st.FileChooser.Site)
	}
	if err := f.s.AnswerFile(context.Background(), "thread:a", st.FileChooser.ID, []string{"/etc/hosts"}); err != nil {
		t.Fatal(err)
	}
	if c := f.c.Calls("DOM.setFileInputFiles"); len(c) != 1 || c[0].Session != frameSession {
		t.Fatalf("answered %+v", c)
	}
}

func TestAnIframesDownloadBelongsToItsPageAndPassesOnNoClick(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	secure(f.c, page, "https://page.example/", "https://page.example")
	attachFrame(f, page, frameSession, "frame-1")
	eventually(t, "the frame", func() bool { return slices.Contains(calledOn(f.c, frameSession), "Runtime.runIfWaitingForDebugger") })
	f.c.Emit("Page.frameNavigated", frameSession, map[string]any{"frame": map[string]any{"id": "frame-1", "parentId": "main", "url": "https://ads.example/x", "securityOrigin": "https://ads.example"}})
	click(t, f)
	f.c.Emit("Page.downloadWillBegin", frameSession, map[string]any{"frameId": "frame-1", "guid": "g", "url": "https://ads.example/a.bin", "suggestedFilename": "a.bin"})
	st := next(t, v, "the question", func(st browser.State) bool { return states(st)[browser.DownloadAsking] == 1 })
	if st.Downloads[0].Site != "ads.example" {
		t.Fatalf("site %q", st.Downloads[0].Site)
	}
}

func TestAHiddenPagesIframeAsksNobody(t *testing.T) {
	f, shown, _ := surfaceFixture(t)
	hidden, err := f.s.Watch("thread:hidden", 640, 480, "")
	if err != nil {
		t.Fatal(err)
	}
	next(t, hidden, "its page", ready)
	const hiddenPage = "session-target-2"
	attachFrame(f, hiddenPage, frameSession, "frame-1")
	eventually(t, "the frame", func() bool { return slices.Contains(calledOn(f.c, frameSession), "Runtime.runIfWaitingForDebugger") })
	hidden.Close()
	f.c.Emit("Page.downloadWillBegin", frameSession, map[string]any{"frameId": "frame-1", "guid": "g", "suggestedFilename": "a.bin"})
	eventually(t, "the cancel", func() bool { return len(f.c.Calls("Browser.cancelDownload")) == 1 })
	if st := latest(f, shown); len(st.Downloads) != 0 {
		t.Fatalf("the surface on screen was asked: %+v", st.Downloads)
	}
}

func press(f *fixture, key string) {
	f.t.Helper()
	k := &browser.KeyEvent{Type: "keyDown", Key: key, Code: key}
	if err := f.s.Input(context.Background(), "thread:a", []browser.InputEvent{{Key: k}}); err != nil {
		f.t.Fatal(err)
	}
}

// focusOn makes the page's helper answer that the keyboard is on a link, or is not.
func focusOn(c *browsertest.Chrome, link bool) {
	c.Reply("Runtime.evaluate", func(call browsertest.Call) (any, error) {
		if call.Params["expression"] == "__cfOnLink()" {
			return map[string]any{"result": map[string]any{"value": link}}, nil
		}
		return map[string]any{"result": map[string]any{"value": ""}}, nil
	})
}

func TestWhatCountsAsAGesture(t *testing.T) {
	tests := []struct {
		name string
		do   func(f *fixture)
		want string
	}{
		{"a click", func(f *fixture) { click(t, f) }, browser.DownloadInProgress},
		{"Enter on a link", func(f *fixture) { focusOn(f.c, true); press(f, "Enter") }, browser.DownloadInProgress},
		{"Enter anywhere else", func(f *fixture) { focusOn(f.c, false); press(f, "Enter") }, browser.DownloadAsking},
		{"Space", func(f *fixture) { focusOn(f.c, true); press(f, " ") }, browser.DownloadAsking},
		{"typing", func(f *fixture) { focusOn(f.c, true); press(f, "a") }, browser.DownloadAsking},
		{"a click, then a page's navigation", func(f *fixture) {
			click(t, f)
			committed(f.c, page, "https://next.example/")
		}, browser.DownloadAsking},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, v, _ := surfaceFixture(t)
			committed(f.c, page, "https://page.example/")
			next(t, v, "the page", func(st browser.State) bool { return st.URL == "https://page.example/" })
			tt.do(f)
			download(f.c, page, "g", "a.bin")
			next(t, v, "the verdict", func(st browser.State) bool { return states(st)[tt.want] == 1 })
		})
	}
}

func TestAPressIsReadForASelectAndAnsweredWhereItOpened(t *testing.T) {
	report, _ := json.Marshal(map[string]any{"t": "select", "selected": 1, "x": 3, "y": 4, "w": 50, "options": []map[string]any{{"label": "one"}, {"label": "two"}}})
	f, v, _ := surfaceFixture(t)
	f.c.Reply("Runtime.evaluate", func(call browsertest.Call) (any, error) {
		if call.Params["expression"] == "__cfTake()" {
			return map[string]any{"result": map[string]any{"value": string(report)}}, nil
		}
		return map[string]any{"result": map[string]any{}}, nil
	})
	if err := f.s.Input(context.Background(), "thread:a", []browser.InputEvent{{Mouse: &browser.MouseEvent{Type: "mousePressed", Button: "left", X: 10, Y: 20}}}); err != nil {
		t.Fatal(err)
	}
	st := next(t, v, "the select", func(st browser.State) bool { return st.Select != nil })
	if st.Select.Selected != 1 || len(st.Select.Options) != 2 || st.Select.X != 3 || st.Select.Y != 4 {
		t.Fatalf("select %+v", st.Select)
	}
	if err := f.s.PickSelect(context.Background(), "thread:a", st.Select.ID, 0); err != nil {
		t.Fatal(err)
	}
	calls := f.c.Calls("Runtime.evaluate")
	if c := calls[len(calls)-1]; c.Session != page || c.Params["contextId"] != 7.0 || c.Params["expression"] != "__cfPick(0)" {
		t.Fatalf("picked %+v", c)
	}
}

func TestASelectInAnIframeOpensWhereTheUserPressed(t *testing.T) {
	report, _ := json.Marshal(map[string]any{"t": "select", "selected": 0, "x": 3, "y": 4, "w": 50, "options": []map[string]any{{"label": "one"}}})
	f, v, _ := surfaceFixture(t)
	attachFrame(f, page, frameSession, "frame-1")
	eventually(t, "the frame", func() bool { return slices.Contains(calledOn(f.c, frameSession), "Runtime.runIfWaitingForDebugger") })
	f.c.Reply("Page.getFrameTree", func(call browsertest.Call) (any, error) {
		return map[string]any{"frameTree": map[string]any{"frame": map[string]any{"id": "frame-of-" + call.Session}}}, nil
	})
	f.c.Reply("Runtime.evaluate", func(call browsertest.Call) (any, error) {
		switch {
		case call.Session == page:
			return map[string]any{"result": map[string]any{"value": "frame"}}, nil
		case call.Params["expression"] == "__cfTake()":
			return map[string]any{"result": map[string]any{"value": string(report)}}, nil
		}
		return map[string]any{"result": map[string]any{}}, nil
	})
	if err := f.s.Input(context.Background(), "thread:a", []browser.InputEvent{{Mouse: &browser.MouseEvent{Type: "mousePressed", Button: "left", X: 100, Y: 200}}}); err != nil {
		t.Fatal(err)
	}
	st := next(t, v, "the select", func(st browser.State) bool { return st.Select != nil })
	if st.Select.X != 100 || st.Select.Y != 200 {
		t.Fatalf("select %+v", st.Select)
	}
	if err := f.s.PickSelect(context.Background(), "thread:a", st.Select.ID, 0); err != nil {
		t.Fatal(err)
	}
	calls := f.c.Calls("Runtime.evaluate")
	if c := calls[len(calls)-1]; c.Session != frameSession {
		t.Fatalf("picked on %q", c.Session)
	}
}

func TestASelectReadAcrossANavigationIsDropped(t *testing.T) {
	report, _ := json.Marshal(map[string]any{"t": "select", "options": []map[string]any{{"label": "one"}}})
	f, v, _ := surfaceFixture(t)
	f.c.Reply("Runtime.evaluate", func(call browsertest.Call) (any, error) {
		if call.Params["expression"] == "__cfTake()" {
			committed(f.c, page, "https://next.example/")
			return map[string]any{"result": map[string]any{"value": string(report)}}, nil
		}
		return map[string]any{"result": map[string]any{}}, nil
	})
	if err := f.s.Input(context.Background(), "thread:a", []browser.InputEvent{{Mouse: &browser.MouseEvent{Type: "mousePressed", Button: "left"}}}); err != nil {
		t.Fatal(err)
	}
	next(t, v, "the next page", func(st browser.State) bool { return st.URL == "https://next.example/" })
	if st := latest(f, v); st.Select != nil {
		t.Fatalf("a select from the last page: %+v", st.Select)
	}
}

// A popup's address read through Page.getFrameTree failed for a page with 20 frames of 2 MB
// addresses ("message is too long"), and the bar stayed empty, with no site and no mark, over
// the fake sign-in the opener wrote into it.
func TestAPopupNobodyCouldReadSaysSoAndIsNotSecure(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	secure(f.c, page, "http://evil.test/", "http://evil.test")
	f.c.Reply("Runtime.evaluate", func(c browsertest.Call) (any, error) {
		if c.Params["expression"] == addressRead {
			return nil, errors.New("message is too long")
		}
		return map[string]any{"result": map[string]any{}}, nil
	})
	openPopup(t, f, v)
	st := next(t, v, "the popup, read", func(st browser.State) bool { return st.Popup })
	time.Sleep(50 * time.Millisecond)
	if last := latest(f, v); last.Popup {
		st = last
	}
	if st.URL != "" || st.Origin != "" || st.Site != "" || st.Security != browser.SecurityInsecure {
		t.Fatalf("url %q origin %q site %q security %q", st.URL, st.Origin, st.Site, st.Security)
	}
	if n := len(f.c.Calls("Page.getFrameTree")); n != 0 {
		t.Fatalf("Page.getFrameTree called %d times: a page can make its reply too long to read", n)
	}
}

// The opener spent its allowance and was closed, leaving its popup alone on the surface: a blank
// with a fake sign-in and, before, no mark, since the rule counted the stack.
func TestAPopupWhoseOpenerWentIsStillAPopup(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	secure(f.c, page, "http://evil.test/", "http://evil.test")
	answerAddress(f.c, "about:blank", "://")
	openPopup(t, f, v)
	next(t, v, "the popup's address", func(st browser.State) bool { return st.Popup && st.URL == "about:blank" })
	latest(f, v)
	f.c.Emit("Target.targetDestroyed", "", map[string]any{"targetId": "target-1"})
	// Said at once: nothing else need happen for the surface to say it has no way back.
	st := latest(f, v)
	if st.Popup || st.CanGoBack {
		t.Fatalf("popup %v, back %v, with the opener gone", st.Popup, st.CanGoBack)
	}
	if st.URL != "about:blank" || st.Security != browser.SecurityInsecure {
		t.Fatalf("url %q security %q", st.URL, st.Security)
	}
}

// A popup whose set-up failed stayed in Chrome, unwatched and tracked, for as long as Chrome ran.
func TestAPopupThatCannotBeSetUpIsClosed(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	f.c.Reply("Target.attachToTarget", func(c browsertest.Call) (any, error) {
		if c.Params["targetId"] == "popup" {
			return map[string]string{"sessionId": popup}, nil
		}
		return map[string]string{"sessionId": "session-" + c.Params["targetId"].(string)}, nil
	})
	f.c.Reply("Page.enable", func(c browsertest.Call) (any, error) {
		if c.Session == popup {
			return nil, errors.New("timed out")
		}
		return map[string]any{}, nil
	})
	f.c.Emit("Target.targetCreated", "", map[string]any{"targetInfo": map[string]any{"targetId": "popup", "type": "page", "openerId": "target-1"}})
	eventually(t, "the close", func() bool {
		c := f.c.Calls("Target.closeTarget")
		return len(c) == 1 && c[0].Params["targetId"] == "popup"
	})
	if st := latest(f, v); st.Popup {
		t.Fatal("it showed")
	}
	// Nothing of it is left to route: its events reach no handler.
	f.c.Emit("Page.javascriptDialogOpening", popup, map[string]any{"url": "https://popup.example/", "message": "hi", "type": "alert"})
	if st := latest(f, v); st.Dialog != nil {
		t.Fatalf("its dialog showed: %+v", st.Dialog)
	}
}

// Each visit to a page with a frame in a frame left the inner one counted, as Chrome says nothing
// of a session whose parent session went: after about 31 visits new cross-site frames never ran.
func TestFramesInsideAFrameGoWithIt(t *testing.T) {
	f, _, _ := surfaceFixture(t)
	for i := range 40 {
		outer, inner := fmt.Sprint("outer", i), fmt.Sprint("inner", i)
		attachFrame(f, page, outer, "fo"+fmt.Sprint(i))
		attachFrame(f, outer, inner, "fi"+fmt.Sprint(i))
		f.c.Emit("Target.detachedFromTarget", page, map[string]any{"sessionId": outer})
	}
	// The next visit's frame, and the frame inside it, both run.
	attachFrame(f, page, "s-late", "f-late")
	attachFrame(f, "s-late", "s-late-inner", "f-late-inner")
	eventually(t, "the late frames", func() bool {
		return slices.Contains(calledOn(f.c, "s-late"), "Runtime.runIfWaitingForDebugger") &&
			slices.Contains(calledOn(f.c, "s-late-inner"), "Runtime.runIfWaitingForDebugger")
	})
}

func TestANewDocumentStartsWithNoFramesCounted(t *testing.T) {
	f, _, _ := surfaceFixture(t)
	for i := range 32 {
		attachFrame(f, page, fmt.Sprint("s", i), fmt.Sprint("f", i))
	}
	eventually(t, "the frames", func() bool { return len(f.c.Calls("Runtime.runIfWaitingForDebugger")) == 32 })
	// Chrome sends no detach for any of them.
	secure(f.c, page, "https://next.example/", "https://next.example")
	attachFrame(f, page, "s-next", "f-next")
	eventually(t, "the new page's frame", func() bool { return slices.Contains(calledOn(f.c, "s-next"), "Runtime.runIfWaitingForDebugger") })
}

// frameOf takes frames off v until one comes, or says there was none.
func frameOf(v *browser.Viewer, wait time.Duration) []byte {
	deadline := time.After(wait)
	for {
		select {
		case <-v.Wake():
			if _, fr, _ := v.Take(); fr != nil {
				fr.Taken()
				return fr.JPEG
			}
		case <-deadline:
			return nil
		}
	}
}

// A page on one site sent its visitor to another whose first paint was slow, or that paints
// nothing: the last frame stayed on screen under the new site's address.
func TestACommitToAnotherSiteCoversTheLastFrame(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	shots := make(chan struct{})
	f.c.Reply("Page.captureScreenshot", func(browsertest.Call) (any, error) {
		<-shots
		return nil, errors.New("no paint yet")
	})
	t.Cleanup(func() { close(shots) })
	secure(f.c, page, "https://evil.example/", "https://evil.example")
	f.c.Frame(page, 1, []byte("evil"), 640, 480)
	if got := frameOf(v, time.Second); string(got) != "evil" {
		t.Fatalf("frame %q", got)
	}
	// The same site keeps its frame: Chrome holds the old paint there itself.
	secure(f.c, page, "https://evil.example/2", "https://evil.example")
	if st := next(t, v, "the same site", func(st browser.State) bool { return strings.HasSuffix(st.URL, "/2") }); st.AwaitingFrame {
		t.Fatal("covered on the same site")
	}
	// One more frame of the evil page waits untaken when the commit lands.
	f.c.Frame(page, 2, []byte("evil, late"), 640, 480)
	time.Sleep(20 * time.Millisecond)
	secure(f.c, page, "https://bank.example/", "https://bank.example")
	st := next(t, v, "the bank", func(st browser.State) bool { return st.Site == "bank.example" })
	if !st.AwaitingFrame {
		t.Fatal("the evil page's frame stands under the bank's address")
	}
	if got := frameOf(v, 100*time.Millisecond); got != nil {
		t.Fatalf("a viewer was sent %q after the commit", got)
	}
	// A new viewer gets no old frame either.
	other, err := f.s.Watch("thread:a", 640, 480, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := frameOf(other, 100*time.Millisecond); got != nil {
		t.Fatalf("a new viewer was sent %q", got)
	}
	other.Close()
	f.c.Frame(page, 3, []byte("bank"), 640, 480)
	next(t, v, "uncovered", func(st browser.State) bool { return !st.AwaitingFrame })
}

// A screenshot asked for before a commit and answered after it is the page before.
func TestAScreenshotAcrossACommitIsNotTheNewPages(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	secure(f.c, page, "https://evil.example/", "https://evil.example")
	next(t, v, "the page", func(st browser.State) bool { return st.Site == "evil.example" && !st.AwaitingFrame })
	// The fake answers one call at a time: what the commit asked for is answered before a reply
	// that waits.
	eventually(t, "the commit's work", func() bool { return len(f.c.Calls("Page.getNavigationHistory")) > 0 })
	time.Sleep(150 * time.Millisecond)
	asked := make(chan struct{}, 8)
	release := make(chan struct{})
	var shots atomic.Int32
	f.c.Reply("Page.captureScreenshot", func(browsertest.Call) (any, error) {
		if shots.Add(1) > 1 {
			// The bank's own, which has not painted yet.
			return nil, errors.New("no paint yet")
		}
		asked <- struct{}{}
		<-release
		return map[string]any{"data": "ZXZpbA=="}, nil // "evil"
	})
	// The page finishing its load asks for a picture of it.
	f.c.Emit("Page.frameStoppedLoading", page, map[string]any{"frameId": "target-1"})
	<-asked
	secure(f.c, page, "https://bank.example/", "https://bank.example")
	next(t, v, "the bank, covered", func(st browser.State) bool { return st.Site == "bank.example" && st.AwaitingFrame })
	close(release)
	time.Sleep(50 * time.Millisecond)
	if st := latest(f, v); st.Site == "bank.example" && !st.AwaitingFrame {
		t.Fatal("the evil page's screenshot uncovered the bank")
	}
}

// history.pushState with 64 MB states swelled Chrome's own process to 2.4 GB, where nothing names
// a page. The page that pushed is the one closed; a busy neighbour is not touched.
func TestASwellIsBlamedOnThePageThatPushedHistory(t *testing.T) {
	f, evil, _ := surfaceFixture(t)
	secure(f.c, page, "https://evil.example/", "https://evil.example")
	calm, err := f.s.Watch("thread:calm", 640, 480, "")
	if err != nil {
		t.Fatal(err)
	}
	next(t, calm, "the calm page", ready)
	const calmPage = "session-target-2"
	secure(f.c, calmPage, "https://calm.example/", "https://calm.example")
	next(t, calm, "the calm site", func(st browser.State) bool { return st.Site == "calm.example" })
	if f.c.Swell() {
		t.Fatal("blamed with no history pushed")
	}
	for i := range 11 {
		pushed(f.c, page, fmt.Sprint("https://evil.example/s", i))
	}
	// A pushState of the calm page's own, once, is not the most.
	f.c.Emit("Page.navigatedWithinDocument", calmPage, map[string]any{"frameId": "target-2", "url": "https://calm.example/next"})
	next(t, evil, "the pushes", func(st browser.State) bool { return st.URL == "https://evil.example/s10" })
	next(t, calm, "the calm push", func(st browser.State) bool { return st.URL == "https://calm.example/next" })
	f.c.Emit("Page.navigatedWithinDocument", calmPage, map[string]any{"frameId": "target-2", "url": "https://calm.example/next"})
	if !f.c.Swell() {
		t.Fatal("nobody blamed")
	}
	eventually(t, "the close", func() bool { return len(f.c.Calls("Target.closeTarget")) == 1 })
	if c := f.c.Calls("Target.closeTarget")[0]; c.Params["targetId"] != "target-1" {
		t.Fatalf("closed %v", c.Params["targetId"])
	}
	next(t, evil, "the notice", func(st browser.State) bool { return strings.Contains(st.Notice, "evil.example was closed") })
	if st := latest(f, calm); st.Notice != "" {
		t.Fatalf("the calm page says %q", st.Notice)
	}
}

// A popup that committed and loaded before its session was set up sends no event for either: on a
// loaded machine its title stayed empty, and nothing would ever read it.
func TestAPopupThatLoadedBeforeItsSetUpGetsItsTitle(t *testing.T) {
	f, v, _ := surfaceFixture(t)
	answerAddress(f.c, "https://popup.example/two", "https://popup.example")
	f.c.Reply("Page.getNavigationHistory", func(c browsertest.Call) (any, error) {
		if c.Session == popup {
			return map[string]any{"currentIndex": 0, "entries": []map[string]any{{"id": 1, "url": "https://popup.example/two", "title": "Two"}}}, nil
		}
		return map[string]any{"currentIndex": 0, "entries": []map[string]any{{"id": 1}}}, nil
	})
	openPopup(t, f, v)
	next(t, v, "the popup's title", func(st browser.State) bool { return st.Popup && st.Title == "Two" })
}
