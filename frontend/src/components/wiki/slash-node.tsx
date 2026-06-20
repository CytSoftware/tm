"use client";

// The "/" slash menu. Trimmed from the Plate registry slash-node to this
// wiki's blocks, wired directly to editor transforms. Renders via
// SlashInputPlugin.withComponent (registered under KEYS.slashInput).

import * as React from "react";
import { KEYS, type TComboboxInputElement } from "platejs";
import {
  PlateElement,
  type PlateEditor,
  type PlateElementProps,
} from "platejs/react";
import { insertTable } from "@platejs/table";
import { insertImage } from "@platejs/media";
import {
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Link2,
  Minus,
  Quote,
  Table as TableIcon,
} from "lucide-react";

import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxGroupLabel,
  InlineComboboxInput,
  InlineComboboxItem,
} from "@/components/ui/inline-combobox";
import { WIKI_LINK_INPUT } from "./wiki-link-plugin";

type SlashItem = {
  icon: React.ReactNode;
  label: string;
  value: string;
  keywords?: string[];
  onSelect: (editor: PlateEditor) => void;
  /** Keep editor focus off after select (so a follow-up combobox can hold it). */
  focusEditor?: boolean;
};

const groups: { group: string; items: SlashItem[] }[] = [
  {
    group: "Basic blocks",
    items: [
      {
        icon: <Heading1 />,
        label: "Heading 1",
        value: KEYS.h1,
        keywords: ["title", "h1"],
        onSelect: (editor) => editor.tf.toggleBlock(KEYS.h1),
      },
      {
        icon: <Heading2 />,
        label: "Heading 2",
        value: KEYS.h2,
        keywords: ["subtitle", "h2"],
        onSelect: (editor) => editor.tf.toggleBlock(KEYS.h2),
      },
      {
        icon: <Heading3 />,
        label: "Heading 3",
        value: KEYS.h3,
        keywords: ["subtitle", "h3"],
        onSelect: (editor) => editor.tf.toggleBlock(KEYS.h3),
      },
      {
        icon: <Quote />,
        label: "Quote",
        value: KEYS.blockquote,
        keywords: ["quote", "citation", ">"],
        onSelect: (editor) => editor.tf.toggleBlock(KEYS.blockquote),
      },
      {
        icon: <Code />,
        label: "Code block",
        value: KEYS.codeBlock,
        keywords: ["```", "snippet"],
        onSelect: (editor) =>
          editor.tf.insertNodes(
            {
              type: KEYS.codeBlock,
              children: [{ type: KEYS.codeLine, children: [{ text: "" }] }],
            },
            { select: true },
          ),
      },
    ],
  },
  {
    group: "Insert",
    items: [
      {
        icon: <TableIcon />,
        label: "Table",
        value: KEYS.table,
        keywords: ["grid"],
        onSelect: (editor) =>
          insertTable(editor, { rowCount: 3, colCount: 3 }, { select: true }),
      },
      {
        icon: <ImageIcon />,
        label: "Image",
        value: KEYS.img,
        keywords: ["picture", "photo", "media"],
        onSelect: (editor) => {
          const url = window.prompt("Image URL");
          if (url) insertImage(editor, url, { select: true });
        },
      },
      {
        icon: <Minus />,
        label: "Divider",
        value: KEYS.hr,
        keywords: ["horizontal rule", "hr", "line", "---"],
        onSelect: (editor) =>
          editor.tf.insertNodes(
            { type: KEYS.hr, children: [{ text: "" }] },
            { select: true },
          ),
      },
      {
        icon: <Link2 />,
        label: "Link to page",
        value: "wiki-page-link",
        keywords: ["page", "reference", "mention", "wiki"],
        // Don't refocus the editor — let the inserted page-picker hold focus.
        focusEditor: false,
        onSelect: (editor) =>
          editor.tf.insertNodes(
            { type: WIKI_LINK_INPUT, trigger: "[", children: [{ text: "" }] },
            { select: true },
          ),
      },
    ],
  },
];

export function SlashInputElement(
  props: PlateElementProps<TComboboxInputElement>,
) {
  const { editor, element } = props;
  return (
    <PlateElement {...props} as="span">
      <InlineCombobox element={element} trigger="/">
        <InlineComboboxInput />
        <InlineComboboxContent>
          <InlineComboboxEmpty>No results</InlineComboboxEmpty>
          {groups.map(({ group, items }) => (
            <InlineComboboxGroup key={group}>
              <InlineComboboxGroupLabel>{group}</InlineComboboxGroupLabel>
              {items.map(
                ({ icon, label, value, keywords, onSelect, focusEditor }) => (
                  <InlineComboboxItem
                    key={value}
                    value={value}
                    label={label}
                    group={group}
                    keywords={keywords}
                    focusEditor={focusEditor ?? true}
                    onClick={() => onSelect(editor)}
                  >
                    <div className="mr-2 text-muted-foreground">{icon}</div>
                    {label}
                  </InlineComboboxItem>
                ),
              )}
            </InlineComboboxGroup>
          ))}
        </InlineComboboxContent>
      </InlineCombobox>
      {props.children}
    </PlateElement>
  );
}
