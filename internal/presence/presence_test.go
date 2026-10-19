package presence

import (
	"fmt"
	"slices"
	"testing"
)

func TestOf(t *testing.T) {
	visible := Client{Visible: true}
	focused := Client{Focused: true}
	both := Client{Visible: true, Focused: true}
	hidden := Client{}
	tests := []struct {
		name    string
		clients []Client
		want    State
	}{
		{"no clients", nil, State{Kind: None}},
		{"one hidden", []Client{hidden}, State{Kind: Background}},
		{"focused but hidden (a minimized key window)", []Client{focused}, State{Kind: Background}},
		{"visible but unfocused (another app is active)", []Client{visible}, State{Kind: Foreground}},
		{"visible and focused", []Client{both}, State{Kind: Foreground, Attended: true}},
		{"one focused hidden, one visible unfocused: not attended", []Client{focused, visible}, State{Kind: Foreground}},
		{"hidden and attended", []Client{hidden, both}, State{Kind: Foreground, Attended: true}},
		{"all hidden", []Client{hidden, focused}, State{Kind: Background}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Of(tt.clients); got != tt.want {
				t.Errorf("Of = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestTrackerSubscribers(t *testing.T) {
	tr := New()
	if got := tr.Current(); got != (State{}) {
		t.Fatalf("initial state %v", got)
	}
	var calls []string
	sub := func(name string) func(from, to State) {
		return func(from, to State) {
			// A subscriber may read the state: it is the new one already.
			calls = append(calls, fmt.Sprintf("%s:%v>%v=%v", name, from, to, tr.Current()))
		}
	}
	tr.Subscribe(sub("a"))
	unsubB := tr.Subscribe(sub("b"))
	tr.Subscribe(sub("c"))

	fg := State{Kind: Foreground}
	att := State{Kind: Foreground, Attended: true}
	tr.Set(fg)
	tr.Set(fg) // no change: nobody is called
	tr.Set(att)
	unsubB()
	unsubB() // twice is harmless
	tr.Set(State{Kind: Background})

	want := []string{
		"a:none>foreground=foreground", "b:none>foreground=foreground", "c:none>foreground=foreground",
		"a:foreground>foreground+attended=foreground+attended", "b:foreground>foreground+attended=foreground+attended",
		"c:foreground>foreground+attended=foreground+attended",
		"a:foreground+attended>background=background", "c:foreground+attended>background=background",
	}
	if !slices.Equal(calls, want) {
		t.Errorf("calls\n got %q\nwant %q", calls, want)
	}
}

// A subscriber unsubscribing another while a change is delivered does not disturb the
// delivery in progress.
func TestTrackerUnsubscribeDuringSet(t *testing.T) {
	tr := New()
	var calls []string
	var unsubB func()
	tr.Subscribe(func(_, _ State) { calls = append(calls, "a"); unsubB() })
	unsubB = tr.Subscribe(func(_, _ State) { calls = append(calls, "b") })
	tr.Set(State{Kind: Background})
	tr.Set(State{Kind: Foreground})
	if want := []string{"a", "b", "a"}; !slices.Equal(calls, want) {
		t.Errorf("calls %q, want %q", calls, want)
	}
}
