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
// The GUI's mic runs dictation.toggle in the focused composer (it has no default chord:
// the hold key starts dictation, and a user may still bind one); the rest are for the
// CLI and the settings page's model row.

// ViewDictationToggle is the ShowView name of dictation.toggle: an action on the window's
// focused composer, like ViewComposerHistory. The GUI presents the command itself in the
// window it was pressed in; the CLI's reaches every window, where a window without a
// focused composer ignores it.
const ViewDictationToggle = "dictation.toggle"

// ViewDictationHold is the ShowView name of dictation.hold: the hold key, routed to a
// composer (docs/notes/dictate-anywhere.md). Its "phase" param is one of the
// DictationHold* phases. The window starts and stops its own session with them, so the
// composer's session has one state machine, the one the mic already uses.
const ViewDictationHold = "dictation.hold"

// The phases of dictation.hold: the key went down, it came up after a counted hold, or
// the hold was discarded (too short, or a shortcut).
const (
	DictationHoldPress   = "press"
	DictationHoldRelease = "release"
	DictationHoldDiscard = "discard"
)

// ViewDictationAllow is the ShowView name of dictation.allow. Only the GUI host acts on
// it, on UiService.WatchIntents: AXIsProcessTrustedWithOptions has to run in the process
// that needs the grant. Windows ignore it.
const ViewDictationAllow = "dictation.allow"

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
		out = "unloaded; it loads again when you next dictate"
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
	if a := s.GetAccessibility(); s.GetEnabled() && a != nil {
		switch {
		case !a.GetGranted():
			out += "; the hold key is not allowed (dictation.allow)"
		case a.GetTapSilent():
			out += "; the hold key is allowed but not heard: restart the app (app.restart)"
		}
	}
	return out
}

func megabytes(n int64) string { return fmt.Sprintf("%d MB", n/1_000_000) }

// RegisterDictation registers dictation.toggle, dictation.hold, dictation.allow,
// dictation.start, dictation.stop, dictation.download, dictation.download.cancel,
// dictation.remove and dictation.status.
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
			Page:        PageState,
			Title:       "Dictate",
			Description: "Start or stop dictating into the focused composer. Speech is transcribed on this Mac; each phrase lands at the caret.",
			Category:    dictationCategory,
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
				return EmitTo(d.Emitter, showViewIntent(ViewDictationToggle, nil)).CLIResult(uctx), nil
			},
		},
		Command{
			Name:         "dictation.hold",
			Page:         PageState,
			NoPalette:    true,
			NoKeybinding: true,
			Title:        "Hold to Dictate",
			Description: "The hold key pressed or let go, for the composer dictation.toggle would pick. The GUI host runs this when the key goes down with " +
				"Code Foundry in front; the window opens and ends the session.",
			Category: dictationCategory,
			Args: []ArgSpec{
				{Name: "phase", Type: Enum, Enum: []string{DictationHoldPress, DictationHoldRelease, DictationHoldDiscard}, Default: DictationHoldPress,
					Description: "press, release (transcribe the rest) or discard (drop it)"},
			},
			Run: func(_ context.Context, uctx Context, a Args) (Result, error) {
				phase := a.String("phase")
				if d.Emitter == nil {
					return Result{}, fmt.Errorf("%w: no app windows to dictate in", ErrUnavailable)
				}
				return EmitTo(d.Emitter, showViewIntent(ViewDictationHold, map[string]string{"phase": phase})).CLIResult(uctx), nil
			},
		},
		Command{
			Name:        "dictation.allow",
			Page:        PageState,
			Title:       "Allow the Dictation Hold Key",
			Description: "Ask macOS to let Code Foundry hear the hold key and paste, and open the list in System Settings where that is turned on.",
			Category:    dictationCategory,
			When: func(Context) bool {
				s := status()
				return s.GetEnabled() && s.GetAccessibility() != nil && !s.GetAccessibility().GetGranted()
			},
			WhyUnavailable: func(Context) string {
				s := status()
				switch {
				case !s.GetEnabled():
					return "dictation is off (Settings → General → Dictation)"
				case s.GetAccessibility() == nil:
					return "the app is not open"
				}
				return "macOS already allows it"
			},
			Run: func(_ context.Context, uctx Context, _ Args) (Result, error) {
				if d.Emitter == nil {
					return Result{}, fmt.Errorf("%w: no app to ask from", ErrUnavailable)
				}
				return EmitTo(d.Emitter, showViewIntent(ViewDictationAllow, nil)).CLIResult(uctx), nil
			},
		},
		Command{
			Name:         "dictation.start",
			NoPalette:    true,
			NoKeybinding: true,
			Title:        "Start Dictation",
			Description: "Open a dictation session: the app's microphone listens until dictation.stop, 30 s without speech, or 2 min without any audio. " +
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
			Page:         PageState,
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
			Page:  PageState,
			Title: "Download Dictation Model",
			Description: "Download the Whisper model dictation uses (about 0.9 GB, once) in the background; an interrupted download resumes. " +
				"Dictation turns on when it finishes. A page asks the user first.",
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
			Run: func(ctx context.Context, uctx Context, _ Args) (Result, error) {
				if err := pageAsks(ctx, uctx, "dictation.download", "Download Dictation Model", "Download", "Download the dictation model (about 0.9 GB) and turn dictation on?"); err != nil {
					return Result{}, err
				}
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
			Page:        PageState,
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
			Page:         PageState,
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
