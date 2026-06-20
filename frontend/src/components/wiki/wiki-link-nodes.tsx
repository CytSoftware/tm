"use client";

import * as React from "react";
import {
  PlateElement,
  useFocused,
  useReadOnly,
  useSelected,
  type PlateEditor,
  type PlateElementProps,
} from "platejs/react";

import { cn } from "@/lib/utils";
import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxInput,
  InlineComboboxItem,
} from "@/components/ui/inline-combobox";
import { useWikiNav, type WikiPageRef } from "./wiki-nav-context";
import type { TWikiLinkElement } from "./wiki-link-plugin";

// ── The clickable chip ──────────────────────────────────────────────────────

export function WikiLinkElement(props: PlateElementProps<TWikiLinkElement>) {
  const { element } = props;
  const selected = useSelected();
  const focused = useFocused();
  const readOnly = useReadOnly();
  const { onNavigate, pages } = useWikiNav();

  // Resolve the live title from the tree (handles renames); fall back to stored.
  const title =
    pages.find((p) => p.key === element.pageKey)?.title ?? element.title;

  return (
    <PlateElement
      {...props}
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5",
        "align-baseline text-sm font-medium text-primary",
        "transition-colors hover:bg-primary/20",
        !readOnly && "cursor-pointer",
        selected && focused && "ring-2 ring-ring",
      )}
      attributes={{
        ...props.attributes,
        contentEditable: false,
        draggable: true,
        "data-wiki-page": element.pageKey,
      }}
    >
      <span
        role="link"
        tabIndex={0}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onNavigate(element.pageKey);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onNavigate(element.pageKey);
          }
        }}
      >
        <span aria-hidden className="opacity-60">
          ↗
        </span>{" "}
        {title}
      </span>
      {props.children}
    </PlateElement>
  );
}

// ── Insert helper (replaces getMentionOnSelectItem) ─────────────────────────

function insertWikiLink(editor: PlateEditor, page: WikiPageRef) {
  (
    editor.tf as unknown as {
      insert: { wikiLink: (a: { pageKey: string; title: string }) => void };
    }
  ).insert.wikiLink({ pageKey: page.key, title: page.title });
  editor.tf.move({ unit: "offset" }); // move caret past the void chip
}

// ── The combobox input element (dynamic items from context) ─────────────────

export function WikiLinkInputElement(props: PlateElementProps) {
  const { editor, element } = props;
  const [search, setSearch] = React.useState("");
  const { pages } = useWikiNav();

  return (
    <PlateElement {...props} as="span">
      <InlineCombobox
        value={search}
        element={element}
        setValue={setSearch}
        showTrigger={false}
        trigger="["
      >
        <span className="inline-block rounded-md bg-muted px-1.5 py-0.5 align-baseline text-sm ring-ring focus-within:ring-2">
          <InlineComboboxInput />
        </span>

        <InlineComboboxContent className="my-1.5">
          <InlineComboboxEmpty>No pages found</InlineComboboxEmpty>

          <InlineComboboxGroup>
            {pages.map((page) => (
              <InlineComboboxItem
                key={page.key}
                value={page.title}
                keywords={[page.key]}
                onClick={() => insertWikiLink(editor, page)}
              >
                <span className="mr-1 opacity-60">↗</span>
                {page.title}
                <span className="ml-auto text-xs text-muted-foreground">
                  {page.key}
                </span>
              </InlineComboboxItem>
            ))}
          </InlineComboboxGroup>
        </InlineComboboxContent>
      </InlineCombobox>

      {props.children}
    </PlateElement>
  );
}
