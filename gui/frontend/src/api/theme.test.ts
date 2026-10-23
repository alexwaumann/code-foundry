import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { EventSchema } from "@/gen/codefoundry/v1/events_pb";
import { ThemeEventSchema, ThemeSnapshotSchema } from "@/gen/codefoundry/v1/theme_pb";
import { themeById } from "@/themes";
import { toEventView } from "./events";
import { toThemesSnapshotView } from "./theme";

const nord = themeById.get("nord");
if (!nord) throw new Error("nord");
const ansi = [...nord.base.terminal.ansi];

const snapshot = create(ThemeSnapshotSchema, {
  curated: [{ id: "nord", name: "Nord", scheme: "dark" }],
  user: [
    {
      id: "nord-copy",
      name: "Nord, quieter",
      scheme: "dark",
      from: "nord",
      createdBy: "s-1",
      path: "/h/themes/nord-copy.json",
      base: { ...nord.base, link: "", terminal: { foreground: nord.base.terminal.foreground, cursor: "", cursorText: "", selection: "#434c5e", ansi } },
      overrides: { "--cf-accent": "#88c0d0" },
    },
    // A scheme the GUI does not know is dropped rather than painted.
    { id: "sepia", name: "Sepia", scheme: "sepia", base: { ...nord.base, terminal: { foreground: "#000000", ansi } } },
  ],
  issues: [{ file: "broken.json", message: "not JSON" }],
  dir: "/h/themes",
  version: 3n,
});

describe("toThemesSnapshotView", () => {
  it("maps user themes to theme files, empty optional colours left out", () => {
    const v = toThemesSnapshotView(snapshot);
    expect(v).toMatchObject({ dir: "/h/themes", version: 3, issues: [{ file: "broken.json", message: "not JSON" }] });
    expect(v.user).toHaveLength(1);
    const t = v.user[0];
    expect(t).toMatchObject({ id: "nord-copy", name: "Nord, quieter", scheme: "dark", from: "nord", createdBy: "s-1", path: "/h/themes/nord-copy.json", overrides: { "--cf-accent": "#88c0d0" } });
    expect(t?.base.terminal).toEqual({ foreground: nord.base.terminal.foreground, selection: "#434c5e", ansi });
    expect(t?.base).not.toHaveProperty("link");
    expect(t).not.toHaveProperty("pair");
  });

  it("an empty snapshot", () => {
    expect(toThemesSnapshotView(undefined)).toEqual({ user: [], issues: [], dir: "", version: 0 });
  });

  it("arrives on the events stream as the theme source", () => {
    const ev = toEventView(create(EventSchema, { event: { case: "theme", value: create(ThemeEventSchema, { snapshot }) } }));
    expect(ev?.source).toBe("theme");
  });
});
