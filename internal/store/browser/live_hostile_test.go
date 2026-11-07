package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// Hostile pages on the real Chrome. Everything is served from this test, on loopback names only:
// 127.0.0.1, localhost and plainHost are three sites to Chrome. Nothing here may put a system
// panel on the desktop: file inputs are looked at and not clicked, a colour input gets an untrusted
// event, and WebAuthn only ever runs inside a virtual environment that has been seen to be there.

// hostilePages are served at /hostile/<name>, with $PORT filled in.
var hostilePages = map[string]string{
	"flood": `<!doctype html><title>Flood</title><script>
const s='/'+'p'.repeat(2000000);let i=0;const c=new MessageChannel();
c.port1.onmessage=()=>{try{history.pushState(0,'',s+(i++))}catch(e){};c.port2.postMessage(0)};c.port2.postMessage(0)</script>`,
	"plain": `<!doctype html><title>Plain</title><body>plain`,
	// Eight history entries whose state is a 64 MB typed array: Chrome's own process keeps each one.
	"stateflood": `<!doctype html><title>State flood</title><script>
const big=new Uint8Array(64<<20);for(let i=0;i<big.length;i+=4096)big[i]=i&255;let n=0;
function step(){big[0]=n;history.pushState(big,'','/hostile/stateflood?'+n);if(++n<8)setTimeout(step,120)}
setTimeout(step,300)</script>`,
	// A neighbour as busy as a game: an animation and a worker that never rests, and no growth.
	"busy": `<!doctype html><title>Busy</title><body style="margin:0"><div id=d style="width:50px;height:50px;background:red;position:absolute"></div><script>
let x=0;function f(){const e=performance.now()+13;while(performance.now()<e);x=(x+3)%500;d.style.left=x+'px';requestAnimationFrame(f)}f();
new Worker(URL.createObjectURL(new Blob(['for(;;);'],{type:'text/javascript'})))</script>`,
	// A page that sends its visitor to another site, whose first paint waits on a stylesheet.
	"lure": `<!doctype html><title>Lure</title><body style="background:#c00;color:#fff;font:40px sans-serif">CALL 555-0100<script>
setTimeout(()=>{location='http://localhost:$PORT/hostile/slowpaint'},300)</script>`,
	"slowpaint": `<!doctype html><title>Slow paint</title><link rel=stylesheet href="/hang.css"><body>the real page`,
	// A popup whose frame tree is past the pipe's limit: 20 frames of 2 MB addresses.
	"tree": `<!doctype html><title>Tree</title><body style="margin:0"><button id=b style="position:fixed;left:0;top:0;width:200px;height:60px">go</button><script>
b.onclick=()=>{const w=open('about:blank','x','width=300,height=300');const d=w.document;d.body.innerHTML='<h1>Sign in to your bank</h1>';
const pad='a'.repeat(2000000);for(let i=0;i<20;i++){const f=d.createElement('iframe');f.style.display='none';f.src='about:blank#'+i+pad;d.body.append(f)}}</script>`,
	"pdfs": `<!doctype html><title>PDFs</title><body style="margin:0"><a id=a href="/terms.pdf" style="position:fixed;left:0;top:0;font-size:60px">terms</a>
<embed src="/terms.pdf" type="application/pdf" style="position:fixed;left:0;top:100px;width:300px;height:200px">`,
	"popup": `<!doctype html><title>Opener</title><body style="margin:0">
<button id=b onclick="window.open('/hostile/rewrite','x','width=300,height=300')" style="position:fixed;left:0;top:0;width:200px;height:60px">go</button>`,
	"rewrite": `<!doctype html><title>Rewrite</title><script>
opener.location='about:blank';
setTimeout(()=>{opener.document.body.innerHTML='<h1>Sign in</h1>';setTimeout(()=>window.close(),100)},500)</script>`,
	"nest": `<!doctype html><title>Nest</title><iframe src="http://localhost:$PORT/hostile/mid"></iframe>`,
	"mid":  `<!doctype html><title>Mid</title><iframe src="http://` + plainHost + `:$PORT/hostile/leaf"></iframe>`,
	"leaf": `<!doctype html><title>Leaf</title><input id=f type=file>`,
	"xselect": `<!doctype html><title>Top</title><body style="margin:0">
<iframe src="http://` + plainHost + `:$PORT/hostile/sel" style="position:fixed;left:0;top:0;width:400px;height:200px;border:0"></iframe>`,
	"sel": `<!doctype html><body style="margin:0"><select id=s style="position:fixed;left:0;top:0;width:200px;height:30px"><option>one<option>two</select>
<script>s.onchange=()=>parent.postMessage('picked '+s.value,'*');</script>`,
	"keys": `<!doctype html><title>Keys</title><body>
<a id=a href="/dlname?n=by-key.txt" style="position:fixed;left:0;top:0;font-size:60px">get it</a>
<textarea id=t style="position:fixed;left:0;top:100px"></textarea><script>
const f=()=>{const i=document.createElement('iframe');i.style.display='none';i.src='/dlname?n=typed.txt';document.body.append(i)};
t.addEventListener('keydown',f)</script>`,
	"leave": `<!doctype html><title>Leave</title><body style="margin:0">
<button onclick="location='/hostile/after'" style="position:fixed;left:0;top:0;width:200px;height:60px">next</button>`,
	"after": `<!doctype html><title>After</title><iframe src="/dlname?n=after.txt" style="display:none"></iframe>`,
	"web": `<!doctype html><title>Web</title><iframe id=d src="data:text/html,<script>parent.postMessage('data','*')</script>"></iframe><iframe id=b></iframe>
<script>window.got=[];addEventListener('message',e=>got.push(e.data));
b.src=URL.createObjectURL(new Blob(["<script>parent.postMessage('blob','*')</scr"+"ipt>"],{type:'text/html'}))</script>`,
}

func serveHostile(w http.ResponseWriter, r *http.Request) {
	body, ok := hostilePages[strings.TrimPrefix(r.URL.Path, "/hostile/")]
	if !ok {
		http.NotFound(w, r)
		return
	}
	_, port, _ := net.SplitHostPort(r.Host)
	w.Header().Set("Content-Type", "text/html")
	fmt.Fprint(w, strings.ReplaceAll(body, "$PORT", port))
}

func (l *live) port() string {
	u, err := url.Parse(l.srv.URL)
	if err != nil {
		l.t.Fatal(err)
	}
	return u.Port()
}

func (l *live) open(address, title string) {
	l.t.Helper()
	if _, err := l.s.Navigate(context.Background(), l.key, address); err != nil {
		l.t.Fatal(err)
	}
	l.until(title, func(st State) bool { return st.Title == title && !st.Loading })
}

func liveAFloodClosesThePageAndNoOther(t *testing.T, l *live) {
	calm := l.other(t, "thread:calm", "http://"+plainHost+":"+l.port()+"/hostile/plain")
	if _, err := l.s.Navigate(context.Background(), l.key, l.srv.URL+"/hostile/flood"); err != nil {
		t.Fatal(err)
	}
	st := l.until("the page's end", func(st State) bool { return strings.Contains(st.Notice, "flooding") })
	if !strings.Contains(st.Notice, "127.0.0.1") {
		t.Fatalf("notice %q", st.Notice)
	}
	l.until("an empty surface", func(st State) bool { return st.URL == "about:blank" || st.URL == "" })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := l.s.Input(ctx, calm.key, []InputEvent{{Mouse: &MouseEvent{Type: "mouseMoved", Button: "none", X: 5, Y: 5}}}); err != nil {
		t.Fatalf("the other surface: %v", err)
	}
	if !l.s.Running() {
		t.Fatal("Chrome went with the page")
	}
	// bringUp's page may still be on its way.
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if _, _, _, err := l.s.shown(l.key); err == nil {
			return
		}
	}
	t.Fatal("no page came back")
}

func liveTheSiteSurvivesAnAddressNoParserTakes(t *testing.T, l *live) {
	origin := "http://" + plainHost + ":" + l.port()
	l.open(origin+"/hostile/plain", "Plain")
	l.eval(`history.pushState(0,'','/%zz');1`, nil)
	st := l.until("the address", func(st State) bool { return strings.HasSuffix(st.URL, "/%zz") })
	if st.Origin != origin || st.Site != plainHost {
		t.Fatalf("origin %q site %q", st.Origin, st.Site)
	}
	l.eval(`setTimeout(()=>alert('hi'),0);1`, nil)
	st = l.until("the dialog", func(st State) bool { return st.Dialog != nil })
	if st.Dialog.Origin != origin || st.Dialog.Site != plainHost {
		t.Fatalf("dialog %+v", st.Dialog)
	}
	if err := l.s.AnswerDialog(context.Background(), l.key, st.Dialog.ID, true, ""); err != nil {
		t.Fatal(err)
	}
}

func liveAPopupCannotBlankItsOpenerUnnoticed(t *testing.T, l *live) {
	origin := "http://" + plainHost + ":" + l.port()
	l.open(origin+"/hostile/popup", "Opener")
	l.click(50, 30)
	l.until("the popup", func(st State) bool { return st.Popup })
	st := l.until("the rewritten opener", func(st State) bool { return !st.Popup && st.URL == "about:blank" && st.Origin != "" })
	if st.Origin != origin || st.Site != plainHost || st.Security != SecurityInsecure {
		t.Fatalf("origin %q site %q security %q", st.Origin, st.Site, st.Security)
	}
	l.evalUntil("document.body.innerText.trim()", eq("Sign in"))
}

func liveEveryCrossSiteFrameHasASessionOfItsOwn(t *testing.T, l *live) {
	l.open(l.srv.URL+"/hostile/nest", "Nest")
	in, _, tg, err := l.s.shown(l.key)
	if err != nil {
		t.Fatal(err)
	}
	frames := func() []*frame {
		l.s.mu.Lock()
		defer l.s.mu.Unlock()
		var out []*frame
		for _, f := range in.frames {
			if f.owner == tg {
				out = append(out, f)
			}
		}
		return out
	}
	deadline := time.Now().Add(10 * time.Second)
	for len(frames()) < 2 || slices.ContainsFunc(frames(), func(f *frame) bool { return f.origin == "" }) {
		if time.Now().After(deadline) {
			t.Fatalf("%d sessions", len(frames()))
		}
		time.Sleep(20 * time.Millisecond)
	}
	ctx := context.Background()
	found := map[string]string{}
	for _, f := range frames() {
		// The session reaches that frame's document, nested one included, and only that session
		// could have intercepted its file input: the page's stops at the process boundary.
		var what string
		if err := evaluate(ctx, in, f.session, `document.title+" "+document.querySelectorAll("input[type=file]").length`, &what); err != nil {
			t.Fatal(err)
		}
		found[f.origin] = what
		if err := in.call(ctx, f.session, "Page.setInterceptFileChooserDialog", map[string]any{"enabled": true}, nil); err != nil {
			t.Fatalf("no interception here: %v", err)
		}
	}
	want := map[string]string{"http://localhost:" + l.port(): "Mid 0", "http://" + plainHost + ":" + l.port(): "Leaf 1"}
	for origin, what := range want {
		if found[origin] != what {
			t.Fatalf("%s: %q in %v", origin, found[origin], found)
		}
	}
}

func liveASelectInACrossSiteFrameOpens(t *testing.T, l *live) {
	l.open(l.srv.URL+"/hostile/xselect", "Top")
	l.eval(`window.got=[];addEventListener('message',e=>got.push(e.data));1`, nil)
	time.Sleep(200 * time.Millisecond) // the frame's own load
	l.click(100, 15)
	st := l.until("the select", func(st State) bool { return st.Select != nil })
	if len(st.Select.Options) != 2 || st.Select.Options[1].Label != "two" {
		t.Fatalf("select %+v", st.Select)
	}
	if st.Select.X != 100 || st.Select.Y != 15 {
		t.Fatalf("opened at %v,%v", st.Select.X, st.Select.Y)
	}
	if err := l.s.PickSelect(context.Background(), l.key, st.Select.ID, 1); err != nil {
		t.Fatal(err)
	}
	l.evalUntil("got.join()", eq("picked two"))
}

func liveTypingIsNoGestureAndNeitherIsSpace(t *testing.T, l *live) {
	before := len(filesIn(t, l.s.Downloads()))
	l.open(l.srv.URL+"/hostile/keys", "Keys")
	l.eval(`t.focus();1`, nil)
	l.typeText("four typed words")
	l.until("the asking", func(st State) bool { return countState(st, DownloadAsking) > 0 })
	time.Sleep(300 * time.Millisecond)
	if n := len(filesIn(t, l.s.Downloads())) - before; n != 0 {
		t.Fatalf("%d files landed from typing", n)
	}
	// On a link, Enter is what a person means by "get that".
	l.open(l.srv.URL+"/hostile/keys?again", "Keys")
	l.eval(`a.focus();1`, nil)
	err := l.s.Input(context.Background(), l.key, []InputEvent{
		{Key: &KeyEvent{Type: "keyDown", Key: "Enter", Code: "Enter", KeyCode: 13, Text: "\r"}},
		{Key: &KeyEvent{Type: "keyUp", Key: "Enter", Code: "Enter", KeyCode: 13}},
	})
	if err != nil {
		t.Fatal(err)
	}
	l.until("the file", func(st State) bool {
		return slices.ContainsFunc(st.Downloads, func(d Download) bool { return d.Name == "by-key.txt" && d.State == DownloadCompleted })
	})
}

func countState(st State, state string) int {
	n := 0
	for _, d := range st.Downloads {
		if d.State == state {
			n++
		}
	}
	return n
}

func liveAGestureDoesNotSurviveTheNextPage(t *testing.T, l *live) {
	o := l.other(t, "thread:gesture", l.srv.URL+"/hostile/leave")
	o.click(50, 30)
	o.until("the next page", func(st State) bool { return st.Title == "After" })
	st := o.until("the file", func(st State) bool {
		return slices.ContainsFunc(st.Downloads, func(d Download) bool { return d.Name == "after.txt" })
	})
	d := st.Downloads[slices.IndexFunc(st.Downloads, func(d Download) bool { return d.Name == "after.txt" })]
	if d.State != DownloadAsking {
		t.Fatalf("%+v", d)
	}
	if err := o.s.AnswerDownload(context.Background(), o.key, d.ID, false); err != nil {
		t.Fatal(err)
	}
}

func liveAPagesCopyDoesNotOutliveThePage(t *testing.T, l *live) {
	ctx := context.Background()
	before := l.now().Copied
	l.click(135, 288)
	l.until("the notice", func(st State) bool { return st.Copied > before })
	l.open(l.srv.URL+"/hostile/plain", "Plain")
	l.until("the strip going", func(st State) bool { return st.Copied == 0 })
	l.copied.Store("what the Mac holds")
	if n, err := l.s.Copy(ctx, l.key, true); err != nil || n != 0 {
		t.Fatalf("the last page's text moved %d characters: %v", n, err)
	}
	if got := l.copied.Load(); got != "what the Mac holds" {
		t.Fatalf("the Mac's clipboard became %q", got)
	}
}

func liveWebAuthnReachesNothingReal(t *testing.T, l *live) {
	// localhost is a secure context, which WebAuthn needs.
	l.open("http://localhost:"+l.port()+"/hostile/plain", "Plain")
	ctx := context.Background()
	in, _, tg, err := l.s.shown(l.key)
	if err != nil {
		t.Fatal(err)
	}
	// Adding an authenticator answers only inside the virtual environment, so this is what shows
	// the page's call below cannot reach the Mac's sheet. Without it the test must not make the call.
	var added struct {
		ID string `json:"authenticatorId"`
	}
	err = in.call(ctx, tg.session, "WebAuthn.addVirtualAuthenticator", map[string]any{"options": map[string]any{"protocol": "ctap2", "transport": "internal"}}, &added)
	if err != nil || added.ID == "" {
		t.Fatalf("no virtual environment, so stopping here: %v", err)
	}
	if err := in.call(ctx, tg.session, "WebAuthn.removeVirtualAuthenticator", map[string]any{"authenticatorId": added.ID}, nil); err != nil {
		t.Fatal(err)
	}
	var got string
	err = evaluate(ctx, in, tg.session, `(async()=>{try{await navigator.credentials.create({publicKey:{rp:{name:'x',id:'localhost'},user:{id:new Uint8Array(8),name:'u',displayName:'u'},challenge:new Uint8Array(32),pubKeyCredParams:[{type:'public-key',alg:-7}],timeout:500}});return 'created'}catch(e){return e.name}})()`, &got)
	if err != nil {
		t.Fatal(err)
	}
	if got != "NotAllowedError" {
		t.Fatalf("create ended in %q", got)
	}
}

func liveOnlyTheWebIsReachable(t *testing.T, l *live) {
	ctx := context.Background()
	in, _, tg, err := l.s.shown(l.key)
	if err != nil {
		t.Fatal(err)
	}
	// A scheme nothing on this Mac handles: the same rule covers mailto:, which must not be tried.
	var res struct {
		ErrorText string `json:"errorText"`
	}
	if err := in.conn.call(ctx, tg.session, "Page.navigate", map[string]any{"url": "cf-probe:hello"}, &res); err != nil {
		t.Fatal(err)
	}
	if res.ErrorText != "net::ERR_BLOCKED_BY_ADMINISTRATOR" {
		t.Fatalf("answered %q", res.ErrorText)
	}
	l.open(l.srv.URL+"/hostile/web", "Web")
	var got []string
	l.evalUntil("got.length.toString()", eq("2"))
	var raw string
	l.eval("JSON.stringify(got.sort())", &raw)
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, []string{"blob", "data"}) {
		t.Fatalf("frames %v", got)
	}
}

// history.pushState with a 64 MB state, eight times, swelled Chrome's own process by about 800 MB.
// The watch took the busiest helper for it, which was a busy neighbour: it is the page that
// pushed that has to go, and closing it is what gives the memory back.
func liveAStateFloodClosesThePusherAndNoNeighbour(t *testing.T, l *live) {
	busy := l.other(t, "thread:busy", "http://"+plainHost+":"+l.port()+"/hostile/busy")
	flood := l.other(t, "thread:stateflood", "http://localhost:"+l.port()+"/hostile/stateflood")
	st := flood.until("the pusher closed", func(st State) bool { return strings.Contains(st.Notice, "flooding") })
	if !strings.Contains(st.Notice, "localhost") {
		t.Fatalf("notice %q", st.Notice)
	}
	if st := busy.now(); st.Notice != "" {
		t.Fatalf("the busy neighbour: %q", st.Notice)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := l.s.Input(ctx, busy.key, []InputEvent{{Mouse: &MouseEvent{Type: "mouseMoved", Button: "none", X: 5, Y: 5}}}); err != nil {
		t.Fatalf("the busy neighbour: %v", err)
	}
	if !l.s.Running() {
		t.Fatal("Chrome went with the page")
	}
}

// A page sent its visitor to another site whose first paint was slow: the page before stayed on
// screen under the new site's address.
func liveACommitToAnotherSiteIsCoveredUntilItPaints(t *testing.T, l *live) {
	l.open("http://"+plainHost+":"+l.port()+"/hostile/lure", "Lure")
	st := l.until("the new site", func(st State) bool { return strings.HasSuffix(st.URL, "/hostile/slowpaint") })
	if !st.AwaitingFrame {
		t.Fatalf("the lure's last frame stands under %q", st.URL)
	}
	sent := l.count.Load()
	time.Sleep(time.Second)
	if st := l.now(); st.AwaitingFrame && l.count.Load() != sent {
		t.Fatal("a frame came while the page still waited to paint")
	}
	l.until("its first frame", func(st State) bool { return !st.AwaitingFrame })
	if l.count.Load() == sent {
		t.Fatal("uncovered with no frame")
	}
}

// A popup whose frame tree was too long to read, by Page.getFrameTree, showed an empty bar with no
// site and no mark over a fake sign-in.
func liveAPopupWithAHugeFrameTreeIsNamedAndMarked(t *testing.T, l *live) {
	origin := "http://" + plainHost + ":" + l.port()
	l.open(origin+"/hostile/tree", "Tree")
	l.click(20, 20)
	st := l.until("the popup", func(st State) bool { return st.Popup && st.URL != "" })
	if st.URL != "about:blank" || st.Origin != origin || st.Security != SecurityInsecure {
		t.Fatalf("url %q origin %q security %q", st.URL, st.Origin, st.Security)
	}
	if err := l.s.Go(context.Background(), l.key, -1); err != nil {
		t.Fatal(err)
	}
	l.until("the opener", func(st State) bool { return !st.Popup })
}

// Chrome says nothing of a frame inside a frame when the outer one goes, or when the page does:
// counted for good, they used up the page's frames.
func liveFramesInsideFramesAreNotLeftCounted(t *testing.T, l *live) {
	counted := func() int {
		l.s.mu.Lock()
		defer l.s.mu.Unlock()
		in := l.s.chrome
		t := l.s.surfaces[l.key].top()
		n := 0
		for _, f := range in.frames {
			if f.owner == t {
				n++
			}
		}
		return n + 1000*t.frames
	}
	nested := func() {
		l.open(l.srv.URL+"/hostile/nest", "Nest")
		for deadline := time.Now().Add(10 * time.Second); counted() != 2002; time.Sleep(20 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("frames %d", counted())
			}
		}
	}
	nested()
	l.eval(`document.querySelector('iframe').remove();1`, nil)
	for deadline := time.Now().Add(5 * time.Second); counted() != 0; time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("the frame inside the removed one: %d", counted())
		}
	}
	nested()
	l.open(l.srv.URL+"/hostile/plain", "Plain")
	if n := counted(); n != 0 {
		t.Fatalf("after the page went: %d", n)
	}
}

// Chrome's PDF viewer has Download and Print buttons of its own. A PDF downloads instead, under
// the rule for any download; an embedded one shows Chrome's placeholder.
func liveAPDFIsADownload(t *testing.T, l *live) {
	l.open(l.srv.URL+"/hostile/pdfs", "PDFs")
	l.click(40, 30)
	st := l.until("the download", func(st State) bool { return countState(st, DownloadCompleted) == 1 })
	if st.URL != l.srv.URL+"/hostile/pdfs" {
		t.Fatalf("the page went to %q", st.URL)
	}
	for _, d := range st.Downloads {
		if d.State == DownloadCompleted && filepath.Base(d.Path) != "terms.pdf" {
			t.Fatalf("landed as %q", d.Path)
		}
	}
	var tg struct {
		TargetInfos []struct {
			URL string `json:"url"`
		} `json:"targetInfos"`
	}
	in, _, _, err := l.s.shown(l.key)
	if err != nil {
		t.Fatal(err)
	}
	if err := in.call(context.Background(), "", "Target.getTargets", map[string]any{"filter": []map[string]any{{}}}, &tg); err != nil {
		t.Fatal(err)
	}
	for _, x := range tg.TargetInfos {
		// The viewer's extension.
		if strings.Contains(x.URL, "mhjfbmdgcfjbbpaeojofohoefgiehjai") {
			t.Fatalf("Chrome's PDF viewer is up: %s", x.URL)
		}
	}
}
