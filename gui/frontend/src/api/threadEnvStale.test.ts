import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { toThreadView } from "@/api/threads";
import { ThreadSchema } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { sameThread } from "@/stores/threads";

// Thread.plugin_env_stale (docs/notes/plugins-env-restart.md) maps to optional fields, and
// their arrival or departure is a change the store keeps (sameThread).
describe("plugin environment staleness", () => {
  it("maps the stale flag and its summary, and leaves both out for a current thread", () => {
    const stale = toThreadView(create(ThreadSchema, { id: "s", pluginEnvStale: true, pluginEnvChange: "Hello removed CF_HELLO" }));
    expect(stale.pluginEnvStale).toBe(true);
    expect(stale.pluginEnvChange).toBe("Hello removed CF_HELLO");
    const current = toThreadView(create(ThreadSchema, { id: "s", pluginEnvChange: "ignored" }));
    expect("pluginEnvStale" in current).toBe(false);
    expect("pluginEnvChange" in current).toBe(false);
  });

  it("a thread turning stale, or current again, is not the same thread", () => {
    const current = toThreadView(create(ThreadSchema, { id: "s" }));
    const stale = toThreadView(create(ThreadSchema, { id: "s", pluginEnvStale: true, pluginEnvChange: "x" }));
    expect(sameThread(current, stale)).toBe(false);
    expect(sameThread(stale, current)).toBe(false);
    expect(sameThread(stale, toThreadView(create(ThreadSchema, { id: "s", pluginEnvStale: true, pluginEnvChange: "x" })))).toBe(true);
    expect(sameThread(stale, toThreadView(create(ThreadSchema, { id: "s", pluginEnvStale: true, pluginEnvChange: "y" })))).toBe(false);
  });
});
