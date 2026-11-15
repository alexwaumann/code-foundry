import { ImageBody } from "../ImageBody";
import { imageMeta } from "../meta";
import type { PreviewKind } from "../types";

/** A raster image (any image/* the webview decodes): the picture alone, no switch. SVG is svg.tsx's. */
const image: PreviewKind = {
  id: "image",
  match: { mime: ["image/*"] },
  shows: (f) => f.image !== null,
  modes: [{ id: "image", label: "Image" }],
  Body: ImageBody,
  meta: (f) => imageMeta(f),
  edit: false,
  tooLarge: "Image",
};

export default image;
