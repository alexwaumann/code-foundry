package browser

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// These run the real system Chrome against pages served from this test, never the network: a
// wrapper (liveChrome) gives it a home of its own, a mock keychain, and a resolver that knows only
// this machine. They skip on a Mac without Chrome, and in CI: a runner has Chrome, and is starved
// enough that a page can take 15 s to load, so they would only make it red at random. `make check`
// runs them.

const livePage = `<!doctype html><title>Live page</title>
<body style="margin:0;font:16px system-ui;height:3000px">
<select id=s style="position:fixed;left:20px;top:20px;width:200px;height:30px"><option>one<option>two<option disabled>three<option>four</select>
<textarea id=t style="position:fixed;left:20px;top:80px;width:300px;height:100px"></textarea>
<a id=blank href="/two" target=_blank style="position:fixed;left:20px;top:200px">blank</a>
<button id=pop onclick="window.w=window.open('/two','x','width=300,height=300')" style="position:fixed;left:120px;top:200px">pop</button>
<input id=f type=file style="position:fixed;left:20px;top:240px">
<a id=dl href="/dl" style="position:fixed;left:20px;top:280px">dl</a>
<button id=copy onclick="navigator.clipboard.writeText('from a button')" style="position:fixed;left:120px;top:280px">copy</button>
<script>
window.log=[]; window.clicks=0; window.scrolls=0;
s.onchange=()=>log.push('change '+s.value);
addEventListener('click',()=>clicks++);
addEventListener('scroll',()=>scrolls++);
addEventListener('paste',e=>log.push('paste '+e.clipboardData.getData('text/plain')));
</script>`

// pasteTop is a hostile page around a cross-site iframe holding the focus: it overrides the
// clipboard and listens for pastes.
const pasteTop = `<!doctype html><title>Paste top</title><body style="margin:0">
<iframe id=f src="http://localhost:%s/paste-child" style="position:fixed;left:0;top:0;width:400px;height:200px;border:0"></iframe>
<script>
window.stolen=[]; window.got=[];
const real=navigator.clipboard.writeText.bind(navigator.clipboard);
navigator.clipboard.writeText=t=>{stolen.push('writeText '+t);return real(t)};
addEventListener('paste',e=>stolen.push('event '+e.clipboardData.getData('text')));
addEventListener('message',e=>{if(typeof e.data==='string')got.push(e.data);else window.apis=e.data});
</script>`

const pasteChild = `<!doctype html><body style="margin:0"><input id=i style="width:390px;height:190px">
<script>
parent.postMessage({picker:typeof showOpenFilePicker,passkey:typeof PublicKeyCredential},'*');
i.addEventListener('focus',()=>parent.postMessage('focus','*'));
i.addEventListener('paste',e=>parent.postMessage('paste '+e.clipboardData.getData('text'),'*'));
i.addEventListener('input',()=>parent.postMessage('value '+i.value,'*'));
</script>`

// floodPage starts downloads with nobody having clicked anything, all from hidden subframes.
const floodPage = `<!doctype html><title>Flood</title><script>
for(let k=0;k<12;k++){const f=document.createElement('iframe');f.style.display='none';f.src='/dlname?n=bulk'+k+'.bin';document.documentElement.append(f)}
</script>`

type live struct {
	t     *testing.T
	s     *Store
	srv   *httptest.Server
	v     *Viewer
	key   string
	mu    sync.Mutex
	state State
	bytes atomic.Int64
	count atomic.Int64
	last  atomic.Pointer[Frame]
	// copied stands in for the Mac's clipboard, which a test must never touch.
	copied atomic.Value
}

func startLive(t *testing.T) *live {
	t.Helper()
	if testing.Short() || os.Getenv("CI") != "" {
		t.Skip("needs system Chrome and a machine that is not starved")
	}
	home, _ := os.UserHomeDir()
	chrome, err := FindChrome(home)
	if err != nil {
		t.Skip("no system Chrome")
	}
	mux := http.NewServeMux()
	html := func(body string) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, body)
		}
	}
	mux.HandleFunc("/", html(livePage))
	mux.HandleFunc("/hostile/", serveHostile)
	mux.HandleFunc("/two", html(`<title>Two</title><body>second page`))
	mux.HandleFunc("/paste-top", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, port, _ := net.SplitHostPort(r.Host)
		fmt.Fprintf(w, pasteTop, port)
	})
	mux.HandleFunc("/paste-child", html(pasteChild))
	mux.HandleFunc("/flood", html(floodPage))
	mux.HandleFunc("/click-dl", html(`<title>Click</title><a id=a href="/dlname?n=clicked.txt" style="position:fixed;left:0;top:0;font-size:60px">get it</a>`))
	mux.HandleFunc("/nested-dl", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, port, _ := net.SplitHostPort(r.Host)
		fmt.Fprintf(w, `<title>Nested</title><iframe src="http://localhost:%s/frame-dl"></iframe>`, port)
	})
	mux.HandleFunc("/frame-dl", html(`<script>const f=document.createElement('iframe');f.src='/dlname?n=nested.txt';document.documentElement.append(f)</script>`))
	mux.HandleFunc("/dlname", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Disposition", `attachment; filename="`+r.URL.Query().Get("n")+`"`)
		fmt.Fprint(w, "data")
	})
	mux.HandleFunc("/slow", func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(2 * time.Second)
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<title>Slow</title><body>the real page`)
	})
	mux.HandleFunc("/dl", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Disposition", `attachment; filename="report.txt"`)
		fmt.Fprint(w, "data")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	// A short path: Chrome's singleton socket does not fit under t.TempDir on macOS.
	dir, err := os.MkdirTemp("", "cfb")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	bin, err := liveChrome(dir, chrome)
	if err != nil {
		t.Fatal(err)
	}
	l := &live{t: t, srv: srv, key: "thread:live"}
	l.copied.Store("")
	s := New(Options{
		SetClipboard: func(_ context.Context, text string) error {
			l.copied.Store(text)
			return nil
		},
		Dir: dir, Enabled: func() bool { return true }, Idle: time.Hour, Log: liveLog(),
		Launch: ExecLauncher(func() (string, error) { return bin, nil }, slog.New(slog.DiscardHandler)),
		Reveal: func(string) error { return nil },
	})
	t.Cleanup(s.Close)
	l.s = s
	l.watch(srv.URL)
	l.until("the page", func(st State) bool { return st.Title == "Live page" && !st.Loading })
	return l
}

// plainHost is a name for this machine that is no secure context, as localhost is.
const plainHost = "cf-plain.test"

// liveChrome is the Chrome of these tests: the real one, kept away from the user's home, Keychain
// and network.
func liveChrome(dir, chrome string) (string, error) {
	home := filepath.Join(dir, "home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		return "", err
	}
	script := fmt.Sprintf(`#!/bin/sh
export HOME=%q CFFIXED_USER_HOME=%q
exec %q --use-mock-keychain --disable-background-networking --disable-component-update \
  --disable-sync --disable-domain-reliability --no-pings \
  "--host-resolver-rules=MAP %s 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1" "$@"
`, home, home, chrome, plainHost)
	bin := filepath.Join(dir, "chrome.sh")
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil { //nolint:gosec // an executable
		return "", err
	}
	return bin, nil
}

// other is a second surface on the same Chrome.
func (l *live) other(t *testing.T, key, address string) *live {
	t.Helper()
	o := &live{t: t, s: l.s, srv: l.srv, key: key}
	o.copied.Store("")
	t.Cleanup(func() { _ = l.s.CloseSurface(context.Background(), key) })
	o.watch(address)
	o.until("its page", func(st State) bool {
		return st.Phase == PhaseReady && strings.HasPrefix(st.URL, address) && !st.Loading
	})
	return o
}

// liveLog shows the store's debug lines with CF_LIVE_LOG set.
func liveLog() *slog.Logger {
	if os.Getenv("CF_LIVE_LOG") == "" {
		return slog.New(slog.DiscardHandler)
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func (l *live) watch(address string) {
	l.t.Helper()
	v, err := l.s.Watch(l.key, 640, 480, address)
	if err != nil {
		l.t.Fatal(err)
	}
	l.v = v
	go func() {
		for range v.Wake() {
			st, f, err := v.Take()
			if st != nil {
				l.mu.Lock()
				l.state = *st
				l.mu.Unlock()
			}
			if f != nil {
				l.count.Add(1)
				l.bytes.Add(int64(len(f.JPEG)))
				l.last.Store(f)
				f.Taken()
			}
			if err != nil {
				return
			}
		}
	}()
}

func (l *live) now() State {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.state
}

func (l *live) until(what string, ok func(State) bool) State {
	l.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if st := l.now(); ok(st) {
			return st
		}
		time.Sleep(10 * time.Millisecond)
	}
	l.t.Fatalf("waiting for %s: %+v", what, l.now())
	return State{}
}

func (l *live) eval(expr string, out any) {
	l.t.Helper()
	in, _, t, err := l.s.shown(l.key)
	if err != nil {
		l.t.Fatal(err)
	}
	if err := evaluate(context.Background(), in, t.session, expr, out); err != nil {
		l.t.Fatal(err)
	}
}

func (l *live) evalUntil(expr string, ok func(string) bool) string {
	l.t.Helper()
	var got string
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		l.eval(expr, &got)
		if ok(got) {
			return got
		}
	}
	l.t.Fatalf("%s stayed %q", expr, got)
	return got
}

func (l *live) click(x, y float64) {
	l.t.Helper()
	err := l.s.Input(context.Background(), l.key, []InputEvent{
		{Mouse: &MouseEvent{Type: "mousePressed", Button: "left", X: x, Y: y, Buttons: 1, ClickCount: 1}},
		{Mouse: &MouseEvent{Type: "mouseReleased", Button: "left", X: x, Y: y, ClickCount: 1}},
	})
	if err != nil {
		l.t.Fatal(err)
	}
}

func (l *live) press(key, code string, keyCode, mods int) {
	l.t.Helper()
	err := l.s.Input(context.Background(), l.key, []InputEvent{
		{Key: &KeyEvent{Type: "rawKeyDown", Key: key, Code: code, KeyCode: keyCode, Modifiers: mods}},
		{Key: &KeyEvent{Type: "keyUp", Key: key, Code: code, KeyCode: keyCode, Modifiers: mods}},
	})
	if err != nil {
		l.t.Fatal(err)
	}
}

func (l *live) typeText(s string) {
	l.t.Helper()
	for _, r := range s {
		c := string(r)
		err := l.s.Input(context.Background(), l.key, []InputEvent{
			{Key: &KeyEvent{Type: "keyDown", Key: c, Text: c}},
			{Key: &KeyEvent{Type: "keyUp", Key: c}},
		})
		if err != nil {
			l.t.Fatal(err)
		}
	}
}

// TestLive runs on one Chrome: each launch of it costs seconds, and many at once starve each
// other. Every case starts from a fresh load of the page.
func TestLive(t *testing.T) {
	l := startLive(t)
	for i, tt := range []struct {
		name string
		run  func(*testing.T, *live)
	}{
		{"InputReachesThePage", liveInputReachesThePage},
		{"ResizeReflowsAndCasts", liveResizeReflowsAndCasts},
		{"NoFramesOnAStillPageAndNoneOnceHidden", liveNoFramesOnAStillPageAndNoneOnceHidden},
		{"FramesSurviveAMoveToAnotherSite", liveFramesSurviveAMoveToAnotherSite},
		{"ADeadAddressSaysSo", liveADeadAddressSaysSo},
		{"DraggingSelectsText", liveDraggingSelectsText},
		{"SelectIsDrawnByTheGUI", liveSelectIsDrawnByTheGUI},
		{"DialogsAskTheViewer", liveDialogsAskTheViewer},
		{"NewWindowsLandInTheSurfaceAndCloseBack", liveNewWindowsLandInTheSurfaceAndCloseBack},
		{"WindowCloseComesBackToTheOpener", liveWindowCloseComesBackToTheOpener},
		{"AddressRuleHolds", liveAddressRuleHolds},
		{"FileChooserAndDownload", liveFileChooserAndDownload},
		{"ClipboardStaysInChromeUntilTheUserMovesIt", liveClipboardStaysInChromeUntilTheUserMovesIt},
		{"PasteReachesOnlyTheFocusedFrame", livePasteReachesOnlyTheFocusedFrame},
		{"PasteWorksWhereThereIsNoSecureContext", livePasteWorksWhereThereIsNoSecureContext},
		{"StaleTextNeverReachesTheMac", liveStaleTextNeverReachesTheMac},
		{"APageCannotEndTheConnection", liveAPageCannotEndTheConnection},
		{"TheAddressIsTheMainFramesAndHasNoCredentials", liveTheAddressIsTheMainFramesAndHasNoCredentials},
		{"AFailedCertificateIsMarked", liveAFailedCertificateIsMarked},
		{"AnOpenerCannotWriteUnderAPendingAddress", liveAnOpenerCannotWriteUnderAPendingAddress},
		{"DownloadsNeedTheUser", liveDownloadsNeedTheUser},
		{"AHiddenSurfaceDownloadsNothing", liveAHiddenSurfaceDownloadsNothing},
		{"ACrossSiteFrameCanOnlyAsk", liveACrossSiteFrameCanOnlyAsk},
		{"ADialogBehindAPopupNeverShows", liveADialogBehindAPopupNeverShows},
		{"SystemPanelsAreGone", liveSystemPanelsAreGone},
		{"AFloodClosesThePageAndNoOther", liveAFloodClosesThePageAndNoOther},
		{"TheSiteSurvivesAnAddressNoParserTakes", liveTheSiteSurvivesAnAddressNoParserTakes},
		{"APopupCannotBlankItsOpenerUnnoticed", liveAPopupCannotBlankItsOpenerUnnoticed},
		{"EveryCrossSiteFrameHasASessionOfItsOwn", liveEveryCrossSiteFrameHasASessionOfItsOwn},
		{"ASelectInACrossSiteFrameOpens", liveASelectInACrossSiteFrameOpens},
		{"TypingIsNoGestureAndNeitherIsSpace", liveTypingIsNoGestureAndNeitherIsSpace},
		{"AGestureDoesNotSurviveTheNextPage", liveAGestureDoesNotSurviveTheNextPage},
		{"APagesCopyDoesNotOutliveThePage", liveAPagesCopyDoesNotOutliveThePage},
		{"WebAuthnReachesNothingReal", liveWebAuthnReachesNothingReal},
		{"OnlyTheWebIsReachable", liveOnlyTheWebIsReachable},
	} {
		t.Run(tt.name, func(t *testing.T) {
			l.t = t
			u := fmt.Sprintf("%s/?case=%d", l.srv.URL, i)
			if _, err := l.s.Navigate(context.Background(), l.key, u); err != nil {
				t.Fatal(err)
			}
			l.until("a fresh page", func(st State) bool { return st.URL == u && st.Title == "Live page" && !st.Loading && !st.Popup })
			tt.run(t, l)
		})
	}
}

func eq(want string) func(string) bool { return func(got string) bool { return got == want } }

func liveInputReachesThePage(t *testing.T, l *live) {
	ctx := context.Background()

	l.click(300, 400)
	l.evalUntil("String(clicks)", eq("1"))

	l.click(100, 120)
	l.typeText("hello")
	l.evalUntil("t.value", eq("hello"))
	l.press("Backspace", "Backspace", 8, 0)
	l.evalUntil("t.value", eq("hell"))
	// Plain keys work by themselves; these two need the editing commands of keys.go.
	l.press("a", "KeyA", 65, modMeta)
	l.evalUntil("String(t.selectionEnd-t.selectionStart)", eq("4"))
	l.press("Backspace", "Backspace", 8, modAlt)
	l.evalUntil("t.value", eq(""))

	err := l.s.Input(ctx, l.key, []InputEvent{{Mouse: &MouseEvent{Type: "mouseWheel", Button: "none", X: 300, Y: 400, DeltaY: 300}}})
	if err != nil {
		t.Fatal(err)
	}
	l.evalUntil("String(scrollY>0)", eq("true"))
}

func liveResizeReflowsAndCasts(t *testing.T, l *live) {
	if err := l.s.Resize(context.Background(), l.key, 500, 300); err != nil {
		t.Fatal(err)
	}
	l.evalUntil("innerWidth+'x'+innerHeight+'@'+devicePixelRatio", eq("500x300@2"))
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if f := l.last.Load(); f != nil && f.Width == 500 && f.Height == 300 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("no 500x300 frame: %+v", l.last.Load())
		}
	}
}

func liveNoFramesOnAStillPageAndNoneOnceHidden(t *testing.T, l *live) {
	time.Sleep(600 * time.Millisecond)
	before := l.count.Load()
	if before == 0 {
		t.Fatal("no frame at all")
	}
	time.Sleep(500 * time.Millisecond)
	if n := l.count.Load() - before; n > 1 {
		t.Fatalf("a still page sent %d frames", n)
	}
	// Moving the page must paint, or the frames were never live.
	l.eval(`document.body.style.background="red"`, nil)
	for deadline := time.Now().Add(5 * time.Second); l.count.Load() == before; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("a change sent no frame")
		}
	}
	l.v.Close()
	time.Sleep(200 * time.Millisecond)
	stopped := l.count.Load()
	l.eval(`document.body.style.background="blue"`, nil)
	time.Sleep(300 * time.Millisecond)
	if n := l.count.Load() - stopped; n != 0 {
		t.Fatalf("%d frames after the last view left", n)
	}
	l.watch("")
	l.until("the view back", func(st State) bool { return st.Phase == PhaseReady })
	if l.count.Load() == stopped {
		// A new view gets the last frame at once, even on a still page.
		time.Sleep(200 * time.Millisecond)
		if l.count.Load() == stopped {
			t.Fatal("a returning view got no frame")
		}
	}
}

func liveADeadAddressSaysSo(t *testing.T, l *live) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dead := "http://" + ln.Addr().String() + "/"
	_ = ln.Close()
	if _, err := l.s.Navigate(context.Background(), l.key, dead); err != nil {
		t.Fatal(err)
	}
	st := l.until("the notice", func(st State) bool { return st.Notice != "" })
	if !strings.Contains(st.Notice, "ERR_CONNECTION_REFUSED") {
		t.Fatalf("notice %q", st.Notice)
	}
	// And the next page clears it.
	if _, err := l.s.Navigate(context.Background(), l.key, l.srv.URL+"/two"); err != nil {
		t.Fatal(err)
	}
	l.until("the page", func(st State) bool { return st.Title == "Two" && st.Notice == "" })
}

func liveDraggingSelectsText(t *testing.T, l *live) {
	l.eval(`t.value="select this by dragging";1`, nil)
	err := l.s.Input(context.Background(), l.key, []InputEvent{
		{Mouse: &MouseEvent{Type: "mousePressed", Button: "left", X: 24, Y: 90, Buttons: 1, ClickCount: 1}},
		{Mouse: &MouseEvent{Type: "mouseMoved", Button: "left", X: 90, Y: 90, Buttons: 1}},
		{Mouse: &MouseEvent{Type: "mouseMoved", Button: "left", X: 160, Y: 90, Buttons: 1}},
		{Mouse: &MouseEvent{Type: "mouseReleased", Button: "left", X: 160, Y: 90, ClickCount: 1}},
	})
	if err != nil {
		t.Fatal(err)
	}
	l.evalUntil("String(t.selectionEnd>t.selectionStart)", eq("true"))
}

func liveFramesSurviveAMoveToAnotherSite(t *testing.T, l *live) {
	other := strings.Replace(l.srv.URL, "127.0.0.1", "localhost", 1)
	for _, u := range []string{other + "/two", l.srv.URL + "/two"} {
		before := l.count.Load()
		if _, err := l.s.Navigate(context.Background(), l.key, u); err != nil {
			t.Fatal(err)
		}
		l.until("the page", func(st State) bool { return st.URL == u && !st.Loading })
		for deadline := time.Now().Add(5 * time.Second); l.count.Load() == before; time.Sleep(10 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("no frame from %s", u)
			}
		}
	}
}

func liveSelectIsDrawnByTheGUI(t *testing.T, l *live) {
	ctx := context.Background()
	l.click(100, 35)
	st := l.until("the select", func(st State) bool { return st.Select != nil })
	if len(st.Select.Options) != 4 || st.Select.Options[1].Label != "two" || !st.Select.Options[2].Disabled || st.Select.Selected != 0 {
		t.Fatalf("select: %+v", st.Select)
	}
	if err := l.s.PickSelect(ctx, l.key, st.Select.ID, 3); err != nil {
		t.Fatal(err)
	}
	l.evalUntil("s.value", eq("four"))
	l.evalUntil("log.join()", eq("change four"))
	if err := l.s.PickSelect(ctx, l.key, st.Select.ID, 1); err == nil {
		t.Fatal("answered the same select twice")
	}
	// A Mac opens the popup from the keyboard too.
	l.eval("s.focus()", nil)
	l.press("ArrowDown", "ArrowDown", 40, 0)
	st = l.until("the select again", func(st State) bool { return st.Select != nil })
	if st.Select.Selected != 3 {
		t.Fatalf("select: %+v", st.Select)
	}
	if err := l.s.PickSelect(ctx, l.key, st.Select.ID, -1); err != nil {
		t.Fatal(err)
	}
}

func liveDialogsAskTheViewer(t *testing.T, l *live) {
	ctx := context.Background()
	l.eval(`setTimeout(()=>{window.r=prompt("Your name?","Ada")},0);1`, nil)
	st := l.until("the prompt", func(st State) bool { return st.Dialog != nil })
	d := st.Dialog
	if d.Kind != "prompt" || d.Message != "Your name?" || d.DefaultPrompt != "Ada" || d.Origin != l.srv.URL {
		t.Fatalf("dialog: %+v", d)
	}
	if err := l.s.Input(ctx, l.key, []InputEvent{{Mouse: &MouseEvent{Type: "mouseMoved", Button: "none", X: 1, Y: 1}}}); err != nil {
		t.Fatalf("input during a dialog must not wait on it: %v", err)
	}
	if err := l.s.AnswerDialog(ctx, l.key, d.ID, true, "Grace"); err != nil {
		t.Fatal(err)
	}
	l.evalUntil("String(window.r)", eq("Grace"))

	// A page that will not stop asking can still be left.
	l.eval(`setTimeout(()=>{alert("stuck")},0);1`, nil)
	l.until("the alert", func(st State) bool { return st.Dialog != nil })
	if _, err := l.s.Navigate(ctx, l.key, l.srv.URL+"/two"); err != nil {
		t.Fatal(err)
	}
	l.until("the next page", func(st State) bool { return st.Title == "Two" && st.Dialog == nil })
}

func liveNewWindowsLandInTheSurfaceAndCloseBack(t *testing.T, l *live) {
	ctx := context.Background()
	for _, tt := range []struct {
		name string
		x, y float64
	}{{"target=_blank", 30, 208}, {"window.open", 135, 212}} {
		t.Run(tt.name, func(t *testing.T) {
			l.click(tt.x, tt.y)
			st := l.until("the popup", func(st State) bool { return st.Popup && st.Title == "Two" })
			if !st.CanGoBack {
				t.Fatal("no way back from a popup")
			}
			l.evalUntil("innerWidth+''", eq("640"))
			if err := l.s.Go(ctx, l.key, -1); err != nil {
				t.Fatal(err)
			}
			l.until("the opener", func(st State) bool { return !st.Popup && st.Title == "Live page" })
		})
	}
}

func liveWindowCloseComesBackToTheOpener(t *testing.T, l *live) {
	l.click(135, 212)
	l.until("the popup", func(st State) bool { return st.Popup && st.Title == "Two" })
	// The page shown is the popup; its opener still holds it, as a sign-in would.
	in, sf, _, err := l.s.shown(l.key)
	if err != nil {
		t.Fatal(err)
	}
	opener := sf.stack[0]
	if err := evaluate(context.Background(), in, opener.session, "w.close(); 1", nil); err != nil {
		t.Fatal(err)
	}
	l.until("the opener", func(st State) bool { return !st.Popup && st.Title == "Live page" })
}

func liveAddressRuleHolds(t *testing.T, l *live) {
	ctx := context.Background()
	for _, bad := range []string{"file:///etc/hosts", "chrome://settings", "devtools://devtools/bundled/inspector.html", "javascript:document.title='pwned'", "data:text/html,x"} {
		if _, err := l.s.Navigate(ctx, l.key, bad); err == nil {
			t.Fatalf("%s reached Chrome", bad)
		}
	}
	if st := l.now(); st.Title != "Live page" {
		t.Fatalf("title %q", st.Title)
	}
	// A page cannot walk there either: Chrome stops it, and the surface stays on an allowed page.
	l.eval(`location.href="file:///etc/hosts";1`, nil)
	l.eval(`window.open("chrome://settings");1`, nil)
	time.Sleep(300 * time.Millisecond)
	if st := l.now(); !allowedPage(st.URL) {
		t.Fatalf("on %q", st.URL)
	}
}

func liveFileChooserAndDownload(t *testing.T, l *live) {
	ctx := context.Background()
	l.click(60, 250)
	st := l.until("the chooser", func(st State) bool { return st.FileChooser != nil })
	if st.FileChooser.Multiple || st.FileChooser.Origin != l.srv.URL {
		t.Fatalf("chooser: %+v", st.FileChooser)
	}
	path := filepath.Join(t.TempDir(), "pick.txt")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := l.s.AnswerFile(ctx, l.key, st.FileChooser.ID, []string{path}); err != nil {
		t.Fatal(err)
	}
	l.evalUntil("f.files.length+f.files[0]?.name", eq("1pick.txt"))

	l.click(25, 288)
	st = l.until("the download", func(st State) bool { return len(st.Downloads) == 1 && st.Downloads[0].State == "completed" })
	d := st.Downloads[0]
	if d.Name != "report.txt" || filepath.Dir(d.Path) != l.s.Downloads() {
		t.Fatalf("download: %+v", d)
	}
	if err := l.s.RevealDownload(l.key, d.ID); err != nil {
		t.Fatal(err)
	}
	if err := l.s.RevealDownload(l.key, "other"); err == nil {
		t.Fatal("revealed an unknown download")
	}
}

func liveClipboardStaysInChromeUntilTheUserMovesIt(t *testing.T, l *live) {
	ctx := context.Background()

	// cmd+c, then the bridge reads it back.
	l.eval(`t.value="copy me";t.focus();t.select();1`, nil)
	l.press("c", "KeyC", 67, modMeta)
	if n, err := l.s.Copy(ctx, l.key, false); err != nil || n != len("copy me") {
		t.Fatalf("copied %d: %v", n, err)
	}
	if got := l.copied.Load(); got != "copy me" {
		t.Fatalf("copied %q", got)
	}
	// Reading happens in a page of our own, and leaves the user's page and focus alone.
	l.copied.Store("what the Mac holds")
	if n, err := l.s.Copy(ctx, l.key, false); err != nil || n != 0 {
		t.Fatalf("a Copy with no new cmd+c moved %d characters: %v", n, err)
	}
	if got := l.copied.Load(); got != "what the Mac holds" {
		t.Fatalf("the Mac's clipboard became %q", got)
	}
	l.evalUntil("document.activeElement.id", eq("t"))
	l.evalUntil("String(document.hasFocus())", eq("true"))

	// A page's own Copy button goes to Chrome's clipboard, and the surface says so.
	before := l.now().Copied
	l.click(135, 288)
	l.until("the notice", func(st State) bool { return st.Copied > before })
	if n, err := l.s.Copy(ctx, l.key, true); err != nil || n == 0 {
		t.Fatalf("copied %d: %v", n, err)
	}
	if got := l.copied.Load(); got != "from a button" {
		t.Fatalf("copied %q", got)
	}

	// Paste is a real paste, so the page's handlers run.
	l.eval(`t.value="";t.focus();log.length=0;1`, nil)
	if err := l.s.Paste(ctx, l.key, "pasted text"); err != nil {
		t.Fatal(err)
	}
	l.evalUntil("t.value", eq("pasted text"))
	l.evalUntil("log.join()", eq("paste pasted text"))
}

func livePasteReachesOnlyTheFocusedFrame(t *testing.T, l *live) {
	ctx := context.Background()
	if _, err := l.s.Navigate(ctx, l.key, l.srv.URL+"/paste-top"); err != nil {
		t.Fatal(err)
	}
	l.until("the page", func(st State) bool { return st.Title == "Paste top" && !st.Loading })
	// Into the cross-site iframe, once its script runs: the page's load says nothing of a frame
	// in another process.
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		l.click(100, 100)
		var got string
		l.eval("got.join()", &got)
		if got == "focus" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the frame reported %q", got)
		}
	}
	if err := l.s.Paste(ctx, l.key, "hunter2"); err != nil {
		t.Fatal(err)
	}
	// Our scratch page taking keys can make the frame see focus come back, so not an exact list.
	l.evalUntil("String(got.includes('paste hunter2')&&got.includes('value hunter2'))", eq("true"))
	// The keyboard is still in the frame that took the paste.
	l.typeText("!")
	l.evalUntil("String(got.includes('value hunter2!'))", eq("true"))
	var stolen string
	l.eval("stolen.join()", &stolen)
	if stolen != "" {
		t.Fatalf("the top page saw %q", stolen)
	}
	in, _, _, err := l.s.shown(l.key)
	if err != nil {
		t.Fatal(err)
	}
	in.clip.mu.Lock()
	left, err := in.readClipboard(ctx)
	in.clip.mu.Unlock()
	if err != nil || left != "" {
		t.Fatalf("Chrome's clipboard kept %q: %v", left, err)
	}
}

func livePasteWorksWhereThereIsNoSecureContext(t *testing.T, l *live) {
	ctx := context.Background()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(l.srv.URL, "http://"))
	if _, err := l.s.Navigate(ctx, l.key, "http://"+plainHost+":"+port+"/"); err != nil {
		t.Fatal(err)
	}
	l.until("the page", func(st State) bool {
		return strings.Contains(st.URL, plainHost) && st.Title == "Live page" && !st.Loading
	})
	l.evalUntil("String(isSecureContext)", eq("false"))
	l.eval(`t.focus();1`, nil)
	if err := l.s.Paste(ctx, l.key, "plain"); err != nil {
		t.Fatal(err)
	}
	l.evalUntil("t.value", eq("plain"))
	l.evalUntil("log.join()", eq("paste plain"))
}

func liveStaleTextNeverReachesTheMac(t *testing.T, l *live) {
	ctx := context.Background()

	// A paste leaves nothing for a cmd+c with no selection to carry to the Mac.
	l.eval(`t.value="";t.focus();1`, nil)
	if err := l.s.Paste(ctx, l.key, "my password"); err != nil {
		t.Fatal(err)
	}
	l.evalUntil("t.value", eq("my password"))
	l.eval(`t.value="";t.focus();1`, nil)
	l.copied.Store("what the Mac holds")
	l.press("c", "KeyC", 67, modMeta)
	if n, err := l.s.Copy(ctx, l.key, false); err != nil || n != 0 {
		t.Fatalf("moved %d: %v", n, err)
	}
	if got := l.copied.Load(); got != "what the Mac holds" {
		t.Fatalf("the Mac's clipboard became %q", got)
	}

	// One surface's copy is not another's: this page's button, then a cmd+c on the other surface
	// with nothing selected, and on another that does select.
	o := l.other(t, "thread:clipboard", l.srv.URL+"/?other")
	before := l.now().Copied
	l.click(135, 288)
	l.until("the notice", func(st State) bool { return st.Copied > before })
	o.eval(`t.value="";t.focus();1`, nil)
	o.press("c", "KeyC", 67, modMeta)
	if n, err := l.s.Copy(ctx, o.key, false); err != nil || n != 0 {
		t.Fatalf("the other surface moved %d: %v", n, err)
	}
	if got := l.copied.Load(); got != "what the Mac holds" {
		t.Fatalf("the Mac's clipboard became %q", got)
	}
	// Nor is text a page left where no click looked for it, on a key press of its own.
	l.eval(`addEventListener('keydown',()=>navigator.clipboard.writeText('planted'));t.focus();1`, nil)
	l.typeText("x")
	time.Sleep(200 * time.Millisecond)
	o.eval(`t.value="";t.focus();1`, nil)
	o.press("c", "KeyC", 67, modMeta)
	if n, err := l.s.Copy(ctx, o.key, false); err != nil || n != 0 {
		t.Fatalf("the other surface moved %d: %v", n, err)
	}
	if got := l.copied.Load(); got != "what the Mac holds" {
		t.Fatalf("the Mac's clipboard became %q", got)
	}
	o.eval(`t.value="selected here";t.focus();t.select();1`, nil)
	o.press("c", "KeyC", 67, modMeta)
	if n, err := l.s.Copy(ctx, o.key, false); err != nil || n == 0 {
		t.Fatalf("a real copy moved %d: %v", n, err)
	}
	if got := l.copied.Load(); got != "selected here" {
		t.Fatalf("the Mac's clipboard became %q", got)
	}
	// The button's text waited, on its own surface, for the user's click on the strip.
	if n, err := l.s.Copy(ctx, l.key, true); err != nil || n == 0 {
		t.Fatalf("the strip moved %d: %v", n, err)
	}
	if got := l.copied.Load(); got != "from a button" {
		t.Fatalf("the Mac's clipboard became %q", got)
	}
}

func liveAPageCannotEndTheConnection(t *testing.T, l *live) {
	ctx := context.Background()
	in, _, tg, err := l.s.shown(l.key)
	if err != nil {
		t.Fatal(err)
	}
	const big = `'x'.repeat(70*1024*1024)`
	l.eval(`console.log(`+big+`);setTimeout(()=>{throw `+big+`});window.lived=1;1`, nil)
	l.evalUntil("String(window.lived)", eq("1"))

	// A reply past the limit fails its call, at once.
	start := time.Now()
	err = in.call(ctx, tg.session, "Runtime.evaluate", map[string]any{"expression": big, "returnByValue": true}, nil)
	if !errors.Is(err, errTooLong) {
		t.Fatalf("call: %v", err)
	}
	if d := time.Since(start); d >= callTimeout {
		t.Fatalf("waited %v", d)
	}

	// 70 MB on Chrome's clipboard goes nowhere, and stops nothing.
	l.eval(`copy.onclick=()=>navigator.clipboard.writeText(`+big+`);1`, nil)
	before := l.now().Copied
	l.click(135, 288)
	time.Sleep(time.Second)
	if st := l.now(); st.Copied != before {
		t.Fatalf("offered a text past the limit: %d", st.Copied)
	}

	if !l.s.Running() || l.now().Phase != PhaseReady {
		t.Fatalf("running %v, %+v", l.s.Running(), l.now())
	}
	l.eval(`t.value="";t.focus();1`, nil)
	l.typeText("ok")
	l.evalUntil("t.value", eq("ok"))
}

func liveTheAddressIsTheMainFramesAndHasNoCredentials(t *testing.T, l *live) {
	ctx := context.Background()
	if st := l.now(); st.Security != SecurityInsecure || st.Site != "127.0.0.1" {
		t.Fatalf("security %q, site %q", st.Security, st.Site)
	}

	// A subframe's pushState leaves the address where it is, the main frame's moves it.
	l.eval(`const f=document.createElement('iframe');f.id='sub';f.src='/two';document.body.append(f);1`, nil)
	l.evalUntil("String(sub.contentDocument?.title)", eq("Two"))
	base := l.now().URL
	l.eval(`sub.contentWindow.history.pushState(0,'','/bank/login');1`, nil)
	time.Sleep(200 * time.Millisecond)
	if st := l.now(); st.URL != base {
		t.Fatalf("a subframe moved the address to %q", st.URL)
	}
	l.eval(`history.pushState(0,'','/moved');1`, nil)
	l.until("the page's own move", func(st State) bool { return strings.HasSuffix(st.URL, "/moved") })

	// A page sending itself to an address with credentials: they do not show.
	host := strings.TrimPrefix(l.srv.URL, "http://")
	if _, err := l.s.Navigate(ctx, l.key, l.srv.URL+"/two"); err != nil {
		t.Fatal(err)
	}
	l.until("the page", func(st State) bool { return st.Title == "Two" })
	l.eval(`location.href='http://bank.example.com%2Flogin:x@`+host+`/?who';1`, nil)
	st := l.until("the move", func(st State) bool { return strings.HasSuffix(st.URL, "/?who") })
	if strings.Contains(st.URL, "@") || strings.Contains(st.URL, "bank") {
		t.Fatalf("showing %q", st.URL)
	}
}

func liveAFailedCertificateIsMarked(t *testing.T, l *live) {
	ctx := context.Background()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "tls") }))
	defer srv.Close()
	if _, err := l.s.Navigate(ctx, l.key, srv.URL); err != nil {
		t.Fatal(err)
	}
	st := l.until("the mark", func(st State) bool { return st.Security == SecurityCert })
	if !strings.HasPrefix(st.URL, srv.URL) {
		t.Fatalf("showing %q", st.URL)
	}
	if _, err := l.s.Navigate(ctx, l.key, l.srv.URL+"/two"); err != nil {
		t.Fatal(err)
	}
	l.until("the mark to change", func(st State) bool { return st.Title == "Two" && st.Security == SecurityInsecure })
}

// document.write into a new popup: the page on screen is the opener's, and so must the address be,
// not where the popup was headed. Chrome drops that navigation.
func liveAnOpenerCannotWriteUnderAPendingAddress(t *testing.T, l *live) {
	opener := l.now().URL
	l.eval(`pop.onclick=()=>{const w=open('/slow','x','width=300,height=300');setTimeout(()=>{w.document.write('<h1>forged');w.document.close()},50)};1`, nil)
	l.click(135, 212)
	l.until("the popup", func(st State) bool { return st.Popup })
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if st := l.now(); strings.Contains(st.URL, "/slow") {
			t.Fatalf("the address says %q over a page the opener wrote", st.URL)
		}
	}
	if st := l.now(); st.URL != opener {
		t.Fatalf("the popup shows %q, its page is the opener's %q", st.URL, opener)
	}
	if err := l.s.Go(context.Background(), l.key, -1); err != nil {
		t.Fatal(err)
	}
	l.until("the opener", func(st State) bool { return !st.Popup })
}

func filesIn(t *testing.T, dir string) []string {
	t.Helper()
	es, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range es {
		out = append(out, e.Name())
	}
	return out
}

func liveDownloadsNeedTheUser(t *testing.T, l *live) {
	ctx := context.Background()
	before := len(filesIn(t, l.s.Downloads()))
	o := l.other(t, "thread:flood", l.srv.URL+"/flood")
	st := o.until("all twelve", func(st State) bool { return len(st.Downloads) == 12 })
	asking, blocked := 0, 0
	for _, d := range st.Downloads {
		switch d.State {
		case DownloadAsking:
			asking++
		case DownloadBlocked:
			blocked++
		}
	}
	if asking != maxAsking || blocked != 12-maxAsking {
		t.Fatalf("%+v", st.Downloads)
	}
	if n := len(filesIn(t, l.s.Downloads())); n != before {
		t.Fatalf("%d files landed with nobody asked", n-before)
	}
	id := ""
	for _, d := range st.Downloads {
		if d.State == DownloadAsking {
			id = d.ID
			break
		}
	}
	if err := l.s.AnswerDownload(ctx, o.key, id, true); err != nil {
		t.Fatal(err)
	}
	st = o.until("it", func(st State) bool {
		return slices.ContainsFunc(st.Downloads, func(d Download) bool { return d.ID == id && d.State == DownloadCompleted })
	})
	if n := len(filesIn(t, l.s.Downloads())); n != before+1 {
		t.Fatalf("%d files landed for one yes", n-before)
	}
	for _, d := range st.Downloads {
		if d.State == DownloadAsking {
			if err := l.s.AnswerDownload(ctx, o.key, d.ID, false); err != nil {
				t.Fatal(err)
			}
		}
	}
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		left := filesIn(t, l.s.incoming())
		if len(left) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("still staged: %v", left)
		}
	}

	// A click needs no question.
	c := l.other(t, "thread:click", l.srv.URL+"/click-dl")
	c.click(60, 30)
	st = c.until("the file", func(st State) bool { return len(st.Downloads) == 1 && st.Downloads[0].State == DownloadCompleted })
	if st.Downloads[0].Name != "clicked.txt" || filepath.Dir(st.Downloads[0].Path) != l.s.Downloads() {
		t.Fatalf("%+v", st.Downloads[0])
	}
}

func liveAHiddenSurfaceDownloadsNothing(t *testing.T, l *live) {
	before := len(filesIn(t, l.s.Downloads()))
	o := l.other(t, "thread:hidden", l.srv.URL+"/two")
	o.eval(`setTimeout(()=>{const a=document.createElement('a');a.href='/dlname?n=hidden.txt';a.click()},300);1`, nil)
	o.v.Close()
	time.Sleep(1500 * time.Millisecond)
	if n := len(filesIn(t, l.s.Downloads())); n != before {
		t.Fatalf("%d files landed from a hidden page", n-before)
	}
	if left := filesIn(t, l.s.incoming()); len(left) != 0 {
		t.Fatalf("still staged: %v", left)
	}
	o.mu.Lock()
	o.state = State{}
	o.mu.Unlock()
	o.watch("")
	st := o.until("the list", func(st State) bool { return len(st.Downloads) == 1 })
	if st.Downloads[0].State != DownloadBlocked || st.Downloads[0].Name != "hidden.txt" {
		t.Fatalf("%+v", st.Downloads[0])
	}
}

// A frame nested in a cross-site iframe sends no session's event, so nothing names its surface:
// the one the user touched last asks.
func liveACrossSiteFrameCanOnlyAsk(t *testing.T, l *live) {
	before := len(filesIn(t, l.s.Downloads()))
	nested := l.other(t, "thread:nested", l.srv.URL+"/nested-dl")
	named := func(d Download) bool { return d.Name == "nested.txt" }
	st := nested.until("the question", func(st State) bool { return slices.ContainsFunc(st.Downloads, named) })
	d := st.Downloads[slices.IndexFunc(st.Downloads, named)]
	if d.State != DownloadAsking || d.Site != "localhost" {
		t.Fatalf("%+v", d)
	}
	if slices.ContainsFunc(l.now().Downloads, named) {
		t.Fatal("asked on a surface that was never its page's")
	}
	if n := len(filesIn(t, l.s.Downloads())); n != before {
		t.Fatalf("%d files landed", n-before)
	}
	if err := l.s.AnswerDownload(context.Background(), nested.key, d.ID, false); err != nil {
		t.Fatal(err)
	}
}

func liveADialogBehindAPopupNeverShows(t *testing.T, l *live) {
	l.eval(`window.answer='unset';pop.onclick=()=>{window.w=open('/two','x','width=300,height=300');setTimeout(()=>{window.answer=prompt('your password')},800)};1`, nil)
	l.click(135, 212)
	l.until("the popup", func(st State) bool { return st.Popup && st.Title == "Two" })
	for deadline := time.Now().Add(1500 * time.Millisecond); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if st := l.now(); st.Dialog != nil {
			t.Fatalf("over the popup's address: %+v", st.Dialog)
		}
	}
	if err := l.s.Go(context.Background(), l.key, -1); err != nil {
		t.Fatal(err)
	}
	l.until("the opener", func(st State) bool { return !st.Popup })
	l.evalUntil("String(window.answer)", eq("null"))
}

func liveSystemPanelsAreGone(t *testing.T, l *live) {
	for _, api := range []string{
		"window.showOpenFilePicker", "window.showSaveFilePicker", "window.showDirectoryPicker",
		"window.PublicKeyCredential", "navigator.share", "window.EyeDropper",
		"navigator.serial", "navigator.usb", "navigator.hid", "navigator.bluetooth",
		"window.documentPictureInPicture", "window.IdentityCredential",
	} {
		var kind string
		l.eval("typeof "+api, &kind)
		if kind != "undefined" {
			t.Errorf("%s is %s", api, kind)
		}
	}
	var video bool
	l.eval("document.pictureInPictureEnabled", &video)
	if video {
		t.Error("a video can leave for a window of its own")
	}
	// Untrusted and with no activation, this opens nothing either way. Prevented, a real click
	// reaches no colour panel.
	var opened bool
	l.eval(`(()=>{const i=document.createElement('input');i.type='color';document.body.append(i);const r=i.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));i.remove();return r})()`, &opened)
	if opened {
		t.Error("a colour input took its click")
	}
	// The flag is the whole browser's, cross-site iframes included.
	if _, err := l.s.Navigate(context.Background(), l.key, l.srv.URL+"/paste-top"); err != nil {
		t.Fatal(err)
	}
	l.until("the page", func(st State) bool { return st.Title == "Paste top" })
	l.evalUntil("JSON.stringify(window.apis ?? null)", eq(`{"picker":"undefined","passkey":"undefined"}`))
}

func TestLiveChromeDiesThenRelaunchOpensBlankAndSaysWhere(t *testing.T) {
	l := startLive(t)
	ctx := context.Background()
	l.s.mu.Lock()
	in := l.s.chrome
	l.s.mu.Unlock()
	p := in.proc.(*process)
	p.signal(9) // this test's own Chrome's group
	st := l.until("the crash", func(st State) bool { return st.Phase == PhaseCrashed })
	if !strings.Contains(st.Message, "unexpectedly") {
		t.Fatalf("message %q", st.Message)
	}
	if l.s.Running() {
		t.Fatal("still running")
	}
	<-p.done
	if err := l.s.Relaunch(ctx); err != nil {
		t.Fatal(err)
	}
	st = l.until("a blank page", func(st State) bool { return st.Phase == PhaseReady })
	if !strings.Contains(st.Notice, "127.0.0.1") {
		t.Fatalf("notice %q", st.Notice)
	}
	time.Sleep(300 * time.Millisecond)
	if st := l.now(); st.Title == "Live page" || (st.URL != "" && st.URL != "about:blank") {
		t.Fatalf("went back to the page that was showing: %q", st.URL)
	}
	if err := l.s.Input(ctx, l.key, []InputEvent{{Mouse: &MouseEvent{Type: "mouseMoved", Button: "none", X: 5, Y: 5}}}); err != nil {
		t.Fatal(err)
	}
}

func TestLiveNothingOutlivesTheStore(t *testing.T) {
	l := startLive(t)
	l.s.mu.Lock()
	p := l.s.chrome.proc.(*process)
	l.s.mu.Unlock()
	group := p.cmd.Process.Pid
	l.s.Close()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		// Signal 0 to the group: ESRCH once no member is left.
		if err := syscall.Kill(-group, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("group %d still has members", group)
		}
	}
}

func TestLiveProfileKeepsCookiesAcrossARestart(t *testing.T) {
	l := startLive(t)
	l.eval(`document.cookie="cf=kept; max-age=86400";1`, nil)
	l.v.Close()
	l.s.mu.Lock()
	in := l.s.chrome
	l.s.mu.Unlock()
	l.s.stop(in)
	l.mu.Lock()
	l.state = State{}
	l.mu.Unlock()
	l.watch("")
	l.until("the page again", func(st State) bool { return st.Phase == PhaseReady && st.Title == "Live page" })
	l.evalUntil("document.cookie", eq("cf=kept"))
}
