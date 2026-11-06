import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, KeyRound, Package2, ShieldAlert, Trash2, Upload } from 'lucide-react';
import { getPlatformSettings, savePlatformSettings } from '../api/platform';
import { listFiles, uploadFile, deleteFile, presignDownload, type FileObject } from '../api/files';
import { useCan } from '../lib/rbac';
import { PageHeader, Panel, Field, Input, Button, Badge, EmptyState, Skeleton } from '../components/ui';
import { toast } from '../components/toast';
import { confirmDialog } from '../components/confirm';

// ─── Agent APK Panel ─────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AgentApkPanel() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const { data: apks = [], isLoading } = useQuery({
    queryKey: ['agent-apks'],
    queryFn: () => listFiles('apk'),
  });

  const sorted: FileObject[] = [...apks].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.apk')) {
      toast.error('Please select an .apk file');
      return;
    }
    setUploading(true);
    try {
      await uploadFile(file, 'apk');
      qc.invalidateQueries({ queryKey: ['agent-apks'] });
      toast.success(`"${file.name}" uploaded — ready to push to fleet.`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleDelete = async (apk: FileObject) => {
    const ok = await confirmDialog({
      title: 'Delete APK?',
      message: `Delete "${apk.name}"? Devices that haven't yet received this build won't be able to fetch it.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await deleteFile(apk.id);
      qc.invalidateQueries({ queryKey: ['agent-apks'] });
      toast.success('APK deleted');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Delete failed');
    }
  };

  const handleDownload = async (apk: FileObject) => {
    try {
      const { url } = await presignDownload(apk.id);
      window.open(url, '_blank');
    } catch {
      toast.error('Could not generate download link');
    }
  };

  return (
    <Panel
      icon={Package2}
      title="Agent APK builds"
      subtitle="Upload MDM agent APKs here. Go to Devices → Update outdated to push the latest build fleet-wide."
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button onClick={() => fileRef.current?.click()} disabled={uploading}>
            <Upload size={14} />
            {uploading ? 'Uploading…' : 'Upload APK'}
          </Button>
          <input ref={fileRef} type="file" accept=".apk" className="hidden" onChange={handleUpload} />
          <span className="text-xs text-muted">
            APKs are stored securely and served over presigned URLs — devices never need a public download link.
          </span>
        </div>

        {isLoading && (
          <div className="space-y-2">
            {[1, 2].map(i => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
          </div>
        )}

        {!isLoading && sorted.length === 0 && (
          <div className="rounded-xl border border-dashed border-line bg-surface-2 p-6 text-center">
            <Package2 className="w-8 h-8 text-faint mx-auto mb-2" />
            <p className="text-sm text-muted">No agent APKs uploaded yet.</p>
            <p className="text-xs text-faint mt-0.5">Upload an APK above to enable OTA fleet updates from the Devices page.</p>
          </div>
        )}

        {sorted.length > 0 && (
          <div className="divide-y divide-line border border-line rounded-xl overflow-hidden">
            {sorted.map((apk, i) => (
              <div key={apk.id} className={`flex items-center gap-3 px-4 py-3 ${i === 0 ? 'bg-surface-2' : ''}`}>
                <Package2 size={16} className={`shrink-0 ${i === 0 ? 'text-accent' : 'text-muted'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-fg truncate">{apk.name}</span>
                    {i === 0 && <Badge tone="success">Latest</Badge>}
                  </div>
                  <div className="text-2xs text-muted mt-0.5 flex items-center gap-3 flex-wrap">
                    <span>{formatBytes(apk.size_bytes)}</span>
                    <span className="font-mono" title={apk.sha256}>{apk.sha256.slice(0, 12)}…</span>
                    <span>{new Date(apk.created_at).toLocaleString()}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => handleDownload(apk)}
                    className="text-xs text-accent hover:underline"
                  >
                    Download
                  </button>
                  <button
                    onClick={() => handleDelete(apk)}
                    className="text-muted hover:text-danger transition-colors"
                    aria-label="Delete APK"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

// ─── Main Settings page ───────────────────────────────────────────────────────

// Settings — global, cross-tenant platform configuration (admin/super_admin).
// Currently the single setting is the agent's debug-unlock password.
export function Settings() {
  const canManage = useCan('platform:manage');
  const qc = useQueryClient();
  const [pw, setPw] = useState('');
  const [reveal, setReveal] = useState(false);
  const [dirty, setDirty] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['platform-settings'],
    queryFn: getPlatformSettings,
    enabled: canManage,
  });

  // Seed the field from the server once (and whenever it changes externally),
  // unless the operator has started editing.
  useEffect(() => {
    if (data && !dirty) setPw(data.debug_unlock_password ?? '');
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: () => savePlatformSettings(pw.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platform-settings'] });
      setDirty(false);
      toast.success('Debug-unlock password saved');
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Save failed'),
  });

  if (!canManage) {
    return (
      <EmptyState
        icon={<ShieldAlert className="w-6 h-6" />}
        title="Not authorized"
        hint="Global platform settings are restricted to admin and super-admin roles."
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        subtitle="Global platform configuration — applies across all tenants."
      />

      <AgentApkPanel />

      <Panel
        icon={KeyRound}
        title="Agent debug-unlock password"
        subtitle="Unlocks the hidden in-app config panel on devices (to repoint the server address offline)."
      >
        <div className="space-y-4 max-w-xl">
          <p className="text-[13px] text-muted leading-relaxed">
            This single password is global — every enrolled device receives it (as a hash)
            and verifies it on-device, so the panel works even when the server is unreachable.
            On the device, the panel is opened by tapping the <b>Agent version</b> line
            <b> 5 times then long-pressing</b> it; the operator then enters this password to
            edit the server address. Leave blank to disable the panel everywhere.
          </p>

          <Field label="Debug-unlock password" hint="Stored in plaintext here so you can view & rotate it; devices only ever receive its hash.">
            <div className="relative">
              <Input
                type={reveal ? 'text' : 'password'}
                value={pw}
                onChange={e => { setPw(e.target.value); setDirty(true); }}
                placeholder={isLoading ? 'Loading…' : 'e.g. dev1234'}
                className="pr-10 font-mono"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setReveal(r => !r)}
                aria-label={reveal ? 'Hide' : 'Reveal'}
                className="absolute inset-y-0 right-0 grid w-10 place-items-center text-faint hover:text-fg"
              >
                {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </Field>

          <div className="flex items-center gap-3">
            <Button onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            {data?.updated_at && (
              <span className="text-2xs text-faint">
                Last updated {new Date(data.updated_at).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}
