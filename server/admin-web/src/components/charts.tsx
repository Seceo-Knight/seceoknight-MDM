// Lightweight, dependency-free SVG charts. Token-colored (currentColor /
// CSS vars), crisp at any size, no library default styling. Designed for the
// restrained, executive look — single accent, clean geometry, no rainbows.

export function Sparkline({ values, className, height = 36, strokeWidth = 1.5, fill = true }: {
  values: number[]; className?: string; height?: number; strokeWidth?: number; fill?: boolean;
}) {
  const w = 100, h = height;
  if (!values.length) return <svg viewBox={`0 0 ${w} ${h}`} className={className} preserveAspectRatio="none" />;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = values.length === 1 ? w : (i / (values.length - 1)) * w;
    const y = h - 3 - ((v - min) / span) * (h - 6);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  const gid = `spark-${Math.round(min)}-${values.length}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className} preserveAspectRatio="none" aria-hidden>
      {fill && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gid})`} />
        </>
      )}
      <path d={line} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function MiniBars({ values, className, height = 36, gap = 2 }: { values: number[]; className?: string; height?: number; gap?: number }) {
  const max = Math.max(1, ...values);
  return (
    <svg viewBox={`0 0 100 ${height}`} className={className} preserveAspectRatio="none" aria-hidden>
      {values.map((v, i) => {
        const bw = (100 - gap * (values.length - 1)) / values.length;
        const bh = (v / max) * (height - 2);
        return <rect key={i} x={i * (bw + gap)} y={height - bh} width={bw} height={Math.max(bh, 1)} rx="1" fill="currentColor" opacity={0.85} />;
      })}
    </svg>
  );
}

export interface DonutSeg { value: number; color: string; label: string }

// Donut/ring chart for distributions (modes, posture buckets). `color` is any
// CSS color (pass token classes' computed colors via inline style, or hexes).
export function Donut({ segments, size = 132, thickness = 14, center }: {
  segments: DonutSeg[]; size?: number; thickness?: number; center?: React.ReactNode;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--surface-3))" strokeWidth={thickness} />
        {segments.filter(s => s.value > 0).map((s, i) => {
          const len = (s.value / total) * c;
          const el = (
            <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color}
              strokeWidth={thickness} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} strokeLinecap="round" />
          );
          offset += len;
          return el;
        })}
      </svg>
      {center && <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{center}</div>}
    </div>
  );
}

// Token color helpers for charts (resolve to current theme via CSS vars).
export const chartColor = {
  accent: 'rgb(var(--accent))',
  success: 'rgb(var(--success))',
  warn: 'rgb(var(--warn))',
  danger: 'rgb(var(--danger))',
  muted: 'rgb(var(--faint))',
  info: 'rgb(var(--info))',
};
