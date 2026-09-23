'use client';

import { AuthProvider, RequireAuth } from '@/components/auth-provider';
import { AppShell } from '@/components/app-shell';

export function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <RequireAuth>
        <AppShell>{children}</AppShell>
      </RequireAuth>
    </AuthProvider>
  );
}

export function PublicLayout({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
