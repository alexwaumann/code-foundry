import type { ComponentType, ReactNode } from "react";
import type { SupportedLanguages } from "@pierre/diffs";
import type { LucideIcon } from "lucide-react";
import type { FileReadView } from "@/api/files";
import type { FileTarget } from "@/surfaces/fileTarget";
import type { FilePlace } from "../fileActions";

/**
 * A preview kind: one way the File tab shows a file besides its text as code (markdown
 * rendered, an image, a PDF's pages, an SVG as a picture). Each kind is one file under
 * `previews/kinds/`, found by `registry.ts`; FileTab knows none of them by name.
 * docs/notes/file-previews-1-registry.md has the rules and how to add one.
 */
export interface PreviewKind {
  /** Stable id: the key of the remembered mode (codeView store `preview`), and `file-<id>-too-large`'s. */
  readonly id: string;
  /** Which files are this kind (registry.ts `previewKindOf`: extension, then exact mime, then a wildcard mime, then a sniff). */
  readonly match: PreviewMatch;
  /**
   * Whether this read can be shown this way; a kind that matched but cannot show the read
   * leaves the file to the next match, else to the code view (or the binary state). Default:
   * the read has text (a binary `.md` is no markdown to render).
   */
  readonly shows?: (file: FileReadView) => boolean;
  /**
   * The switch's preview modes, the one a file opens in first. "Source" (the text as code)
   * is added last whenever the read has text, so a kind does not list it; a kind with one
   * mode and no text (an image, a video) has no switch at all.
   */
  readonly modes: readonly [PreviewMode, ...PreviewMode[]];
  /**
   * How the file is read for this kind; decided from the path alone (`previewKindOf(path,
   * null)`), so a kind with a read of its own matches by extension. Only "whole" (ReadFile
   * up to READ_MAX_BYTES) exists today; a tail read (logs) and a stream URL (media) come with
   * their kinds.
   */
  readonly read?: "whole";
  /** The body in a preview mode. Wrap a heavy one in React.lazy: FileTab renders it under Suspense. */
  readonly Body: ComponentType<PreviewBodyProps>;
  /** Row two's meta in a preview mode, before the body says more (`PreviewBodyProps.onMeta`). */
  readonly meta: (f: PreviewFile) => ReactNode;
  /** More of row two after the mode switch, in a preview mode only (the patch's Unified | Split). */
  readonly Controls?: ComponentType<PreviewControlsProps>;
  /** The preview mode has wrapping text, so the wrap toggle stays (it always shows in Source). */
  readonly wrap?: boolean;
  /** The preview mode's text can be searched (file.search): the body takes `findKey`. */
  readonly find?: boolean;
  /** false: no Edit (pencil) for this kind, even in Source. Otherwise Edit switches to Source and edits there. */
  readonly edit?: false;
  /** What Copy contents copies in a preview mode (a table's tab-separated text); default the file's text. Source always copies the text. */
  readonly copy?: (f: PreviewFile) => string;
  /**
   * The noun of "<noun> · 48 MB · too large to show": a read cut short (over the cap) cannot
   * be shown this way at all (the webview cannot decode part of an image). Unset: a cut
   * read shows what came back, under the truncated notice.
   */
  readonly tooLarge?: string;
  /** Source's highlighting and its name in the meta, when the extension does not say (an SVG is XML, named "SVG"). */
  readonly source?: { readonly lang: SupportedLanguages; readonly name: string };
  /** The header's icon, in place of fileIconOf's. */
  readonly icon?: LucideIcon;
}

/** Which files a kind is. Every list is lower case; the registry tries the tiers in this order across all kinds. */
export interface PreviewMatch {
  /** Extensions without the dot: "md", "svg". */
  readonly ext?: readonly string[];
  /** Mime types without parameters: "text/markdown"; "image/*" matches any image, below every exact type. */
  readonly mime?: readonly string[];
  /** A look at the text when no extension or mime matched. Runs once per read on every text file: keep it a single cheap scan. */
  readonly sniff?: (text: string) => boolean;
}

/** One choice of a kind's mode switch. */
export interface PreviewMode {
  readonly id: string;
  readonly label: string;
}

/** The mode a text kind's switch ends with: the text as code, where Edit works. */
export const SOURCE: PreviewMode = { id: "source", label: "Source" };

/** What a kind's functions are told. */
export interface PreviewFile {
  /** The read, as the kind's `read` asked for it. */
  readonly file: FileReadView;
  /** Absolute path. */
  readonly path: string;
}

export interface PreviewControlsProps extends PreviewFile {
  /** The preview mode on (one of the kind's `modes`). */
  readonly mode: string;
}

export interface PreviewBodyProps extends PreviewControlsProps {
  /** The file's name, for alt text and titles. */
  readonly name: string;
  /** The file's project and checkout (relative links resolve against them). */
  readonly place: FilePlace;
  /** An HTML page's page param (FileTarget). */
  readonly page: FileTarget["page"];
  /** Refresh presses: a body that loads on its own (a frame) loads again even when the file did not change. */
  readonly reloads: number;
  /** The find's key, for a kind with `find`. */
  readonly findKey: string | undefined;
  /** Replaces row two's meta while this body shows (an image's size once it decodes, a PDF's page count). */
  readonly onMeta: (meta: ReactNode) => void;
  /** Switches the tab to another mode as the switch does (remembered for the kind): a body's way to Source when it cannot show the file (a diagram that does not parse). */
  readonly onMode: (mode: string) => void;
}
