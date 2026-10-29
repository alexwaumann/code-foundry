import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** How long a landed phrase's tint lasts (the fade in dictation.css runs as long). */
export const LANDED_MS = 1_000;

/** A phrase that just landed: its range (mapped through later edits) and when it landed. */
interface Landed {
  from: number;
  to: number;
  at: number;
}

interface LandingState {
  landed: readonly Landed[];
  /** The marker where the next phrase lands (while dictating). */
  marker: boolean;
}

type LandingMeta = { add: Landed } | { expire: number } | { marker: boolean };

export const dictationLandingKey = new PluginKey<LandingState>("dictationLanding");

/**
 * Dictated phrases in the prompt (docs/notes/dictation-4-gui.md): a decoration, not a
 * mark, so nothing reaches the draft's text. Each landed phrase is tinted and fades over
 * LANDED_MS (a negative animation-delay keeps the fade where it was when ProseMirror
 * redraws the span), then its range is dropped; typing inside or around it is plain text.
 * While dictating, a small accent dot sits after the caret where the next phrase lands.
 */
export const DictationLanding = Extension.create({
  name: "dictationLanding",
  addProseMirrorPlugins() {
    return [
      new Plugin<LandingState>({
        key: dictationLandingKey,
        state: {
          init: () => ({ landed: [], marker: false }),
          apply(tr, prev) {
            const meta = tr.getMeta(dictationLandingKey) as LandingMeta | undefined;
            let landed = tr.docChanged
              ? prev.landed.map((r) => ({ ...r, from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) })).filter((r) => r.to > r.from)
              : prev.landed;
            let marker = prev.marker;
            if (meta && "add" in meta) landed = [...landed, meta.add];
            if (meta && "expire" in meta) {
              const cut = meta.expire;
              landed = landed.filter((r) => r.at > cut);
            }
            if (meta && "marker" in meta) marker = meta.marker;
            return landed === prev.landed && marker === prev.marker ? prev : { landed, marker };
          },
        },
        props: {
          decorations(state: EditorState) {
            const s = dictationLandingKey.getState(state);
            if (!s || (s.landed.length === 0 && !s.marker)) return null;
            const now = Date.now();
            const decos = s.landed.map((r) =>
              Decoration.inline(r.from, r.to, { class: "cf-dictated", style: `animation-delay: -${String(Math.min(LANDED_MS, now - r.at))}ms` }),
            );
            if (s.marker) {
              decos.push(
                Decoration.widget(
                  state.selection.to,
                  () => {
                    const dot = document.createElement("span");
                    dot.className = "cf-dictation-marker";
                    dot.setAttribute("aria-hidden", "true");
                    dot.dataset.testid = "dictation-marker";
                    return dot;
                  },
                  { side: 1, key: "dictation-marker", ignoreSelection: true },
                ),
              );
            }
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

export function landedMeta(from: number, to: number, at: number): LandingMeta {
  return { add: { from, to, at } };
}

export function expireMeta(at: number): LandingMeta {
  return { expire: at };
}

export function markerMeta(on: boolean): LandingMeta {
  return { marker: on };
}
