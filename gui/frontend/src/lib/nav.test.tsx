import { useLayoutEffect, useMemo } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNav } from "./nav";
import { NavProvider, NavRow } from "./NavRow";

interface Props {
  /** The rows, one letter each. */
  rows: string;
  follow: string | null;
}

/** What each commit showed: the key followed and the cursor's row. */
let commits: [string | null, string | null][] = [];

function List({ rows, follow }: Props) {
  const items = useMemo(() => rows.split("").map((key) => ({ key })), [rows]);
  const nav = useNav(items, { follow });
  useLayoutEffect(() => {
    commits.push([follow, nav.cursorKey]);
  });
  return (
    <NavProvider value={nav.ctx}>
      <div data-testid="list" tabIndex={0} onKeyDown={nav.onKeyDown}>
        {items.map((it) => (
          <NavRow key={it.key} navKey={it.key}>
            {it.key}
          </NavRow>
        ))}
      </div>
    </NavProvider>
  );
}

const intoView = vi.fn<(this: Element) => void>();
const scrolled = () => intoView.mock.contexts.map((e) => e.getAttribute("data-nav-key"));
const cursor = () => screen.queryByRole("option", { selected: true })?.getAttribute("data-nav-key") ?? null;

type Step = { props: Props } | { press: string };

describe("useNav's follow", () => {
  beforeEach(() => {
    intoView.mockClear();
    Element.prototype.scrollIntoView = intoView;
    commits = [];
  });
  afterEach(cleanup);

  const cases: { name: string; first: Props; steps: Step[]; cursor: string | null; scrolled: string[] }[] = [
    { name: "opens on the key, owing its row a scroll", first: { rows: "abc", follow: "b" }, steps: [], cursor: "b", scrolled: ["b"] },
    { name: "no key, no cursor", first: { rows: "abc", follow: null }, steps: [], cursor: null, scrolled: [] },
    { name: "the key changing moves the cursor and scrolls to it", first: { rows: "abc", follow: "a" }, steps: [{ props: { rows: "abc", follow: "c" } }], cursor: "c", scrolled: ["a", "c"] },
    { name: "a key not among the items shows no cursor", first: { rows: "abc", follow: "a" }, steps: [{ props: { rows: "abc", follow: "z" } }], cursor: null, scrolled: ["a"] },
    { name: "a key not listed yet is held until the list has it", first: { rows: "ab", follow: "c" }, steps: [{ props: { rows: "abc", follow: "c" } }], cursor: "c", scrolled: ["c"] },
    { name: "the list changing under an unchanged key leaves the user's cursor", first: { rows: "abc", follow: "a" }, steps: [{ press: "End" }, { props: { rows: "abcd", follow: "a" } }], cursor: "c", scrolled: ["a", "c"] },
    { name: "the user moves, then the key changes: the key wins", first: { rows: "abcd", follow: "a" }, steps: [{ press: "End" }, { props: { rows: "abcd", follow: "b" } }], cursor: "b", scrolled: ["a", "d", "b"] },
    { name: "the user moves, then the key goes to null: the cursor stays", first: { rows: "abc", follow: "a" }, steps: [{ press: "End" }, { props: { rows: "abc", follow: null } }], cursor: "c", scrolled: ["a", "c"] },
    { name: "the key back after null moves the cursor again", first: { rows: "abc", follow: "a" }, steps: [{ press: "End" }, { props: { rows: "abc", follow: null } }, { props: { rows: "abc", follow: "a" } }], cursor: "a", scrolled: ["a", "c", "a"] },
    { name: "the key moving to where the user already is owes nothing", first: { rows: "abc", follow: "a" }, steps: [{ press: "End" }, { props: { rows: "abc", follow: "c" } }], cursor: "c", scrolled: ["a", "c"] },
  ];

  it.each(cases)("$name", ({ first, steps, cursor: want, scrolled: wantScrolled }) => {
    const { rerender } = render(<List {...first} />);
    for (const step of steps) {
      if ("press" in step) fireEvent.keyDown(screen.getByTestId("list"), { key: step.press });
      else rerender(<List {...step.props} />);
    }
    expect(cursor()).toBe(want);
    expect(scrolled()).toEqual(wantScrolled);
  });

  it("the cursor is on a new key in the commit that brings it, not a render behind", () => {
    const { rerender } = render(<List rows="abc" follow="a" />);
    rerender(<List rows="abc" follow="b" />);
    rerender(<List rows="abc" follow="c" />);
    expect(commits).toEqual([
      ["a", "a"],
      ["b", "b"],
      ["c", "c"],
    ]);
  });
});
