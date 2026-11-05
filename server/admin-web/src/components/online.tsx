// Centralised online-state heuristic. We treat a device as online if it has
// heartbeated within the last 2× heartbeat window (server defaults to 60s).
// Tweak ONLINE_WINDOW_MS in lockstep with HeartbeatSec on the server.

export const ONLINE_WINDOW_MS = 150_000;

export function isOnline(lastHeartbeat?: string | null): boolean {
  if (!lastHeartbeat) return false;
  const t = new Date(lastHeartbeat).getTime();
  if (!t) return false;
  return Date.now() - t < ONLINE_WINDOW_MS;
}

export function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      title={online ? 'Connected' : 'Disconnected'}
      className={`inline-block w-2 h-2 rounded-full ${online ? 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]' : 'bg-slate-300 dark:bg-surface-3'}`}
    />
  );
}

export function formatRelative(iso?: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
