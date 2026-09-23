'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from './auth-provider';
import { Button } from './ui';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { session, signOut } = useAuth();

  const tabs = [
    { href: '/documents', label: 'Documents' },
    { href: '/chat', label: 'Chat' },
  ];

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-4">
      <header className="flex flex-wrap items-center gap-4 border-b py-4">
        <Link href="/documents" className="text-sm font-semibold">
          Knowledge Base
        </Link>
        <nav className="flex gap-1">
          {tabs.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className={`rounded-md px-3 py-1.5 text-sm transition ${
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
      <main className="flex-1 py-6">{children}</main>
    </div>
  );
}
