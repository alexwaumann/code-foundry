import { timestampMs, type Timestamp } from "@bufbuild/protobuf/wkt";

/** A proto timestamp as epoch milliseconds; null when it is unset. */
export function ms(t: Timestamp | undefined): number | null {
  return t ? timestampMs(t) : null;
}
