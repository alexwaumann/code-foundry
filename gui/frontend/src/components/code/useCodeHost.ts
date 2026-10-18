import { useLayoutEffect, useRef } from "react";
import { DIFFS_TAG_NAME } from "@pierre/diffs";

/**
 * A ref for the element around a @pierre/diffs component that empties the component's
 * shadow root when it detaches. The library (1.5.2) leaves its <pre> there on cleanUp; a
 * re-attach to the same element (React StrictMode's double mount, in development and e2e)
 * takes that empty <pre> for prerendered HTML and, with disableFileHeader, never renders.
 */
export function useCodeHost() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    return () => {
      host?.querySelector(DIFFS_TAG_NAME)?.shadowRoot?.replaceChildren();
    };
  }, []);
  return ref;
}
