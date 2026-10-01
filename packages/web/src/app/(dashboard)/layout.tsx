import { ResponsiveShell } from '@/components/layout/responsive-shell';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <ResponsiveShell>{children}</ResponsiveShell>;
}
