/**
 * Internal Markdown ↔ Yjs/Plate encoder for wiki page bodies.
 *
 * The wiki body is a slate-yjs CRDT (the source of truth, owned by the live
 * collaborative editor). The Python backend can store and relay that binary
 * blob but cannot faithfully *construct* it — the encoding lives in JS
 * (`yjs` + `@slate-yjs/core`). Rather than duplicate those libraries into the
 * Python image, the backend's MCP write tools call this route, which reuses the
 * exact same versions the editor runs, guaranteeing byte-compatible CRDT
 * updates.
 *
 * This is an internal, server-to-server endpoint: it is gated by a shared
 * secret (`WIKI_ENCODE_SECRET`, mirroring the broadcast bridge secret) and is
 * never called from the browser.
 *
 * Operations:
 *   replace      — overwrite the whole body with the given Markdown.
 *   append       — add the Markdown's blocks after the existing content.
 *   insert       — insert the Markdown's blocks at top-level block `index`.
 *   to_markdown  — serialize a Plate value back to Markdown (for reads).
 */

import { NextResponse } from "next/server";
import * as Y from "yjs";
import { slateNodesToInsertDelta } from "@slate-yjs/core";

import { createWikiServerEditor } from "@/components/wiki/wiki-schema";

// yjs needs the Node runtime (Buffer, no edge constraints).
export const runtime = "nodejs";

type WriteOp = "replace" | "append" | "insert";
type SlateNode = Record<string, unknown>;

type EncodeRequest = {
  op: WriteOp | "to_markdown";
  /** Base64 of the current full CRDT state. Empty/absent = empty document. */
  stateB64?: string;
  /** Markdown source for write ops. */
  markdown?: string;
  /** Top-level block index for `insert` (clamped). Defaults to end. */
  index?: number;
  /** Plate value for `to_markdown`. */
  value?: SlateNode[];
};

function unauthorized() {
  return NextResponse.json({ detail: "Forbidden." }, { status: 403 });
}

/** Reconstruct a Plate value from a slate-yjs XmlText (mirrors the editor read). */
function xmlTextToSlate(xt: Y.XmlText): SlateNode {
  const delta = xt.toDelta() as Array<{
    insert: string | Y.XmlText;
    attributes?: Record<string, unknown>;
  }>;
  const children: SlateNode[] = delta.length
    ? delta.map((d) =>
        typeof d.insert === "string"
          ? { ...(d.attributes ?? {}), text: d.insert }
          : xmlTextToSlate(d.insert),
      )
    : [{ text: "" }];
  return { ...xt.getAttributes(), children };
}

function readBody(root: Y.XmlText): SlateNode[] {
  return (root.toDelta() as Array<{ insert: Y.XmlText }>).map((d) =>
    xmlTextToSlate(d.insert),
  );
}

export async function POST(request: Request) {
  const secret = process.env.WIKI_ENCODE_SECRET ?? "";
  if (secret) {
    const provided = request.headers.get("x-cyt-broadcast-secret") ?? "";
    if (provided !== secret) return unauthorized();
  }

  let body: EncodeRequest;
  try {
    body = (await request.json()) as EncodeRequest;
  } catch {
    return NextResponse.json({ detail: "Invalid JSON." }, { status: 400 });
  }

  const editor = createWikiServerEditor();

  // --- read path: Plate value -> Markdown -------------------------------------
  if (body.op === "to_markdown") {
    const value =
      Array.isArray(body.value) && body.value.length > 0
        ? body.value
        : [{ type: "p", children: [{ text: "" }] }];
    const markdown = editor.api.markdown.serialize({ value: value as never });
    return NextResponse.json({ markdown });
  }

  // --- write path: Markdown -> CRDT update ------------------------------------
  if (body.op !== "replace" && body.op !== "append" && body.op !== "insert") {
    return NextResponse.json({ detail: "Unknown op." }, { status: 400 });
  }

  const nodes = editor.api.markdown.deserialize(
    body.markdown ?? "",
  ) as SlateNode[];
  if (nodes.length === 0) {
    return NextResponse.json(
      { detail: "Markdown produced no content." },
      { status: 400 },
    );
  }

  const doc = new Y.Doc();
  if (body.stateB64) {
    Y.applyUpdate(doc, Buffer.from(body.stateB64, "base64"));
  }
  const root = doc.get("content", Y.XmlText);
  const beforeSV = Y.encodeStateVector(doc);
  const insertDelta = slateNodesToInsertDelta(nodes as never);

  if (body.op === "replace") {
    if (root.length > 0) root.delete(0, root.length);
    root.applyDelta(insertDelta, { sanitize: false });
  } else if (body.op === "append") {
    root.applyDelta([{ retain: root.length }, ...insertDelta], {
      sanitize: false,
    });
  } else {
    // insert at a top-level block index (each block occupies one unit).
    const at = Math.max(0, Math.min(body.index ?? root.length, root.length));
    root.applyDelta(at > 0 ? [{ retain: at }, ...insertDelta] : insertDelta, {
      sanitize: false,
    });
  }

  return NextResponse.json({
    // Incremental update relative to the input state — applied to the live room
    // so connected editors converge.
    diffB64: Buffer.from(Y.encodeStateAsUpdate(doc, beforeSV)).toString(
      "base64",
    ),
    // Full state — persisted to DocState.
    fullStateB64: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
    // Denormalized snapshot for read/search (matches the editor's snapshot).
    content: readBody(root),
  });
}
