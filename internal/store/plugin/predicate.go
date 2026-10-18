package plugin

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"
)

// Availability predicates: the when clauses of manifest commands and surfaces, a small
// language over host facts, compiled when the manifest loads and evaluated on the
// daemon (docs/notes/plugins-2-surfaces.md has the reference).
//
//	expr    := or
//	or      := and ("||" and)*
//	and     := unary ("&&" unary)*
//	unary   := "!" unary | "(" expr ")" | operand [op operand]
//	op      := "==" | "!=" | "=~" | "in"
//	operand := fact | "str" | 'str' | number | true | false | null | [ literal, … ] | /re2/
//	fact    := segment ("." segment)*     segment := [A-Za-z_][A-Za-z0-9_-]*
//
// A bare operand is truthy (null, false, "", 0 and [] are not). == and != compare
// values of the same kind; with a list on either side == holds when any element pairs
// up, and != when none does. =~ needs a regular expression on the right and holds when
// the left (any element of a list) matches. "x in y" holds when any element of x (a
// scalar is a one-element list) equals any element of y. A fact the host cannot know
// yet (the pull request's checks while they are fetched) is unknown, and logic is
// three-valued: unknown && false is false, unknown || true is true, anything else with
// an unknown is unknown, and an unknown result lists as unavailable.

// tri is a three-valued truth.
type tri int8

const (
	triFalse tri = iota
	triTrue
	triUnknown
)

func triOf(b bool) tri {
	if b {
		return triTrue
	}
	return triFalse
}

func (t tri) not() tri {
	switch t {
	case triTrue:
		return triFalse
	case triFalse:
		return triTrue
	}
	return triUnknown
}

func (t tri) String() string {
	switch t {
	case triTrue:
		return "true"
	case triFalse:
		return "false"
	}
	return "unknown"
}

// vkind is a value's kind.
type vkind int8

const (
	vNull vkind = iota
	vUnknown
	vBool
	vString
	vNumber
	vList
)

// value is a fact's or a literal's value. List elements are scalars.
type value struct {
	k    vkind
	b    bool
	s    string
	n    float64
	list []value
}

var (
	nullValue    = value{k: vNull}
	unknownValue = value{k: vUnknown}
)

func boolValue(b bool) value     { return value{k: vBool, b: b} }
func stringValue(s string) value { return value{k: vString, s: s} }
func numberValue(n float64) value {
	return value{k: vNumber, n: n}
}

// stringsValue is a list of strings; an empty one is the empty list, not null.
func stringsValue(ss []string) value {
	l := make([]value, len(ss))
	for i, s := range ss {
		l[i] = stringValue(s)
	}
	return value{k: vList, list: l}
}

// optString is a string fact that is null when empty.
func optString(s string) value {
	if s == "" {
		return nullValue
	}
	return stringValue(s)
}

func (v value) truthy() tri {
	switch v.k {
	case vUnknown:
		return triUnknown
	case vBool:
		return triOf(v.b)
	case vString:
		return triOf(v.s != "")
	case vNumber:
		return triOf(v.n != 0)
	case vList:
		return triOf(len(v.list) > 0)
	}
	return triFalse
}

// elems is v as a list: its elements, or v itself; nothing for null.
func (v value) elems() []value {
	switch v.k {
	case vList:
		return v.list
	case vNull:
		return nil
	}
	return []value{v}
}

func scalarEqual(a, b value) bool {
	if a.k != b.k {
		return false
	}
	switch a.k {
	case vBool:
		return a.b == b.b
	case vString:
		return a.s == b.s
	case vNumber:
		return a.n == b.n
	case vNull:
		return true
	}
	return false
}

// MarshalJSON encodes a value as plain JSON (surface/open's facts).
func (v value) MarshalJSON() ([]byte, error) {
	switch v.k {
	case vBool:
		return json.Marshal(v.b)
	case vString:
		return json.Marshal(v.s)
	case vNumber:
		return json.Marshal(v.n)
	case vList:
		return json.Marshal(v.list)
	}
	return []byte("null"), nil
}

// valueFromJSON converts a context/set value: null, a boolean, a string, a number or
// a list of those.
func valueFromJSON(raw any, depth int) (value, error) {
	switch x := raw.(type) {
	case nil:
		return nullValue, nil
	case bool:
		return boolValue(x), nil
	case string:
		return stringValue(x), nil
	case float64:
		return numberValue(x), nil
	case json.Number:
		f, err := x.Float64()
		if err != nil {
			return value{}, err
		}
		return numberValue(f), nil
	case []any:
		if depth > 0 {
			return value{}, errors.New("lists do not nest")
		}
		l := make([]value, 0, len(x))
		for _, e := range x {
			v, err := valueFromJSON(e, depth+1)
			if err != nil {
				return value{}, err
			}
			l = append(l, v)
		}
		return value{k: vList, list: l}, nil
	}
	return value{}, fmt.Errorf("a %T is not a fact value (null, boolean, string, number or a list of them)", raw)
}

// Predicate is a compiled when clause.
type Predicate struct {
	src   string
	root  boolExpr
	facts []string // the facts it reads, sorted, distinct
}

// String returns the source.
func (p *Predicate) String() string { return p.src }

// Facts returns the fact names the predicate reads.
func (p *Predicate) Facts() []string { return p.facts }

// eval evaluates the predicate with lookup resolving facts. A nil predicate is true.
func (p *Predicate) eval(lookup func(name string) value) tri {
	if p == nil {
		return triTrue
	}
	return p.root.eval(lookup)
}

type boolExpr interface {
	eval(lookup func(string) value) tri
}

type orExpr []boolExpr
type andExpr []boolExpr
type notExpr struct{ x boolExpr }
type truthyExpr struct{ x operand }
type cmpExpr struct {
	op   string
	l, r operand
	re   *regexp.Regexp
}

func (e orExpr) eval(lookup func(string) value) tri {
	out := triFalse
	for _, x := range e {
		switch x.eval(lookup) {
		case triTrue:
			return triTrue
		case triUnknown:
			out = triUnknown
		}
	}
	return out
}

func (e andExpr) eval(lookup func(string) value) tri {
	out := triTrue
	for _, x := range e {
		switch x.eval(lookup) {
		case triFalse:
			return triFalse
		case triUnknown:
			out = triUnknown
		}
	}
	return out
}

func (e notExpr) eval(lookup func(string) value) tri { return e.x.eval(lookup).not() }

func (e truthyExpr) eval(lookup func(string) value) tri { return e.x.value(lookup).truthy() }

func (e cmpExpr) eval(lookup func(string) value) tri {
	l := e.l.value(lookup)
	if l.k == vUnknown {
		return triUnknown
	}
	if e.op == "=~" {
		for _, x := range l.elems() {
			if x.k == vString && e.re.MatchString(x.s) {
				return triTrue
			}
		}
		return triFalse
	}
	r := e.r.value(lookup)
	if r.k == vUnknown {
		return triUnknown
	}
	switch e.op {
	case "==", "!=":
		eq := false
		if l.k == vNull || r.k == vNull {
			eq = l.k == r.k
		} else {
			eq = anyPair(l, r)
		}
		return triOf(eq == (e.op == "=="))
	case "in":
		return triOf(anyPair(l, r))
	}
	return triFalse
}

func anyPair(l, r value) bool {
	for _, a := range l.elems() {
		for _, b := range r.elems() {
			if scalarEqual(a, b) {
				return true
			}
		}
	}
	return false
}

// operand is a fact or a literal.
type operand struct {
	fact string // "" for a literal
	lit  value
	re   *regexp.Regexp
}

func (o operand) value(lookup func(string) value) value {
	if o.fact != "" {
		return lookup(o.fact)
	}
	return o.lit
}

// MaxPredicate bounds a when clause's length.
const MaxPredicate = 1024

// CompilePredicate parses a when clause and checks its facts: every host fact name
// (factNames) is known, and any other name is a plugin's fact (<plugin>.<key>).
func CompilePredicate(src string) (*Predicate, error) {
	if len(src) > MaxPredicate {
		return nil, fmt.Errorf("longer than %d bytes", MaxPredicate)
	}
	toks, err := lex(src)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks}
	root, err := p.expr(0)
	if err != nil {
		return nil, err
	}
	if t := p.peek(); t.kind != tEOF {
		return nil, fmt.Errorf("unexpected %s at %d", t, t.pos)
	}
	facts := slices.Clone(p.facts)
	slices.Sort(facts)
	return &Predicate{src: src, root: root, facts: slices.Compact(facts)}, nil
}

type tkind int8

const (
	tEOF tkind = iota
	tIdent
	tString
	tNumber
	tRegex
	tOp // ( ) [ ] , ! && || == != =~ in
)

type token struct {
	kind tkind
	text string // the ident, the decoded string, the regex source, the operator
	num  float64
	pos  int
}

func (t token) String() string {
	switch t.kind {
	case tEOF:
		return "end of input"
	case tString:
		return strconv.Quote(t.text)
	case tRegex:
		return "/" + t.text + "/"
	}
	return "\"" + t.text + "\""
}

func isIdentStart(r rune) bool { return r == '_' || r < unicode.MaxASCII && unicode.IsLetter(r) }
func isIdentRune(r rune) bool {
	return isIdentStart(r) || r == '-' || r == '.' || (r >= '0' && r <= '9')
}

// lex splits src into tokens. A "/" starts a regular expression only after =~.
func lex(src string) ([]token, error) {
	var out []token
	rs := []rune(src)
	for i := 0; i < len(rs); {
		r := rs[i]
		switch {
		case unicode.IsSpace(r):
			i++
		case isIdentStart(r):
			j := i
			for j < len(rs) && isIdentRune(rs[j]) {
				j++
			}
			word := string(rs[i:j])
			if word == "in" {
				out = append(out, token{kind: tOp, text: "in", pos: i})
			} else {
				out = append(out, token{kind: tIdent, text: word, pos: i})
			}
			i = j
		case r == '"' || r == '\'':
			var b strings.Builder
			j := i + 1
			for ; j < len(rs) && rs[j] != r; j++ {
				if rs[j] == '\\' && j+1 < len(rs) {
					j++
				}
				b.WriteRune(rs[j])
			}
			if j >= len(rs) {
				return nil, fmt.Errorf("unterminated string at %d", i)
			}
			out = append(out, token{kind: tString, text: b.String(), pos: i})
			i = j + 1
		case r == '-' || (r >= '0' && r <= '9'):
			j := i + 1
			for j < len(rs) && (rs[j] == '.' || (rs[j] >= '0' && rs[j] <= '9')) {
				j++
			}
			n, err := strconv.ParseFloat(string(rs[i:j]), 64)
			if err != nil || math.IsInf(n, 0) {
				return nil, fmt.Errorf("bad number %q at %d", string(rs[i:j]), i)
			}
			out = append(out, token{kind: tNumber, text: string(rs[i:j]), num: n, pos: i})
			i = j
		case r == '/' && len(out) > 0 && out[len(out)-1].kind == tOp && out[len(out)-1].text == "=~":
			var b strings.Builder
			j := i + 1
			for ; j < len(rs) && rs[j] != '/'; j++ {
				if rs[j] == '\\' && j+1 < len(rs) && rs[j+1] == '/' {
					j++
				}
				b.WriteRune(rs[j])
			}
			if j >= len(rs) {
				return nil, fmt.Errorf("unterminated regular expression at %d", i)
			}
			out = append(out, token{kind: tRegex, text: b.String(), pos: i})
			i = j + 1
		default:
			two := ""
			if i+1 < len(rs) {
				two = string(rs[i : i+2])
			}
			switch {
			case slices.Contains([]string{"&&", "||", "==", "!=", "=~"}, two):
				out = append(out, token{kind: tOp, text: two, pos: i})
				i += 2
			case strings.ContainsRune("()[],!", r):
				out = append(out, token{kind: tOp, text: string(r), pos: i})
				i++
			default:
				return nil, fmt.Errorf("unexpected %q at %d", string(r), i)
			}
		}
	}
	return append(out, token{kind: tEOF, pos: len(rs)}), nil
}

type parser struct {
	toks  []token
	i     int
	facts []string
}

func (p *parser) peek() token { return p.toks[p.i] }
func (p *parser) next() token {
	t := p.toks[p.i]
	if t.kind != tEOF {
		p.i++
	}
	return t
}
func (p *parser) isOp(s string) bool { t := p.peek(); return t.kind == tOp && t.text == s }

// maxNesting bounds parentheses and negations.
const maxNesting = 32

func (p *parser) expr(depth int) (boolExpr, error) {
	if depth > maxNesting {
		return nil, errors.New("nested too deeply")
	}
	var or orExpr
	for {
		var and andExpr
		for {
			u, err := p.unary(depth)
			if err != nil {
				return nil, err
			}
			and = append(and, u)
			if !p.isOp("&&") {
				break
			}
			p.next()
		}
		if len(and) == 1 {
			or = append(or, and[0])
		} else {
			or = append(or, and)
		}
		if !p.isOp("||") {
			break
		}
		p.next()
	}
	if len(or) == 1 {
		return or[0], nil
	}
	return or, nil
}

func (p *parser) unary(depth int) (boolExpr, error) {
	if depth > maxNesting {
		return nil, errors.New("nested too deeply")
	}
	switch {
	case p.isOp("!"):
		p.next()
		x, err := p.unary(depth + 1)
		if err != nil {
			return nil, err
		}
		return notExpr{x}, nil
	case p.isOp("("):
		p.next()
		x, err := p.expr(depth + 1)
		if err != nil {
			return nil, err
		}
		if !p.isOp(")") {
			t := p.peek()
			return nil, fmt.Errorf("expected \")\" at %d, found %s", t.pos, t)
		}
		p.next()
		return x, nil
	}
	l, err := p.operand(false)
	if err != nil {
		return nil, err
	}
	t := p.peek()
	if t.kind != tOp || !slices.Contains([]string{"==", "!=", "=~", "in"}, t.text) {
		if l.re != nil {
			return nil, errors.New("a regular expression only goes right of =~")
		}
		return truthyExpr{l}, nil
	}
	p.next()
	if l.re != nil {
		return nil, errors.New("a regular expression only goes right of =~")
	}
	r, err := p.operand(t.text == "=~")
	if err != nil {
		return nil, err
	}
	switch {
	case t.text == "=~" && r.re == nil:
		return nil, fmt.Errorf("=~ at %d needs a /regular expression/ on its right", t.pos)
	case t.text != "=~" && r.re != nil:
		return nil, errors.New("a regular expression only goes right of =~")
	}
	if p.peek().kind == tOp && slices.Contains([]string{"==", "!=", "=~", "in"}, p.peek().text) {
		return nil, fmt.Errorf("comparisons do not chain (at %d): use && or parentheses", p.peek().pos)
	}
	return cmpExpr{op: t.text, l: l, r: r, re: r.re}, nil
}

func (p *parser) operand(regexOK bool) (operand, error) {
	t := p.next()
	switch t.kind {
	case tIdent:
		switch t.text {
		case "true", "false":
			return operand{lit: boolValue(t.text == "true")}, nil
		case "null":
			return operand{lit: nullValue}, nil
		}
		if err := checkFactName(t.text); err != nil {
			return operand{}, err
		}
		p.facts = append(p.facts, t.text)
		return operand{fact: t.text}, nil
	case tString:
		return operand{lit: stringValue(t.text)}, nil
	case tNumber:
		return operand{lit: numberValue(t.num)}, nil
	case tRegex:
		if !regexOK {
			return operand{}, errors.New("a regular expression only goes right of =~")
		}
		re, err := regexp.Compile(t.text)
		if err != nil {
			return operand{}, fmt.Errorf("regular expression at %d: %v", t.pos, err)
		}
		return operand{re: re}, nil
	case tOp:
		if t.text == "[" {
			return p.list()
		}
	}
	return operand{}, fmt.Errorf("expected a fact or a value at %d, found %s", t.pos, t)
}

func (p *parser) list() (operand, error) {
	var l []value
	for !p.isOp("]") {
		if len(l) > 0 {
			if !p.isOp(",") {
				t := p.peek()
				return operand{}, fmt.Errorf("expected \",\" or \"]\" at %d, found %s", t.pos, t)
			}
			p.next()
		}
		t := p.next()
		switch {
		case t.kind == tString:
			l = append(l, stringValue(t.text))
		case t.kind == tNumber:
			l = append(l, numberValue(t.num))
		case t.kind == tIdent && (t.text == "true" || t.text == "false"):
			l = append(l, boolValue(t.text == "true"))
		default:
			return operand{}, fmt.Errorf("a list holds literals; found %s at %d", t, t.pos)
		}
	}
	p.next()
	return operand{lit: value{k: vList, list: l}}, nil
}

// hostNamespaces are the first segments of host facts; any other first segment names a
// plugin.
var hostNamespaces = []string{"view", "thread", "project", "workspace", "pr"}

var factSegment = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*$`)

// checkFactName reports whether name is a host fact or a well-formed plugin fact.
func checkFactName(name string) error {
	segs := strings.Split(name, ".")
	for _, s := range segs {
		if !factSegment.MatchString(s) {
			return fmt.Errorf("%q is not a fact name", name)
		}
	}
	if slices.Contains(hostNamespaces, segs[0]) {
		if _, ok := hostFacts[name]; !ok {
			return fmt.Errorf("unknown fact %q (host facts: %s)", name, strings.Join(HostFactNames(), ", "))
		}
		return nil
	}
	if len(segs) < 2 {
		return fmt.Errorf("unknown fact %q: a plugin's fact is <plugin>.<key>", name)
	}
	return nil
}
