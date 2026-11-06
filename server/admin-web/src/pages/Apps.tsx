import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteFile, listFiles, uploadFile, type FileObject } from '../api/files';
import { listDevices, issueCommand, deviceLabel } from '../api/devices';
import { listGroups } from '../api/groups';
import { listFleetApps, listBlockedPackages, addBlockedPackage, deleteBlockedPackage, type FleetApp } from '../api/apps';
import {
  Panel, SectionHeading, Badge, Button, IconButton, Field, Input,
  EmptyState, Skeleton, PageHero, HeroStat, Hairline,
  Modal, ModalHeader, ModalBody, ModalFooter,
} from '../components/ui';
import { confirmDialog } from '../components/confirm';
import { toast } from '../components/toast';
import {
  Package, Upload, HardDrive, Fingerprint, CalendarClock, Smartphone,
  Send, Boxes, Trash2, Download, Check, Info, Shield, Search,
  ShieldAlert, Users, BarChart3, Plus, X, AlertCircle, RefreshCw,
} from 'lucide-react';

// ─── Tab types ────────────────────────────────────────────────────────────────
type Tab = 'catalog' | 'fleet' | 'blocklist';

export function Apps() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('catalog');
  const [busy, setBusy] = useState(false);
  const [installFor, setInstallFor] = useState<FileObject | null>(null);

  // APK catalog
  const { data: files, isLoading: filesLoading } = useQuery({
    queryKey: ['files', 'apk'],
    queryFn: () => listFiles('apk'),
  });

  // Fleet inventory
  const { data: fleetData, isLoading: fleetLoading, refetch: refetchFleet } = useQuery({
    queryKey: ['fleet-apps'],
    queryFn: () => listFleetApps(500),
    staleTime: 60_000,
    enabled: tab === 'fleet',
  });

  // Blocklist
  const { data: blocklist = [], isLoading: blocklistLoading } = useQuery({
    queryKey: ['blocklist'],
    queryFn: listBlockedPackages,
    staleTime: 30_000,
    enabled: tab === 'blocklist',
  });

  const upload = useMutation({
    mutationFn: (f: File) => uploadFile(f, 'apk'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['files', 'apk'] }); toast.success('APK uploaded'); },
    onError: (e: any) => toast.error(`Upload failed: ${e?.response?.data?.error ?? e?.message ?? 'unknown'}`),
    onSettled: () => setBusy(false),
  });

  const removeFile = useMutation({
    mutationFn: (id: string) => deleteFile(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files', 'apk'] }),
    onError: (e: any) => toast.error(`Delete failed: ${e?.response?.data?.error ?? e?.message ?? 'unknown'}`),
  });

  const count = files?.length ?? 0;
  const fleetApps = fleetData?.items ?? [];
  const maxDeviceCount = fleetApps.length > 0 ? Math.max(...fleetApps.map(a => a.device_count)) : 1;
  const blockedSet = useMemo(() => new Set(blocklist.map(b => b.package_name)), [blocklist]);

  return (
    <div className="space-y-5">
      <PageHero
        icon={Package}
        eyebrow={<><span className="w-1.5 h-1.5 rounded-full bg-accent" style={{ animation: 'onlinePulse 2s infinite' }} /> App management</>}
        title="App Management"
        subtitle="Upload APKs, view fleet-wide app inventory, and manage the package blocklist."
        actions={tab === 'catalog' ? (
          <label className="inline-flex items-center gap-1.5 rounded-xl btn-brand ring-1 ring-inset ring-white/20 text-sm font-medium px-4 h-11 cursor-pointer transition-all active:translate-y-px">
            <Upload size={16} />{busy ? 'Uploading…' : 'Upload APK'}
            <input type="file" accept=".apk,application/vnd.android.package-archive" className="hidden"
              disabled={busy}
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) { setBusy(true); upload.mutate(f); e.currentTarget.value = ''; }
              }} />
          </label>
        ) : undefined}
        stats={<>
          <HeroStat icon={Package} label="APKs" value={count} tone="accent" />
          <HeroStat icon={BarChart3} label="App types" value={fleetData?.total ?? '—'} tone="info" />
          <HeroStat icon={ShieldAlert} label="Blocked" value={blocklist.length} tone={blocklist.length > 0 ? 'danger' : 'muted'} />
        </>}
      />

      {/* Tab bar */}
      <div className="flex gap-1 p-1 rounded-xl bg-surface-2 ring-1 ring-inset ring-line w-fit">
        {([
          { key: 'catalog',   label: 'APK Catalog',      icon: Package   },
          { key: 'fleet',     label: 'Fleet Inventory',  icon: BarChart3 },
          { key: 'blocklist', label: 'Blocklist',        icon: ShieldAlert },
        ] as { key: Tab; label: string; icon: React.ElementType }[]).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all ${
              tab === t.key
                ? 'bg-surface shadow-sm text-fg ring-1 ring-inset ring-line'
                : 'text-muted hover:text-fg'
            }`}
          >
            <t.icon size={14} />
            {t.label}
          </button>
        ))}
      </div>

      {/* ── APK Catalog tab ── */}
      {tab === 'catalog' && (
        <Panel
          icon={Boxes}
          title="APK catalog"
          subtitle="Signed packages staged for deployment to your managed fleet."
          actions={<Badge tone={count ? 'accent' : 'muted'} dot>{count} package{count === 1 ? '' : 's'}</Badge>}
          bodyClassName="p-0"
          className="relative overflow-hidden animate-slideup card-grad ring-1 ring-inset ring-line"
        >
          <Hairline tone="faint" />
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead>
                <tr className="text-left text-2xs font-semibold uppercase tracking-wider text-faint border-b border-line bg-surface-2/40">
                  <th className="px-4 py-2.5">Package</th>
                  <th className="px-4 py-2.5">Size</th>
                  <th className="px-4 py-2.5">SHA-256</th>
                  <th className="px-4 py-2.5">Uploaded</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="rail divide-y divide-line">
                {filesLoading && Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3"><div className="flex items-center gap-3"><Skeleton className="h-9 w-9 rounded-lg shrink-0" /><Skeleton className="h-3.5 w-40" /></div></td>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-16" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-32" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-28" /></td>
                    <td className="px-4 py-3"><div className="flex justify-end gap-2"><Skeleton className="h-8 w-28" /><Skeleton className="h-8 w-8" /></div></td>
                  </tr>
                ))}
                {!filesLoading && files?.length === 0 && (
                  <tr><td colSpan={5}>
                    <EmptyState
                      icon={<div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm"><Package size={22} /></div>}
                      title="No APKs uploaded yet"
                      hint="Upload a signed APK to stage it for deployment, then push it to any enrolled device or group."
                      action={
                        <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg btn-brand px-3.5 text-sm font-medium ring-1 ring-inset ring-white/20 transition-all active:translate-y-px">
                          <Upload size={15} />{busy ? 'Uploading…' : 'Upload APK'}
                          <input type="file" accept=".apk,application/vnd.android.package-archive" className="hidden"
                            disabled={busy}
                            onChange={e => {
                              const f = e.target.files?.[0];
                              if (f) { setBusy(true); upload.mutate(f); e.currentTarget.value = ''; }
                            }} />
                        </label>
                      }
                    />
                  </td></tr>
                )}
                {files?.map((f, i) => (
                  <tr key={f.id} className="group animate-fadein transition-colors hover:bg-surface-2" style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent ring-1 ring-inset ring-accent/15 transition-colors group-hover:bg-accent/15">
                          <Package size={16} />
                        </span>
                        <span className="truncate font-medium text-fg">{f.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted tabular-nums">
                      <span className="inline-flex items-center gap-1.5"><HardDrive size={12} className="text-faint" />{formatSize(f.size_bytes)}</span>
                    </td>
                    <td className="px-4 py-3 text-muted" title={f.sha256}>
                      <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-2/60 px-2 py-1 ring-1 ring-inset ring-line">
                        <Fingerprint size={12} className="text-faint" />
                        <span className="font-mono text-2xs">{f.sha256.slice(0, 16)}…</span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted tabular-nums">
                      <span className="inline-flex items-center gap-1.5"><CalendarClock size={12} className="text-faint" />{new Date(f.created_at).toLocaleString()}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button size="sm" variant="secondary" onClick={() => setInstallFor(f)}>
                          <Download size={13} />Install…
                        </Button>
                        <IconButton
                          label={`Delete ${f.name}`}
                          className="text-muted hover:bg-danger/10 hover:text-danger"
                          disabled={removeFile.isPending && removeFile.variables === f.id}
                          onClick={async () => {
                            if (await confirmDialog({
                              title: `Delete "${f.name}"?`,
                              message: 'The APK is removed from the catalog. Copies already installed on devices are unaffected.',
                              confirmLabel: 'Delete APK', icon: Trash2,
                            })) removeFile.mutate(f.id);
                          }}>
                          <Trash2 size={15} className={removeFile.isPending && removeFile.variables === f.id ? 'animate-pulse' : ''} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ── Fleet Inventory tab ── */}
      {tab === 'fleet' && (
        <Panel
          icon={BarChart3}
          title="Fleet app inventory"
          subtitle="Apps installed across your fleet — aggregated from device telemetry."
          actions={
            <Button size="sm" variant="secondary" onClick={() => refetchFleet()} disabled={fleetLoading}>
              <RefreshCw size={13} className={fleetLoading ? 'animate-spin' : ''} />
              Refresh
            </Button>
          }
          bodyClassName="p-0"
          className="relative overflow-hidden animate-slideup card-grad ring-1 ring-inset ring-line"
        >
          <Hairline tone="faint" />
          <FleetInventoryTable
            apps={fleetApps}
            isLoading={fleetLoading}
            blockedSet={blockedSet}
            maxDeviceCount={maxDeviceCount}
            onBlock={(pkg) => {
              addBlockedPackage({ package_name: pkg, reason: 'Blocked from fleet inventory' })
                .then(() => { qc.invalidateQueries({ queryKey: ['blocklist'] }); toast.success(`${pkg} added to blocklist`); })
                .catch(e => toast.error(e?.response?.data?.error ?? 'Failed to block'));
            }}
          />
        </Panel>
      )}

      {/* ── Blocklist tab ── */}
      {tab === 'blocklist' && (
        <BlocklistPanel
          blocklist={blocklist}
          isLoading={blocklistLoading}
          onDelete={async (id, pkg) => {
            if (await confirmDialog({ title: `Unblock "${pkg}"?`, message: 'Devices will no longer be flagged for having this package installed.', confirmLabel: 'Remove', icon: Shield })) {
              deleteBlockedPackage(id)
                .then(() => { qc.invalidateQueries({ queryKey: ['blocklist'] }); toast.success('Package unblocked'); })
                .catch(e => toast.error(e?.response?.data?.error ?? 'Failed'));
            }
          }}
          onAdd={(body) => addBlockedPackage(body)
            .then(() => { qc.invalidateQueries({ queryKey: ['blocklist'] }); toast.success('Package blocked'); })
            .catch(e => { toast.error(e?.response?.data?.error ?? 'Failed'); throw e; })}
        />
      )}

      {installFor && <InstallToDeviceModal file={installFor} onClose={() => setInstallFor(null)} />}
    </div>
  );
}

// ─── Fleet Inventory Table ────────────────────────────────────────────────────
function FleetInventoryTable({
  apps, isLoading, blockedSet, maxDeviceCount, onBlock,
}: {
  apps: FleetApp[];
  isLoading: boolean;
  blockedSet: Set<string>;
  maxDeviceCount: number;
  onBlock: (pkg: string) => void;
}) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    if (!q) return apps;
    const lq = q.toLowerCase();
    return apps.filter(a => a.package_name.toLowerCase().includes(lq) || a.app_name.toLowerCase().includes(lq));
  }, [apps, q]);

  return (
    <>
      <div className="px-4 py-3 border-b border-line flex items-center gap-2">
        <Search size={14} className="text-faint shrink-0" />
        <input
          value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search packages…"
          className="flex-1 bg-transparent text-sm text-fg placeholder-faint outline-none"
        />
        {q && <button onClick={() => setQ('')}><X size={13} className="text-faint hover:text-fg" /></button>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="text-left text-2xs font-semibold uppercase tracking-wider text-faint border-b border-line bg-surface-2/40">
              <th className="px-4 py-2.5">App</th>
              <th className="px-4 py-2.5">Package name</th>
              <th className="px-4 py-2.5">Fleet spread</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {isLoading && Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>
                <td className="px-4 py-3"><Skeleton className="h-4 w-32" /></td>
                <td className="px-4 py-3"><Skeleton className="h-3 w-48" /></td>
                <td className="px-4 py-3"><Skeleton className="h-3 w-24" /></td>
                <td className="px-4 py-3"><div className="flex justify-end"><Skeleton className="h-7 w-20" /></div></td>
              </tr>
            ))}
            {!isLoading && filtered.length === 0 && (
              <tr><td colSpan={4}>
                <EmptyState
                  icon={<BarChart3 size={22} className="text-faint" />}
                  title={apps.length === 0 ? 'No app inventory yet' : 'No matches'}
                  hint={apps.length === 0 ? 'App inventory is collected via telemetry heartbeats. Use "Refresh app inventory" on a device to trigger it.' : 'Try a different search term.'}
                />
              </td></tr>
            )}
            {filtered.map((a, i) => {
              const isBlocked = blockedSet.has(a.package_name);
              const pct = maxDeviceCount > 0 ? (a.device_count / maxDeviceCount) * 100 : 0;
              return (
                <tr key={a.package_name} className="group hover:bg-surface-2 transition-colors animate-fadein" style={{ animationDelay: `${Math.min(i, 12) * 20}ms` }}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset ${isBlocked ? 'bg-danger/10 text-danger ring-danger/20' : 'bg-surface-2 text-muted ring-line'}`}>
                        {isBlocked ? <ShieldAlert size={14} /> : <Package size={14} />}
                      </span>
                      <div>
                        <div className="font-medium text-fg text-sm truncate max-w-[180px]">{a.app_name || a.package_name.split('.').pop()}</div>
                        {a.version_name && <div className="text-2xs text-faint">v{a.version_name}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-2xs text-muted">{a.package_name}</span>
                    {isBlocked && <span className="ml-2 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-2xs font-semibold text-danger bg-danger/10">blocked</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="relative h-1.5 w-24 rounded-full bg-surface-3 overflow-hidden flex-shrink-0">
                        <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-muted tabular-nums whitespace-nowrap">{a.device_count} device{a.device_count !== 1 ? 's' : ''}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!isBlocked && (
                      <Button size="sm" variant="secondary"
                        className="hover:bg-danger/10 hover:text-danger hover:border-danger/30"
                        onClick={() => onBlock(a.package_name)}>
                        <ShieldAlert size={12} />Block
                      </Button>
                    )}
                    {isBlocked && <span className="text-2xs text-danger font-medium flex items-center justify-end gap-1"><AlertCircle size={11} />Blocked</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!isLoading && apps.length > 0 && (
        <div className="px-4 py-2 border-t border-line text-2xs text-faint">
          {filtered.length} of {apps.length} apps shown
        </div>
      )}
    </>
  );
}

// ─── Blocklist Panel ──────────────────────────────────────────────────────────
function BlocklistPanel({
  blocklist, isLoading, onDelete, onAdd,
}: {
  blocklist: ReturnType<typeof listBlockedPackages> extends Promise<infer T> ? T : never;
  isLoading: boolean;
  onDelete: (id: string, pkg: string) => void;
  onAdd: (body: { package_name: string; display_name?: string; reason?: string }) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [pkgInput, setPkgInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [reasonInput, setReasonInput] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!pkgInput.trim()) return;
    setSaving(true);
    try {
      await onAdd({ package_name: pkgInput.trim(), display_name: nameInput.trim(), reason: reasonInput.trim() });
      setPkgInput(''); setNameInput(''); setReasonInput('');
      setAdding(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card animate-slideup ring-1 ring-inset ring-line">
      <div className="flex items-center justify-between p-4 border-b border-line">
        <div>
          <div className="flex items-center gap-2">
            <ShieldAlert size={16} className="text-danger" />
            <span className="font-semibold text-fg">Package Blocklist</span>
            <Badge tone={blocklist.length > 0 ? 'danger' : 'muted'} dot>{blocklist.length} blocked</Badge>
          </div>
          <p className="text-xs text-muted mt-0.5">Packages on this list are flagged on any device that has them installed.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setAdding(v => !v)}>
          {adding ? <X size={13} /> : <Plus size={13} />}
          {adding ? 'Cancel' : 'Block package'}
        </Button>
      </div>

      {/* Add form */}
      {adding && (
        <div className="p-4 border-b border-line bg-surface-2/40 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Package name *" hint="e.g. com.example.malware">
              <Input value={pkgInput} onChange={e => setPkgInput(e.target.value)} placeholder="com.example.app" className="font-mono" />
            </Field>
            <Field label="Display name" hint="Friendly name shown in the UI">
              <Input value={nameInput} onChange={e => setNameInput(e.target.value)} placeholder="Evil App" />
            </Field>
          </div>
          <Field label="Reason" hint="Why is this package blocked?">
            <Input value={reasonInput} onChange={e => setReasonInput(e.target.value)} placeholder="Malware, unauthorized app, etc." />
          </Field>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={handleAdd} disabled={!pkgInput.trim() || saving}>
              <Shield size={13} />
              {saving ? 'Blocking…' : 'Block package'}
            </Button>
          </div>
        </div>
      )}

      {/* List */}
      {isLoading ? (
        <div className="p-4 space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-3 rounded-xl border border-line">
              <Skeleton className="h-8 w-8 rounded-lg" />
              <div className="flex-1"><Skeleton className="h-4 w-48 mb-1" /><Skeleton className="h-3 w-32" /></div>
            </div>
          ))}
        </div>
      ) : blocklist.length === 0 ? (
        <EmptyState
          icon={<Shield size={22} className="text-faint" />}
          title="No packages blocked"
          hint="Add package names to flag any device that has them installed. The AI engine cross-references this list."
        />
      ) : (
        <div className="divide-y divide-line">
          {blocklist.map(b => (
            <div key={b.id} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 transition-colors group">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-danger/10 text-danger ring-1 ring-inset ring-danger/20">
                <ShieldAlert size={14} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-fg text-sm">{b.display_name || b.package_name}</span>
                  {b.display_name && <span className="font-mono text-2xs text-faint">{b.package_name}</span>}
                </div>
                {b.reason && <p className="text-xs text-muted truncate">{b.reason}</p>}
                <p className="text-2xs text-faint">{new Date(b.created_at).toLocaleString()}</p>
              </div>
              <IconButton
                label={`Unblock ${b.package_name}`}
                className="opacity-0 group-hover:opacity-100 text-muted hover:bg-danger/10 hover:text-danger transition-opacity"
                onClick={() => onDelete(b.id, b.package_name)}
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Install to device / group modal ─────────────────────────────────────────
type InstallTarget = 'devices' | 'groups';

function InstallToDeviceModal({ file, onClose }: { file: FileObject; onClose: () => void }) {
  const [pkg, setPkg] = useState('');
  const [target, setTarget] = useState<InstallTarget>('devices');
  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(new Set());
  const [selectedGroup, setSelectedGroup] = useState<string>('');

  const { data: devicesData, isLoading: devicesLoading } = useQuery({
    queryKey: ['devices', 'install-target'],
    queryFn: () => listDevices({ limit: 200, state: 'enrolled' }),
  });
  const { data: groups = [], isLoading: groupsLoading } = useQuery({
    queryKey: ['groups'],
    queryFn: listGroups,
  });

  const devices = devicesData?.items ?? [];

  // When a group is selected, automatically select all its devices
  const groupDevices = useMemo(() => {
    if (!selectedGroup) return [];
    return devices.filter(d => d.group_id === selectedGroup);
  }, [devices, selectedGroup]);

  const fire = useMutation({
    mutationFn: async () => {
      const targetIds = target === 'groups' ? groupDevices.map(d => d.id) : Array.from(selectedDevices);
      for (const id of targetIds) {
        await issueCommand(id, 'INSTALL_APP', {
          ...(pkg ? { package_name: pkg } : {}),
          download_object_id: file.id,
        });
      }
    },
    onSuccess: () => { toast.success('Install commands sent'); onClose(); },
    onError: (e: any) => toast.error(e?.response?.data?.error ?? 'Failed to send'),
  });

  const canFire = target === 'devices' ? selectedDevices.size > 0 : (selectedGroup !== '' && groupDevices.length > 0);
  const targetCount = target === 'devices' ? selectedDevices.size : groupDevices.length;

  return (
    <Modal onClose={onClose} label="Install APK to devices" width="max-w-[36rem]">
      <ModalHeader icon={Package} title="Install to devices" subtitle={<span className="truncate font-mono text-2xs">{file.name}</span>} onClose={onClose} />
      <ModalBody className="space-y-4">
        <div className="flex items-start gap-2 rounded-xl bg-info/10 px-3 py-2.5 text-xs text-muted ring-1 ring-inset ring-info/20">
          <Info size={14} className="mt-0.5 shrink-0 text-info" />
          <span>Silent install requires <span className="font-medium text-fg">Device Owner</span>. In Device Admin mode the user is prompted to confirm.</span>
        </div>

        <Field label="Package name" hint="Optional — leave blank to auto-detect from the APK.">
          <Input value={pkg} onChange={e => setPkg(e.target.value)} placeholder="auto" className="font-mono" />
        </Field>

        {/* Target selector */}
        <div className="flex gap-1 p-1 rounded-xl bg-surface-2 ring-1 ring-inset ring-line w-fit">
          {([
            { key: 'devices' as const, label: 'By Device',  icon: Smartphone },
            { key: 'groups'  as const, label: 'By Group',   icon: Users },
          ]).map(t => (
            <button
              key={t.key}
              onClick={() => setTarget(t.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                target === t.key ? 'bg-surface shadow-sm text-fg ring-1 ring-inset ring-line' : 'text-muted hover:text-fg'
              }`}
            >
              <t.icon size={12} />{t.label}
            </button>
          ))}
        </div>

        {/* Device selector */}
        {target === 'devices' && (
          <div>
            <SectionHeading icon={Smartphone} title="Enrolled devices" actions={selectedDevices.size > 0 ? <Badge tone="accent" dot>{selectedDevices.size} selected</Badge> : undefined} />
            <div className="mt-2 max-h-64 overflow-y-auto space-y-1.5 pr-1">
              {devicesLoading && Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2.5 rounded-xl border border-line px-3 py-2.5">
                  <Skeleton className="h-7 w-7 rounded-lg" /><Skeleton className="h-3.5 w-36" />
                </div>
              ))}
              {!devicesLoading && devices.length === 0 && (
                <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">No enrolled devices</div>
              )}
              {devices.map(d => {
                const on = selectedDevices.has(d.id);
                return (
                  <label key={d.id} className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm ${on ? 'border-accent/40 bg-accent/10 ring-1 ring-inset ring-accent/20' : 'border-line hover:bg-surface-2'}`}>
                    <input type="checkbox" className="sr-only" checked={on} onChange={e => {
                      const next = new Set(selectedDevices);
                      if (e.target.checked) next.add(d.id); else next.delete(d.id);
                      setSelectedDevices(next);
                    }} />
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset transition-colors ${on ? 'bg-accent/15 text-accent ring-accent/25' : 'bg-surface text-muted ring-line'}`}>
                      <Smartphone size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-fg">{deviceLabel(d)}</div>
                      <div className="truncate text-2xs text-faint">{d.manufacturer} {d.model}<span className="font-mono"> · {d.serial_number ?? d.id.slice(0, 8)}</span></div>
                    </div>
                    <span className={`ml-auto grid h-5 w-5 shrink-0 place-items-center rounded-md border transition-colors ${on ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong text-transparent'}`}>
                      <Check size={12} strokeWidth={3} />
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* Group selector */}
        {target === 'groups' && (
          <div>
            <SectionHeading icon={Users} title="Device groups" />
            <div className="mt-2 space-y-1.5">
              {groupsLoading && <Skeleton className="h-12 w-full rounded-xl" />}
              {!groupsLoading && groups.length === 0 && (
                <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">No groups defined</div>
              )}
              {groups.map(g => {
                const on = selectedGroup === g.id;
                const devCount = devices.filter(d => d.group_id === g.id).length;
                return (
                  <label key={g.id} className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm ${on ? 'border-accent/40 bg-accent/10 ring-1 ring-inset ring-accent/20' : 'border-line hover:bg-surface-2'}`}>
                    <input type="radio" className="sr-only" checked={on} onChange={() => setSelectedGroup(g.id)} />
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset transition-colors ${on ? 'bg-accent/15 text-accent ring-accent/25' : 'bg-surface text-muted ring-line'}`}>
                      <Users size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-fg">{g.name}</div>
                      <div className="text-2xs text-faint">{devCount} enrolled device{devCount !== 1 ? 's' : ''}</div>
                    </div>
                    <span className={`ml-auto grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 transition-colors ${on ? 'border-accent' : 'border-line-strong'}`}>
                      {on && <span className="w-2.5 h-2.5 rounded-full bg-accent" />}
                    </span>
                  </label>
                );
              })}
            </div>
            {selectedGroup && groupDevices.length === 0 && (
              <p className="mt-2 text-xs text-warn text-center">No enrolled devices in this group.</p>
            )}
            {selectedGroup && groupDevices.length > 0 && (
              <p className="mt-2 text-xs text-muted text-center">Will push to <span className="font-semibold text-fg">{groupDevices.length}</span> device{groupDevices.length !== 1 ? 's' : ''} in this group.</p>
            )}
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={() => fire.mutate()} disabled={!canFire || fire.isPending}>
          <Send size={14} />
          {fire.isPending ? 'Sending…' : `Push to ${targetCount} device${targetCount === 1 ? '' : 's'}`}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function formatSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
