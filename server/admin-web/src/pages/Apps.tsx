import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteFile, listFiles, uploadFile, type FileObject } from '../api/files';
import { listDevices, issueCommand, deviceLabel } from '../api/devices';
import { Panel, SectionHeading, Badge, Button, IconButton, Field, Input, EmptyState, Skeleton, PageHero, HeroStat, Hairline, Modal, ModalHeader, ModalBody, ModalFooter } from '../components/ui';
import { confirmDialog } from '../components/confirm';
import { toast } from '../components/toast';
import { Package, Upload, HardDrive, Fingerprint, CalendarClock, Smartphone, Send, Boxes, Trash2, Download, Check, Info } from 'lucide-react';

export function Apps() {
  const qc = useQueryClient();
  const { data: files, isLoading } = useQuery({
    queryKey: ['files', 'apk'],
    queryFn: () => listFiles('apk')
  });

  const [busy, setBusy] = useState(false);
  const [installFor, setInstallFor] = useState<FileObject | null>(null);

  const upload = useMutation({
    mutationFn: (f: File) => uploadFile(f, 'apk'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['files', 'apk'] }); toast.success('APK uploaded'); },
    onError: (e: any) => toast.error(`Upload failed: ${e?.response?.data?.error ?? e?.message ?? 'unknown'}`),
    onSettled: () => setBusy(false)
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteFile(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files', 'apk'] }),
    onError: (e: any) => toast.error(`Delete failed: ${e?.response?.data?.error ?? e?.message ?? 'unknown'}`)
  });

  const count = files?.length ?? 0;
  const totalBytes = (files ?? []).reduce((acc, f) => acc + (f.size_bytes ?? 0), 0);

  return (
    <div className="space-y-5">
      <PageHero
        icon={Package}
        eyebrow={<><span className="w-1.5 h-1.5 rounded-full bg-accent" style={{ animation: 'onlinePulse 2s infinite' }} /> App catalog</>}
        title="Apps"
        subtitle="Upload APKs to push to managed devices (Device Owner / Device Admin)."
        actions={
          <label className="inline-flex items-center gap-1.5 rounded-xl btn-brand ring-1 ring-inset ring-white/20 text-sm font-medium px-4 h-11 cursor-pointer transition-all active:translate-y-px">
            <Upload size={16} />{busy ? 'Uploading…' : 'Upload APK'}
            <input type="file" accept=".apk,application/vnd.android.package-archive" className="hidden"
                   disabled={busy}
                   onChange={e => {
                     const f = e.target.files?.[0];
                     if (f) { setBusy(true); upload.mutate(f); e.currentTarget.value = ''; }
                   }} />
          </label>
        }
        stats={<>
          <HeroStat icon={Package} label="Packages" value={count} tone="accent" />
          <HeroStat icon={HardDrive} label="Total size" value={count ? formatSize(totalBytes) : '—'} tone="info" />
        </>}
      />

      <Panel
        icon={Boxes}
        title="APK catalog"
        subtitle="Signed packages staged for deployment to your managed fleet."
        actions={
          <Badge tone={count ? 'accent' : 'muted'} dot>
            {count} package{count === 1 ? '' : 's'}
          </Badge>
        }
        bodyClassName="p-0"
        className="relative overflow-hidden animate-slideup card-grad ring-1 ring-inset ring-line"
      >
        {/* Top hairline accent */}
        <Hairline tone="faint" />
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead>
              <tr className="text-left text-2xs font-semibold uppercase tracking-wider text-faint border-b border-line bg-surface-2/40">
                <th className="px-4 py-2.5 font-semibold">Package</th>
                <th className="px-4 py-2.5 font-semibold">Size</th>
                <th className="px-4 py-2.5 font-semibold">SHA-256</th>
                <th className="px-4 py-2.5 font-semibold">Uploaded</th>
                <th className="px-4 py-2.5 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="rail divide-y divide-line">
              {isLoading && Array.from({ length: 4 }).map((_, i) => (
                <tr key={i}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Skeleton className="h-9 w-9 rounded-lg shrink-0" />
                      <Skeleton className="h-3.5 w-40" />
                    </div>
                  </td>
                  <td className="px-4 py-3"><Skeleton className="h-4 w-16" /></td>
                  <td className="px-4 py-3"><Skeleton className="h-4 w-32" /></td>
                  <td className="px-4 py-3"><Skeleton className="h-4 w-28" /></td>
                  <td className="px-4 py-3"><div className="flex justify-end gap-2"><Skeleton className="h-8 w-28" /><Skeleton className="h-8 w-8" /></div></td>
                </tr>
              ))}
              {!isLoading && files?.length === 0 && (
                <tr><td colSpan={5}>
                  <EmptyState
                    icon={
                      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm">
                        <Package size={22} />
                      </div>
                    }
                    title="No APKs uploaded yet"
                    hint="Upload a signed APK to stage it for deployment, then push it to any enrolled device in a single tap."
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
                        <Download size={13} />Install to device…
                      </Button>
                      <IconButton
                        label={`Delete ${f.name}`}
                        className="text-muted hover:bg-danger/10 hover:text-danger"
                        disabled={remove.isPending && remove.variables === f.id}
                        onClick={async () => {
                          if (await confirmDialog({
                            title: `Delete “${f.name}”?`,
                            message: 'The APK is removed from the catalog. Copies already installed on devices are unaffected.',
                            confirmLabel: 'Delete APK', icon: Trash2,
                          })) remove.mutate(f.id);
                        }}>
                        <Trash2 size={15} className={remove.isPending && remove.variables === f.id ? 'animate-pulse' : ''} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {installFor && <InstallToDeviceModal file={installFor} onClose={() => setInstallFor(null)} />}
    </div>
  );
}

function formatSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function InstallToDeviceModal({ file, onClose }: { file: FileObject; onClose: () => void }) {
  const [pkg, setPkg] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data, isLoading } = useQuery({
    queryKey: ['devices', 'install-target'],
    queryFn: () => listDevices({ limit: 200, state: 'enrolled' })
  });

  const fire = useMutation({
    mutationFn: async () => {
      const ids = Array.from(selected);
      for (const id of ids) {
        await issueCommand(id, 'INSTALL_APP', {
          // Empty package_name → agent lets PackageInstaller derive it from the APK.
          ...(pkg ? { package_name: pkg } : {}),
          download_object_id: file.id
        });
      }
    },
    onSuccess: onClose
  });

  const devices = data?.items ?? [];

  return (
    <Modal onClose={onClose} label="Install APK to devices" width="max-w-[34rem]">
        <ModalHeader
          icon={Package}
          title="Install to devices"
          subtitle={<span className="truncate font-mono text-2xs">{file.name}</span>}
          onClose={onClose}
        />
        <ModalBody className="space-y-4">
          <div className="flex items-start gap-2 rounded-xl bg-info/10 px-3 py-2.5 text-xs text-muted ring-1 ring-inset ring-info/20">
            <Info size={14} className="mt-0.5 shrink-0 text-info" />
            <span>Silent install requires <span className="font-medium text-fg">Device Owner</span>. In Device Admin mode the user is prompted to confirm on the device.</span>
          </div>

          <Field label="Package name" hint="Optional — leave blank to auto-detect from the APK.">
            <Input value={pkg} onChange={e => setPkg(e.target.value)} placeholder="auto" className="font-mono" />
          </Field>

          <div>
            <div className="mb-2">
              <SectionHeading
                icon={Smartphone}
                title="Enrolled devices"
                actions={selected.size > 0 ? <Badge tone="accent" dot>{selected.size} selected</Badge> : undefined}
              />
            </div>

            {isLoading && (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2.5 rounded-xl border border-line px-3 py-2.5">
                    <Skeleton className="h-7 w-7 rounded-lg" />
                    <Skeleton className="h-3.5 w-36" />
                    <Skeleton className="ml-auto h-3 w-16" />
                  </div>
                ))}
              </div>
            )}

            {!isLoading && devices.length === 0 && (
              <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
                <div className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-2xl bg-surface-2 text-faint">
                  <Smartphone size={18} />
                </div>
                <div className="text-sm font-medium text-fg">No enrolled devices</div>
                <p className="mt-1 text-xs text-muted">Enroll a device before you can push apps to it.</p>
              </div>
            )}

            {!isLoading && devices.length > 0 && (
              <div className="space-y-2">
                {devices.map(d => {
                  const on = selected.has(d.id);
                  return (
                    <label key={d.id}
                      className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-[transform,box-shadow,background-color,border-color] duration-200 hover:-translate-y-0.5 hover:shadow-sm ${
                        on ? 'border-accent/40 bg-accent/10 ring-1 ring-inset ring-accent/20' : 'border-line hover:bg-surface-2'
                      }`}>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={on}
                        onChange={e => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(d.id); else next.delete(d.id);
                          setSelected(next);
                        }} />
                      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset transition-colors ${
                        on ? 'bg-accent/15 text-accent ring-accent/25' : 'bg-surface text-muted ring-line'
                      }`}>
                        <Smartphone size={14} />
                      </span>
                      <div className="min-w-0">
                        {/* Alias first — it's what operators name a device by; make/model + serial are the secondary context. */}
                        <div className="truncate text-sm font-medium text-fg" title={d.alias ?? undefined}>{deviceLabel(d)}</div>
                        <div className="truncate text-2xs text-faint">
                          {d.manufacturer} {d.model}
                          <span className="font-mono"> · {d.serial_number ?? d.id.slice(0, 8)}</span>
                        </div>
                      </div>
                      <span className={`ml-auto grid h-5 w-5 shrink-0 place-items-center rounded-md border transition-colors ${
                        on ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong text-transparent'
                      }`}>
                        <Check size={12} strokeWidth={3} />
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </ModalBody>

        <ModalFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={() => fire.mutate()} disabled={selected.size === 0 || fire.isPending}>
            <Send size={14} />
            {fire.isPending ? 'Sending…' : `Send to ${selected.size} device${selected.size === 1 ? '' : 's'}`}
          </Button>
        </ModalFooter>
    </Modal>
  );
}
