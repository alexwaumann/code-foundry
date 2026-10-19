/**
 * The backdrops folder (SettingsService.ListBackdrops / ImportBackdrop / RemoveBackdrop /
 * ReadBackdrop) without files: an import takes its type from the path's extension (the
 * daemon sniffs the content), names the copy from the path instead of the content, and
 * every image reads as the same small PNG. Selection goes through MockSettings like the
 * daemon's store goes through the settings store.
 *
 *   POST /__mock/backdrops/import?path=/Users/me/Pictures/a.png   (what Add image… would do)
 */
import { createHash } from "node:crypto";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { CommandError } from "./world";
import type { MockSettings } from "./settings";
import { MOCK_ATTACHMENT_PNG } from "./thread";

const TYPES: Record<string, string> = { ".png": ".png", ".jpg": ".jpg", ".jpeg": ".jpg", ".webp": ".webp", ".gif": ".gif" };

interface MockBackdrop {
  name: string;
  size: bigint;
  width: number;
  height: number;
  added: Date;
}

export class MockBackdrops {
  private images: MockBackdrop[] = [];
  /** "import <path>", "remove <name>", "read <name>". */
  calls: string[] = [];

  constructor(private readonly settings: MockSettings) {
    settings.backdropExists = (name) => this.images.some((b) => b.name === name);
  }

  reset(): void {
    this.images = [];
    this.calls = [];
  }

  list() {
    return this.images.map((b) => ({ name: b.name, size: b.size, width: b.width, height: b.height, addedAt: timestampFromDate(b.added) }));
  }

  import(path: string) {
    this.calls.push(`import ${path}`);
    if (!path.startsWith("/")) throw new CommandError("invalid", `invalid argument: image "${path}" is not absolute`);
    if (path.includes("missing")) throw new CommandError("notfound", `not found: image "${path}" does not exist`);
    if (path.includes("huge")) throw new CommandError("invalid", "invalid argument: the limit for a backdrop image is 24 MiB");
    const ext = TYPES[(/\.[a-z0-9]+$/i.exec(path)?.[0] ?? "").toLowerCase()];
    if (!ext) throw new CommandError("invalid", "invalid argument: not a PNG, JPEG, WebP or GIF image (its content is text/plain; charset=utf-8)");
    const name = createHash("sha256").update(path).digest("hex").slice(0, 32) + ext;
    let image = this.images.find((b) => b.name === name);
    if (!image) {
      image = { name, size: BigInt(MOCK_ATTACHMENT_PNG.length), width: 48, height: 32, added: new Date() };
      this.images.push(image);
    }
    this.settings.update({ "appearance.backdrop": "custom", "appearance.backdrop_file": name });
    return this.list().find((b) => b.name === name);
  }

  remove(name: string): void {
    this.calls.push(`remove ${name}`);
    if (!this.images.some((b) => b.name === name)) throw new CommandError("notfound", `not found: backdrop "${name}"`);
    this.images = this.images.filter((b) => b.name !== name);
    if (this.settings.value("appearance.backdrop_file") !== name) return;
    const partial: Record<string, string> = { "appearance.backdrop_file": "" };
    if (this.settings.value("appearance.backdrop") === "custom") partial["appearance.backdrop"] = "forest";
    this.settings.update(partial);
  }

  read(name: string): { data: Uint8Array; mimeType: string } {
    this.calls.push(`read ${name}`);
    if (name.includes("/") || name.startsWith(".")) throw new CommandError("invalid", `invalid argument: "${name}" is not a file name in the backdrops folder`);
    if (!this.images.some((b) => b.name === name)) throw new CommandError("notfound", `not found: backdrop "${name}"`);
    return { data: new Uint8Array(MOCK_ATTACHMENT_PNG), mimeType: "image/png" };
  }
}
