package settings

import (
	"context"
	"testing"
)

// Close returns only after fsnotify's reader goroutine has ended: that reader can close
// a watch's fd again after the watcher's Close (fsnotify's kqueue backend), and a file
// the caller opens after Close could have that number (store.go, Close). The reader
// closes Events as it ends, so Events is closed by the time Close returns.
func TestCloseWaitsForTheWatcher(t *testing.T) {
	s, _, _ := openTest(t, "")
	if s.watcher == nil {
		t.Fatal("no watcher")
	}
	// A save renames a file in the watched directory: the reader drops that watch.
	if _, err := s.Update(context.Background(), map[string]string{KeyFontSize: "14"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case _, open := <-s.watcher.Events:
		if open {
			t.Error("an event after Close")
		}
	default:
		t.Error("Close returned while the watcher's reader was still running")
	}
}
