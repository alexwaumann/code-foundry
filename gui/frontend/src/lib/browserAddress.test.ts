import { describe, expect, it } from "vitest";
import { addressParts, UNKNOWN_SITE } from "./browserAddress";

const known = (lead: string, site: string, rest: string) => ({ lead, site, rest, unknown: false });

describe("addressParts", () => {
  it.each([
    ["https://example.com/", "https://example.com", "example.com", known("https://", "example.com", "")],
    ["https://a.b.example.co.uk/x?y=1#z", "https://a.b.example.co.uk", "example.co.uk", known("https://a.b.", "example.co.uk", "/x?y=1#z")],
    ["http://localhost:5173/app", "http://localhost:5173", "localhost", known("http://", "localhost:5173", "/app")],
    ["http://127.0.0.1:8000/", "http://127.0.0.1:8000", "127.0.0.1", known("http://", "127.0.0.1:8000", "")],
    ["https://login.bank.com.evil.co/path", "https://login.bank.com.evil.co", "evil.co", known("https://login.bank.com.", "evil.co", "/path")],
    ["http://[::1]:8080/x", "http://[::1]:8080", "::1", known("http://", "[::1]:8080", "/x")],
  ])("%s", (url, origin, site, want) => {
    expect(addressParts(url, origin, site)).toEqual(want);
  });

  it("does not take a suffix of a label for the domain", () => {
    expect(addressParts("https://notevil.co/", "https://notevil.co", "evil.co")).toEqual(known("https://", "notevil.co", ""));
  });

  it.each([
    ["a path no parser takes", "http://evil.test:81/%zz", "http://evil.test:81", "evil.test", known("http://", "evil.test:81", "/%zz")],
    ["a host no parser takes", "http://a{b.evil.test/x", "http://a{b.evil.test", "evil.test", known("http://a{b.", "evil.test", "/x")],
    ["a backtick in the host", "http://a`b.evil.test/x", "http://a`b.evil.test", "evil.test", known("http://a`b.", "evil.test", "/x")],
  ])("keeps the domain through %s", (_, url, origin, site, want) => {
    expect(addressParts(url, origin, site)).toEqual(want);
  });

  it("does not read the origin out of a longer host", () => {
    expect(addressParts("https://example.com.evil.co/", "https://example.com", "example.com")?.rest).toBe(" https://example.com.evil.co/");
  });

  it.each([
    ["a blank page another site wrote", "about:blank"],
    ["a blob", "blob:https://evil.test/1"],
  ])("names who made %s, and puts the address after it", (_, url) => {
    expect(addressParts(url, "https://evil.test", "evil.test")).toEqual(known("https://", "evil.test", ` ${url}`));
  });

  it.each([["data:text/html,hi"], ["about:blank"], ["http://x/%zz"]])("says it cannot tell for %s with no origin", (url) => {
    expect(addressParts(url, "", "")).toEqual({ lead: "", site: UNKNOWN_SITE, rest: ` ${url}`, unknown: true });
  });

  it("has nothing to show without an address", () => {
    expect(addressParts("", "", "")).toBeNull();
  });
});
