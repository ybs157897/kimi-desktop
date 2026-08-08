/**
 * ChatSkeleton — the initial transcript loading state, shaped like the chat
 * so the switch from placeholder to content does not shift the layout.
 *
 * A user bubble, an assistant text passage, a code block, and a tool row are
 * sketched with shimmering blocks (`.skeleton-block` in `styles/app.css`);
 * the sweep animation turns off under `prefers-reduced-motion`.
 */

export function ChatSkeleton() {
  return (
    <div
      role="status"
      aria-label="正在加载对话"
      className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-background-surface)]"
    >
      <div className="mx-auto w-full max-w-[var(--layout-thread-max-width)] px-6 pb-8 pt-5">
        {/* User bubble */}
        <div className="mb-4 flex justify-end">
          <div className="skeleton-block h-10 w-2/5 max-w-[18rem] rounded-2xl" />
        </div>
        {/* Assistant text passage */}
        <div className="mb-4 space-y-2">
          <div className="skeleton-block h-4 w-full" />
          <div className="skeleton-block h-4 w-[88%]" />
          <div className="skeleton-block h-4 w-[62%]" />
        </div>
        {/* Code block */}
        <div className="mb-4 rounded-2xl border border-[var(--color-border-light)] p-3">
          <div className="skeleton-block mb-2.5 h-3 w-28 rounded" />
          <div className="space-y-1.5">
            <div className="skeleton-block h-3 w-full" />
            <div className="skeleton-block h-3 w-[92%]" />
            <div className="skeleton-block h-3 w-[70%]" />
          </div>
        </div>
        {/* Tool row */}
        <div className="flex items-center gap-2">
          <div className="skeleton-block h-5 w-5 rounded-md" />
          <div className="skeleton-block h-3 w-44 rounded" />
        </div>
      </div>
    </div>
  );
}
