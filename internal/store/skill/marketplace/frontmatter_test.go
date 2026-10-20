package marketplace

import (
	"reflect"
	"testing"
)

func TestParseFrontmatter(t *testing.T) {
	tests := []struct {
		name string
		text string
		want Frontmatter
	}{
		{"none", "# Title\n", Frontmatter{}},
		{"unterminated", "---\nname: x\n", Frontmatter{}},
		{"empty", "---\n---\nbody", Frontmatter{}},
		{"plain", "---\nname: pdf\ndescription: Read PDFs.\n---\n", Frontmatter{Name: "pdf", Description: "Read PDFs."}},
		{"bom and crlf", "\xef\xbb\xbf---\r\nname: pdf\r\n---\r\n", Frontmatter{Name: "pdf"}},
		{"quoted", "---\nname: \"pdf: reader\"\ndescription: 'It''s good'\n---\n",
			Frontmatter{Name: "pdf: reader", Description: "It's good"}},
		{"folded", "---\ndescription: >\n  one\n  two\nname: x\n---\n", Frontmatter{Name: "x", Description: "one two"}},
		{"literal", "---\ndescription: |\n  one\n  two\n---\n", Frontmatter{Description: "one\ntwo"}},
		{"plain continued", "---\ndescription: one\n  two\n---\n", Frontmatter{Description: "one two"}},
		{"comment", "---\nname: x # the name\n---\n", Frontmatter{Name: "x"}},
		{"metadata", "---\nname: x\nmetadata:\n  version: 1.2.0\n  owner: Guild\n  author: Someone\n  keywords:\n    - a\n    - \"b c\"\n---\n",
			Frontmatter{Name: "x", MetaVersion: "1.2.0", MetaOwner: "Guild", MetaAuthor: "Someone", Keywords: []string{"a", "b c"}}},
		{"metadata flow keywords", "---\nmetadata:\n  keywords: [a, 'b']\nkeywords: c\n---\n", Frontmatter{Keywords: []string{"a", "b"}}},
		{"top keywords list same indent", "---\nkeywords:\n- a\n- b\nname: n\n---\n", Frontmatter{Name: "n", Keywords: []string{"a", "b"}}},
		{"top keywords comma", "---\nkeywords: a, b ,\n---\n", Frontmatter{Keywords: []string{"a", "b"}}},
		{"owner and author", "---\nowner: Team\nauthor: Me\n---\n", Frontmatter{Owner: "Team", Author: "Me"}},
		{"unknown structure ignored", "---\nallowed-tools:\n  - Read\nhooks:\n  pre:\n    run: x\nname: n\n---\n", Frontmatter{Name: "n"}},
		{"garbage", "---\n: : :\n- x\n  y\nname: ok\n---\n", Frontmatter{Name: "ok"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ParseFrontmatter(tt.text); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("ParseFrontmatter =\n%+v\nwant\n%+v", got, tt.want)
			}
		})
	}
}

func TestBy(t *testing.T) {
	tests := []struct {
		f    Frontmatter
		want string
	}{
		{Frontmatter{}, ""},
		{Frontmatter{Author: "a"}, "a"},
		{Frontmatter{Author: "a", MetaAuthor: "ma"}, "ma"},
		{Frontmatter{Author: "a", MetaAuthor: "ma", MetaOwner: "mo"}, "mo"},
		{Frontmatter{Author: "a", MetaAuthor: "ma", MetaOwner: "mo", Owner: "o"}, "o"},
	}
	for _, tt := range tests {
		if got := tt.f.By(); got != tt.want {
			t.Errorf("%+v.By() = %q, want %q", tt.f, got, tt.want)
		}
	}
}
