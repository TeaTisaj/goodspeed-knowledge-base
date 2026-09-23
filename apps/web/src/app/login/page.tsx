'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase';
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
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="text-lg font-semibold">Knowledge Base</h1>
      <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
        {mode === 'signin' ? 'Sign in to your documents.' : 'Create an account.'}
      </p>

      <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
        {error && <ErrorBanner message={error} />}

        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border bg-transparent px-3 py-2 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border bg-transparent px-3 py-2 text-sm"
          />
        </label>

        <Button type="submit" disabled={busy} className="mt-2">
          {busy ? 'Working...' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </Button>
      </form>

      <button
        onClick={() => {
          setMode(mode === 'signin' ? 'signup' : 'signin');
          setError(null);
        }}
        className="mt-4 text-sm text-[var(--color-ink-muted)] underline"
      >
        {mode === 'signin' ? 'Need an account?' : 'Already have an account?'}
      </button>

      <p className="mt-6 rounded-md border border-dashed px-3 py-2 text-xs text-[var(--color-ink-muted)]">
        Seeded demo account is pre-filled. Run <code>pnpm db:seed</code> if it does not work yet.
      </p>
    </div>
  );
}
