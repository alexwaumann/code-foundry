package main

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// checkReq is a page check of /h/p.html for thread t-1.
func checkReq(id string, png bool) *v1.ShotRequest {
	return &v1.ShotRequest{Id: id, Width: 720, Height: 2400, Page: &v1.PageShot{Path: "/h/p.html", ThreadId: "t-1", SettleMs: 1000, Png: png}}
}

// publishedChecks collects the page checks' answers.
type publishedChecks struct{ ch chan *v1.PublishShotRequest }

func (p *publishedChecks) publish(_ context.Context, r *v1.PublishShotRequest) error {
	p.ch <- r
	return nil
}

// A page check goes to the page as its own request, and is answered with the page's report:
// with the card frame's snapshot (clipped to its height) when asked, the snapshot's failure
// in the report, and no snapshot of a page that did not render.
func TestShotPageCheck(t *testing.T) {
	report := PageChecked{Loaded: true, Settled: true, Height: 312, SettleMs: 800, Problems: []PageCheckIssue{{Kind: "script", Message: "x is not defined", Where: "p.html:3:1", Count: 2}}}
	tests := []struct {
		name      string
		png       bool
		report    PageChecked
		picture   func(string) shotPicture
		wantPanel []string
		wantPNG   string
		wantShot  string
	}{
		{name: "report alone", report: report, wantPanel: []string{"open", "show:a 720x2400", "hide"}},
		{name: "report and the frame's snapshot", png: true, report: report,
			wantPanel: []string{"open", "show:a 720x2400", "snapshot:a clip=312", "hide"}, wantPNG: "png:a"},
		{name: "a snapshot that fails is said in the report", png: true, report: report,
			picture:   func(string) shotPicture { return shotPicture{err: errors.New("no image")} },
			wantPanel: []string{"open", "show:a 720x2400", "snapshot:a clip=312", "hide"}, wantShot: "the snapshot failed: no image"},
		{name: "no snapshot of a page that did not render", png: true, report: PageChecked{Failure: "Could not render this page: not found"},
			wantPanel: []string{"open", "show:a 720x2400", "hide"}, wantShot: "the page was not rendered"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got shotPageRequest
			panel := &fakeShotPanel{picture: tt.picture}
			svc, _, ctx, _ := newShotHarness(t, panel)
			pub := &publishedChecks{ch: make(chan *v1.PublishShotRequest, 4)}
			svc.publish = pub.publish
			panel.onShow = func(req shotPageRequest) {
				got = req
				go svc.Checked(req.ID, tt.report)
			}
			svc.take(ctx, checkReq("a", tt.png))
			var r *v1.PublishShotRequest
			select {
			case r = <-pub.ch:
			case <-time.After(wait):
				t.Fatal("nothing published")
			}
			if got.Page == nil || got.Page.Path != "/h/p.html" || got.Page.ThreadID != "t-1" || got.Page.SettleMs != 1000 || got.Plugin != "" {
				t.Errorf("page request %+v", got)
			}
			rep := r.GetPageReport()
			if rep == nil || r.GetError() != "" || string(r.GetPng()) != tt.wantPNG || rep.GetShotError() != tt.wantShot || rep.GetFailure() != tt.report.Failure {
				t.Fatalf("published %v", r)
			}
			if tt.report.Loaded && (rep.GetHeight() != 312 || len(rep.GetProblems()) != 1 || rep.GetProblems()[0].GetCount() != 2 || rep.GetProblems()[0].GetWhere() != "p.html:3:1") {
				t.Errorf("report %v", rep)
			}
			if got := panel.got(); !slices.Equal(got, tt.wantPanel) {
				t.Errorf("panel %v, want %v", got, tt.wantPanel)
			}
		})
	}
}

// A page check has its settle time on top of the host's own, and a page that sent another
// kind of answer is answered with an error.
func TestShotPageCheckTimeAndWrongAnswer(t *testing.T) {
	panel := &fakeShotPanel{}
	svc, pub, ctx, _ := newShotHarness(t, panel)
	svc.timeout = 150 * time.Millisecond
	panel.onShow = func(req shotPageRequest) {
		// Past the host's 150 ms, within its 150 ms and the check's 1 s settle.
		go func() {
			time.Sleep(400 * time.Millisecond)
			svc.Rendered(req.ID, ShotRendered{ContentHeight: 10})
		}()
	}
	svc.take(ctx, checkReq("a", false))
	if got := pub.next(t, wait); !strings.HasPrefix(got, "a error=the page check sent no report") {
		t.Fatalf("published %q", got)
	}
}
