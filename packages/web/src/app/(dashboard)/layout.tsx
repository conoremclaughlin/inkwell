import { Sidebar } from '@/components/layout/sidebar';
import { SystemStatusBanner } from '@/components/layout/system-status-banner';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-gray-50 p-8">
        <SystemStatusBanner />
        {children}
      </main>
    </div>
  );
}
