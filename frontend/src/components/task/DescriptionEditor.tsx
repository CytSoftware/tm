"use client";

import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import LinkExtension from "@tiptap/extension-link";
import ImageExtension from "@tiptap/extension-image";
import { mergeAttributes } from "@tiptap/core";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";

declare module "@tiptap/core" {
  interface Storage {
    markdown: MarkdownStorage;
  }
}
import {
  Bold,
  Italic,
  Strikethrough,
  Heading2,
  List,
  ListOrdered,
  Link,
  Code,
  Undo,
  Redo,
  Paperclip,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { uploadFile } from "@/lib/api";

const VIDEO_SRC = /\.(mp4|webm|mov|m4v|ogv)$/i;

/** True when the URL path (ignoring query and hash) names a video file. */
function isVideoSrc(src: unknown): boolean {
  return typeof src === "string" && VIDEO_SRC.test(src.split(/[?#]/)[0]);
}

type MarkdownState = {
  write: (text: string) => void;
  esc: (text: string) => string;
  closeBlock: (node: unknown) => void;
};

// Markdown has no video syntax and tiptap-markdown runs with `html: false`,
// so a video is stored as image markdown (`![name.webm](url)`) and only
// rendered as a player. It stays an "image" node, so the markdown is the same
// for both and Mowafeq (or anyone) can write it.
const MediaExtension = ImageExtension.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        // tiptap-markdown's default writes images as inline text, so two
        // block images (or an image and the next paragraph) were glued onto
        // one line on save. Close the block: one `![alt](src)` per line.
        serialize(state: MarkdownState, node: { attrs: Record<string, string | null> }) {
          const { alt, src, title } = node.attrs;
          const dest = (src ?? "").replace(/[()]/g, "\\$&");
          const suffix = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
          state.write(`![${state.esc(alt ?? "")}](${dest}${suffix})`);
          state.closeBlock(node);
        },
      },
    };
  },
  parseHTML() {
    return [...(this.parent?.() ?? []), { tag: "video[src]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    if (isVideoSrc(node.attrs.src)) {
      return [
        "video",
        mergeAttributes({
          src: node.attrs.src,
          controls: "true",
          preload: "metadata",
          class: "max-w-full rounded",
          "aria-label": node.attrs.alt ?? undefined,
        }),
      ];
    }
    return this.parent?.({ node, HTMLAttributes }) ?? ["img", HTMLAttributes];
  },
  addNodeView() {
    const parentView = this.parent?.();
    const baseAttributes = this.options.HTMLAttributes;
    return (props) => {
      if (!isVideoSrc(props.node.attrs.src)) {
        return parentView
          ? parentView(props)
          : renderStatic(mergeAttributes(baseAttributes, props.HTMLAttributes));
      }
      const video = document.createElement("video");
      video.src = props.node.attrs.src;
      video.controls = true;
      video.preload = "metadata";
      video.className = "max-w-full rounded";
      if (props.node.attrs.alt) video.setAttribute("aria-label", props.node.attrs.alt);
      return {
        dom: video,
        // Hand pointer and keyboard events on the player to the browser, so
        // play, scrub and volume work instead of starting a node drag.
        stopEvent: () => true,
        ignoreMutation: () => true,
      };
    };
  },
});

function renderStatic(attrs: Record<string, unknown>) {
  const img = document.createElement("img");
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) img.setAttribute(key, String(value));
  }
  return { dom: img };
}

type Props = {
  value: string;
  onChange: (markdown: string) => void;
  onSubmit?: () => void;
};

export function DescriptionEditor({ value, onChange, onSubmit }: Props) {
  const isInternalUpdate = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Held in a ref so the editor's paste/drop callbacks (captured once on
  // mount) always see the latest uploader without re-instantiating the
  // editor on every render.
  const insertFilesRef = useRef<((files: File[]) => Promise<void>) | null>(
    null,
  );
  const onSubmitRef = useRef<typeof onSubmit>(onSubmit);
  onSubmitRef.current = onSubmit;

  const editor = useEditor({
    extensions: [
      StarterKit,
      LinkExtension.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: "Write details..." }),
      MediaExtension.configure({
        inline: false,
        allowBase64: true,
        HTMLAttributes: {
          class: "max-w-full h-auto rounded cursor-zoom-in",
        },
      }),
      Markdown.configure({
        html: false,
        linkify: true,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: value || "",
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => {
      isInternalUpdate.current = true;
      onChange(e.storage.markdown.getMarkdown());
    },
    editorProps: {
      attributes: {
        class:
          "prose prose-sm max-w-none dark:prose-invert min-h-[200px] p-3 focus-visible:outline-none",
      },
      handlePaste: (_view, event) => {
        const files = filesFromClipboard(event.clipboardData);
        if (files.length === 0) return false;
        event.preventDefault();
        void insertFilesRef.current?.(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = filesFromDataTransfer(
          (event as DragEvent).dataTransfer,
        );
        if (files.length === 0) return false;
        event.preventDefault();
        void insertFilesRef.current?.(files);
        return true;
      },
      handleKeyDown: (_view, event) => {
        if (
          onSubmitRef.current &&
          (event.metaKey || event.ctrlKey) &&
          event.key === "Enter"
        ) {
          event.preventDefault();
          event.stopPropagation();
          onSubmitRef.current?.();
          return true;
        }
        return false;
      },
      handleDoubleClickOn: (_view, _pos, node) => {
        if (node.type.name === "image" && !isVideoSrc(node.attrs.src)) {
          const src = node.attrs.src as string | undefined;
          if (src) window.open(src, "_blank", "noopener,noreferrer");
          return true;
        }
        return false;
      },
    },
  });

  useEffect(() => {
    if (!editor) {
      insertFilesRef.current = null;
      return;
    }
    insertFilesRef.current = (files) => uploadAndInsert(editor, files);
  }, [editor]);

  async function uploadAndInsert(ed: Editor, files: File[]) {
    setUploadError(null);
    setUploading(true);
    try {
      for (const file of files) {
        const { url, name, content_type } = await uploadFile(file);
        const content =
          isVideoSrc(url) || content_type.startsWith("image/")
            ? { type: "image", attrs: { src: url, alt: name } }
            : {
                type: "paragraph",
                content: [
                  { type: "text", text: name, marks: [{ type: "link", attrs: { href: url } }] },
                ],
              };
        // An inserted image is left selected; inserting over that selection
        // would replace it, so the next file of a multi-file drop goes after.
        const { selection } = ed.state;
        if ("node" in selection) {
          ed.chain().focus().insertContentAt(selection.to, content).run();
        } else {
          ed.chain().focus().insertContent(content).run();
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed.";
      setUploadError(msg);
    } finally {
      setUploading(false);
    }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    // Reset so picking the same file twice still fires `onChange`.
    e.target.value = "";
    if (picked.length === 0 || !editor) return;
    void uploadAndInsert(editor, picked);
  }

  // Sync external value changes into the editor (e.g. when opening a task
  // with existing description). Skip if the change originated from typing.
  // Both sides are markdown strings — tiptap-markdown parses on setContent.
  useEffect(() => {
    if (!editor) return;
    if (isInternalUpdate.current) {
      isInternalUpdate.current = false;
      return;
    }
    const current = editor.storage.markdown.getMarkdown();
    if (current.trim() !== (value ?? "").trim()) {
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
  }, [value, editor]);

  if (!editor) return null;

  return (
    <div className="h-full flex flex-col rounded-md border border-border/80 overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-0.5 overflow-x-auto scrollbar-none px-2 py-1.5 border-b border-border/60 bg-muted/30">
        <ToolbarButton
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Bold"
        >
          <Bold className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italic"
        >
          <Italic className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("strike")}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          title="Strikethrough"
        >
          <Strikethrough className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("code")}
          onClick={() => editor.chain().focus().toggleCode().run()}
          title="Inline code"
        >
          <Code className="size-3.5" />
        </ToolbarButton>
        <div className="w-px h-4 shrink-0 bg-border mx-1" />
        <ToolbarButton
          active={editor.isActive("heading", { level: 2 })}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 2 }).run()
          }
          title="Heading"
        >
          <Heading2 className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="Bullet list"
        >
          <List className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="Numbered list"
        >
          <ListOrdered className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("link")}
          onClick={() => {
            if (editor.isActive("link")) {
              editor.chain().focus().unsetLink().run();
              return;
            }
            const url = window.prompt("URL");
            if (url) {
              editor
                .chain()
                .focus()
                .extendMarkRange("link")
                .setLink({ href: url })
                .run();
            }
          }}
          title="Link"
        >
          <Link className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          title="Upload file (or paste / drop into editor)"
        >
          {uploading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Paperclip className="size-3.5" />
          )}
        </ToolbarButton>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onPickFile}
        />
        <div className="w-px h-4 shrink-0 bg-border mx-1" />
        <ToolbarButton
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
          title="Undo"
        >
          <Undo className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
          title="Redo"
        >
          <Redo className="size-3.5" />
        </ToolbarButton>
      </div>
      {/* Editor */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>
      {uploadError && (
        <div className="shrink-0 px-3 py-1.5 text-[11px] text-destructive border-t border-destructive/30 bg-destructive/5 flex items-center justify-between gap-2">
          <span className="truncate">{uploadError}</span>
          <button
            type="button"
            className="text-[10px] uppercase tracking-wide hover:underline"
            onClick={() => setUploadError(null)}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) out.push(file);
    }
  }
  return out;
}

function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files);
}

function ToolbarButton({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "size-7 shrink-0 grid place-items-center rounded transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        disabled && "opacity-30 pointer-events-none",
      )}
    >
      {children}
    </button>
  );
}
