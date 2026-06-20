"use client";

import type { RefObject } from "react";
import { useEditorContainerRef, usePluginOption } from "platejs/react";
import { YjsPlugin } from "@platejs/yjs/react";
import {
  useRemoteCursorOverlayPositions,
  type CursorOverlayData,
} from "@slate-yjs/react";

type CursorData = { name: string; color: string };

/** Remote selections + carets for collaborators.
 *
 * Rendered via the Yjs plugin's `render.afterEditable`, so it lives inside the
 * Slate context (required by `useRemoteCursorOverlayPositions`). Positions are
 * computed against the shared editor container (PlateContainer, which is
 * `position:relative`). Renders nothing until the doc has synced. */
export function RemoteCursorOverlay() {
  const isSynced = usePluginOption(YjsPlugin, "_isSynced");
  const containerRef = useEditorContainerRef();
  const [cursors] = useRemoteCursorOverlayPositions<CursorData>({
    containerRef: containerRef as RefObject<HTMLDivElement>,
  });

  if (!isSynced) return null;

  return (
    <>
      {cursors.map((cursor) => (
        <RemoteSelection key={cursor.clientId} cursor={cursor} />
      ))}
    </>
  );
}

function RemoteSelection({
  cursor,
}: {
  cursor: CursorOverlayData<CursorData>;
}) {
  const { data, selectionRects, caretPosition } = cursor;
  if (!data) return null;
  const color = data.color;

  return (
    <>
      {selectionRects.map((rect, i) => (
        <div
          key={i}
          className="pointer-events-none absolute z-10 rounded-[1px]"
          style={{
            backgroundColor: color,
            opacity: 0.3,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }}
        />
      ))}
      {caretPosition && (
        <div
          className="pointer-events-none absolute z-10 w-0.5"
          style={{
            backgroundColor: color,
            left: caretPosition.left,
            top: caretPosition.top,
            height: caretPosition.height,
          }}
        >
          <span
            className="absolute -top-5 left-0 whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-medium text-white"
            style={{ backgroundColor: color }}
          >
            {data.name}
          </span>
        </div>
      )}
    </>
  );
}
