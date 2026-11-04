package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

// fakePasteHost records the calls it gets, waits included.
type fakePasteHost struct {
	calls      []string
	writeErr   error
	postErr    error
	restored   bool
	restoreErr error
}

func (f *fakePasteHost) Save() (int, int) {
	f.calls = append(f.calls, "save")
	return 2, 1
}

func (f *fakePasteHost) Write(string) (int64, error) {
	f.calls = append(f.calls, "write")
	return 7, f.writeErr
}

func (f *fakePasteHost) Post() error {
	f.calls = append(f.calls, "post")
	return f.postErr
}

func (f *fakePasteHost) Restore(count int64) (bool, error) {
	if count != 7 {
		f.calls = append(f.calls, "restore with the wrong count")
	}
	f.calls = append(f.calls, "restore")
	return f.restored, f.restoreErr
}

func TestPasteText(t *testing.T) {
	boom := errors.New("boom")
	tests := []struct {
		name      string
		host      fakePasteHost
		wantCalls []string
		wantErr   string
		wantSaid  string
	}{
		{
			name:      "pastes, waits, restores",
			host:      fakePasteHost{restored: true},
			wantCalls: []string{"save", "write", "wait 50ms", "post", "wait 100ms", "wait 500ms", "restore"},
			wantSaid:  "clipboard restored",
		},
		{
			name:      "something else wrote to the clipboard",
			host:      fakePasteHost{},
			wantCalls: []string{"save", "write", "wait 50ms", "post", "wait 100ms", "wait 500ms", "restore"},
			wantSaid:  "clipboard left alone",
		},
		{
			name:      "a failed restore is said",
			host:      fakePasteHost{restoreErr: boom},
			wantCalls: []string{"save", "write", "wait 50ms", "post", "wait 100ms", "wait 500ms", "restore"},
			wantSaid:  "clipboard not restored: boom",
		},
		{
			name:      "a failed write still gives the clipboard back",
			host:      fakePasteHost{writeErr: boom, restored: true},
			wantCalls: []string{"save", "write", "restore"},
			wantErr:   "write clipboard: boom",
			wantSaid:  "clipboard restored",
		},
		{
			name:      "a failed post gives the clipboard back at once",
			host:      fakePasteHost{postErr: boom, restored: true},
			wantCalls: []string{"save", "write", "wait 50ms", "post", "restore"},
			wantErr:   "post Cmd+V: boom",
			wantSaid:  "clipboard restored",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			host := tt.host
			var said []string
			wait := func(d time.Duration) { host.calls = append(host.calls, "wait "+d.String()) }
			err := pasteText(&host, "text", wait, func(s string) { said = append(said, s) })
			if !reflect.DeepEqual(host.calls, tt.wantCalls) {
				t.Errorf("calls\n got %v\nwant %v", host.calls, tt.wantCalls)
			}
			if got := errText(err); got != tt.wantErr {
				t.Errorf("err = %q, want %q", got, tt.wantErr)
			}
			if !strings.Contains(strings.Join(said, "\n"), tt.wantSaid) {
				t.Errorf("said %q, want it to include %q", said, tt.wantSaid)
			}
		})
	}
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
