import {
  button,
  buttons,
  type InteractiveInput,
  list,
} from "@photon-ai/whatsapp-business";
import type { Poll } from "@spectrum-ts/core";

const MAX_BUTTON_OPTIONS = 3;
const LIST_BUTTON_TEXT = "View options";
const LIST_SECTION_TITLE = "Options";

export const pollOptionId = (index: number): string => `opt_${index}`;

export const pollToInteractive = (content: Poll): InteractiveInput => {
  if (content.options.length <= MAX_BUTTON_OPTIONS) {
    return buttons(
      content.title,
      ...content.options.map((o, i) => button(pollOptionId(i), o.title))
    );
  }
  return list(content.title, LIST_BUTTON_TEXT).section(
    LIST_SECTION_TITLE,
    content.options.map((o, i) => ({ id: pollOptionId(i), title: o.title }))
  );
};
