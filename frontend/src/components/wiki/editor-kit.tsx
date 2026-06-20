"use client";

/**
 * Wiki editor plugin set + component map (open-source Plate, MIT).
 *
 * v1 scope: marks (bold/italic/underline/strikethrough/code), headings (1-3),
 * blockquote, horizontal rule, code blocks, links, tables, and images. The
 * Yjs collaboration plugin is composed on top in WikiEditor (it needs the
 * per-document room + cursor identity).
 */

import { KEYS } from "platejs";
import {
  BlockquotePlugin,
  BoldPlugin,
  CodePlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
  HorizontalRulePlugin,
  ItalicPlugin,
  StrikethroughPlugin,
  UnderlinePlugin,
} from "@platejs/basic-nodes/react";
import { LinkPlugin } from "@platejs/link/react";
import { CodeBlockPlugin } from "@platejs/code-block/react";
import { TablePlugin } from "@platejs/table/react";
import { ImagePlugin } from "@platejs/media/react";
import { SlashInputPlugin, SlashPlugin } from "@platejs/slash-command/react";

import {
  BlockquoteElement,
  BoldLeaf,
  CodeBlockElement,
  CodeLeaf,
  CodeLineElement,
  H1Element,
  H2Element,
  H3Element,
  HrElement,
  ImageElement,
  ItalicLeaf,
  LinkElement,
  ParagraphElement,
  StrikethroughLeaf,
  TableCellElement,
  TableCellHeaderElement,
  TableElement,
  TableRowElement,
  UnderlineLeaf,
} from "./nodes";
import { SlashInputElement } from "./slash-node";
import {
  WIKI_LINK,
  WIKI_LINK_INPUT,
  WikiLinkPlugin,
} from "./wiki-link-plugin";
import { WikiLinkElement, WikiLinkInputElement } from "./wiki-link-nodes";

/** Behaviour plugins (schema / transforms / normalization). */
export const wikiBasePlugins = [
  H1Plugin,
  H2Plugin,
  H3Plugin,
  BlockquotePlugin,
  HorizontalRulePlugin,
  BoldPlugin,
  ItalicPlugin,
  UnderlinePlugin,
  StrikethroughPlugin,
  CodePlugin,
  LinkPlugin,
  CodeBlockPlugin,
  TablePlugin,
  ImagePlugin,
  WikiLinkPlugin,
  SlashPlugin.configure({
    options: {
      trigger: "/",
      triggerPreviousCharPattern: /^\s?$/,
      triggerQuery: (editor) =>
        !editor.api.some({
          match: { type: editor.getType(KEYS.codeBlock) },
        }),
    },
  }),
  SlashInputPlugin.withComponent(SlashInputElement),
];

/** Node-type → render component. */
export const wikiComponents = {
  [KEYS.p]: ParagraphElement,
  [KEYS.h1]: H1Element,
  [KEYS.h2]: H2Element,
  [KEYS.h3]: H3Element,
  [KEYS.blockquote]: BlockquoteElement,
  [KEYS.hr]: HrElement,
  [KEYS.codeBlock]: CodeBlockElement,
  [KEYS.codeLine]: CodeLineElement,
  [KEYS.a]: LinkElement,
  [KEYS.table]: TableElement,
  [KEYS.tr]: TableRowElement,
  [KEYS.td]: TableCellElement,
  [KEYS.th]: TableCellHeaderElement,
  [KEYS.img]: ImageElement,
  [KEYS.bold]: BoldLeaf,
  [KEYS.italic]: ItalicLeaf,
  [KEYS.underline]: UnderlineLeaf,
  [KEYS.strikethrough]: StrikethroughLeaf,
  [KEYS.code]: CodeLeaf,
  [WIKI_LINK]: WikiLinkElement,
  [WIKI_LINK_INPUT]: WikiLinkInputElement,
};
