import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, KeyRound, ShieldAlert } from 'lucide-react';
import { getPlatformSettings, savePlatformSettings } from '../api/platform';
import { useCan } from '../lib/rbac';
import { PageHeader, Panel, Field, Input, Button, EmptyState } from '../components/ui';
import { toast } from '../components/toast';

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
