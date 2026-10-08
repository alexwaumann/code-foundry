package claudestatus

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// exp is one expected transition in a fixture replay.
type exp struct {
	status Status
	kind   string // NeedsAttention reason kind
	truth  int    // ms at which the evidence appeared in the capture
	lag    int    // max detection delay after truth, ms
}

// Detection lag bounds.
const (
	// evLag: transitions driven by the output stream, transcript, or input. The
	// transcript's turn-end records trail the idle title by up to ~150 ms.
	evLag = 200
	// tkLag: transitions that need a screen read: the next Tick (period 1 s) after the
	// 300 ms settle delay.
	tkLag = 1350
)

func ev(st Status, kind string, truth int) exp { return exp{st, kind, truth, evLag} }
func tk(st Status, kind string, truth int) exp { return exp{st, kind, truth, tkLag} }

// gone: the session left Claude's UI (exit); Unknown must also persist for unknownHold.
func gone(truth int) exp { return exp{Unknown, "", truth, tkLag + int(unknownHold/time.Millisecond)} }

// Expected timelines with all signals. truth values are the times in the capture at
// which the deciding evidence appeared: the title changing, the dialog first drawn,
// the user's keystroke, the title being cleared on exit. See testdata/README.md.
var fixtureTimelines = map[string][]exp{
	"trust": {
		ev(Unknown, "", 0),
		tk(NeedsAttention, "trust", 254), // dialog drawn on the primary screen
		tk(Idle, "", 2503),               // dialog gone after "Yes, I trust this folder"
		gone(7555),                       // after /exit
	},
	"text": {
		ev(Unknown, "", 0),
		ev(Idle, "", 522),                    // title "✳ Claude Code"
		ev(Busy, "", 4384),                   // title "◐ Claude Code"
		ev(NeedsAttention, "finished", 8928), // title "✳ ...", then end_turn + turn_duration
		ev(Idle, "", 17756),                  // user types /exit
		gone(18478),                          // title cleared, "Resume this session with"
	},
	"permission": {
		ev(Unknown, "", 0),
		ev(Idle, "", 467),
		ev(Busy, "", 3343),
		tk(NeedsAttention, "permission", 7756), // "Do you want to proceed?"
		ev(Busy, "", 13606),                    // approved; spinner again
		ev(NeedsAttention, "finished", 15004),
		ev(Idle, "", 22506),
		gone(23232),
	},
	"question": {
		ev(Unknown, "", 0),
		ev(Idle, "", 480),
		ev(Busy, "", 3336),
		tk(NeedsAttention, "question", 5504), // AskUserQuestion; no transcript record yet
		ev(Busy, "", 13443),
		ev(NeedsAttention, "finished", 14273),
		ev(Idle, "", 21426),
		gone(22134),
	},
	"plan": {
		ev(Unknown, "", 0),
		ev(Idle, "", 561),
		ev(Busy, "", 3400),
		tk(NeedsAttention, "plan", 13505), // ExitPlanMode approval
		ev(Busy, "", 17577),
		ev(NeedsAttention, "finished", 26673),
		ev(Idle, "", 34305),
		gone(35015),
	},
	"interrupt": {
		ev(Unknown, "", 0),
		ev(Idle, "", 477),
		ev(Busy, "", 3300),
		ev(Idle, "", 8276), // Ctrl-C; "[Request interrupted by user]" acknowledges
		gone(17214),
	},
	"api-error": {
		ev(Unknown, "", 0),
		ev(Idle, "", 475),
		ev(Busy, "", 3244),
		ev(NeedsAttention, "error", 3547), // isApiErrorMessage model_not_found
		ev(Idle, "", 10927),
		gone(11635),
	},
	"long-tool": {
		ev(Unknown, "", 0),
		ev(Idle, "", 433),
		ev(Busy, "", 3258), // stays busy through the 8 s Bash call
		ev(NeedsAttention, "finished", 14877),
		ev(Idle, "", 20256),
		gone(20966),
	},
	"ghostty-notify": {
		ev(Unknown, "", 0),
		ev(Idle, "", 577),
		ev(Busy, "", 3383),
		tk(NeedsAttention, "permission", 5505),
		ev(Busy, "", 13319),
		ev(NeedsAttention, "finished", 14443),
		ev(Idle, "", 18590),
		ev(Busy, "", 19305),
		ev(NeedsAttention, "finished", 24820), // Esc only left vim insert mode; output unseen
	},
	"inline-renderer": {
		ev(Unknown, "", 0),
		ev(Idle, "", 438),
		ev(Busy, "", 3198),
		ev(NeedsAttention, "finished", 4780),
		ev(Idle, "", 9254),
		ev(Busy, "", 9970),
		tk(NeedsAttention, "permission", 11863),
		tk(Idle, "", 15863), // "4. No": dialog gone, user present
		ev(Busy, "", 20592),
		tk(Idle, "", 24591), // Ctrl-C while thinking: no transcript record, prompt restored
	},
}

func TestFixtureTimelines(t *testing.T) {
	for name, want := range fixtureTimelines {
		evs := loadFixture(t, name)
		for _, offset := range []time.Duration{0, 250 * time.Millisecond, 500 * time.Millisecond, 750 * time.Millisecond} {
			t.Run(fmt.Sprintf("%s/tick+%v", name, offset), func(t *testing.T) {
				got, _ := replay(evs, replayOpts{tickOffset: offset})
				if len(got) != len(want) {
					t.Fatalf("got %d transitions, want %d:\n%s", len(got), len(want), dumpTransitions(got))
				}
				for i, w := range want {
					g := got[i]
					at := int(g.At.Milliseconds())
					// Screen samples are 250 ms apart, so a dialog may have been drawn up
					// to one sample before its first recorded screen.
					early := 0
					if w.lag >= tkLag {
						early = 250
					}
					if g.Status != w.status || g.Kind != w.kind || at < w.truth-early || at > w.truth+w.lag {
						t.Errorf("transition %d: got %v, want %v %q at %d..%dms\n%s", i, g, w.status, w.kind, w.truth,
							w.truth+w.lag, dumpTransitions(got))
					}
				}
			})
		}
	}
}

// With a signal missing, detection degrades but stays sensible. These are the status
// sequences (kinds only) with tick offset 0.
func TestFixtureDegraded(t *testing.T) {
	tests := []struct {
		fixture string
		opts    replayOpts
		want    string
	}{
		// No title (e.g. CLAUDE_CODE_DISABLE_TERMINAL_TITLE): busy comes from transcript +
		// output activity, idle from the screen; everything is up to a tick later.
		{"text", replayOpts{noTitle: true}, "unknown idle busy finished idle unknown"},
		{"permission", replayOpts{noTitle: true}, "unknown idle busy permission busy finished idle unknown"},
		{"question", replayOpts{noTitle: true}, "unknown idle busy question busy finished idle unknown"},
		{"plan", replayOpts{noTitle: true}, "unknown idle busy plan busy finished idle unknown"},
		{"inline-renderer", replayOpts{noTitle: true},
			"unknown idle busy finished idle busy permission idle busy idle"},
		// No transcript: turn ends wait for a screen read; API errors read as "finished".
		{"api-error", replayOpts{noTranscript: true}, "unknown idle busy finished idle unknown"},
		{"permission", replayOpts{noTranscript: true}, "unknown idle busy permission busy finished idle unknown"},
		{"interrupt", replayOpts{noTranscript: true}, "unknown idle busy idle unknown"},
		// No screen: dialogs are inferred from the open turn / pending tool; the trust
		// dialog (no title, no transcript yet) is invisible.
		{"trust", replayOpts{noScreen: true}, "unknown idle unknown"},
		{"permission", replayOpts{noScreen: true},
			"unknown idle busy waiting for approval busy finished idle unknown"},
		{"question", replayOpts{noScreen: true}, "unknown idle busy waiting for input busy finished idle unknown"},
		{"plan", replayOpts{noScreen: true}, "unknown idle busy waiting for input busy finished idle unknown"},
		{"ghostty-notify", replayOpts{noScreen: true},
			"unknown idle busy waiting for approval busy finished idle busy finished"},
		// No Input calls: "finished" persists until the next turn starts.
		{"text", replayOpts{noInput: true}, "unknown idle busy finished unknown"},
		{"inline-renderer", replayOpts{noInput: true}, "unknown idle busy finished busy permission idle busy finished"},
	}
	for _, tt := range tests {
		t.Run(tt.fixture, func(t *testing.T) {
			got, _ := replay(loadFixture(t, tt.fixture), tt.opts)
			if s := kinds(got); s != tt.want {
				t.Errorf("%+v:\ngot  %s\nwant %s\n%s", tt.opts, s, tt.want, dumpTransitions(got))
			}
		})
	}
}

// Without a screen, the Ghostty OSC 777 notification ("Claude needs your permission")
// is recorded even when the transcript already decided.
func TestFixtureNotification(t *testing.T) {
	_, d := replay(loadFixture(t, "ghostty-notify"), replayOpts{noScreen: true})
	if s := d.Snapshot(); s.Notification != "Claude needs your permission" {
		t.Fatalf("notification %q", s.Notification)
	}
}

func kinds(trs []transition) string {
	var parts []string
	for _, tr := range trs {
		if tr.Kind != "" {
			parts = append(parts, tr.Kind)
		} else {
			parts = append(parts, tr.Status.String())
		}
	}
	return strings.Join(parts, " ")
}

func dumpTransitions(trs []transition) string {
	var b strings.Builder
	for _, tr := range trs {
		b.WriteString(tr.String())
		b.WriteByte('\n')
	}
	return b.String()
}
