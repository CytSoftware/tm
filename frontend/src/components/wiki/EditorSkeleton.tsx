export function EditorSkeleton() {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-11 shrink-0 border-b border-border" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 lg:px-12 lg:py-8 animate-pulse">
          <div className="h-9 w-2/3 rounded bg-muted" />
          <div className="mt-8 space-y-3">
            <div className="h-4 w-full rounded bg-muted" />
            <div className="h-4 w-full rounded bg-muted" />
            <div className="h-4 w-5/6 rounded bg-muted" />
            <div className="h-4 w-3/4 rounded bg-muted" />
          </div>
        </div>
      </div>
    </div>
  );
}
