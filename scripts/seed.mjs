#!/usr/bin/env node
/**
 * Seeds demo users and documents into local Supabase.
 *
 * Users are created through the Auth Admin API rather than inserted into
 * `auth.users` directly: raw inserts depend on Supabase's internal auth schema
 * and password hashing, which shift between versions and are a common reason a
 * "one command setup" works for the author and fails for everyone else.
 *
 * Documents are seeded as `queued`. Chunking and embedding are deliberately
 * left to the ingestion worker, so the seed cannot drift from the real pipeline.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

for (const candidate of ['.env', '../.env']) {
  const p = resolve(process.cwd(), candidate);
  if (existsSync(p)) {
    process.loadEnvFile(p);
    break;
  }
}

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SECRET = process.env.SUPABASE_SECRET_KEY;
if (!SECRET) {
  console.error('SUPABASE_SECRET_KEY is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const admin = createClient(URL, SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEMO_PASSWORD = 'demo-password-123';

const USERS = [
  { email: 'demo@example.com', label: 'Demo user' },
  { email: 'second@example.com', label: 'Second user (proves isolation)' },
];

const DOCUMENTS = [
  {
    email: 'demo@example.com',
    title: 'Engineering onboarding guide',
    tags: ['onboarding', 'engineering'],
    content: `# Engineering onboarding

## First day
Your laptop ships pre-configured. Sign in with the credentials emailed to you,
then run \`make bootstrap\` in the platform repository. It installs the toolchain,
starts the local database, and seeds demo data. Expect it to take about fifteen
minutes on a first run because it downloads container images.

## Development workflow
We work in short-lived branches off \`main\`. Open a pull request as soon as you
have something to discuss, even if it is unfinished — mark it as a draft. Every
pull request needs one approving review, and CI must be green before merge.

## Deployments
Deployments happen automatically when a pull request merges to \`main\`. A deploy
takes roughly eight minutes end to end. If a deploy fails, the previous version
stays live; nothing is ever half-deployed. To roll back, re-run the previous
successful deploy from the Actions tab.

## Who to ask
Platform questions go to #eng-platform. Anything urgent and customer-facing goes
to #incidents, where someone is on call at all times.`,
  },
  {
    email: 'demo@example.com',
    title: 'Q3 revenue summary',
    tags: ['finance', 'quarterly'],
    content: `# Q3 revenue summary

Total revenue for Q3 was 4.2 million dollars, up 18 percent from Q2. Growth came
almost entirely from the enterprise tier, which added 31 new accounts.

## Breakdown by tier
Enterprise contributed 2.8 million, self-serve 1.1 million, and professional
services the remaining 300 thousand. Self-serve revenue was flat quarter over
quarter, which we attribute to the pricing change shipped in July.

## Churn
Gross churn was 2.1 percent, down from 3.4 percent in Q2. The improvement
followed the onboarding rework: accounts that completed guided setup churned at
roughly a third the rate of those that skipped it.

## Outlook
We expect Q4 revenue between 4.6 and 5.0 million dollars. The main risk is that
two enterprise renewals worth a combined 400 thousand land in late December and
could slip into Q1.`,
  },
  {
    email: 'demo@example.com',
    title: 'Incident retrospective: search outage',
    tags: ['engineering', 'incident'],
    content: `# Incident retrospective: search outage

## What happened
On 14 August, search returned empty results for approximately 47 minutes. No
data was lost and no other feature was affected.

## Root cause
A migration added a filter to the retrieval query without rebuilding the vector
index. The index was scanned before the filter was applied, so the database
returned fewer rows than requested and, for most queries, none at all.

## Why it took 47 minutes
Our alerting watched error rates, and this failure produced no errors — the
query succeeded and returned zero rows. We were paged only when a customer
reported it.

## Actions taken
We now alert on empty-result rate, not just error rate. The migration checklist
requires confirming index compatibility whenever a retrieval query changes.

## Lesson
A silent wrong answer is more dangerous than a loud failure. Monitoring that
only watches for exceptions will miss an entire class of correctness bugs.`,
  },
  {
    email: 'second@example.com',
    title: 'Private notes (should never appear in the demo user’s search)',
    tags: ['private'],
    content: `These notes belong to the second demo account. They exist so you can sign in
as the other user and confirm that retrieval never crosses account boundaries.
If you ever see this text while signed in as demo@example.com, row level
security is not doing its job.`,
  },
];

async function upsertUser(email) {
  const { data: list } = await admin.auth.admin.listUsers();
  const existing = list?.users?.find((u) => u.email === email);
  if (existing) return existing.id;

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: DEMO_PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser(${email}): ${error.message}`);
  return data.user.id;
}

async function main() {
  const ids = {};
  for (const u of USERS) {
    ids[u.email] = await upsertUser(u.email);
    console.log(`  user  ${u.email}`);
  }

  // Idempotent: wipe seeded documents so re-running produces the same state.
  await admin
    .from('documents')
    .delete()
    .in('owner_id', Object.values(ids));

  for (const doc of DOCUMENTS) {
    const { error } = await admin.from('documents').insert({
      owner_id: ids[doc.email],
      title: doc.title,
      content: doc.content,
      tags: doc.tags,
      status: 'queued',
    });
    if (error) throw new Error(`insert ${doc.title}: ${error.message}`);
    console.log(`  doc   ${doc.title}`);
  }

  console.log(`\nSeeded ${USERS.length} users and ${DOCUMENTS.length} documents.`);
  console.log(`Sign in with any of the emails above, password: ${DEMO_PASSWORD}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
