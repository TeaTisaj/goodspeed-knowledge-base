import { ProtectedLayout } from '../layout-client';

export default function DocumentsLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedLayout>{children}</ProtectedLayout>;
}
