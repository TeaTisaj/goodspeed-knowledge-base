import { ProtectedLayout } from '../layout-client';

/** One layout for every signed-in page, so the shell and session persist across tabs. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedLayout>{children}</ProtectedLayout>;
}
