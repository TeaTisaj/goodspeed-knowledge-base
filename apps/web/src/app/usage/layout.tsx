import { ProtectedLayout } from '../layout-client';

export default function UsageLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedLayout>{children}</ProtectedLayout>;
}
