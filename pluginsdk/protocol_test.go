package pluginsdk

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestSurfaceActStored(t *testing.T) {
	for _, tt := range []struct {
		name   string
		values map[string]any
		want   StoredSecret
		ok     bool
	}{
		{"decoded", map[string]any{"token": map[string]any{"key": "api", "stored": true}}, StoredSecret{Key: "api", Stored: true}, true},
		{"typed", map[string]any{"token": StoredSecret{Key: "api", Stored: true}}, StoredSecret{Key: "api", Stored: true}, true},
		{"left empty", map[string]any{"name": "Ada"}, StoredSecret{}, false},
		{"a plain value", map[string]any{"token": "x"}, StoredSecret{}, false},
	} {
		got, ok := SurfaceAct{Values: tt.values}.Stored("token")
		if got != tt.want || ok != tt.ok {
			t.Errorf("%s: %+v, %v", tt.name, got, ok)
		}
	}
}

func TestLogParamsKeepsIntegers(t *testing.T) {
	var p LogParams
	if err := json.Unmarshal([]byte(`{"level":"info","msg":"flagged","attrs":{"run":39128319017,"ratio":0.5,"name":"ci"}}`), &p); err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprint(p.Attrs["run"], " ", p.Attrs["ratio"], " ", p.Attrs["name"]); got != "39128319017 0.5 ci" {
		t.Errorf("attrs print as %q", got)
	}
	if p.Level != "info" || p.Msg != "flagged" {
		t.Errorf("%+v", p)
	}
}
