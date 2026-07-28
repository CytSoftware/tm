"use client";

import { useEditorRef, useEditorSelector } from "platejs/react";
import { KEYS } from "platejs";
import {
  deleteColumn,
  deleteRow,
  getTableAbove,
  insertTable,
  insertTableColumn,
  insertTableRow,
} from "@platejs/table";
import { insertImage } from "@platejs/media";
import { toggleBulletedList, toggleNumberedList } from "@platejs/list-classic";
import {
  BetweenHorizontalEnd,
  BetweenVerticalEnd,
  Bold,
  Code,
  Columns3,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  Rows3,
  Strikethrough,
  Table as TableIcon,
  Underline,
} from "lucide-react";

import { uploadImage } from "@/lib/api";

function ToolbarButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-border" />;
}

export function WikiToolbar() {
  const editor = useEditorRef();

  const toggleMark = (key: string) => editor.tf.toggleMark(key);
  const toggleBlock = (type: string) => editor.tf.toggleBlock(type);

  const onImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const { url } = await uploadImage(file);
        insertImage(editor, url);
      } catch {
        // upload failed — ignore for v1
      }
    };
    input.click();
  };

  const onLink = () => {
    const url = window.prompt("Link URL");
    if (!url) return;
    editor.tf.insertNodes({
      type: KEYS.a,
      url,
      children: [{ text: url }],
    });
  };

  return (
    <div className="sticky top-0 z-20 flex shrink-0 items-center gap-0.5 overflow-x-auto scrollbar-none border-b border-border bg-background/80 px-3 py-1.5 backdrop-blur">
      <ToolbarButton title="Bold" onClick={() => toggleMark(KEYS.bold)}>
        <Bold className="size-4" />
      </ToolbarButton>
      <ToolbarButton title="Italic" onClick={() => toggleMark(KEYS.italic)}>
        <Italic className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        title="Underline"
        onClick={() => toggleMark(KEYS.underline)}
      >
        <Underline className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        title="Strikethrough"
        onClick={() => toggleMark(KEYS.strikethrough)}
      >
        <Strikethrough className="size-4" />
      </ToolbarButton>
      <ToolbarButton title="Inline code" onClick={() => toggleMark(KEYS.code)}>
        <Code className="size-4" />
      </ToolbarButton>

      <Divider />

      <ToolbarButton title="Heading 1" onClick={() => toggleBlock(KEYS.h1)}>
        <Heading1 className="size-4" />
      </ToolbarButton>
      <ToolbarButton title="Heading 2" onClick={() => toggleBlock(KEYS.h2)}>
        <Heading2 className="size-4" />
      </ToolbarButton>
      <ToolbarButton title="Heading 3" onClick={() => toggleBlock(KEYS.h3)}>
        <Heading3 className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        title="Quote"
        onClick={() => toggleBlock(KEYS.blockquote)}
      >
        <Quote className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        title="Code block"
        onClick={() => toggleBlock(KEYS.codeBlock)}
      >
        <Code className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        title="Bulleted list"
        onClick={() => toggleBulletedList(editor)}
      >
        <List className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        title="Numbered list"
        onClick={() => toggleNumberedList(editor)}
      >
        <ListOrdered className="size-4" />
      </ToolbarButton>

      <Divider />

      <ToolbarButton title="Link" onClick={onLink}>
        <Link2 className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        title="Table"
        onClick={() => insertTable(editor, { rowCount: 3, colCount: 3 })}
      >
        <TableIcon className="size-4" />
      </ToolbarButton>
      <ToolbarButton title="Image" onClick={onImage}>
        <ImageIcon className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        title="Divider"
        onClick={() => editor.tf.insertNodes({ type: KEYS.hr, children: [{ text: "" }] })}
      >
        <Minus className="size-4" />
      </ToolbarButton>

      <TableControls />
    </div>
  );
}

/** Row/column controls — only shown while the cursor is inside a table. */
function TableControls() {
  const editor = useEditorRef();
  const inTable = useEditorSelector(
    (ed) => Boolean(getTableAbove(ed)),
    [],
  );

  if (!inTable) return null;

  return (
    <>
      <Divider />
      <ToolbarButton
        title="Insert row below"
        onClick={() => insertTableRow(editor)}
      >
        <BetweenHorizontalEnd className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        title="Insert column right"
        onClick={() => insertTableColumn(editor)}
      >
        <BetweenVerticalEnd className="size-4" />
      </ToolbarButton>
      <ToolbarButton title="Delete row" onClick={() => deleteRow(editor)}>
        <Rows3 className="size-4" />
      </ToolbarButton>
      <ToolbarButton title="Delete column" onClick={() => deleteColumn(editor)}>
        <Columns3 className="size-4" />
      </ToolbarButton>
    </>
  );
}
