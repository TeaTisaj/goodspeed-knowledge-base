'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from './auth-provider';
import { ProviderBanner } from './provider-banner';
import { Button } from './ui';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { session, signOut } = useAuth();

  const tabs = [
    { href: '/documents', label: 'Documents' },
    { href: '/chat', label: 'Chat' },
    { href: '/usage', label: 'Usage' },
  ];

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-4">
      <header className="flex items-center gap-2 border-b py-4 sm:gap-4">
        <Link href="/documents" className="hidden text-sm font-semibold sm:inline">
          Knowledge Base
        </Link>
        <nav className="flex gap-1">
          {tabs.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className={`rounded-md px-2 py-1.5 text-sm transition sm:px-3 ${
                pathname.startsWith(t.href)
                  ? 'bg-[var(--color-surface-muted)] font-medium'
                  : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)]'
              }`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-xs text-[var(--color-ink-muted)] sm:inline">
            {session?.user.email}
          </span>
          <Button variant="secondary" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>
      <ProviderBanner />
      <main className="flex-1 py-6">{children}</main>
    </div>
  );
}
