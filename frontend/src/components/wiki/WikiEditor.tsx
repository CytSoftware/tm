"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Plate,
  PlateContainer,
  PlateContent,
  usePlateEditor,
  usePluginOption,
} from "platejs/react";
import { YjsPlugin } from "@platejs/yjs/react";
import type { YjsProviderConfig } from "@platejs/yjs";

import { apiFetch } from "@/lib/api";
import { meKey } from "@/lib/query-keys";
import {
  saveWikiSnapshot,
  useUpdateDoc,
  useWikiDocQuery,
  useWikiTreeQuery,
} from "@/hooks/use-wiki";
import type { WikiDoc, WikiDocDetail, WikiValue } from "@/lib/types";

import { ensureWebsocketProviderRegistered } from "./collab-provider";
import { RemoteCursorOverlay } from "./cursor-overlay";
import { EditorSkeleton } from "./EditorSkeleton";
import { wikiBasePlugins, wikiComponents } from "./editor-kit";
import { useMounted } from "./use-mounted";
import { WikiNavProvider } from "./wiki-nav-context";
import { WikiToolbar } from "./WikiToolbar";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000";
const WIKI_WS_BASE = `${WS_URL}/ws/wiki`;

const EMPTY_VALUE: WikiValue = [{ type: "p", children: [{ text: "" }] }];

const CURSOR_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];

function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return CURSOR_COLORS[h % CURSOR_COLORS.length];
}

type Me = { id: number; username: string; first_name: string; last_name: string };

// Register the y-websocket provider type once, at module load.
ensureWebsocketProviderRegistered();

export function WikiEditor({
  doc,
  onNavigate,
}: {
  doc: WikiDoc;
  onNavigate: (key: string) => void;
}) {
  const mounted = useMounted();
  const detailQuery = useWikiDocQuery(doc.key);

  // Paint the HTTP snapshot the moment it lands — don't wait on Yjs to sync
  // before showing anything. The Yjs provider connects in the background and
  // reconciles the editor once it syncs (see WikiEditorContent).
  if (!mounted || !detailQuery.isSuccess) return <EditorSkeleton />;

  return (
    <WikiEditorContent doc={doc} detail={detailQuery.data} onNavigate={onNavigate} />
  );
}

function WikiEditorContent({
  doc,
  detail,
  onNavigate,
}: {
  doc: WikiDoc;
  detail: WikiDocDetail;
  onNavigate: (key: string) => void;
}) {
  const treeQuery = useWikiTreeQuery();
  const pages = useMemo(
    () =>
      (treeQuery.data ?? []).map((d) => ({
        key: d.key,
        title: d.title || "Untitled",
      })),
    [treeQuery.data],
  );
  const meQuery = useQuery({
    queryKey: meKey(),
    queryFn: () => apiFetch<Me>("/api/auth/me/"),
    staleTime: Infinity,
  });

  const cursor = useMemo(() => {
    const me = meQuery.data;
    const name = me ? me.first_name || me.username : "Someone";
    return { name, color: colorFor(me ? String(me.id) : name) };
  }, [meQuery.data]);

  const initialValue = useMemo<WikiValue>(
    () =>
      detail.content && detail.content.length > 0
        ? (detail.content as WikiValue)
        : EMPTY_VALUE,
    // Only the value captured when this doc was first loaded matters — the
    // editor owns its content from here on (Yjs reconciles it in the background).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.key],
  );

  const editor = usePlateEditor(
    {
      value: initialValue as never,
      components: wikiComponents,
      plugins: [
        ...wikiBasePlugins,
        YjsPlugin.configure({
          options: {
            cursors: { data: cursor },
            providers: [
              {
                type: "websocket",
                options: { url: WIKI_WS_BASE, name: doc.key },
              } as unknown as YjsProviderConfig,
            ],
          },
          render: { afterEditable: RemoteCursorOverlay },
        }),
      ],
    },
    [doc.key],
  );

  // Connect Yjs in the background. The editor already shows the HTTP
  // snapshot (see `initialValue` above); once the shared doc syncs,
  // slate-yjs's own binding reconciles the editor content in place — no
  // seed is applied if the shared doc already has content.
  useEffect(() => {
    const yjs = editor.getApi(YjsPlugin).yjs;
    yjs.init({
      id: doc.key,
      value: initialValue as never,
      autoSelect: "end",
    } as never);
    let torn = false;
    return () => {
      // Pair destroy with this init exactly once. Guards the dev-only
      // StrictMode double-invoke and tolerates provider teardown races
      // (yjs logs a benign "remove handler that doesn't exist" otherwise).
      if (torn) return;
      torn = true;
      try {
        yjs.destroy();
      } catch {
        /* provider already disposed */
      }
    };
  }, [editor, doc.key, initialValue]);

  // Debounced snapshot autosave (denormalization; CRDT remains source of truth).
  const syncedRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleChange = useCallback(
    (value: WikiValue) => {
      if (!syncedRef.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveWikiSnapshot(doc.key, value).catch(() => {});
      }, 1200);
    },
    [doc.key],
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <WikiNavProvider pages={pages} onNavigate={onNavigate}>
        <Plate
          editor={editor}
          onChange={({ value }) => handleChange(value as WikiValue)}
        >
          <SyncTracker syncedRef={syncedRef} />
          <WikiToolbar />
          <div className="flex-1 min-h-0 overflow-y-auto">
            <PlateContainer className="relative mx-auto max-w-3xl px-12 py-8">
              <TitleHeader doc={doc} />
              <PlateContent
                className="wiki-prose mt-4 min-h-[55vh] text-[15px] leading-7 outline-none"
                placeholder="Start writing…"
              />
            </PlateContainer>
          </div>
        </Plate>
      </WikiNavProvider>
    </div>
  );
}

/** Tracks Yjs sync state so autosave doesn't fire before the shared doc has
 *  reconciled (avoids persisting a pre-sync snapshot as the source of truth). */
function SyncTracker({ syncedRef }: { syncedRef: MutableRefObject<boolean> }) {
  const isSynced = usePluginOption(YjsPlugin, "_isSynced");
  useEffect(() => {
    syncedRef.current = !!isSynced;
  }, [isSynced, syncedRef]);
  return null;
}

function TitleHeader({ doc }: { doc: WikiDoc }) {
  const update = useUpdateDoc();
  const [title, setTitle] = useState(doc.title);

  useEffect(() => {
    setTitle(doc.title);
  }, [doc.key, doc.title]);

  const commit = () => {
    const t = title.trim();
    if (t !== doc.title) {
      update.mutate({ key: doc.key, title: t || "Untitled" });
    }
  };

  return (
    <input
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder="Untitled"
      className="w-full bg-transparent text-3xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/40"
    />
  );
}
