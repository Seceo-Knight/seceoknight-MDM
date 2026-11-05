import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useMemo, useState } from 'react';
import { formatRelative } from '../components/online';
import { listUsers } from '../api/auth';
import { listDevices, deviceLabel } from '../api/devices';
import { Card, Input, Badge, Button, IconButton, Skeleton, cn, PageHero, HeroStat, Hairline, Modal, ModalBody, ModalFooter } from '../components/ui';
import { Search, ScrollText, ShieldCheck, Link2, User, Smartphone, Cog, Activity, X, Clock, Crosshair, Fingerprint, Braces } from 'lucide-react';

interface Entry {
  id: string;
  tenant_id?: string;
  actor_kind: string;
  actor_id?: string;
  action: string;
  target_kind?: string;
  target_id?: string;
  metadata?: Record<string, unknown>;
  prev_hash?: string;
  hash?: string;
  created_at: string;
}

export function Audit() {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Entry | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['audit'],
    queryFn: async () => (await api.get<{ items: Entry[] }>('/api/v1/audit?limit=300')).data.items,
    // Pause auto-refresh while a detail modal is open — no point re-rendering
    // (and re-blurring) the 300-row table behind it; resumes on close.
    refetchInterval: selected ? false : 5000
  });

  // Resolve actor UUIDs → emails and target device UUIDs → friendly labels.
  // listUsers is admin-only; if the caller can't read it (viewer/operator) we
  // fall back to showing the raw UUID rather than failing the whole page.
  const { data: users } = useQuery({
    queryKey: ['tenant-users'], queryFn: listUsers, retry: false,
    staleTime: 60_000
  });
  const { data: devices } = useQuery({
    queryKey: ['devices', 'audit-lookup'],
    queryFn: () => listDevices({ limit: 500 }),
    staleTime: 30_000
  });

  const userEmail = useMemo(() => {
    const m = new Map<string, string>();
    (users ?? []).forEach(u => m.set(u.id, u.email));
    return m;
  }, [users]);
  const deviceName = useMemo(() => {
    const m = new Map<string, string>();
    (devices?.items ?? []).forEach(d => m.set(d.id, deviceLabel(d)));
    return m;
  }, [devices]);

  const actorLabel = (e: Entry): string => {
    if (e.actor_kind === 'user') {
      if (e.actor_id && userEmail.has(e.actor_id)) return userEmail.get(e.actor_id)!;
      return e.actor_id ? `user ${e.actor_id.slice(0, 8)}…` : 'unknown user';
    }
    if (e.actor_kind === 'device') {
      if (e.actor_id && deviceName.has(e.actor_id)) return deviceName.get(e.actor_id)!;
      return e.actor_id ? `device ${e.actor_id.slice(0, 8)}…` : 'device';
    }
    return 'system';
  };

  const targetLabel = (e: Entry): string | null => {
    // Device targets: prefer target_id, fall back to metadata.device_id (some
    // command events carry it there). Resolve to the device's name; if it's no
    // longer in the fleet (retired/deleted) say so instead of a bare id.
    if (e.target_kind === 'device') {
      const id = e.target_id ?? (e.metadata?.device_id as string | undefined);
      if (id) return deviceName.get(id) ?? `device ${id.slice(0, 8)}… (removed)`;
    }
    if (!e.target_id) return e.target_kind ?? null;
    return `${e.target_kind ?? 'target'} ${e.target_id.slice(0, 8)}…`;
  };

  const filtered = data?.filter(e => {
    if (!filter) return true;
    const f = filter.toLowerCase();
    return e.action.toLowerCase().includes(f)
      || e.actor_kind.toLowerCase().includes(f)
      || actorLabel(e).toLowerCase().includes(f)
      || (targetLabel(e) ?? '').toLowerCase().includes(f);
  });

  // Lightweight at-a-glance counts (presentation only — no logic change).
  const total = data?.length ?? 0;
  const byUser = data?.filter(e => e.actor_kind === 'user').length ?? 0;
  const byDevice = data?.filter(e => e.actor_kind === 'device').length ?? 0;
  const bySystem = total - byUser - byDevice;

  return (
    <div className="space-y-5">
      <PageHero
        icon={ScrollText}
        eyebrow={<><ShieldCheck size={13} className="text-success" /> Tamper-evident chain</>}
        title="Audit log"
        subtitle="Hash-chained, append-only record of every admin and device action."
        actions={
          <div className="relative w-full max-w-md">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
            <Input value={filter} onChange={e => setFilter(e.target.value)}
                   placeholder="Filter by action, account or device…" className="pl-9 h-10 bg-surface/70 backdrop-blur" />
          </div>
        }
        stats={<>
          <HeroStat icon={Activity} label="Events" value={isLoading ? '—' : total} tone="accent" />
          <HeroStat icon={User} label="By account" value={isLoading ? '—' : byUser} tone="info" />
          <HeroStat icon={Smartphone} label="By device" value={isLoading ? '—' : byDevice} tone="success" />
          <HeroStat icon={Cog} label="System" value={isLoading ? '—' : bySystem} tone="muted" />
        </>}
      />

      <Card className="card-grad relative overflow-hidden ring-1 ring-inset ring-line animate-slideup" style={{ animationDelay: '60ms' }}>
        {/* Chain-seal hairline at the top edge */}
        <Hairline tone="success" />
        <div className="flex items-start gap-2.5 px-4 py-3 border-b border-line">
          <span className="mt-0.5 grid place-items-center h-7 w-7 shrink-0 rounded-lg bg-success-soft text-success ring-1 ring-inset ring-success/15">
            <Link2 size={15} />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-fg leading-tight">Verified chain</div>
            <div className="text-2xs text-faint mt-0.5">Append-only — each entry seals the one before it</div>
          </div>
          {!isLoading && filtered && (
            <Badge tone="success" dot className="ml-auto shrink-0 gap-1.5 tabular-nums">
              {filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}
            </Badge>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead>
              <tr className="text-left text-2xs font-semibold uppercase tracking-wider text-faint bg-surface-2/40 border-b border-line">
                <th className="px-4 py-2.5 font-semibold">When</th>
                <th className="px-4 py-2.5 font-semibold">Account / Actor</th>
                <th className="px-4 py-2.5 font-semibold">Action</th>
                <th className="px-4 py-2.5 font-semibold">Device / Target</th>
                <th className="px-4 py-2.5 font-semibold">Detail</th>
              </tr>
            </thead>
            <tbody className="rail">
              {isLoading && Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="border-b border-line/60">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <Skeleton className="h-6 w-6 rounded-full shrink-0" />
                      <Skeleton className="h-4 w-16" />
                    </div>
                  </td>
                  {Array.from({ length: 4 }).map((_, j) => <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>)}
                </tr>
              ))}
              {!isLoading && filtered?.length === 0 && (
                <tr><td colSpan={5}>
                  {/* Custom empty state so the gradient medallion renders once (not nested inside EmptyState's neutral chip). */}
                  <div className="flex flex-col items-center justify-center text-center py-14 px-6">
                    <span className="grid place-items-center h-12 w-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm mb-3">
                      <ScrollText size={20} />
                    </span>
                    <div className="text-sm font-medium text-fg">No audit events match</div>
                    <p className="text-xs text-muted mt-1 max-w-sm">
                      {filter ? 'Try a different search term.' : 'Admin and device actions will be recorded here.'}
                    </p>
                    {filter && (
                      <div className="mt-4">
                        <Button variant="secondary" size="sm" onClick={() => setFilter('')}>Clear filter</Button>
                      </div>
                    )}
                  </div>
                </td></tr>
              )}
              {!isLoading && filtered?.map((e, i) => {
                const tgt = targetLabel(e);
                const actorTone = e.actor_kind === 'user' ? 'info' : e.actor_kind === 'device' ? 'success' : 'muted';
                const ActorIcon = e.actor_kind === 'user' ? User : e.actor_kind === 'device' ? Smartphone : Cog;
                const first = i === 0;
                const last = i === (filtered.length - 1);
                return (
                  <tr key={e.id} onClick={() => setSelected(e)}
                      title="View full audit detail"
                      className="group align-top cursor-pointer border-b border-line/60 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none transition-colors"
                      tabIndex={0}
                      onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setSelected(e); } }}>
                    {/* relative td spans the full row height so the chain line reaches node-center to node-center even when other cells wrap */}
                    <td className="relative px-4 py-3 whitespace-nowrap" title={e.created_at}>
                      {/* Connecting chain line — spans the full cell height so it always reaches node-center to node-center; clipped to the node on the ends */}
                      <span className="pointer-events-none absolute w-px bg-gradient-to-b from-success/30 via-success/25 to-success/30"
                            style={{
                              left: 'calc(1rem + 12px)',
                              top: first ? 'calc(0.75rem + 12px)' : 0,
                              bottom: last ? 'calc(100% - 0.75rem - 12px)' : 0,
                            }} />
                      <div className="relative flex items-center gap-2.5">
                        {/* Chain link node — visual seal between consecutive entries */}
                        <span className="relative z-10 grid place-items-center h-6 w-6 rounded-full bg-success-soft text-success ring-1 ring-inset ring-success/25 shadow-sm transition-[transform,background-color] duration-200 group-hover:bg-success/15 group-hover:scale-110">
                          <Link2 size={12} />
                        </span>
                        <span className="text-xs text-faint tabular-nums">{formatRelative(e.created_at)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Badge tone={actorTone} className="gap-1">
                          <ActorIcon size={10} />
                          {e.actor_kind}
                        </Badge>
                        <span className="text-xs font-medium text-fg truncate" title={e.actor_id ?? ''}>{actorLabel(e)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <code className="font-mono text-xs text-muted bg-surface-2 rounded px-1.5 py-0.5 ring-1 ring-inset ring-line group-hover:ring-line-strong transition-colors">{e.action}</code>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted" title={e.target_id ?? ''}>
                      {tgt ? <span>{tgt}</span> : <span className="text-faint">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted max-w-xs">
                      {(() => {
                        const keys = e.metadata ? Object.keys(e.metadata) : [];
                        if (keys.length === 0) return <span className="text-faint">—</span>;
                        return (
                          <span className="inline-flex max-w-full items-center gap-1.5 align-middle" title={JSON.stringify(e.metadata)}>
                            <Braces size={12} className="shrink-0 text-faint" />
                            {keys.slice(0, 2).map(k => (
                              <code key={k} className="font-mono text-2xs text-muted bg-surface-2 rounded px-1.5 py-0.5 ring-1 ring-inset ring-line truncate max-w-[7rem]">{k}</code>
                            ))}
                            {keys.length > 2 && <span className="text-2xs text-faint tabular-nums shrink-0">+{keys.length - 2}</span>}
                          </span>
                        );
                      })()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {selected && (
        <AuditDetailModal
          entry={selected}
          actor={actorLabel(selected)}
          target={targetLabel(selected)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/* ============================ Detail modal ============================ */

function AuditDetailModal({ entry, actor, target, onClose }: {
  entry: Entry; actor: string; target: string | null; onClose: () => void;
}) {
  const actorTone = entry.actor_kind === 'user' ? 'info' : entry.actor_kind === 'device' ? 'success' : 'muted';
  const ActorIcon = entry.actor_kind === 'user' ? User : entry.actor_kind === 'device' ? Smartphone : Cog;

  const metaEntries = entry.metadata ? Object.entries(entry.metadata) : [];
  const hasMeta = metaEntries.length > 0;
  const metaJson = hasMeta ? JSON.stringify(entry.metadata, null, 2) : '';

  const renderVal = (v: unknown): string =>
    typeof v === 'string' ? v : JSON.stringify(v);

  return (
    <Modal onClose={onClose} label="Audit entry detail" width="max-w-2xl">
        <div className="flex shrink-0 items-center gap-3 px-5 py-4 border-b border-line">
          <span className="grid place-items-center h-9 w-9 shrink-0 rounded-xl bg-success-soft text-success ring-1 ring-inset ring-success/20">
            <Link2 size={16} />
          </span>
          <div className="min-w-0">
            <div className="text-2xs uppercase tracking-wider text-faint">Audit entry</div>
            <code className="font-mono text-sm text-fg break-all">{entry.action}</code>
          </div>
          <IconButton label="Close" onClick={onClose} className="ml-auto shrink-0"><X size={16} /></IconButton>
        </div>

        <ModalBody className="p-5 space-y-5">
          {/* Timestamp — absolute + relative */}
          <Field icon={Clock} label="When">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-sm text-fg tabular-nums">{new Date(entry.created_at).toLocaleString()}</span>
              <span className="text-xs text-faint">({formatRelative(entry.created_at)})</span>
            </div>
            <div className="text-2xs text-faint font-mono break-all mt-0.5">{entry.created_at}</div>
          </Field>

          {/* Actor */}
          <Field icon={ActorIcon} label="Actor">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={actorTone} className="gap-1"><ActorIcon size={10} />{entry.actor_kind}</Badge>
              <span className="text-sm font-medium text-fg break-all">{actor}</span>
            </div>
            {entry.actor_id && (
              <div className="text-2xs text-faint font-mono break-all mt-0.5">id: {entry.actor_id}</div>
            )}
          </Field>

          {/* Target */}
          <Field icon={Crosshair} label="Target">
            {target || entry.target_kind || entry.target_id ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {entry.target_kind && <Badge tone="default">{entry.target_kind}</Badge>}
                  <span className="text-sm text-fg break-all">{target ?? '—'}</span>
                </div>
                {entry.target_id && (
                  <div className="text-2xs text-faint font-mono break-all mt-0.5">id: {entry.target_id}</div>
                )}
              </>
            ) : (
              <span className="text-sm text-faint">No target</span>
            )}
          </Field>

          {/* Metadata */}
          <Field icon={Braces} label="Metadata">
            {hasMeta ? (
              <div className="space-y-2">
                <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
                  {metaEntries.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="font-mono text-muted break-all sm:text-right">{k}</dt>
                      <dd className="font-mono text-fg break-all">{renderVal(v)}</dd>
                    </div>
                  ))}
                </dl>
                <pre className="font-mono text-xs bg-surface-2 rounded-lg p-3 whitespace-pre-wrap break-all text-muted ring-1 ring-inset ring-line">{metaJson}</pre>
              </div>
            ) : (
              <span className="text-sm text-faint">No metadata recorded</span>
            )}
          </Field>

          {/* Tamper-evident chain proof */}
          <Field icon={Fingerprint} label="Tamper-evident proof">
            <div className="space-y-2">
              <HashRow label="Entry ID" value={entry.id} />
              {entry.tenant_id && <HashRow label="Tenant" value={entry.tenant_id} />}
              <HashRow label="Hash" value={entry.hash} tone="success" />
              <HashRow label="Prev hash" value={entry.prev_hash} />
            </div>
            <p className="mt-2 text-2xs text-faint inline-flex items-center gap-1.5">
              <ShieldCheck size={12} className="text-success" />
              Each entry's hash chains to the previous one — any tampering breaks the chain.
            </p>
          </Field>
        </ModalBody>

        <ModalFooter>
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </ModalFooter>
    </Modal>
  );
}

function Field({ icon: Icon, label, children }: { icon: typeof Activity; label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-faint mb-1.5">
        <Icon size={12} />
        {label}
      </div>
      {children}
    </div>
  );
}

function HashRow({ label, value, tone }: { label: string; value?: string; tone?: 'success' }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
      <span className="text-2xs uppercase tracking-wider text-faint shrink-0 sm:w-24">{label}</span>
      <code className={cn('font-mono text-xs break-all bg-surface-2 rounded px-1.5 py-1 ring-1 ring-inset ring-line',
        tone === 'success' ? 'text-success' : 'text-muted')}>
        {value || '—'}
      </code>
    </div>
  );
}
