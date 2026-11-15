import { afterEach, describe, expect, it } from "vitest";
import { setMuted, setPlaybackRate, setVolume, stepVolume, toggleMuted, useMediaPlayerStore } from "./mediaPlayer";

const KEY = "code-foundry.mediaPlayer";
const state = () => useMediaPlayerStore.getState();

afterEach(() => {
  localStorage.clear();
  useMediaPlayerStore.setState({ volume: 1, muted: false, rate: 1 });
});

describe("the media player store", () => {
  it("keeps volume, mute and speed in localStorage for the next file", () => {
    setVolume(0.4);
    setMuted(true);
    setPlaybackRate(1.5);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toMatchObject({ state: { volume: 0.4, muted: true, rate: 1.5 } });
  });

  it("reads back only sane values", async () => {
    localStorage.setItem(KEY, JSON.stringify({ state: { volume: 7, muted: "yes", rate: 3 }, version: 1 }));
    await useMediaPlayerStore.persist.rehydrate();
    expect(state()).toMatchObject({ volume: 1, muted: false, rate: 1 });
    localStorage.setItem(KEY, JSON.stringify({ state: { volume: 0.25, muted: true, rate: 0.5 }, version: 1 }));
    await useMediaPlayerStore.persist.rehydrate();
    expect(state()).toMatchObject({ volume: 0.25, muted: true, rate: 0.5 });
  });

  it("Up and Down step the volume within 0..1; Up unmutes, as raising the slider does", () => {
    setVolume(0.95);
    stepVolume(1);
    expect(state().volume).toBe(1);
    setVolume(0.05);
    stepVolume(-1);
    expect(state().volume).toBe(0);
    setMuted(true);
    stepVolume(-1);
    expect(state().muted).toBe(true);
    stepVolume(1);
    expect(state()).toMatchObject({ volume: 0.1, muted: false });
  });

  it("the speaker mutes and unmutes; unmuting at 0 comes back audible", () => {
    setVolume(0.6);
    toggleMuted();
    expect(state()).toMatchObject({ volume: 0.6, muted: true });
    toggleMuted();
    expect(state()).toMatchObject({ volume: 0.6, muted: false });
    setVolume(0);
    toggleMuted();
    expect(state()).toMatchObject({ volume: 0.5, muted: false });
  });
});
