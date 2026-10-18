package pluginsdk

import (
	"reflect"
	"slices"
	"strings"
	"testing"
)

func validManifest() Manifest {
	return Manifest{
		Name: "hello", Version: "0.1.0", Protocol: 1, Exec: []string{"bin/hello"},
		Permissions: Permissions{Commands: []string{"thread.send"}, Secrets: true},
		Commands: []CommandSpec{
			{Name: "greet", Title: "Greet", Args: []ArgSpec{{Name: "name", Positional: true}}},
			{Name: "send", Title: "Send", Confirm: "Send {text}?", Args: []ArgSpec{
				{Name: "text", Required: true},
				{Name: "thread", Context: ArgContextThread},
			}},
		},
		Surfaces: []SurfaceSpec{{ID: "main", Title: "Hello", Icon: "hand", Scope: ScopeThread, Placement: []string{PlacementPanel}}},
	}
}

func TestManifestValidate(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Manifest)
		want   string // substring of the error; "" means valid
	}{
		{name: "valid", mutate: func(*Manifest) {}},
		{name: "name with digits first", mutate: func(m *Manifest) { m.Name = "1password"; m.Commands = nil }},
		{name: "name with digits first and commands", mutate: func(m *Manifest) { m.Name = "1password" }, want: "cannot carry commands"},
		{name: "name trailing hyphen without commands", mutate: func(m *Manifest) { m.Name = "x-"; m.Commands = nil }},
		{name: "name uppercase", mutate: func(m *Manifest) { m.Name = "Hello" }, want: "name: "},
		{name: "name too long", mutate: func(m *Manifest) { m.Name = strings.Repeat("a", 65) }, want: "name: "},
		{name: "name reserved", mutate: func(m *Manifest) { m.Name = "logs" }, want: "reserved"},
		{name: "version with v", mutate: func(m *Manifest) { m.Version = "v1.0.0" }, want: "version"},
		{name: "version prerelease", mutate: func(m *Manifest) { m.Version = "1.0.0-rc.1+build.5" }},
		{name: "version two parts", mutate: func(m *Manifest) { m.Version = "1.0" }, want: "version"},
		{name: "version leading zero", mutate: func(m *Manifest) { m.Version = "01.0.0" }, want: "version"},
		{name: "protocol missing", mutate: func(m *Manifest) { m.Protocol = 0 }, want: "protocol"},
		{name: "exec missing", mutate: func(m *Manifest) { m.Exec = nil }, want: "exec"},
		{name: "exec on PATH", mutate: func(m *Manifest) { m.Exec = []string{"python3", "main.py"} }},
		{name: "exec absolute", mutate: func(m *Manifest) { m.Exec = []string{"/bin/sh"} }, want: "relative"},
		{name: "exec escapes", mutate: func(m *Manifest) { m.Exec = []string{"../other/bin"} }, want: "leaves"},
		{name: "exec escapes after clean", mutate: func(m *Manifest) { m.Exec = []string{"bin/../../x"} }, want: "leaves"},
		{name: "glob ok", mutate: func(m *Manifest) { m.Permissions.Commands = []string{"view.open.*", "action.**"} }},
		{name: "glob bad", mutate: func(m *Manifest) { m.Permissions.Commands = []string{"Thread Send"} }, want: "permissions.commands[0]"},
		{name: "unknown event source", mutate: func(m *Manifest) { m.Permissions.Events = []string{"terminal"} }, want: "unknown event source"},
		{name: "command name bad", mutate: func(m *Manifest) { m.Commands[0].Name = "Greet" }, want: "commands[0].name"},
		{name: "command dotted", mutate: func(m *Manifest) { m.Commands[0].Name = "run.rerun-failed" }},
		{name: "command show reserved", mutate: func(m *Manifest) { m.Commands[0].Name = "show.main" }, want: "reserved for surfaces"},
		{name: "command duplicate", mutate: func(m *Manifest) { m.Commands[1].Name = "greet" }, want: "declared twice"},
		{name: "command title missing", mutate: func(m *Manifest) { m.Commands[0].Title = "" }, want: "commands[0].title"},
		{name: "command timeout too long", mutate: func(m *Manifest) { m.Commands[0].TimeoutSeconds = 601 }, want: "timeoutSeconds"},
		{name: "arg reserved", mutate: func(m *Manifest) { m.Commands[0].Args[0].Name = "json" }, want: "reserved"},
		{name: "arg type unknown", mutate: func(m *Manifest) { m.Commands[0].Args[0].Type = "float" }, want: "unknown type"},
		{name: "arg enum without values", mutate: func(m *Manifest) { m.Commands[0].Args[0].Type = ArgEnum }, want: "needs values"},
		{name: "arg enum default not a value", mutate: func(m *Manifest) {
			m.Commands[0].Args[0] = ArgSpec{Name: "x", Type: ArgEnum, Enum: []string{"a"}, Default: "b"}
		}, want: "not one of"},
		{name: "arg required with default", mutate: func(m *Manifest) { m.Commands[0].Args[0].Required = true; m.Commands[0].Args[0].Default = "x" }, want: "required arg"},
		{name: "arg context on bool", mutate: func(m *Manifest) {
			m.Commands[0].Args[0] = ArgSpec{Name: "x", Type: ArgBool, Context: ArgContextThread}
		}, want: "string or a path"},
		{name: "arg context unknown", mutate: func(m *Manifest) { m.Commands[0].Args[0].Context = "session" }, want: "unknown context"},
		{name: "arg duplicate", mutate: func(m *Manifest) { m.Commands[1].Args[1].Name = "text" }, want: "declared twice"},
		{name: "confirm unknown placeholder", mutate: func(m *Manifest) { m.Commands[1].Confirm = "Drop {what}?" }, want: "unknown arg"},
		{name: "surface id bad", mutate: func(m *Manifest) { m.Surfaces[0].ID = "Main" }, want: "surfaces[0].id"},
		{name: "surface scope bad", mutate: func(m *Manifest) { m.Surfaces[0].Scope = "repo" }, want: "unknown scope"},
		{name: "surface scope pr", mutate: func(m *Manifest) { m.Surfaces[0].Scope = ScopePR }},
		{name: "surface placement bad", mutate: func(m *Manifest) { m.Surfaces[0].Placement = []string{"sidebar"} }, want: "unknown placement"},
		{name: "surface icon bad", mutate: func(m *Manifest) { m.Surfaces[0].Icon = "Hand" }, want: "lucide"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := validManifest()
			tt.mutate(&m)
			err := m.Validate()
			switch {
			case tt.want == "" && err != nil:
				t.Fatalf("unexpected error: %v", err)
			case tt.want != "" && err == nil:
				t.Fatalf("no error, want %q", tt.want)
			case tt.want != "" && !strings.Contains(err.Error(), tt.want):
				t.Fatalf("error %q does not contain %q", err, tt.want)
			}
		})
	}
}

func TestParseManifestWarnsUnknownFields(t *testing.T) {
	data := `{"name":"hello","version":"0.1.0","protocol":1,"exec":["bin/hello"],"icon":"x",
	  "permissions":{"commands":["thread.send"],"mcpServers":true},
	  "commands":[{"name":"greet","title":"Greet","keybindings":["cmd+g"],"args":[{"name":"x","hint":"y"}]}]}`
	m, warnings, err := LoadManifest([]byte(data))
	if err != nil {
		t.Fatal(err)
	}
	if m.Name != "hello" || len(m.Commands) != 1 {
		t.Fatalf("manifest %+v", m)
	}
	want := []string{"icon: unknown field", "permissions.mcpServers: unknown field",
		"commands[0].keybindings: unknown field", "commands[0].args[0].hint: unknown field"}
	for _, w := range want {
		if !slices.Contains(warnings, w) {
			t.Errorf("missing warning %q in %q", w, warnings)
		}
	}
	if _, _, err := ParseManifest([]byte("{")); err == nil {
		t.Error("syntax error not reported")
	}
}

// TestJSONFieldNames keeps the hand-written field lists in step with the struct tags.
func TestJSONFieldNames(t *testing.T) {
	for _, schema := range []any{Manifest{}, Permissions{}, CommandSpec{}, ArgSpec{}, SurfaceSpec{}} {
		var tags []string
		rt := reflect.TypeOf(schema)
		for i := range rt.NumField() {
			name, _, _ := strings.Cut(rt.Field(i).Tag.Get("json"), ",")
			tags = append(tags, name)
		}
		if got := jsonFieldNames(schema); !slices.Equal(got, tags) {
			t.Errorf("%s: jsonFieldNames %q, tags %q", rt.Name(), got, tags)
		}
	}
}

func TestMatchCommand(t *testing.T) {
	tests := []struct {
		glob, name string
		want       bool
	}{
		{"thread.send", "thread.send", true},
		{"thread.send", "thread.sends", false},
		{"thread.*", "thread.send", true},
		{"thread.*", "thread.mcp.reconnect", false},
		{"thread.**", "thread.mcp.reconnect", true},
		{"**", "anything.at.all", true},
		{"view.open.*", "view.open.url", true},
		{"*.list", "thread.list", true},
		{"*.list", "action.runs", false},
		{"thread.se*", "thread.send", true},
		{"Thread.send", "thread.send", false},
		{"thread.send", "threadxsend", false},
	}
	for _, tt := range tests {
		if got := MatchCommand(tt.glob, tt.name); got != tt.want {
			t.Errorf("MatchCommand(%q, %q) = %v, want %v", tt.glob, tt.name, got, tt.want)
		}
	}
}

func TestPermissionsWithin(t *testing.T) {
	granted := Permissions{Commands: []string{"thread.send", "view.open.*"}, Events: []string{"gh"}, Secrets: true}
	tests := []struct {
		name string
		p    Permissions
		want bool
	}{
		{"none", Permissions{}, true},
		{"same", granted, true},
		{"fewer", Permissions{Commands: []string{"thread.send"}}, true},
		{"new command", Permissions{Commands: []string{"thread.archive"}}, false},
		{"new event", Permissions{Events: []string{"thread"}}, false},
		{"new flag", Permissions{API: true}, false},
		{"kept flag", Permissions{Secrets: true}, true},
	}
	for _, tt := range tests {
		if got := tt.p.Within(granted); got != tt.want {
			t.Errorf("%s: Within = %v, want %v", tt.name, got, tt.want)
		}
	}
	if !(Permissions{}).Empty() || granted.Empty() {
		t.Error("Empty")
	}
	if len(granted.Describe()) != 3 {
		t.Errorf("Describe = %q", granted.Describe())
	}
}
