import { Activity, Smartphone, Users, Shield, Box, History, QrCode, FileText, KeyRound, Settings, UserCheck, ShieldAlert, Bell, MapPin, Brain, FileDown, Map } from 'lucide-react';

// Single source of truth for navigable pages — consumed by the sidebar
// (Layout) and the ⌘K command palette.
export type NavItem = { to: string; label: string; Icon: typeof Activity; section: 'fleet' | 'ops'; perm?: string };

export const nav: NavItem[] = [
  { to: '/',            label: 'Overview',    Icon: Activity,   section: 'fleet' },
  { to: '/devices',     label: 'Devices',     Icon: Smartphone, section: 'fleet' },
  { to: '/groups',      label: 'Groups',      Icon: Users,      section: 'fleet' },
  { to: '/policies',    label: 'Policies',    Icon: Shield,     section: 'fleet' },
  { to: '/apps',        label: 'Apps',        Icon: Box,        section: 'fleet' },
  { to: '/map',         label: 'Live Map',    Icon: Map,         section: 'fleet' },
  { to: '/geofencing',  label: 'Geofencing',  Icon: MapPin,      section: 'fleet' },
  { to: '/ai-insights', label: 'AI Insights', Icon: Brain,       section: 'fleet' },
  { to: '/reports',     label: 'Reports',     Icon: FileDown,    section: 'ops' },
  { to: '/compliance',  label: 'Compliance',  Icon: ShieldAlert, section: 'ops', perm: 'policy:read' },
  { to: '/alerts',      label: 'Alerts',      Icon: Bell,        section: 'ops', perm: 'policy:read' },
  { to: '/timetravel',  label: 'Time travel', Icon: History,    section: 'ops' },
  { to: '/enrollment',  label: 'Enrollment',  Icon: QrCode,     section: 'ops' },
  { to: '/audit',       label: 'Audit',       Icon: FileText,   section: 'ops' },
  { to: '/access-log',  label: 'Access log',  Icon: UserCheck,  section: 'ops', perm: 'user:read' },
  { to: '/roles',       label: 'Access',      Icon: KeyRound,   section: 'ops', perm: 'role:read' },
  { to: '/settings',    label: 'Settings',    Icon: Settings,   section: 'ops', perm: 'platform:manage' },
];
