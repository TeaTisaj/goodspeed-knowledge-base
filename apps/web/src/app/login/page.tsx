'use client';

import { m } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase';
import { LogoMark } from '@/components/icons';
import { EASE_OUT } from '@/components/motion';
import { Button, ErrorBanner } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('demo@example.com');
  const [password, setPassword] = useState('demo-password-123');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    const supabase = supabaseBrowser();
    const { error: authError } =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    setBusy(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    router.push('/documents');
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <m.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE_OUT }}
          className="mx-auto w-full max-w-sm"
        >
          <div className="flex items-center gap-2">
            <LogoMark width={28} height={28} />
            <span className="text-sm font-semibold">Knowledge Base</span>
          </div>

          <h1 className="mt-10 text-2xl font-semibold tracking-tight">
            {mode === 'signin' ? 'Welcome back' : 'Create your account'}
          </h1>
          <p className="mt-1.5 text-sm text-[var(--color-ink-muted)]">
            {mode === 'signin'
              ? 'Sign in to your documents.'
              : 'Your documents stay private to you.'}
          </p>

          <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
            {error && <ErrorBanner message={error} />}

            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Email
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="field font-normal"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Password
              <input
                type="password"
                required
                minLength={6}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="field font-normal"
              />
            </label>

            <Button type="submit" disabled={busy} className="mt-2 h-10">
              {busy ? 'Working...' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          <button
            onClick={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin');
              setError(null);
            }}
            className="mt-5 text-sm text-[var(--color-ink-muted)] underline-offset-4 transition-colors hover:text-[var(--color-ink)] hover:underline"
          >
            {mode === 'signin' ? 'Need an account?' : 'Already have an account?'}
          </button>

          <p className="mt-10 rounded-xl border border-dashed px-3 py-2.5 text-xs text-[var(--color-ink-muted)]">
            Seeded demo account is pre-filled. Run{' '}
            <code className="font-mono text-[var(--color-ink)]">pnpm db:seed</code> if it does not
            work yet.
          </p>
        </m.div>
      </div>

      <Showcase />
    </div>
  );
}

const ANSWER =
  'Re-run the last successful deploy from the Actions tab. It takes about eight minutes';

/**
 * A one-time illustration of the product's promise: every answer points at the
 * passage it came from. It plays once on load and never loops, because a
 * looping demo next to a form competes with the form.
 */
function Showcase() {
  const words = ANSWER.split(' ');
  const wordStep = 0.045;
  const answerStart = 0.9;
  const citeAt = answerStart + words.length * wordStep + 0.15;

  return (
    <div
      aria-hidden="true"
      className="relative hidden overflow-hidden border-l bg-[var(--color-surface)] lg:flex lg:items-center lg:justify-center"
    >
      {/* Faint grid and a single accent glow: depth without a gradient wash. */}
      <div className="absolute inset-0 [background-image:linear-gradient(var(--color-border)_1px,transparent_1px),linear-gradient(90deg,var(--color-border)_1px,transparent_1px)] [background-size:32px_32px] opacity-50 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]" />
      <div className="absolute top-1/3 left-1/2 size-96 -translate-x-1/2 rounded-full bg-[var(--color-accent)] opacity-[0.08] blur-3xl" />

      <div className="relative w-full max-w-md px-8">
        <m.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.4, ease: EASE_OUT }}
          className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-[var(--color-surface-muted)] px-4 py-2.5 text-sm"
        >
          How do I roll back a bad deploy?
        </m.div>

        <m.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7, duration: 0.4, ease: EASE_OUT }}
          className="mt-4 rounded-2xl border bg-[var(--color-canvas)] p-4 shadow-xl shadow-black/5"
        >
          <div className="flex items-center gap-2 text-xs font-medium text-[var(--color-ink-muted)]">
            <LogoMark width={16} height={16} />
            Assistant
          </div>
          <p className="mt-2 text-sm leading-relaxed">
            {words.map((w, i) => (
              <m.span
                key={i}
                initial={{ opacity: 0, filter: 'blur(4px)' }}
                animate={{ opacity: 1, filter: 'blur(0px)' }}
                transition={{ delay: answerStart + i * wordStep, duration: 0.3 }}
              >
                {w}{' '}
              </m.span>
            ))}
            <m.span
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: citeAt, type: 'spring', duration: 0.4, bounce: 0.4 }}
              className="inline-flex size-4.5 items-center justify-center rounded-md bg-[var(--color-accent-soft)] align-[0.1em] text-[10px] font-semibold text-[var(--color-accent)]"
            >
              1
            </m.span>
          </p>

          <m.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: citeAt + 0.35, duration: 0.4, ease: EASE_OUT }}
            className="mt-4 rounded-xl border bg-[var(--color-surface)] p-3"
          >
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded-md bg-[var(--color-accent-soft)] px-1.5 font-semibold text-[var(--color-accent)]">
                1
              </span>
              <span className="font-medium">Deployment runbook</span>
              <span className="ml-auto text-[var(--color-ink-muted)]">Rolling back</span>
            </div>
            <p className="mt-2 border-l-2 border-[var(--color-accent)] pl-2.5 text-xs leading-relaxed text-[var(--color-ink-muted)]">
              To roll back a bad deploy, re-run the previous successful deploy from the Actions tab.
              A rollback takes about eight minutes to finish.
            </p>
          </m.div>
        </m.div>

        <m.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: citeAt + 0.8, duration: 0.5 }}
          className="mt-8 text-center text-sm text-balance text-[var(--color-ink-muted)]"
        >
          Answers come only from your documents, and every claim links to the passage behind it.
        </m.p>
      </div>
    </div>
  );
}
