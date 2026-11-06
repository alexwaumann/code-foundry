package gh

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

// taskItemCase is one case of testdata/task_items.json: a body and the task items both
// parsers must find in it (the GUI's lib/taskItems.test.tsx reads the same file).
type taskItemCase struct {
	Name  string `json:"name"`
	Body  string `json:"body"`
	Items []struct {
		Checked bool   `json:"checked"`
		Text    string `json:"text"`
	} `json:"items"`
}

func TestTaskItems(t *testing.T) {
	b, err := os.ReadFile("testdata/task_items.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []taskItemCase
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tt := range cases {
		t.Run(tt.Name, func(t *testing.T) {
			got := taskItems([]byte(tt.Body))
			if len(got) != len(tt.Items) {
				t.Fatalf("items = %+v, want %+v", got, tt.Items)
			}
			for i, it := range got {
				if it.checked != tt.Items[i].Checked || it.text != tt.Items[i].Text {
					t.Errorf("item %d = %+v, want %+v", i, it, tt.Items[i])
				}
				if tt.Body[it.box] != '[' {
					t.Errorf("item %d: box %d is at %q, not a [", i, it.box, tt.Body[it.box])
				}
			}
		})
	}
}

func TestSetTaskItem(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		index   int
		shown   string
		checked bool
		want    string
		changed bool
		refusal string
	}{
		{name: "ticks", body: "- [ ] a\n- [ ] b\n", index: 1, shown: "b", checked: true,
			want: "- [ ] a\n- [x] b\n", changed: true},
		{name: "unticks", body: "- [x] a\n", shown: "a", want: "- [ ] a\n", changed: true},
		{name: "unticks an upper-case X", body: "- [X] a\n", shown: "a", want: "- [ ] a\n", changed: true},
		{name: "already ticked", body: "- [x] a\n", shown: "a", checked: true, want: "- [x] a\n"},
		{name: "an upper-case X already counts", body: "- [X] a\n", shown: "a", checked: true, want: "- [X] a\n"},
		{name: "line endings, spacing and trailing bytes stay", index: 1, shown: "b", checked: true,
			body: "Title  \r\n\r\n*   [ ]   a  \r\n*   [ ]   b  \r\n\n\tcode\r\nno newline",
			want: "Title  \r\n\r\n*   [ ]   a  \r\n*   [x]   b  \r\n\n\tcode\r\nno newline", changed: true},
		{name: "the box in code is passed over", index: 0, shown: "real", checked: true,
			body: "```\n- [ ] real\n```\n- [ ] real\n", want: "```\n- [ ] real\n```\n- [x] real\n", changed: true},
		{name: "bytes before it are not runes", body: "🦊 ü\n\n- [ ] é\n", shown: "é", checked: true,
			want: "🦊 ü\n\n- [x] é\n", changed: true},
		{name: "a nested item", body: "- [ ] a\n  - [ ] b\n", index: 1, shown: "b", checked: true,
			want: "- [ ] a\n  - [x] b\n", changed: true},
		{name: "in a blockquote", body: "> - [ ] a\n", shown: "a", checked: true, want: "> - [x] a\n", changed: true},
		{name: "item gone", body: "- [ ] a\n", index: 1, shown: "b", checked: true,
			refusal: "has no task 2 in its description any more (it has 1)"},
		{name: "no items left", body: "", shown: "a", refusal: "has no task 1 in its description any more (it has 0)"},
		{name: "negative index", body: "- [ ] a\n", index: -1, shown: "a", refusal: "has no task 0"},
		{name: "item edited", body: "- [ ] edited\n", shown: "a", checked: true,
			refusal: `has a different task 1 in its description now ("edited", was "a")`},
		{name: "item moved: another took its place", body: "- [ ] new\n- [ ] a\n", shown: "a", checked: true,
			refusal: `has a different task 1 in its description now ("new", was "a")`},
		{name: "a refusal clips a long line", body: "- [ ] " + strings.Repeat("é", 100) + "\n", shown: "a",
			refusal: `("` + strings.Repeat("é", 60) + `…", was "a")`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, changed, refusal := SetTaskItem(tt.body, tt.index, tt.shown, tt.checked)
			if tt.refusal != "" {
				if !strings.Contains(refusal, tt.refusal) || got != "" || changed {
					t.Errorf("got %q, %t, %q; want refusal containing %q", got, changed, refusal, tt.refusal)
				}
				return
			}
			if got != tt.want || changed != tt.changed || refusal != "" {
				t.Errorf("got %q, %t, %q; want %q, %t", got, changed, refusal, tt.want, tt.changed)
			}
		})
	}
}

// One byte changes, whatever else the body holds: the flip never re-renders anything.
func TestSetTaskItemKeepsEveryOtherByte(t *testing.T) {
	body := "# Title\r\n\n| a |\n|---|\n| b |\n\n<div>x</div>\n\n1. [ ] one\n   - [x] two\n\n```\n[ ]\n```\n"
	items := taskItems([]byte(body))
	if len(items) != 2 {
		t.Fatalf("items = %+v", items)
	}
	for i, it := range items {
		next, changed, why := SetTaskItem(body, i, it.text, !it.checked)
		if !changed || why != "" {
			t.Fatalf("item %d: changed %t, refusal %q", i, changed, why)
		}
		var diff []int
		for j := range len(body) {
			if body[j] != next[j] {
				diff = append(diff, j)
			}
		}
		if !slices.Equal(diff, []int{it.box + 1}) || len(next) != len(body) {
			t.Errorf("item %d: bytes %v differ, want only %d", i, diff, it.box+1)
		}
	}
}
