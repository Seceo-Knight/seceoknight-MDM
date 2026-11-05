import { cn } from './ui';

/* ============================================================================
   Brand assets for SeceoKnight MDM.
   - BrandIcon: inline SVG shield with "SK" mark (cyan, works on all surfaces)
   - BrandWordmark: "SeceoKnight" two-tone wordmark (IBM Plex Sans)
   - CompanyLogo: "SeceoKnight Technologies" company mark
   ========================================================================== */

// The SK shield mark — a self-contained inline SVG, no external images needed.
// Renders crisply at any size on both light and dark surfaces.
export function BrandIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"
         aria-label="SeceoKnight" role="img"
         className={cn('shrink-0 select-none', className)}>
      {/* Shield body — dark navy fill with cyan border */}
      <path d="M24 2.5L6.5 11.2V25.5C6.5 35.6 14.5 44.6 24 46.9C33.5 44.6 41.5 35.6 41.5 25.5V11.2L24 2.5Z"
            fill="#071525" stroke="#2DD4E8" strokeWidth="1.4" strokeLinejoin="round"/>
      {/* Inner shield layer for depth */}
      <path d="M24 7.5L11 14.5V25.5C11 33.8 16.9 41.1 24 43.1C31.1 41.1 37 33.8 37 25.5V14.5L24 7.5Z"
            fill="#0A1E35"/>
      {/* "SK" letters */}
      <text x="24" y="30" textAnchor="middle"
            fill="#2DD4E8"
            fontFamily="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
            fontSize="15" fontWeight="700" letterSpacing="-0.5">SK</text>
    </svg>
  );
}

// "SeceoKnight" wordmark — IBM Plex Sans, with "Seceo" in cyan accent and
// "Knight" in grey. `onDark` brightens tones for placement over dark surfaces.
export function BrandWordmark({ onDark, className }: { onDark?: boolean; className?: string }) {
  return (
    <span
      className={cn('font-semibold tracking-tight whitespace-nowrap leading-none', className)}
      style={{ fontFamily: "'IBM Plex Sans', 'Geist', sans-serif" }}
    >
      <span className={onDark ? 'text-cyan-300' : 'text-accent'}>Seceo</span>
      <span className={onDark ? 'text-slate-200' : 'text-fg/70'}>Knight</span>
    </span>
  );
}

// SeceoKnight Technologies company mark. Renders as styled text in the
// appropriate colour for the placement context.
export function CompanyLogo({ className, variant }: { className?: string; variant?: 'black' | 'white' }) {
  return (
    <span
      className={cn('inline-flex items-baseline whitespace-nowrap select-none', className)}
      style={{ fontFamily: "'IBM Plex Sans', 'Geist', sans-serif" }}
    >
      <span className={
        variant === 'white' ? 'text-white/90 font-semibold text-sm'
        : variant === 'black' ? 'text-slate-800 font-semibold text-sm'
        : 'text-fg/80 font-semibold text-sm'
      }>
        SeceoKnight
      </span>
      <span className={
        variant === 'white' ? 'text-white/50 font-normal text-sm ml-1'
        : variant === 'black' ? 'text-slate-500 font-normal text-sm ml-1'
        : 'text-muted font-normal text-sm ml-1'
      }>
        Technologies
      </span>
    </span>
  );
}
