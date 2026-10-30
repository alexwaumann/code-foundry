package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func dictationSnapshot(state v1.DictationState, mut func(*v1.DictationSnapshot)) *v1.DictationSnapshot {
	s := &v1.DictationSnapshot{
		Enabled: state != v1.DictationState_DICTATION_STATE_DISABLED, State: state,
		Model:    &v1.DictationModel{Name: "ggml-large-v3-turbo-q8_0.bin", SizeBytes: 874188075, Downloaded: true},
		Hardware: &v1.DictationHardware{Chip: "Apple M1 Pro", MemoryBytes: 16 << 30, M1Family: true},
	}
	if mut != nil {
		mut(s)
	}
	return s
}

func newDictationRegistry(t *testing.T, b *commandtest.Dictation, snap *v1.DictationSnapshot, e command.Emitter) *command.Registry {
	t.Helper()
	reg := command.NewRegistry()
	if err := command.RegisterDictation(reg, command.DictationDeps{
		Dictation: b, Status: func() *v1.DictationSnapshot { return snap }, Emitter: e,
	}); err != nil {
		t.Fatal(err)
	}
	return reg
}

func TestDictationAvailability(t *testing.T) {
	notDownloaded := func(s *v1.DictationSnapshot) { s.Model.Downloaded = false }
	downloading := func(s *v1.DictationSnapshot) {
		s.Model.Downloaded = false
		s.Model.Download = &v1.DictationDownload{ReceivedBytes: 1, TotalBytes: 2}
	}
	for _, tc := range []struct {
		name string
		snap *v1.DictationSnapshot
		// available lists the commands with a When that are available.
		available []string
	}{
		{"unavailable", nil, nil},
		{"off without model", dictationSnapshot(v1.DictationState_DICTATION_STATE_DISABLED, notDownloaded), []string{"dictation.download"}},
		{"off with model", dictationSnapshot(v1.DictationState_DICTATION_STATE_DISABLED, nil), []string{"dictation.remove"}},
		{"downloading", dictationSnapshot(v1.DictationState_DICTATION_STATE_DOWNLOADING, downloading), []string{"dictation.download.cancel", "dictation.remove"}},
		{"ready", dictationSnapshot(v1.DictationState_DICTATION_STATE_READY, nil), []string{"dictation.toggle", "dictation.remove"}},
		{"on without model", dictationSnapshot(v1.DictationState_DICTATION_STATE_NO_MODEL, notDownloaded), []string{"dictation.download"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reg := newDictationRegistry(t, &commandtest.Dictation{}, tc.snap, &commandtest.Emitter{})
			for _, name := range []string{"dictation.toggle", "dictation.download", "dictation.download.cancel", "dictation.remove"} {
				c, _ := reg.Get(name)
				want := false
				for _, a := range tc.available {
					want = want || a == name
				}
				if got := c.Available(command.Context{}); got != want {
					t.Errorf("%s available = %v, want %v", name, got, want)
				}
			}
		})
	}
}

func TestDictationCommands(t *testing.T) {
	listening := dictationSnapshot(v1.DictationState_DICTATION_STATE_LISTENING, func(s *v1.DictationSnapshot) {
		s.Session = &v1.DictationSession{Id: "dict-1", ClientId: "composer-1"}
	})
	for _, tc := range []struct {
		name    string
		snap    *v1.DictationSnapshot
		command string
		args    map[string]string
		err     error
		// want is the request the backend got (nil: none), msg a substring of the message.
		want proto.Message
		msg  string
	}{
		{"start from the cli", listening, "dictation.start", nil, nil, &v1.StartDictationRequest{ClientId: "cli"}, "listening (session dict-9)"},
		{"start for a client", listening, "dictation.start", map[string]string{"client": "c7"}, nil, &v1.StartDictationRequest{ClientId: "c7"}, "dict-9"},
		{"stop the open session", listening, "dictation.stop", nil, nil, &v1.StopDictationRequest{SessionId: "dict-1", Flush: true}, "stopped dict-1"},
		{"stop without flush", listening, "dictation.stop", map[string]string{"session": "dict-2", "flush": "false"}, nil, &v1.StopDictationRequest{SessionId: "dict-2"}, "stopped dict-2"},
		{"stop with nobody dictating", dictationSnapshot(v1.DictationState_DICTATION_STATE_READY, nil), "dictation.stop", nil, nil, nil, "nobody is dictating"},
		{"download", dictationSnapshot(v1.DictationState_DICTATION_STATE_DISABLED, func(s *v1.DictationSnapshot) { s.Model.Downloaded = false }),
			"dictation.download", nil, nil, &v1.DownloadDictationModelRequest{}, "downloading ggml-large-v3-turbo-q8_0.bin (874 MB); dictation turns on"},
		{"start refused", listening, "dictation.start", nil, errors.New("another composer is dictating"), &v1.StartDictationRequest{ClientId: "cli"}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := &commandtest.Dictation{Err: tc.err, Snapshot: tc.snap, SessionID: "dict-9"}
			reg := newDictationRegistry(t, b, tc.snap, &commandtest.Emitter{})
			res, err := reg.Invoke(context.Background(), command.Context{}, tc.command, tc.args)
			if tc.err != nil {
				if err == nil {
					t.Fatal("no error")
				}
			} else if err != nil {
				t.Fatal(err)
			}
			reqs := b.Requests()
			switch {
			case tc.want == nil && len(reqs) != 0:
				t.Errorf("requests %v, want none", reqs)
			case tc.want != nil && (len(reqs) != 1 || !proto.Equal(reqs[0], tc.want)):
				t.Errorf("requests %v, want %v", reqs, tc.want)
			}
			if !strings.Contains(res.Message, tc.msg) {
				t.Errorf("message %q, want %q", res.Message, tc.msg)
			}
		})
	}
}

func TestDictationStatus(t *testing.T) {
	for _, tc := range []struct {
		name string
		snap *v1.DictationSnapshot
		want string
	}{
		{"ready on an M1", dictationSnapshot(v1.DictationState_DICTATION_STATE_READY, nil),
			"dictation: ready\nthis Mac: Apple M1 Pro, 16 GB (an M1: each phrase takes a few seconds)"},
		{"off without model", dictationSnapshot(v1.DictationState_DICTATION_STATE_DISABLED, func(s *v1.DictationSnapshot) {
			s.Model.Downloaded = false
			s.Hardware = &v1.DictationHardware{Chip: "Apple M4 Pro", MemoryBytes: 48 << 30}
		}), "dictation: off; the model is not downloaded (dictation.download)\nthis Mac: Apple M4 Pro, 48 GB"},
		{"downloading", dictationSnapshot(v1.DictationState_DICTATION_STATE_DOWNLOADING, func(s *v1.DictationSnapshot) {
			s.Model.Download = &v1.DictationDownload{ReceivedBytes: 557_000_000, TotalBytes: 874_188_075, BytesPerSecond: 11_000_000}
			s.Hardware = nil
		}), "dictation: downloading the model: 557 MB of 874 MB at 11 MB/s"},
		{"download failed from every source", dictationSnapshot(v1.DictationState_DICTATION_STATE_DISABLED, func(s *v1.DictationSnapshot) {
			s.Model.Downloaded = false
			s.Error = "Download failed:\nGitHub: gh is not logged in (run gh auth login)\nhuggingface.co: the server answered 403 Forbidden"
			s.Hardware = nil
		}), "dictation: off; the model is not downloaded (dictation.download)\nDownload failed:\nGitHub: gh is not logged in (run gh auth login)\nhuggingface.co: the server answered 403 Forbidden"},
		{"download failed", dictationSnapshot(v1.DictationState_DICTATION_STATE_DISABLED, func(s *v1.DictationSnapshot) {
			s.Model.Downloaded = false
			s.Error = "Download failed: the downloaded model is damaged (sha256 mismatch)"
			s.Hardware = nil
		}), "dictation: off; the model is not downloaded (dictation.download); Download failed: the downloaded model is damaged (sha256 mismatch)"},
		{"failed", dictationSnapshot(v1.DictationState_DICTATION_STATE_ERROR, func(s *v1.DictationSnapshot) {
			s.Error = "the dictation engine is not installed"
			s.Hardware = nil
		}), "dictation: failed: the dictation engine is not installed"},
		{"denied mic", dictationSnapshot(v1.DictationState_DICTATION_STATE_UNLOADED, func(s *v1.DictationSnapshot) {
			s.MicDenied = true
			s.Hardware = nil
		}), "dictation: unloaded; it loads again when you return to the app or dictate; macOS denied the microphone"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reg := newDictationRegistry(t, &commandtest.Dictation{}, tc.snap, &commandtest.Emitter{})
			res, err := reg.Invoke(context.Background(), command.Context{}, "dictation.status", nil)
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tc.want {
				t.Errorf("message\n%q\nwant\n%q", res.Message, tc.want)
			}
			if res.JSON != tc.snap {
				t.Error("JSON is not the snapshot")
			}
		})
	}
}

func TestDictationToggleEmits(t *testing.T) {
	e := &commandtest.Emitter{Delivered: 1, OpenWindows: 1}
	reg := newDictationRegistry(t, &commandtest.Dictation{}, dictationSnapshot(v1.DictationState_DICTATION_STATE_READY, nil), e)
	if _, err := reg.Invoke(context.Background(), command.Context{ActiveView: "thread"}, "dictation.toggle", nil); err != nil {
		t.Fatal(err)
	}
	got := e.Intents()
	if len(got) != 1 || got[0].GetShowView().GetName() != command.ViewDictationToggle {
		t.Errorf("intents %v", got)
	}
	c, _ := reg.Get("dictation.toggle")
	if len(c.Keybindings) != 1 || c.Keybindings[0] != "cmd+shift+m" || c.Title != "Dictate" {
		t.Errorf("toggle %+v", c)
	}
}
