package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

func TestParseEventSources(t *testing.T) {
	tests := []struct {
		in      string
		want    []v1.EventSource
		wantErr bool
	}{
		{"", nil, false},
		{"thread-list", []v1.EventSource{v1.EventSource_EVENT_SOURCE_THREAD_LIST}, false},
		{"thread_list, project,thread-list", []v1.EventSource{v1.EventSource_EVENT_SOURCE_THREAD_LIST, v1.EventSource_EVENT_SOURCE_PROJECT}, false},
		{"Action,UI", []v1.EventSource{v1.EventSource_EVENT_SOURCE_ACTION, v1.EventSource_EVENT_SOURCE_UI}, false},
		{"threads", nil, true},
		{"unspecified", nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := parseEventSources(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, want error %v", err, tt.wantErr)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("got %v, want %v", got, tt.want)
				}
			}
		})
	}
	if names := strings.Join(eventSourceNames(), ","); !strings.HasPrefix(names, "project,terminal,thread-list,gh,ui,gitops,settings,update,workspace,thread,action") {
		t.Errorf("names = %s", names)
	}
}

func TestEventLine(t *testing.T) {
	tests := []struct {
		name string
		ev   *v1.Event
		want string
	}{
		{"thread updated", &v1.Event{Seq: 42, Event: &v1.Event_ThreadList{ThreadList: &v1.ThreadListEvent{Event: &v1.ThreadListEvent_Updated{
			Updated: &v1.Thread{Id: "s-1", Name: "fix", Status: v1.ThreadStatus_THREAD_STATUS_BUSY, StatusReason: "working"}}}}},
			"42 thread-list updated s-1: busy (working)"},
		{"thread removed", &v1.Event{Seq: 43, Event: &v1.Event_ThreadList{ThreadList: &v1.ThreadListEvent{Event: &v1.ThreadListEvent_RemovedId{RemovedId: "s-1"}}}},
			"43 thread-list removed-id s-1"},
		{"snapshot", &v1.Event{Event: &v1.Event_Project{Project: &v1.ProjectEvent{Event: &v1.ProjectEvent_Snapshot{Snapshot: &v1.ProjectSnapshot{}}}}},
			"- project snapshot"},
		{"project updated", &v1.Event{Seq: 7, Event: &v1.Event_Project{Project: &v1.ProjectEvent{Event: &v1.ProjectEvent_ProjectUpdated{ProjectUpdated: &v1.Project{Id: "r1", Name: "app"}}}}},
			"7 project project-updated r1"},
		{"worktree files", &v1.Event{Seq: 11, Event: &v1.Event_Project{Project: &v1.ProjectEvent{Event: &v1.ProjectEvent_WorktreeFilesChanged{
			WorktreeFilesChanged: &v1.WorktreeFilesChanged{ProjectId: "r1", Path: "/code/app", Files: []*v1.ChangedFile{{Path: "a.go", Op: v1.FileOp_FILE_OP_MODIFIED}}}}}}},
			"11 project worktree-files-changed /code/app"},
		{"terminal", &v1.Event{Seq: 8, Event: &v1.Event_Terminal{Terminal: &v1.TerminalEvent{Event: &v1.TerminalEvent_Updated{Updated: &v1.Terminal{Id: "t-1"}}}}},
			"8 terminal updated t-1"},
		{"ui intent", &v1.Event{Seq: 9, Event: &v1.Event_Ui{Ui: &v1.UiIntent{Intent: &v1.UiIntent_FocusThread_{FocusThread: &v1.UiIntent_FocusThread{ThreadId: "s-2"}}}}},
			"9 ui focus-thread s-2"},
		{"pending", &v1.Event{Seq: 10, Event: &v1.Event_Thread{Thread: &v1.ThreadEvent{Event: &v1.ThreadEvent_Pending{Pending: &v1.ThreadPending{ThreadId: "s-3"}}}}},
			"10 thread pending s-3"},
		{"skill epoch", &v1.Event{Seq: 12, Event: &v1.Event_Skill{Skill: &v1.SkillEvent{Epoch: 3}}}, "12 skill epoch 3"},
		{"plugin registry epoch", &v1.Event{Seq: 13, Event: &v1.Event_Plugin{Plugin: &v1.PluginEvent{Event: &v1.PluginEvent_RegistryEpoch{RegistryEpoch: 2}}}},
			"13 plugin registry-epoch 2"},
		{"empty", &v1.Event{}, "- (empty event)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := eventLine(tt.ev); got != tt.want {
				t.Errorf("eventLine = %q, want %q", got, tt.want)
			}
		})
	}
}

// lineWriter hands each line written to it to a channel.
type lineWriter struct {
	w     *io.PipeWriter
	lines chan string
}

func newLineWriter() *lineWriter {
	r, w := io.Pipe()
	lw := &lineWriter{w: w, lines: make(chan string, 64)}
	go func() {
		sc := bufio.NewScanner(r)
		for sc.Scan() {
			lw.lines <- sc.Text()
		}
	}()
	return lw
}

func (lw *lineWriter) Write(p []byte) (int, error) { return lw.w.Write(p) }

func (lw *lineWriter) next(t *testing.T) string {
	t.Helper()
	select {
	case l := <-lw.lines:
		return l
	case <-time.After(5 * time.Second):
		t.Fatal("no line")
		return ""
	}
}

func TestRunEvents(t *testing.T) {
	b := bus.New()
	projects, threads := projecttest.New(b), threadtest.New(b)
	route := api.NewEvents(api.EventsDeps{Bus: b, Project: projects, Thread: threads}).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	c := &client.Client{Events: codefoundryv1connect.NewEventServiceClient(srv.Client(), srv.URL)}

	start := func(t *testing.T, args ...string) (*lineWriter, context.CancelFunc, chan error, *bytes.Buffer) {
		t.Helper()
		lw := newLineWriter()
		var stderr bytes.Buffer
		cl := &cli{stdout: lw, stderr: &stderr, connect: func(context.Context) (*client.Client, error) { return c, nil }}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- runEvents(ctx, cl, args) }()
		t.Cleanup(cancel)
		return lw, cancel, done, &stderr
	}

	lw, cancel, done, _ := start(t, "--source", "project,thread-list", "--json")
	var epoch string
	for range 2 {
		var ev map[string]any
		if err := json.Unmarshal([]byte(lw.next(t)), &ev); err != nil {
			t.Fatal(err)
		}
		if _, ok := ev["seq"]; ok {
			t.Fatalf("snapshot with a seq: %v", ev)
		}
		if e, _ := ev["epoch"].(string); e == "" || (epoch != "" && e != epoch) {
			t.Fatalf("snapshot epoch %v (first %q)", ev["epoch"], epoch)
		} else {
			epoch = e
		}
	}
	projects.Put(project.Project{ID: "r1", Name: "app"})
	threads.Put(thread.Thread{ID: "s1", State: thread.StateConnected, Status: thread.StatusBusy, StatusReason: "working"})
	projects.Put(project.Project{ID: "r2", Name: "lib"})
	// The text line of each live event by seq: the sources' topics race to the hub, so
	// the three may be numbered in any order.
	texts := map[uint64]string{}
	for range 3 {
		line := lw.next(t)
		var ev v1.Event
		if err := protojson.Unmarshal([]byte(line), &ev); err != nil || ev.GetSeq() == 0 || ev.GetEpoch() != epoch {
			t.Fatalf("line %q (err %v), want a seq and epoch %s", line, err, epoch)
		}
		texts[ev.GetSeq()] = eventLine(&ev)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("after Ctrl-C: %v", err)
	}
	seqs := slices.Sorted(maps.Keys(texts))

	// A second client resumes after the first event with the epoch: the other two, as
	// text lines.
	lw2, cancel2, done2, _ := start(t, "--source", "project,thread-list", "--since", strconv.FormatUint(seqs[0], 10), "--since-epoch", epoch)
	got := []string{lw2.next(t), lw2.next(t)}
	if want := []string{texts[seqs[1]], texts[seqs[2]]}; !slices.Equal(got, want) {
		t.Fatalf("replay = %q, want %q", got, want)
	}
	cancel2()
	if err := <-done2; err != nil {
		t.Fatal(err)
	}

	// Another daemon's epoch (it restarted), or none to compare (E8): snapshots, not a
	// replay; without an epoch a notice says so.
	for _, tt := range []struct {
		args       []string
		wantNotice string
	}{
		{args: []string{"--since-epoch", "0123456789ab"}},
		{wantNotice: "code-foundry events: --since " + strconv.FormatUint(seqs[0], 10) +
			" without --since-epoch could be another daemon's seq; starting with snapshots (pass both to resume)\n"},
	} {
		lw3, cancel3, done3, stderr := start(t, append([]string{"--source", "project", "--since", strconv.FormatUint(seqs[0], 10)}, tt.args...)...)
		if got := lw3.next(t); got != "- project snapshot" {
			t.Fatalf("first line with %v = %q, want the snapshot", tt.args, got)
		}
		cancel3()
		if err := <-done3; err != nil {
			t.Fatal(err)
		}
		if stderr.String() != tt.wantNotice {
			t.Errorf("stderr with %v = %q, want %q", tt.args, stderr.String(), tt.wantNotice)
		}
	}
}

// When the daemon goes away the stream exits 1 and says how to resume (E8: exit 0 and
// an empty stderr looked like a normal end).
func TestRunEventsDaemonGone(t *testing.T) {
	b := bus.New()
	projects := projecttest.New(b)
	route := api.NewEvents(api.EventsDeps{Bus: b, Project: projects}).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	c := &client.Client{Events: codefoundryv1connect.NewEventServiceClient(srv.Client(), srv.URL)}
	lw := newLineWriter()
	var stderr bytes.Buffer
	cl := &cli{stdout: lw, stderr: &stderr, connect: func(context.Context) (*client.Client, error) { return c, nil }}
	done := make(chan error, 1)
	go func() { done <- runEvents(context.Background(), cl, []string{"--source", "project", "--json"}) }()

	lw.next(t) // the snapshot
	projects.Put(project.Project{ID: "r1", Name: "app"})
	var ev v1.Event
	if err := protojson.Unmarshal([]byte(lw.next(t)), &ev); err != nil || ev.GetSeq() == 0 {
		t.Fatalf("event %v (err %v)", &ev, err)
	}
	srv.CloseClientConnections()
	select {
	case err := <-done:
		if !errors.Is(err, errReported) {
			t.Fatalf("err = %v, want exit 1 (errReported)", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the stream did not end")
	}
	want := fmt.Sprintf("; resume with --since %d --since-epoch %s\n", ev.GetSeq(), ev.GetEpoch())
	if s := stderr.String(); !strings.HasPrefix(s, "code-foundry events: daemon connection lost") || !strings.HasSuffix(s, want) {
		t.Errorf("stderr = %q, want the loss and %q", s, want)
	}
}

func TestConnectionLost(t *testing.T) {
	tests := []struct {
		name  string
		last  uint64
		epoch string
		err   error
		want  string
	}{
		{name: "a clean end", last: 42, epoch: "e1", want: "daemon connection lost; resume with --since 42 --since-epoch e1"},
		{name: "an error", last: 42, epoch: "e1", err: errors.New("unexpected EOF"),
			want: "daemon connection lost (unexpected EOF); resume with --since 42 --since-epoch e1"},
		{name: "only snapshots seen", epoch: "e1", want: "daemon connection lost; run events again to start with snapshots"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := connectionLost(tt.last, tt.epoch, tt.err); got != tt.want {
				t.Errorf("connectionLost = %q, want %q", got, tt.want)
			}
		})
	}
}

// A worktree's file changes reach `events --json --source project` as protojson.
func TestRunEventsWorktreeFiles(t *testing.T) {
	b := bus.New()
	projects := projecttest.New(b)
	route := api.NewEvents(api.EventsDeps{Bus: b, Project: projects}).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	c := &client.Client{Events: codefoundryv1connect.NewEventServiceClient(srv.Client(), srv.URL)}
	lw := newLineWriter()
	var stderr bytes.Buffer
	cl := &cli{stdout: lw, stderr: &stderr, connect: func(context.Context) (*client.Client, error) { return c, nil }}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() { done <- runEvents(ctx, cl, []string{"--source", "project", "--json"}) }()

	lw.next(t) // the snapshot
	projects.FilesChanged(project.WorktreeFilesChanged{ProjectID: "r1", Path: "/code/app", Truncated: true, Files: []project.ChangedFile{
		{Path: "pkg/a_test.go", Op: project.FileCreated}, {Path: "old/", Op: project.FileRemoved},
	}})
	var ev map[string]any
	if err := json.Unmarshal([]byte(lw.next(t)), &ev); err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(ev["project"])
	want := `{"worktreeFilesChanged":{"files":[{"op":"FILE_OP_CREATED","path":"pkg/a_test.go"},{"op":"FILE_OP_REMOVED","path":"old/"}],"path":"/code/app","projectId":"r1","truncated":true}}`
	if string(got) != want {
		t.Fatalf("project = %s\nwant      %s", got, want)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRunEventsBadSource(t *testing.T) {
	cl, _, stderr := newTestCLI()
	err := runEvents(context.Background(), cl, []string{"--source", "nope"})
	if !errors.Is(err, errUsage) || !strings.Contains(stderr.String(), `unknown source "nope"`) {
		t.Fatalf("err = %v, stderr %q", err, stderr.String())
	}
}
