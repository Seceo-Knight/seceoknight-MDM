import { useCallback, useRef, useState } from 'react';

/**
 * Drag-to-resize table columns. Pair with a `<colgroup>` of `<col>` whose
 * widths come from the returned `widths`, and put a [ColResizeHandle] in each
 * resizable `<th>` (the th must be `position: relative`). Use with
 * `table-fixed` so the column widths are authoritative.
 */
export function useColumnWidths(initial: number[], min = 64) {
  const [widths, setWidths] = useState<number[]>(initial);
  const drag = useRef<{ idx: number; startX: number; startW: number } | null>(null);

  const onMove = useCallback((e: MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    setWidths(w => w.map((cw, i) => (i === d.idx ? Math.max(min, d.startW + dx) : cw)));
  }, [min]);

  const onUp = useCallback(() => {
    drag.current = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, [onMove]);

  const startResize = useCallback((idx: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { idx, startX: e.clientX, startW: widths[idx] };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [widths, onMove, onUp]);

  const total = widths.reduce((a, b) => a + b, 0);
  return { widths, startResize, total };
}

/** A thin drag affordance pinned to the right edge of a (relative) <th>. */
export function ColResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <span
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize select-none transition-colors hover:bg-accent/40 active:bg-accent/60"
    />
  );
}
