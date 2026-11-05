import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '../api/auth';
import { useAuth } from '../stores/authStore';
import { Button, Input, Field } from '../components/ui';
import { BrandIcon, BrandWordmark, CompanyLogo } from '../components/brand';
import { ShieldCheck, Activity, Lock, Radar, ArrowRight, Eye, EyeOff } from 'lucide-react';

// Live-looking status chips for the hero — purely decorative, sets the
// "command center" tone without implying real telemetry on the login screen.
const SIGNALS = [
  { icon: Radar, label: 'Fleet telemetry', value: 'streaming' },
  { icon: Lock, label: 'Zero-trust posture', value: 'enforced' },
  { icon: Activity, label: 'Hash-chained audit', value: 'sealed' },
];

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const setTokens = useAuth(s => s.setTokens);
  const setUser = useAuth(s => s.setUser);
  const navigate = useNavigate();
  const glowRef = useRef<HTMLDivElement | null>(null);
  const posRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);

  // Light that follows the pointer across the hero. We mutate `transform`
  // (GPU-composited, no repaint) inside a requestAnimationFrame so a burst of
  // mousemoves collapses to one update per frame — smooth, no lag.
  const onHeroMove = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    posRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = glowRef.current;
      if (el) el.style.transform = `translate3d(${posRef.current.x}px, ${posRef.current.y}px, 0)`;
    });
  };
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await login(email, password);
      setTokens(r.access_token, r.refresh_token);
      setUser(r.user);
      navigate('/');
    } catch (e: any) {
      setErr(e?.response?.data?.error ?? 'Login failed. Check your credentials.');
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-full grid lg:grid-cols-[1.05fr_0.95fr]">
      {/* ---------------- Brand hero (desktop) ---------------- */}
      <div onMouseMove={onHeroMove}
           className="login-hero hidden lg:flex flex-col justify-between p-12 xl:p-16 relative overflow-hidden text-white/90 select-none">
        {/* Drifting aurora fields (static now, for performance) */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 -left-24 w-[34rem] h-[34rem] rounded-full bg-indigo-500/30 blur-[120px] animate-aurora-a" />
          <div className="absolute top-1/3 -right-24 w-[30rem] h-[30rem] rounded-full bg-cyan-400/20 blur-[120px] animate-aurora-b" />
          <div className="absolute -bottom-40 left-1/4 w-[32rem] h-[32rem] rounded-full bg-violet-500/25 blur-[130px] animate-float" />
        </div>
        <div className="login-hero__grid pointer-events-none absolute inset-0" />
        {/* Pointer-following light */}
        <div ref={glowRef} className="login-hero__glow" />
        <div className="login-hero__grain pointer-events-none absolute inset-0" />
        {/* Inner hairline frame for a "console" feel */}
        <div className="pointer-events-none absolute inset-4 rounded-2xl ring-1 ring-inset ring-white/[0.06]" />

        {/* Brand lockup */}
        <div className="relative flex items-center gap-3.5 login-rise" style={{ animationDelay: '40ms' }}>
          <BrandIcon className="w-12 h-12" />
          <div>
            <BrandWordmark onDark className="text-2xl" />
            <div className="text-2xs uppercase tracking-[0.2em] text-white/45 mt-0.5">Mobile Device Management</div>
          </div>
        </div>

        {/* Headline */}
        <div className="relative max-w-md">
          <div className="login-rise inline-flex items-center gap-2 mb-5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-2xs font-medium text-white/70 backdrop-blur"
               style={{ animationDelay: '120ms' }}>
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
            Control plane online
          </div>
          <h1 className="login-hero__title text-[2.7rem] leading-[1.05] font-semibold tracking-tight login-rise"
              style={{ animationDelay: '180ms' }}>
            Your mobile fleet,<br />
            <span className="login-hero__grad animate-gradient-pan">under total command.</span>
          </h1>
          <p className="text-white/55 mt-5 text-[15px] leading-relaxed login-rise" style={{ animationDelay: '260ms' }}>
            Enroll, secure, and watch every Android device in real time — policies, live
            telemetry, attestation posture, and time-travel audit, in one console.
          </p>

          {/* Signal chips */}
          <div className="mt-8 space-y-2.5">
            {SIGNALS.map((s, i) => (
              <div key={s.label}
                   className="login-rise flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3.5 py-2.5 backdrop-blur-sm
                              transition-colors hover:border-white/15 hover:bg-white/[0.06]"
                   style={{ animationDelay: `${320 + i * 90}ms` }}>
                <span className="grid place-items-center w-8 h-8 rounded-lg bg-white/[0.06] text-indigo-300 ring-1 ring-white/10">
                  <s.icon size={15} />
                </span>
                <span className="text-sm text-white/75">{s.label}</span>
                <span className="ml-auto text-2xs font-medium uppercase tracking-wider text-emerald-400/90">{s.value}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="relative login-rise" style={{ animationDelay: '640ms' }}>
          <div className="flex items-center gap-2.5 text-2xs text-white/40">
            <span className="uppercase tracking-[0.16em] text-white/30">Powered by</span>
            <a href="https://vgipl.com" target="_blank" rel="noreferrer" className="opacity-90 hover:opacity-100 transition-opacity">
              <CompanyLogo variant="white" className="h-10 w-auto" />
            </a>
          </div>
          <div className="mt-2 flex items-center gap-2 text-2xs text-white/30">
            <ShieldCheck size={13} className="text-emerald-400/70" />
            © {new Date().getFullYear()} Virtual Galaxy Infotech Ltd · RBAC · zero-trust posture
          </div>
        </div>
      </div>

      {/* ---------------- Sign-in form ---------------- */}
      <div className="relative flex items-center justify-center p-6 sm:p-12 bg-bg overflow-hidden">
        {/* Soft accent glow bleeding in from the hero side */}
        <div className="pointer-events-none absolute -top-24 -right-24 w-80 h-80 rounded-full bg-accent/10 blur-3xl" />
        <form onSubmit={submit} className="relative w-full max-w-sm animate-fadein">
          {/* Mobile brand lockup */}
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <BrandIcon className="w-10 h-10" />
            <div className="leading-tight">
              <BrandWordmark className="text-lg" />
              <div className="text-2xs uppercase tracking-wider text-faint">Mobile Device Management</div>
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-surface/80 backdrop-blur-xl shadow-lg p-7">
            <h2 className="text-xl font-semibold text-fg tracking-tight">Sign in</h2>
            <p className="text-sm text-muted mt-1 mb-6">Welcome back. Sign in to your console.</p>

            <div className="space-y-4">
              <Field label="Email">
                <Input type="email" autoFocus autoComplete="username" value={email}
                       onChange={e => setEmail(e.target.value)} placeholder="you@company.com" />
              </Field>
              <Field label="Password">
                <div className="relative">
                  <Input type={showPw ? 'text' : 'password'} autoComplete="current-password" value={password}
                         onChange={e => setPassword(e.target.value)} placeholder="••••••••" className="pr-10" />
                  <button type="button"
                          onClick={() => setShowPw(v => !v)}
                          aria-label={showPw ? 'Hide password' : 'Show password'}
                          tabIndex={-1}
                          className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-fg">
                    {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </Field>
              {err && (
                <div className="text-sm text-danger bg-danger/10 ring-1 ring-inset ring-danger/20 rounded-lg px-3 py-2 animate-fadein" role="alert">
                  {err}
                </div>
              )}
              <Button type="submit" variant="primary" size="md" disabled={busy}
                      className="group w-full relative overflow-hidden">
                <span className="inline-flex items-center gap-1.5">
                  {busy ? 'Signing in…' : 'Sign in'}
                  {!busy && <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />}
                </span>
              </Button>
            </div>
          </div>

          <p className="mt-5 text-center text-2xs text-faint">
            Protected console · access is logged to the hash-chained audit trail
          </p>
        </form>
      </div>
    </div>
  );
}
