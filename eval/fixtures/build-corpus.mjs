/**
 * Builds the eval corpus.
 *
 * Generated rather than hand-written for one reason: the documents have to be
 * long enough that chunking actually changes the answer. The first version of
 * this harness used five short documents, every configuration scored 100%, and
 * it measured nothing at all.
 *
 * Each document interleaves a handful of *answer-bearing* sentences with
 * plausible filler on the same topic. The filler matters: it is what forces
 * retrieval to discriminate within a document rather than just between them.
 */

const FILLER = [
  'This section is reviewed each quarter and updated when the process changes.',
  'Exceptions require sign-off from the owning team and are recorded in the decision log.',
  'Historical records are retained for ninety days and then archived automatically.',
  'If anything here conflicts with the team handbook, the handbook takes precedence.',
  'Questions about this section should go to the owning team rather than the general channel.',
  'The process below has been stable since the last reorganisation and is unlikely to change soon.',
  'Related guidance lives in the internal wiki, which is linked from the team homepage.',
  'Anyone can propose a change by opening a pull request against this document.',
  'Metrics for this area are reviewed in the monthly operations meeting.',
  'Training material covering this topic is available in the learning portal.',
];

function pad(seed, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(FILLER[(seed + i) % FILLER.length]);
  return out.join(' ');
}

/** section = { heading, facts: [...] } — facts are what questions target. */
function renderDoc(doc) {
  const parts = [`# ${doc.title}`];
  doc.sections.forEach((s, i) => {
    // Enough filler that a document spans several chunks at 512 tokens.
    // Without that, chunk size cannot affect the result and the ablation is
    // measuring nothing.
    parts.push(
      `## ${s.heading}\n\n${pad(i, 8)}\n\n${s.facts.join(' ')}\n\n${pad(i + 5, 8)}`,
    );
  });
  return parts.join('\n\n');
}

export const DOCS = [
  {
    id: 'runbook',
    title: 'Deployment runbook',
    tags: ['ops'],
    sections: [
      { heading: 'Rolling back', facts: [
        'To roll back a bad deploy, re-run the previous successful deploy from the Actions tab.',
        'A rollback takes about eight minutes end to end.' ] },
      { heading: 'Incident response', facts: [
        'Page the on-call engineer in the incidents channel.',
        'The on-call rotation changes every Monday at 09:00 UTC.' ] },
      { heading: 'Database migrations', facts: [
        'A failed migration aborts the deploy and leaves the previous version live.',
        'Migrations must be backwards compatible with the previous release.' ] },
      { heading: 'Feature flags', facts: [
        'Flags are removed within two weeks of full rollout.' ] },
      { heading: 'Release cadence', facts: [
        'We deploy on demand rather than on a fixed schedule.' ] },
    ],
  },
  {
    id: 'finance',
    title: 'Q3 financial summary',
    tags: ['finance'],
    sections: [
      { heading: 'Revenue', facts: [
        'Total revenue for Q3 was 4.2 million dollars, up 18 percent from Q2.' ] },
      { heading: 'Breakdown by tier', facts: [
        'Enterprise contributed 2.8 million, self-serve 1.1 million.',
        'Self-serve revenue was flat because of the pricing change shipped in July.' ] },
      { heading: 'Churn', facts: [
        'Gross churn was 2.1 percent, down from 3.4 percent in Q2.',
        'Accounts that completed guided setup churned at a third the rate of those that skipped it.' ] },
      { heading: 'Outlook', facts: [
        'Two enterprise renewals worth a combined 400 thousand could slip into Q1.' ] },
      { heading: 'Headcount', facts: [
        'Engineering grew by six people during the quarter.' ] },
    ],
  },
  {
    id: 'onboarding',
    title: 'Engineering onboarding',
    tags: ['hr', 'engineering'],
    sections: [
      { heading: 'First day', facts: [
        'Run make bootstrap in the platform repository.',
        'It takes about fifteen minutes on a first run because it downloads container images.' ] },
      { heading: 'Development workflow', facts: [
        'Every pull request needs one approving review before merge.' ] },
      { heading: 'Code review', facts: [
        'Reviewers are expected to respond within one business day.' ] },
      { heading: 'Who to ask', facts: [
        'Urgent customer-facing issues go to the incidents channel.' ] },
      { heading: 'Equipment', facts: [
        'Laptops are replaced every three years.' ] },
    ],
  },
  {
    id: 'security',
    title: 'Security policy',
    tags: ['security', 'ops'],
    sections: [
      { heading: 'Access control', facts: [
        'Production access requires hardware two-factor authentication.',
        'Access unused for ninety days is revoked automatically.' ] },
      { heading: 'Secrets', facts: [
        'A secret committed to git is treated as compromised and must be rotated.' ] },
      { heading: 'Incident severity', facts: [
        'Severity one means customer data is at risk or the product is fully unavailable.' ] },
      { heading: 'Vendor review', facts: [
        'A vendor security review takes about two weeks.' ] },
      { heading: 'Reporting', facts: [
        'Suspected vulnerabilities go to the security channel, never a public issue.' ] },
    ],
  },
  {
    id: 'retro',
    title: 'Incident retrospective: search outage',
    tags: ['ops', 'engineering'],
    sections: [
      { heading: 'What happened', facts: [
        'Search returned empty results for approximately 47 minutes.' ] },
      { heading: 'Root cause', facts: [
        'A filter was added to the retrieval query without rebuilding the vector index.',
        'The index was scanned before the filter was applied, so it returned fewer rows than requested.' ] },
      { heading: 'Why detection was slow', facts: [
        'Alerting watched error rates, and the query succeeded while returning zero rows.' ] },
      { heading: 'Actions taken', facts: [
        'We now alert on empty-result rate, not just error rate.' ] },
      { heading: 'Lesson', facts: [
        'A silent wrong answer is more dangerous than a loud failure.' ] },
    ],
  },
  {
    id: 'support',
    title: 'Customer support playbook',
    tags: ['support'],
    sections: [
      { heading: 'Response targets', facts: [
        'First response to a paying customer is due within four business hours.' ] },
      { heading: 'Escalation', facts: [
        'Escalate to engineering when a problem affects more than ten accounts.' ] },
      { heading: 'Refunds', facts: [
        'Refunds up to five hundred dollars can be approved without a manager.' ] },
      { heading: 'Tone', facts: [
        'Acknowledge the problem before explaining the cause.' ] },
      { heading: 'Handover', facts: [
        'Unresolved tickets are handed over in writing at the end of each shift.' ] },
    ],
  },
  {
    id: 'data',
    title: 'Data retention standard',
    tags: ['security', 'data'],
    sections: [
      { heading: 'Customer data', facts: [
        'Customer content is deleted thirty days after account closure.' ] },
      { heading: 'Logs', facts: [
        'Application logs are retained for fourteen days.' ] },
      { heading: 'Backups', facts: [
        'Database backups are kept for thirty-five days and tested monthly.' ] },
      { heading: 'Analytics', facts: [
        'Aggregated analytics contain no personally identifying fields.' ] },
      { heading: 'Deletion requests', facts: [
        'A verified deletion request is completed within seven days.' ] },
    ],
  },
  {
    id: 'architecture',
    title: 'Platform architecture overview',
    tags: ['engineering'],
    sections: [
      { heading: 'Services', facts: [
        'The platform is a modular monolith rather than microservices.' ] },
      { heading: 'Database', facts: [
        'We run a single primary Postgres with one read replica.' ] },
      { heading: 'Background work', facts: [
        'Jobs are queued in Postgres, not Redis.' ] },
      { heading: 'Caching', facts: [
        'There is no shared cache tier; caching is per-process and short-lived.' ] },
      { heading: 'Scaling', facts: [
        'Read replicas are added before any attempt at sharding.' ] },
    ],
  },
];

export const CORPUS = DOCS.map((d) => ({
  id: d.id,
  title: d.title,
  tags: d.tags,
  content: renderDoc(d),
}));
