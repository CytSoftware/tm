"use client";

/**
 * Render components for wiki node types. Thin wrappers over PlateElement /
 * PlateLeaf with Tailwind classes matching the app theme. Behaviour (schema,
 * transforms, normalization) comes from the plugins; these only paint.
 */

import {
  PlateElement,
  PlateLeaf,
  type PlateElementProps,
  type PlateLeafProps,
} from "platejs/react";

// ── Blocks ────────────────────────────────────────────────────────────────

export function ParagraphElement(props: PlateElementProps) {
  return <PlateElement {...props} className="my-1 leading-7" />;
}

export function H1Element(props: PlateElementProps) {
  return (
    <PlateElement
      {...props}
      as="h1"
      className="mt-6 mb-2 text-3xl font-semibold tracking-tight"
    />
  );
}

export function H2Element(props: PlateElementProps) {
  return (
    <PlateElement
      {...props}
      as="h2"
      className="mt-5 mb-2 text-2xl font-semibold tracking-tight"
    />
  );
}

export function H3Element(props: PlateElementProps) {
  return (
    <PlateElement
      {...props}
      as="h3"
      className="mt-4 mb-1 text-xl font-semibold tracking-tight"
    />
  );
}

export function BlockquoteElement(props: PlateElementProps) {
  return (
    <PlateElement
      {...props}
      as="blockquote"
      className="my-2 border-l-2 border-border pl-4 italic text-muted-foreground"
    />
  );
}

export function HrElement(props: PlateElementProps) {
  return (
    <PlateElement {...props} className="py-2">
      <div contentEditable={false}>
        <hr className="border-border" />
      </div>
      {props.children}
    </PlateElement>
  );
}

export function CodeBlockElement(props: PlateElementProps) {
  return (
    <PlateElement
      {...props}
      as="pre"
      className="my-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-[13px] leading-6"
    >
      <code>{props.children}</code>
    </PlateElement>
  );
}

export function CodeLineElement(props: PlateElementProps) {
  return <PlateElement {...props} />;
}

// ── Lists (classic ul / ol / li / lic) ──────────────────────────────────────

export function BulletedListElement(props: PlateElementProps) {
  return (
    <PlateElement
      {...props}
      as="ul"
      className="my-1 list-disc pl-6 marker:text-muted-foreground [&_ul]:list-[circle] [&_ul_ul]:list-[square]"
    />
  );
}

export function NumberedListElement(props: PlateElementProps) {
  return (
    <PlateElement
      {...props}
      as="ol"
      className="my-1 list-decimal pl-6 marker:text-muted-foreground"
    />
  );
}

export function ListItemElement(props: PlateElementProps) {
  return <PlateElement {...props} as="li" className="leading-7" />;
}

export function ListItemContentElement(props: PlateElementProps) {
  // The text content of a list item (sits inside <li>, before any nested list).
  return <PlateElement {...props} />;
}

// ── Tables ──────────────────────────────────────────────────────────────────

export function TableElement(props: PlateElementProps) {
  return (
    <PlateElement {...props} className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <tbody>{props.children}</tbody>
      </table>
    </PlateElement>
  );
}

export function TableRowElement(props: PlateElementProps) {
  return <PlateElement {...props} as="tr" />;
}

export function TableCellElement(props: PlateElementProps) {
  return (
    <PlateElement
      {...props}
      as="td"
      className="min-w-24 border border-border p-2 align-top"
    />
  );
}

export function TableCellHeaderElement(props: PlateElementProps) {
  return (
    <PlateElement
      {...props}
      as="th"
      className="min-w-24 border border-border bg-muted p-2 text-left font-medium align-top"
    />
  );
}

// ── Media ───────────────────────────────────────────────────────────────────

export function ImageElement(props: PlateElementProps) {
  const url = (props.element as { url?: string }).url ?? "";
  return (
    <PlateElement {...props} className="my-2">
      <div contentEditable={false}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt=""
          className="max-w-full rounded-md border border-border"
        />
      </div>
      {props.children}
    </PlateElement>
  );
}

// ── Inline ──────────────────────────────────────────────────────────────────

export function LinkElement(props: PlateElementProps) {
  const url = (props.element as { url?: string }).url ?? "";
  return (
    <PlateElement
      {...props}
      as="a"
      className="font-medium text-primary underline underline-offset-2"
      attributes={{
        ...props.attributes,
        href: url,
        target: "_blank",
        rel: "noopener noreferrer",
      }}
    />
  );
}

// ── Marks (leaves) ──────────────────────────────────────────────────────────

export function BoldLeaf(props: PlateLeafProps) {
  return <PlateLeaf {...props} as="strong" />;
}

export function ItalicLeaf(props: PlateLeafProps) {
  return <PlateLeaf {...props} as="em" />;
}

export function UnderlineLeaf(props: PlateLeafProps) {
  return <PlateLeaf {...props} as="u" />;
}

export function StrikethroughLeaf(props: PlateLeafProps) {
  return <PlateLeaf {...props} as="s" />;
}

export function CodeLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      {...props}
      as="code"
      className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
    />
  );
}
