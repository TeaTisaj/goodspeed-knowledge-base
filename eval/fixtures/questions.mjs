/**
 * Questions with the exact answer span they require.
 *
 * Scoring is chunk-level: a retrieval is a hit only when a returned chunk
 * actually contains the answer span. Document-level scoring would be far more
 * forgiving and would not reflect what the model sees -- retrieving the right
 * document but the wrong chunk still produces an unanswerable prompt.
 */
export const QUESTIONS = [
  { q: 'How long does a rollback take?', doc: 'runbook', span: 'about eight minutes' },
  { q: 'How do I roll back a bad deploy?', doc: 'runbook', span: 'previous successful deploy from the Actions tab' },
  { q: 'When does the on-call rotation change?', doc: 'runbook', span: 'every Monday at 09:00 UTC' },
  { q: 'What happens when a database migration fails?', doc: 'runbook', span: 'aborts the deploy and leaves the previous version live' },
  { q: 'How long do feature flags stay around?', doc: 'runbook', span: 'removed within two weeks of full rollout' },

  { q: 'What was revenue last quarter?', doc: 'finance', span: '4.2 million dollars' },
  { q: 'How much did enterprise contribute?', doc: 'finance', span: 'Enterprise contributed 2.8 million' },
  { q: 'Did churn improve?', doc: 'finance', span: '2.1 percent, down from 3.4 percent' },
  { q: 'Why was self-serve revenue flat?', doc: 'finance', span: 'pricing change shipped in July' },
  { q: 'What could slip into next quarter?', doc: 'finance', span: '400 thousand could slip into Q1' },

  { q: 'What do I run on my first day?', doc: 'onboarding', span: 'make bootstrap in the platform repository' },
  { q: 'Why is the first bootstrap slow?', doc: 'onboarding', span: 'downloads container images' },
  { q: 'How many approvals does a pull request need?', doc: 'onboarding', span: 'one approving review' },
  { q: 'How fast should reviewers respond?', doc: 'onboarding', span: 'within one business day' },

  { q: 'Is two-factor required for production?', doc: 'security', span: 'hardware two-factor authentication' },
  { q: 'What if a secret is committed to git?', doc: 'security', span: 'treated as compromised and must be rotated' },
  { q: 'What counts as severity one?', doc: 'security', span: 'customer data is at risk' },
  { q: 'How long does a vendor security review take?', doc: 'security', span: 'about two weeks' },
  { q: 'What happens to unused production access?', doc: 'security', span: 'ninety days is revoked automatically' },

  { q: 'Why did search return empty results?', doc: 'retro', span: 'without rebuilding the vector index' },
  { q: 'How long was the search outage?', doc: 'retro', span: 'approximately 47 minutes' },
  { q: 'Why was the outage not caught sooner?', doc: 'retro', span: 'query succeeded while returning zero rows' },
  { q: 'What alerting changed afterwards?', doc: 'retro', span: 'alert on empty-result rate' },

  { q: 'How quickly must we respond to a paying customer?', doc: 'support', span: 'four business hours' },
  { q: 'When do we escalate to engineering?', doc: 'support', span: 'more than ten accounts' },
  { q: 'How large a refund can I approve alone?', doc: 'support', span: 'five hundred dollars' },

  { q: 'How long is customer content kept after closure?', doc: 'data', span: 'thirty days after account closure' },
  { q: 'How long are application logs retained?', doc: 'data', span: 'retained for fourteen days' },
  { q: 'How long do we keep database backups?', doc: 'data', span: 'thirty-five days' },

  { q: 'Do we use microservices?', doc: 'architecture', span: 'modular monolith rather than microservices' },
  { q: 'Where are background jobs queued?', doc: 'architecture', span: 'queued in Postgres, not Redis' },
  { q: 'Is there a shared cache tier?', doc: 'architecture', span: 'no shared cache tier' },

  // Keyword-shaped queries, to exercise the full-text arm specifically.
  { q: 'index scanned before filter applied fewer rows', doc: 'retro', span: 'scanned before the filter was applied' },
  { q: 'guided setup churn rate comparison', doc: 'finance', span: 'guided setup churned at a third the rate' },
  { q: 'hardware two-factor production access', doc: 'security', span: 'hardware two-factor authentication' },
];
