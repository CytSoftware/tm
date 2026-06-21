/**
 * Headless wiki schema — the *behaviour* plugins, with NO React components.
 *
 * The interactive editor (WikiEditor / editor-kit.tsx) is a `"use client"`
 * module that pulls in React render components. The server-side Markdown↔Plate
 * encoder (`/api/wiki/encode`) must run in a plain Node context, so it needs the
 * same node *schema* (types, normalization) without any of the rendering. These
 * base (non-`/react`) plugins register the identical node types the editor uses
 * — `h1/h2/h3`, `p`, `blockquote`, `hr`, `code_block/code_line`, classic lists
 * (`ul/ol/li/lic`), `a`, `table/tr/td/th`, `img`, and the inline marks — so the
 * Plate value we build here is byte-identical to what the browser produces.
 *
 * Keep this list in sync with `wikiBasePlugins` in editor-kit.tsx.
 */

import { createSlateEditor } from "platejs";
import {
  BaseBlockquotePlugin,
  BaseBoldPlugin,
  BaseCodePlugin,
  BaseH1Plugin,
  BaseH2Plugin,
  BaseH3Plugin,
  BaseHorizontalRulePlugin,
  BaseItalicPlugin,
  BaseStrikethroughPlugin,
  BaseUnderlinePlugin,
} from "@platejs/basic-nodes";
import { BaseLinkPlugin } from "@platejs/link";
import { BaseCodeBlockPlugin } from "@platejs/code-block";
import { BaseTablePlugin } from "@platejs/table";
import { BaseImagePlugin } from "@platejs/media";
import {
  BaseBulletedListPlugin,
  BaseListItemContentPlugin,
  BaseListItemPlugin,
  BaseNumberedListPlugin,
} from "@platejs/list-classic";
import { MarkdownPlugin } from "@platejs/markdown";
import remarkGfm from "remark-gfm";

/** Behaviour plugins (schema only) + Markdown (GFM: tables, strikethrough). */
export const wikiHeadlessPlugins = [
  BaseH1Plugin,
  BaseH2Plugin,
  BaseH3Plugin,
  BaseBlockquotePlugin,
  BaseHorizontalRulePlugin,
  BaseBoldPlugin,
  BaseItalicPlugin,
  BaseUnderlinePlugin,
  BaseStrikethroughPlugin,
  BaseCodePlugin,
  BaseLinkPlugin,
  BaseCodeBlockPlugin,
  BaseTablePlugin,
  BaseImagePlugin,
  // Classic lists (ul/ol/li/lic). The Markdown plugin emits classic-list nodes
  // when the indent `list` plugin is absent — which it is here, by design.
  BaseBulletedListPlugin,
  BaseNumberedListPlugin,
  BaseListItemPlugin,
  BaseListItemContentPlugin,
  MarkdownPlugin.configure({ options: { remarkPlugins: [remarkGfm] } }),
];

/** A fresh headless editor carrying the wiki node schema + Markdown API. */
export function createWikiServerEditor() {
  return createSlateEditor({ plugins: wikiHeadlessPlugins });
}
