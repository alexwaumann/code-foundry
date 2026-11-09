package pluginsdk

import "testing"

func TestSurfaceActQuery(t *testing.T) {
	tests := []struct {
		name string
		act  SurfaceAct
		want string
	}{
		{"a search", SurfaceAct{Kind: ActSearch, Value: "ale"}, "ale"},
		{"a change's value", SurfaceAct{Kind: ActChange, Value: "ale"}, ""},
		{"a search without a string", SurfaceAct{Kind: ActSearch, Value: 3.0}, ""},
	}
	for _, tt := range tests {
		if got := tt.act.Query(); got != tt.want {
			t.Errorf("%s: Query() = %q, want %q", tt.name, got, tt.want)
		}
	}
}
