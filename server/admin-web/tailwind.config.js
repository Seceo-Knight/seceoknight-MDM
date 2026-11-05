/** @type {import('tailwindcss').Config} */
//
// Design system. Colors are driven by CSS custom properties (see styles.css)
// so light/dark are a single source of truth and every component speaks in
// semantic tokens (surface, line, fg, muted, accent) instead of raw palette
// shades. `rgb(var(--x) / <alpha-value>)` keeps Tailwind opacity modifiers
// (e.g. bg-accent/10) working.
const token = (v) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: token('--bg'),
        surface: token('--surface'),
        'surface-2': token('--surface-2'),
        'surface-3': token('--surface-3'),
        line: token('--line'),
        'line-strong': token('--line-strong'),
        fg: token('--fg'),
        muted: token('--muted'),
        faint: token('--faint'),
        accent: {
          DEFAULT: token('--accent'),
          hover: token('--accent-hover'),
          fg: token('--accent-fg'),
          soft: token('--accent-soft'),
        },
        success: { DEFAULT: token('--success'), soft: token('--success-soft') },
        warn: { DEFAULT: token('--warn'), soft: token('--warn-soft') },
        danger: {
          DEFAULT: token('--danger'),
          soft: token('--danger-soft'),
          solid: token('--danger-solid'),
          'solid-hover': token('--danger-solid-hover'),
        },
        info: { DEFAULT: token('--info'), soft: token('--info-soft') },
        // Back-compat: existing `brand-*` usages resolve onto the accent ramp.
        brand: {
          50: token('--accent-soft'),
          100: token('--accent-soft'),
          300: token('--accent-300'),
          500: token('--accent'),
          600: token('--accent'),
          700: token('--accent-hover'),
          800: token('--accent-hover'),
          950: token('--accent-950'),
        },
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'],
        // Display face for page/panel titles — the brand voice.
        display: ['Bricolage Grotesque', 'Geist', 'ui-sans-serif', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],
      },
      borderRadius: { lg: '0.625rem', xl: '0.875rem', '2xl': '1.125rem' },
      boxShadow: {
        xs: '0 1px 2px 0 rgb(0 0 0 / 0.04)',
        sm: '0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 3px 0 rgb(0 0 0 / 0.06)',
        md: '0 2px 4px -1px rgb(0 0 0 / 0.05), 0 10px 28px -8px rgb(0 0 0 / 0.14)',
        lg: '0 12px 34px -8px rgb(0 0 0 / 0.16), 0 4px 12px -4px rgb(0 0 0 / 0.10)',
        overlay: '0 28px 70px -14px rgb(0 0 0 / 0.34), 0 10px 28px -10px rgb(0 0 0 / 0.22)',
        focus: '0 0 0 3px rgb(var(--accent) / 0.30)',
      },
      ringColor: { DEFAULT: 'rgb(var(--accent) / 0.5)' },
      keyframes: {
        fadein: { from: { opacity: 0, transform: 'translateY(-3px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        scalein: { from: { opacity: 0, transform: 'scale(0.97)' }, to: { opacity: 1, transform: 'scale(1)' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        slideup: { from: { opacity: 0, transform: 'translateY(8px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        // Mobile nav drawer: slide in from the left edge (not "up" — drawers
        // come from the edge they're anchored to).
        'drawer-in': { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(0)' } },
        // Drifting "aurora" fields — two phases offset so blobs never sync up.
        'aurora-a': {
          '0%, 100%': { transform: 'translate3d(0,0,0) scale(1)' },
          '33%': { transform: 'translate3d(7%,-6%,0) scale(1.18)' },
          '66%': { transform: 'translate3d(-6%,7%,0) scale(0.92)' },
        },
        'aurora-b': {
          '0%, 100%': { transform: 'translate3d(0,0,0) scale(1.08)' },
          '50%': { transform: 'translate3d(-9%,6%,0) scale(0.9)' },
        },
        float: { '0%, 100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-7px)' } },
        'gradient-pan': { '0%, 100%': { backgroundPosition: '0% 50%' }, '50%': { backgroundPosition: '100% 50%' } },
        sheen: { '0%': { transform: 'translateX(-130%) skewX(-18deg)' }, '55%, 100%': { transform: 'translateX(240%) skewX(-18deg)' } },
      },
      animation: {
        fadein: 'fadein 0.18s ease-out',
        scalein: 'scalein 0.16s cubic-bezier(0.16,1,0.3,1)',
        slideup: 'slideup 0.24s cubic-bezier(0.16,1,0.3,1)',
        'drawer-in': 'drawer-in 0.26s cubic-bezier(0.16,1,0.3,1)',
        'aurora-a': 'aurora-a 18s ease-in-out infinite',
        'aurora-b': 'aurora-b 22s ease-in-out infinite',
        float: 'float 6s ease-in-out infinite',
        'gradient-pan': 'gradient-pan 8s ease-in-out infinite',
        sheen: 'sheen 5.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
