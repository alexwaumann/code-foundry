package command

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// dictation.* (docs/notes/dictation-2-daemon.md): voice dictation into the composers.
// The GUI's mic and ⌘⇧M run dictation.toggle in the focused composer; the rest are for
// the CLI and the settings page's model row.

// ViewDictationToggle is the ShowView name of dictation.toggle: an action on the window's
// focused composer, like ViewComposerHistory. The GUI presents the command itself in the
// window it was pressed in; the CLI's reaches every window, where a window without a
// focused composer ignores it.
const ViewDictationToggle = "dictation.toggle"

// DictationBackend is the slice of DictationService the dictation.* commands need, in
// generated Connect signatures (see TerminalBackend for why).
type DictationBackend interface {
	Download(context.Context, *connect.Request[v1.DownloadDictationModelRequest]) (*connect.Response[v1.DownloadDictationModelResponse], error)
	CancelDownload(context.Context, *connect.Request[v1.CancelDictationDownloadRequest]) (*connect.Response[v1.CancelDictationDownloadResponse], error)
	RemoveModel(context.Context, *connect.Request[v1.RemoveDictationModelRequest]) (*connect.Response[v1.RemoveDictationModelResponse], error)
	Start(context.Context, *connect.Request[v1.StartDictationRequest]) (*connect.Response[v1.StartDictationResponse], error)
	Stop(context.Context, *connect.Request[v1.StopDictationRequest]) (*connect.Response[v1.StopDictationResponse], error)
}

var (
	_ DictationBackend = codefoundryv1connect.DictationServiceHandler(nil)
	_ DictationBackend = codefoundryv1connect.DictationServiceClient(nil)
)

// DictationDeps are the dependencies of the dictation.* commands. Nil Dictation or
// Status make them fail with Unimplemented, or unavailable.
type DictationDeps struct {
	Dictation DictationBackend
	// Status is the dictation snapshot now.
	Status  func() *v1.DictationSnapshot
	Emitter Emitter
}

const dictationCategory = "Dictation"

// DictationSummary is a one-line description of a dictation snapshot ("ready", "off",
// "downloading the model: 557 MB of 874 MB", ...), plus a line per source after a
// download that failed from several.
func DictationSummary(s *v1.DictationSnapshot) string {
	if s == nil {
		return "dictation unavailable"
	}
	m := s.GetModel()
	var out string
	switch s.GetState() {
	case v1.DictationState_DICTATION_STATE_DISABLED:
		out = "off"
		if !m.GetDownloaded() {
			out += "; the model is not downloaded (dictation.download)"
		}
	case v1.DictationState_DICTATION_STATE_NO_MODEL:
		out = "on, but the model is not downloaded (dictation.download)"
	case v1.DictationState_DICTATION_STATE_DOWNLOADING:
		d := m.GetDownload()
		out = fmt.Sprintf("downloading the model: %s of %s", megabytes(d.GetReceivedBytes()), megabytes(d.GetTotalBytes()))
		if bps := d.GetBytesPerSecond(); bps > 0 {
			out += fmt.Sprintf(" at %s/s", megabytes(bps))
		}
	case v1.DictationState_DICTATION_STATE_LOADING:
		out = "loading the model"
	case v1.DictationState_DICTATION_STATE_READY:
		out = "ready"
	case v1.DictationState_DICTATION_STATE_UNLOADED:
		out = "unloaded; it loads again when you return to the app or dictate"
	case v1.DictationState_DICTATION_STATE_LISTENING:
		out = fmt.Sprintf("listening (session %s, for %s)", s.GetSession().GetId(), s.GetSession().GetClientId())
	case v1.DictationState_DICTATION_STATE_ERROR:
		return "failed: " + s.GetError()
	default:
		out = "unknown"
	}
	if e := s.GetError(); strings.Contains(e, "\n") {
		// A download that failed from every source: one line per source.
		out += "\n" + e
	} else if e != "" {
		out += "; " + e
	}
	if s.GetMicDenied() {
		out += "; macOS denied the microphone"
	}
	return out
}

func megabytes(n int64) string { return fmt.Sprintf("%d MB", n/1_000_000) }

// RegisterDictation registers dictation.toggle, dictation.start, dictation.stop,
// dictation.download, dictation.download.cancel, dictation.remove and dictation.status.
func RegisterDictation(r *Registry, d DictationDeps) error {
	if d.Dictation == nil {
		d.Dictation = codefoundryv1connect.UnimplementedDictationServiceHandler{}
	}
	status := func() *v1.DictationSnapshot {
		if d.Status == nil {
			return nil
		}
		return d.Status()
	}
	// The mic works once dictation is on and the model is there.
	usable := func(Context) bool { s := status(); return s.GetEnabled() && s.GetModel().GetDownloaded() }
	state := func() v1.DictationState { return status().GetState() }
	return r.RegisterAll(
		Command{
			Name:        "dictation.toggle",
			Title:       "Dictate",
			Description: "Start or stop dictating into the focused composer. Speech is transcribed on this Mac; each phrase lands at the caret.",
			Category:    dictationCategory,
			Keybindings: []string{"cmd+shift+m"},
			When:        usable,
			WhyUnavailable: func(Context) string {
				if !status().GetEnabled() {
					return "dictation is off (Settings → General → Dictation)"
				}
				return "the dictation model is not downloaded (dictation.download)"
			},
			Run: func(_ context.Context, uctx Context, _ Args) (Result, error) {
				if d.Emitter == nil {
					return Result{}, fmt.Errorf("%w: no app windows to dictate in", ErrUnavailable)
				}
				return EmitTo(d.Emitter, showViewIntent(ViewDictationToggle, "", nil)).CLIResult(uctx), nil
			},
		},
		Command{
			Name:         "dictation.start",
			NoPalette:    true,
			NoKeybinding: true,
			Title:        "Start Dictation",
			Description: "Open a dictation session: the app's microphone listens until dictation.stop, or 30 s without speech. " +
				"Prints the session id. Refused while another composer is dictating.",
			Category: dictationCategory,
			Args: []ArgSpec{
				{Name: "client", Type: String, Default: "cli", Description: "Who is dictating (the GUI passes its composer's id)"},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := d.Dictation.Start(ctx, connect.NewRequest(&v1.StartDictationRequest{ClientId: a.String("client")}))
				if err != nil {
					return Result{}, err
				}
				id := res.Msg.GetSessionId()
				return Result{Message: "listening (session " + id + ")", JSON: res.Msg}, nil
			},
		},
		Command{
			Name:         "dictation.stop",
			NoPalette:    true,
			NoKeybinding: true,
			Title:        "Stop Dictation",
			Description:  "End a dictation session (default: the open one), transcribing the speech it holds first unless --flush=false.",
			Category:     dictationCategory,
			Args: []ArgSpec{
				{Name: "session", Type: String, Description: "Session id (default: the open session)"},
				{Name: "flush", Type: Bool, Default: "true", Description: "Transcribe the last phrase before stopping"},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("session")
				if id == "" {
					id = status().GetSession().GetId()
				}
				if id == "" {
					return Result{Message: "nobody is dictating"}, nil
				}
				if _, err := d.Dictation.Stop(ctx, connect.NewRequest(&v1.StopDictationRequest{SessionId: id, Flush: a.Bool("flush")})); err != nil {
					return Result{}, err
				}
				return Result{Message: "stopped " + id}, nil
			},
		},
		Command{
			Name:  "dictation.download",
			Title: "Download Dictation Model",
			Description: "Download the Whisper model dictation uses (about 0.9 GB, once) in the background; an interrupted download resumes. " +
				"Dictation turns on when it finishes.",
			Category: dictationCategory,
			When: func(Context) bool {
				s := status()
				return s != nil && !s.GetModel().GetDownloaded() && s.GetModel().GetDownload() == nil
			},
			WhyUnavailable: func(Context) string {
				if status().GetModel().GetDownloaded() {
					return "the model is already downloaded"
				}
				return "the model is downloading"
			},
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := d.Dictation.Download(ctx, connect.NewRequest(&v1.DownloadDictationModelRequest{}))
				if err != nil {
					return Result{}, err
				}
				s := res.Msg.GetSnapshot()
				return Result{
					Message: fmt.Sprintf("downloading %s (%s); dictation turns on when it finishes (dictation.status shows progress)",
						s.GetModel().GetName(), megabytes(s.GetModel().GetSizeBytes())),
					JSON: s,
				}, nil
			},
		},
		Command{
			Name:        "dictation.download.cancel",
			Title:       "Cancel Dictation Model Download",
			Description: "Stop downloading the dictation model, keeping what arrived so the next download resumes.",
			Category:    dictationCategory,
			When:        func(Context) bool { return state() == v1.DictationState_DICTATION_STATE_DOWNLOADING },
			WhyUnavailable: func(Context) string {
				return "the model is not downloading"
			},
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := d.Dictation.CancelDownload(ctx, connect.NewRequest(&v1.CancelDictationDownloadRequest{}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "download cancelled", JSON: res.Msg.GetSnapshot()}, nil
			},
		},
		Command{
			Name:         "dictation.remove",
			Title:        "Remove Dictation Model",
			Description:  "Delete the dictation model from this Mac, stopping dictation until it is downloaded again.",
			Category:     dictationCategory,
			Confirm:      "Remove the dictation model? Dictation stops until you download it again (about 0.9 GB).",
			ConfirmLabel: "Remove",
			When: func(Context) bool {
				m := status().GetModel()
				return m.GetDownloaded() || m.GetDownload() != nil
			},
			WhyUnavailable: func(Context) string { return "the model is not downloaded" },
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := d.Dictation.RemoveModel(ctx, connect.NewRequest(&v1.RemoveDictationModelRequest{}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "dictation model removed", JSON: res.Msg.GetSnapshot()}, nil
			},
		},
		Command{
			Name:         "dictation.status",
			NoPalette:    true,
			NoKeybinding: true,
			ReadOnly:     true,
			Title:        "Dictation Status",
			Description:  "Show dictation's state: on or off, the model and its download, the open session, this Mac's chip and memory.",
			Category:     dictationCategory,
			Run: func(context.Context, Context, Args) (Result, error) {
				s := status()
				if s == nil {
					return Result{}, errors.New("dictation is unavailable in this daemon")
				}
				hw := s.GetHardware()
				msg := "dictation: " + DictationSummary(s)
				if hw.GetChip() != "" {
					msg += fmt.Sprintf("\nthis Mac: %s, %d GB", hw.GetChip(), hw.GetMemoryBytes()>>30)
					if hw.GetM1Family() {
						msg += " (an M1: each phrase takes a few seconds)"
					}
				}
				return Result{Message: msg, JSON: s}, nil
			},
		},
	)
}
