import { ResponsiveShell } from '@/components/layout/responsive-shell';
import { SystemStatusBanner } from '@/components/layout/system-status-banner';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <ResponsiveShell>
      <SystemStatusBanner />
      {children}
    </ResponsiveShell>
  );
}
