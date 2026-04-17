import { text } from "./text";
import type { Content, ContentInput } from "./types";

export const resolveContents = (
  items: readonly ContentInput[]
): Promise<Content[]> =>
  Promise.all(
    items.map((c) => (typeof c === "string" ? text(c).build() : c.build()))
  );
