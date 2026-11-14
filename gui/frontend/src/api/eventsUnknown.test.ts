import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { describe, expect, it } from "vitest";
import { EventSchema } from "@/gen/codefoundry/v1/events_pb";
import { LayoutEventSchema } from "@/gen/codefoundry/v1/layout_pb";
import { toEventView } from "./events";

// A GUI drops an event kind it does not map, so a daemon may add a source before the GUI
// reads it (docs/notes/shell-3-layout-store.md, "Version window").
describe("toEventView with an event kind the GUI does not map", () => {
  it("drops a layout event whose change this build does not know", () => {
    // A LayoutEvent with no snapshot and no delta: what a newer daemon's new change kind reads as.
    const ev = create(EventSchema, { seq: 7n, event: { case: "layout", value: create(LayoutEventSchema, { rev: 3n }) } });
    expect(toEventView(fromBinary(EventSchema, toBinary(EventSchema, ev)))).toBeNull();
  });

  it("drops an event whose case is newer than this build, as an older GUI drops layout", () => {
    // Field 99 of Event: unknown to every build, as field 22 (layout) is to a GUI built before it.
    const bytes = new BinaryWriter().tag(99, WireType.LengthDelimited).bytes(new Uint8Array([8, 3])).tag(20, WireType.Varint).uint64(8n).finish();
    const ev = fromBinary(EventSchema, bytes);
    expect(ev.event.case).toBeUndefined();
    expect(ev.seq).toBe(8n);
    expect(toEventView(ev)).toBeNull();
  });
});
