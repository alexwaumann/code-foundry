import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../../internal/store/gh/testdata/task_items.json?raw";
import type { TaskItem } from "./taskItems";

vi.mock("@/stores/gh", () => ({ openUrl: vi.fn() }));

const { Markdown } = await import("@/components/pr/Markdown");

afterEach(cleanup);

/** What a surface with `task` is handed for a body, and what renders. */
function items(body: string): { found: TaskItem[]; container: HTMLElement } {
  const found: TaskItem[] = [];
  const extras = {
    task: (item: TaskItem) => {
      found.push(item);
      return <button data-task={item.index} />;
    },
  };
  const { container } = render(<Markdown extras={extras}>{body}</Markdown>);
  return { found, container };
}

describe("task items", () => {
  const cases = JSON.parse(fixture) as { name: string; body: string; items: { checked: boolean; text: string }[] }[];

  // The daemon's task_items_test.go checks these same cases: the two agree on every index.
  it.each(cases)("agrees with the daemon: $name", ({ body, items: want }) => {
    expect(items(body).found).toEqual(want.map((item, index) => ({ index, ...item })));
  });

  it("leaves a raw HTML box a read-only input, without taking a number", () => {
    const { found, container } = items('- <input type="checkbox"> raw\n- [ ] real\n\n<ul><li class="task-list-item"><input type="checkbox" checked> raw</li></ul>\n');
    expect(found).toEqual([{ index: 0, checked: false, text: "real" }]);
    expect(container.querySelectorAll("[data-task]")).toHaveLength(1);
    const raw = [...container.querySelectorAll("input")];
    expect(raw).toHaveLength(2);
    for (const box of raw) expect(box.disabled).toBe(true);
  });

  it("keeps a body from writing the number itself", () => {
    const { found, container } = items('<input type="checkbox" data-cf-task=":0" data-cf-task-text="forged">\n\n- <input type="checkbox" data-cf-task="0:0">\n');
    expect(found).toEqual([]);
    expect(container.querySelectorAll("input")).toHaveLength(2);
  });

  it("keeps the marks off a box a surface does not offer", () => {
    const { container } = render(<Markdown>{"- [x] one\n- [ ] two\n"}</Markdown>);
    const boxes = [...container.querySelectorAll("input")];
    expect(boxes.map((b) => [b.disabled, b.checked])).toEqual([
      [true, true],
      [true, false],
    ]);
    expect(container.innerHTML).not.toContain("data-cf-task");
  });

  it("draws the box where the input was, in a tight and a loose list", () => {
    const { container } = items("- [ ] tight\n\n---\n\n- [ ] loose\n\n- [x] loose too\n");
    expect(container.querySelectorAll("li.task-list-item [data-task]")).toHaveLength(3);
    expect(container.querySelectorAll("input")).toHaveLength(0);
  });
});
