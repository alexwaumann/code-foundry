import { cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/prWorld")).prGhFakes }));

const { GP_SLUG, seedPrWorld, SLUG } = await import("@/test/prWorld");
const { dashboardResource } = await import("@/stores/gh");
const { usePrSource } = await import("./useRefSources");
const { CompletionCard } = await import("./CompletionCard");
type Completion = import("./useCompletion").Completion;

/**
 * The composer's `#` source over the mock's dashboards (src/test/prWorld.ts): a draft in two
 * projects lists both repositories' pull requests with the repository as the hint, and the
 * card draws it. Picking one into the real editor is e2e/composer-prs.spec.ts's.
 */

beforeEach(() => {
  seedPrWorld();
  dashboardResource.store.setState({ entries: {} });
});

afterEach(() => {
  cleanup();
});

const trigger = (query: string) => ({ char: "#" as const, query, from: 0, to: query.length + 1 });

describe("usePrSource", () => {
  it("two projects: both repositories' pull requests, each with its repository as the hint", async () => {
    const { result } = renderHook(() => usePrSource(trigger("12"), [SLUG, GP_SLUG]));
    await waitFor(() => {
      expect(result.current.groups[0]?.items.length).toBeGreaterThan(0);
    });
    const first = result.current.groups[0]?.items[0];
    expect(first?.label).toBe("#12");
    expect(first?.hint).toBe(GP_SLUG);
    expect(first?.tag).toEqual({ tagKind: "pr", slug: GP_SLUG, number: 12 });
  });

  it("one project: its pull requests only, no hint", async () => {
    const { result } = renderHook(() => usePrSource(trigger("12"), [GP_SLUG]));
    await waitFor(() => {
      expect(result.current.groups[0]?.items.length).toBeGreaterThan(0);
    });
    expect(result.current.groups[0]?.items.map((i) => [i.label, i.hint])).toEqual([["#12", undefined]]);
  });
});

describe("CompletionCard", () => {
  it("draws a row's hint beside its label", () => {
    const completion = {
      show: "list",
      label: "Pull requests",
      groups: [{ key: "prs", heading: null, items: [{ key: `${GP_SLUG}#12`, label: "#12", hint: GP_SLUG, detail: "renderer: port glyph cache to the new atlas", tag: { tagKind: "pr", slug: GP_SLUG, number: 12 } }] }],
      emptyText: "",
      selected: 0,
      listId: "l",
      optionId: (i: number) => `l-${String(i)}`,
      aria: null,
      onTrigger: () => undefined,
      onKey: () => false,
      select: () => undefined,
      insert: () => undefined,
    } as unknown as Completion;
    render(<CompletionCard completion={completion} />);
    const row = screen.getAllByTestId("completion-item")[0] as HTMLElement;
    expect(within(row).getByTestId("completion-label").textContent).toBe("#12");
    expect(within(row).getByTestId("completion-hint").textContent).toBe(GP_SLUG);
  });
});
