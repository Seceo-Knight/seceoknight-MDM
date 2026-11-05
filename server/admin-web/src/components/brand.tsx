import { cn } from './ui';

/* ============================================================================
   Brand assets. The CyberSentinel shield icon + the two-tone "CyberSentinel"
   wordmark (matching the official logo: "Cyber" indigo, "Sentinel" grey), and
   the Virtual Galaxy company logo which swaps with the light/dark theme.
   Source images live in /public/brand and are served at /brand/*.
   ========================================================================== */

// The circuit-board shield mark. It's a complete, self-contained logo, so we
// render it directly (no colored tile) — it reads on both light and dark.
export function BrandIcon({ className }: { className?: string }) {
  return (
    <img
      src="/brand/cybersentinel-icon.png"
      alt="CyberSentinel"
      draggable={false}
      className={cn('object-contain shrink-0 select-none drop-shadow-sm', className)}
    />
  );
}

// "CyberSentinel" wordmark in the official logo style — Montserrat Bold, with
// "Cyber" in deep indigo and "Sentinel" in grey. `onDark` brightens both tones
// for placement over a dark surface (e.g. the login hero).
export function BrandWordmark({ onDark, className }: { onDark?: boolean; className?: string }) {
  return (
    <span
      className={cn('font-bold tracking-tight whitespace-nowrap leading-none', className)}
      style={{ fontFamily: "'Montserrat', 'Geist', sans-serif" }}
    >
      <span className={onDark ? 'text-indigo-300' : 'text-accent'}>Cyber</span>
      <span className={onDark ? 'text-slate-300' : 'text-fg/70'}>Sentinel</span>
    </span>
  );
}

// Virtual Galaxy company wordmark. By default it follows the app theme (black
// wordmark on light, white wordmark on dark). Pass `variant` to force one.
export function CompanyLogo({ className, variant }: { className?: string; variant?: 'black' | 'white' }) {
  if (variant) {
    return (
      <img src={`/brand/vg-${variant}.png`} alt="Virtual Galaxy" draggable={false}
           className={cn('object-contain select-none', className)} />
    );
  }
  return (
    <>
      <img src="/brand/vg-black.png" alt="Virtual Galaxy" draggable={false}
           className={cn('object-contain select-none block dark:hidden', className)} />
      <img src="/brand/vg-white.png" alt="Virtual Galaxy" draggable={false}
           className={cn('object-contain select-none hidden dark:block', className)} />
    </>
  );
}
