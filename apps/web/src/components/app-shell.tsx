'use client';

import { m } from 'motion/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from './auth-provider';
import { ChartIcon, ChatIcon, FileIcon, LogoMark } from './icons';
import { EASE_OUT, SPRING } from './motion';
import { ProviderBanner } from './provider-banner';
import { Button } from './ui';

const TABS = [
  { href: '/documents', label: 'Documents', icon: FileIcon },
  { href: '/chat', label: 'Chat', icon: ChatIcon },
  { href: '/usage', label: 'Usage', icon: ChartIcon },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { session, signOut } = useAuth();
  const email = session?.user.email ?? '';

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-[color-mix(in_oklab,var(--color-canvas)_80%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:gap-6">
          <Link href="/documents" className="flex items-center gap-2 text-sm font-semibold">
            <LogoMark />
            <span className="hidden sm:inline">Knowledge Base</span>
          </Link>

          <nav className="flex gap-0.5">
            {TABS.map((t) => {
              const active = pathname.startsWith(t.href);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors sm:px-3 ${
                    active
                      ? 'font-medium text-[var(--color-ink)]'
                      : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
                  }`}
                >
                  {active && (
                    <m.span
                      layoutId="nav-pill"
                      transition={SPRING}
                      className="absolute inset-0 rounded-lg border bg-[var(--color-surface)] shadow-xs"
                    />
                  )}
                  <t.icon className="relative hidden sm:block" />
                  <span className="relative">{t.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span
              className="hidden size-7 items-center justify-center rounded-full bg-[var(--color-accent-soft)] text-xs font-semibold text-[var(--color-accent)] uppercase md:flex"
              title={email}
              aria-hidden="true"
            >
              {email.slice(0, 1)}
            </span>
            <span className="hidden max-w-48 truncate text-xs text-[var(--color-ink-muted)] lg:inline">
              {email}
            </span>
            <Button variant="ghost" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4">
        <ProviderBanner />
        {/* Keyed on the route so each page fades in once. No exit animation:
            waiting for the old page to leave would only delay the new one. */}
        <m.main
          key={pathname}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: EASE_OUT }}
          className="flex flex-1 flex-col py-6"
        >
          {children}
        </m.main>
      </div>
    </div>
  );
}
