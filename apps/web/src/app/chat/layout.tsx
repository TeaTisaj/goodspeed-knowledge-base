import { ProtectedLayout } from '../layout-client';

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedLayout>{children}</ProtectedLayout>;
}
