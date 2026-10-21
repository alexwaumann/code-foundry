package thread

import (
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// TestCutTurnUsage: a process that ends before its result leaves the turn the usage
// the stream reported of it, each response once (message_start, the assistant frames
// and message_delta all report the same one), so it matches what the result would have
// said; a turn whose stream reported no usage yet keeps zeros.
func TestCutTurnUsage(t *testing.T) {
	tests := []struct {
		fixture string
		// frames is how many stream lines the process got through before it ended; 0
		// means every line before the result.
		frames int
		// fromResult: the result's own usage is the reference (else want).
		fromResult bool
		want       TurnEnd
		wantModel  string
	}{
		{fixture: "bash", fromResult: true, wantModel: "claude-haiku-5-5"},
		{fixture: "text-table", fromResult: true, wantModel: "claude-haiku-5-5"},
		{fixture: "write-allow", fromResult: true, wantModel: "claude-haiku-5-5"},
		{fixture: "bash", frames: 1},
	}
	for _, tt := range tests {
		t.Run(fmt.Sprintf("%s/%d", tt.fixture, tt.frames), func(t *testing.T) {
			data, err := os.ReadFile(fixturePath(tt.fixture))
			if err != nil {
				t.Fatal(err)
			}
			var lines [][]byte
			var result *claudestream.Result
			var sp claudestream.Splitter
			for _, line := range sp.Split(nil, data) {
				if r, ok := claudestream.Parse(line).(*claudestream.Result); ok {
					result = r
					break
				}
				lines = append(lines, line)
			}
			if tt.frames > 0 {
				lines = lines[:tt.frames]
			}
			want := tt.want
			if tt.fromResult {
				u := result.Usage
				want = TurnEnd{InputTokens: u.InputTokens, OutputTokens: u.OutputTokens, CacheReadTokens: u.CacheReadInputTokens, CacheWriteTokens: u.CacheCreationInputTokens}
				if want.OutputTokens == 0 {
					t.Fatal("the fixture's result has no usage")
				}
			}
			log := newThreadLog("s", bus.New(), time.Now, nil)
			w := itemWriter{log: log, save: func(Item) {}}
			w.add(Item{ID: "u1", Kind: KindUserMessage, Text: "go"})
			p := newProjector(w, runningTotals{known: true})
			for _, line := range lines {
				p.event(claudestream.Parse(line))
			}
			it, ok := p.cutTurn(time.Now())
			if !ok {
				t.Fatal("no turn closed")
			}
			got := it.Turn
			if got.Subtype != SubtypeProcessEnded || !got.Interrupted || got.TurnCostUSD != nil || got.CostUSD != 0 {
				t.Errorf("turn end %+v", got)
			}
			if got.InputTokens != want.InputTokens || got.OutputTokens != want.OutputTokens ||
				got.CacheReadTokens != want.CacheReadTokens || got.CacheWriteTokens != want.CacheWriteTokens {
				t.Errorf("usage in %d out %d read %d write %d, want %+v", got.InputTokens, got.OutputTokens, got.CacheReadTokens, got.CacheWriteTokens, want)
			}
			if got.Model != tt.wantModel {
				t.Errorf("model %q, want %q", got.Model, tt.wantModel)
			}
			if _, ok := p.partialUsage(); ok {
				t.Error("the next turn starts with this one's usage")
			}
		})
	}
}
