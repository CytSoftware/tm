"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Plate,
  PlateContainer,
  PlateContent,
  useEditorRef,
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
import type { WikiDoc, WikiValue } from "@/lib/types";

import { ensureWebsocketProviderRegistered } from "./collab-provider";
import { RemoteCursorOverlay } from "./cursor-overlay";
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

  // Yjs applies the synced/seeded doc to the editor outside React's knowledge.
  // PlateContent only repaints on a *parent* re-render (which is why editing
  // the title made content appear). Bumping this forces that parent re-render.
  const [, forcePaint] = useReducer((n: number) => n + 1, 0);

  const cursor = useMemo(() => {
    const me = meQuery.data;
    const name = me ? me.first_name || me.username : "Someone";
    return { name, color: colorFor(me ? String(me.id) : name) };
  }, [meQuery.data]);

  const editor = usePlateEditor(
    {
      skipInitialization: true,
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

  const detail = detailQuery.data;
  const detailReady = detailQuery.isSuccess;

  // Yjs lifecycle: seed the shared doc once it's mounted + the snapshot loaded.
  // The seed is only applied if the server doc is empty (slate-yjs guards it);
  // otherwise the synced CRDT wins.
  useEffect(() => {
    if (!mounted || !detailReady) return;
    const initial =
      detail?.content && detail.content.length > 0
        ? (detail.content as WikiValue)
        : EMPTY_VALUE;
    const yjs = editor.getApi(YjsPlugin).yjs;
    yjs.init({
      id: doc.key,
      value: initial as never,
      autoSelect: "end",
      // Force a paint once the doc is ready — Yjs mutates the editor outside
      // React's knowledge, so without this the content stays blank until a
      // parent re-render (e.g. editing the title) happens.
      onReady: () =>
        setTimeout(() => {
          editor.api.onChange();
          forcePaint();
        }, 0),
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
    // detail content is captured at init; re-running on content change would
    // duplicate the seed. Intentionally keyed on editor identity + readiness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, mounted, detailReady, doc.key]);

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

  if (!mounted) return null;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <WikiNavProvider pages={pages} onNavigate={onNavigate}>
        <Plate
          editor={editor}
          onChange={({ value }) => handleChange(value as WikiValue)}
        >
          <SyncGate syncedRef={syncedRef} onSynced={forcePaint} />
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

function SyncGate({
  syncedRef,
  onSynced,
}: {
  syncedRef: MutableRefObject<boolean>;
  onSynced: () => void;
}) {
  const editor = useEditorRef();
  const isSynced = usePluginOption(YjsPlugin, "_isSynced");
  useEffect(() => {
    syncedRef.current = !!isSynced;
    if (isSynced) {
      // The synced doc was applied to the editor outside React's knowledge;
      // onChange alone doesn't repaint PlateContent here — force a parent
      // re-render so the content paints without a manual edit.
      editor.api.onChange();
      onSynced();
    }
  }, [isSynced, syncedRef, editor, onSynced]);
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
