"use client";

// Inline "link to another wiki page" — a custom inline-void element built on
// the @platejs/mention pattern (createTSlatePlugin + a sibling combobox-input
// element + withTriggerCombobox). Triggered by typing "[".

import { createSlatePlugin, createTSlatePlugin, type TElement } from "platejs";
import { withTriggerCombobox } from "@platejs/combobox";

export const WIKI_LINK = "wiki_link";
export const WIKI_LINK_INPUT = "wiki_link_input";

export interface TWikiLinkElement extends TElement {
  type: typeof WIKI_LINK;
  pageKey: string;
  title: string;
}

/** The combobox-trigger input element (mirror of KEYS.mentionInput). */
export const WikiLinkInputPlugin = createSlatePlugin({
  key: WIKI_LINK_INPUT,
  node: { isElement: true, isInline: true, isVoid: true },
});

/** The chip element + the "[" trigger behaviour (mirror of BaseMentionPlugin). */
export const WikiLinkPlugin = createTSlatePlugin({
  key: WIKI_LINK,
  node: {
    isElement: true,
    isInline: true,
    isVoid: true,
    isMarkableVoid: true,
  },
  options: {
    trigger: "[",
    // Fire only at line start or after whitespace, so "arr[0]" never triggers.
    triggerPreviousCharPattern: /^\s?$/,
    createComboboxInput: (trigger: string) => ({
      children: [{ text: "" }],
      trigger,
      type: WIKI_LINK_INPUT,
    }),
  },
  plugins: [WikiLinkInputPlugin],
})
  .extendEditorTransforms(({ editor, type }) => ({
    insert: {
      wikiLink: ({ pageKey, title }: { pageKey: string; title: string }) => {
        editor.tf.insertNodes<TWikiLinkElement>({
          type: type as typeof WIKI_LINK,
          pageKey,
          title,
          children: [{ text: "" }],
        });
      },
    },
  }))
  .overrideEditor(withTriggerCombobox as never);
