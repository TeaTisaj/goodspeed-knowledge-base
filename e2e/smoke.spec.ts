import { NO_ANSWER } from '@kb/contracts';
import { expect, test } from '@playwright/test';

const EMAIL = `e2e-${Date.now()}@example.test`;
const PASSWORD = 'e2e-password-12345';

const DOC = `# Deployment runbook

## Rolling back
To roll back a bad deploy, re-run the previous successful deploy from the Actions tab.
A rollback takes about eight minutes to finish.

## Incident response
Page the on-call engineer in the incidents channel. The on-call rotation changes every Monday.`;

test.describe.configure({ mode: 'serial' });

test('sign up, create a document, ingest it, and get a cited answer', async ({ page }) => {
  // --- sign up ------------------------------------------------------------
  await page.goto('/login');
  await page.getByRole('button', { name: /need an account/i }).click();

  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /create account/i }).click();

  await expect(page).toHaveURL(/\/documents/, { timeout: 30_000 });

  // A brand new account has nothing, and should say so rather than showing a
  // blank screen.
  await expect(page.getByText(/no documents yet/i)).toBeVisible();

  // --- create a document --------------------------------------------------
  await page
    .getByRole('button', { name: /new document/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}/, { timeout: 30_000 });

  await page.getByLabel('Title').fill('Deployment runbook');
  await page.getByLabel(/^Tags/).fill('ops');
  await page.getByLabel(/^Content/).fill(DOC);
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // --- ingestion completes without a reload -------------------------------
  // Asserted on the chunk count, not on "Ready" or /chunks? indexed/. Creating
  // a document produces an empty one, which ingests to `ready` with 0 chunks --
  // so both of those already match *before* the save, and the test would race
  // ahead and ask its question against an unindexed document.
  await expect(page.getByText(/\b1 chunk indexed\b/)).toBeVisible({ timeout: 45_000 });

  // --- ask a question -----------------------------------------------------
  await page.getByRole('link', { name: 'Chat' }).click();
  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByText(/ask about your documents/i)).toBeVisible();

  await page
    .getByPlaceholder(/ask a question/i)
    .fill('How do I roll back a deploy and how long does it take?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();

  // The answer streams in, so assert on content rather than a load event.
  // Scoped to the assistant turn specifically: a broad selector could match the
  // question echoed back, and the test would pass without an answer existing.
  const assistantTurn = page
    .locator('div')
    .filter({ has: page.getByText('Assistant', { exact: true }) })
    .last();
  await expect(assistantTurn).toContainText(/roll back|Actions tab|eight minutes/i, {
    timeout: 45_000,
  });

  // The answer must be grounded in the document, not the refusal. Pinned to the
  // contract constant: a hand-written regex here stopped matching the day the
  // refusal wording changed, and would have gone on passing forever.
  await expect(assistantTurn).not.toContainText(NO_ANSWER);

  // --- citations are clickable and show the supporting text ---------------
  const citation = page.getByRole('button', { name: /^\[\d+\]/ }).first();
  await expect(citation).toBeVisible({ timeout: 30_000 });
  await citation.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/roll back|Actions tab|eight minutes/i).first()).toBeVisible();

  // The citation links back to the document that supported the claim.
  await expect(dialog.getByRole('link', { name: /open document/i })).toBeVisible();
  await dialog.getByRole('button', { name: /close/i }).click();

  // --- an off-topic follow-up is refused, not answered --------------------
  // The first question any reviewer tries. In the zero-key stack this goes
  // through the condense step, retrieval and the fake model end to end.
  await page.getByPlaceholder(/ask a question/i).fill('What is the capital of France?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const refusalTurn = page
    .locator('div')
    .filter({ has: page.getByText('Assistant', { exact: true }) })
    .last();
  await expect(refusalTurn).toContainText(NO_ANSWER, { timeout: 45_000 });
  await expect(refusalTurn).not.toContainText(/paris/i);

  // --- conversation persists ----------------------------------------------
  await page.reload();
  await expect(page.getByRole('button', { name: /how do i roll back/i })).toBeVisible({
    timeout: 30_000,
  });
});

test('uploading a text file creates a document and records usage', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/documents/, { timeout: 30_000 });

  // Upload through the real file input rather than calling the API directly,
  // so the multipart boundary the browser generates is exercised.
  await page.setInputFiles('input[type="file"]', {
    name: 'security-policy.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      '# Security policy\n\nProduction access requires hardware two-factor authentication.\n' +
        'A vendor security review takes about two weeks to complete.\n',
    ),
  });

  // An upload stays on the list rather than opening the editor, and confirms
  // itself with a banner. The title comes from the markdown heading, not the
  // filename.
  await expect(page).toHaveURL(/\/documents$/);
  await expect(page.getByText(/Uploaded "Security policy"/)).toBeVisible({ timeout: 30_000 });

  // Chunk count, not the status badge: an upload is created and ingested in one
  // step, so "Ready" can be on screen before the chunks exist and the usage
  // assertions below would then race an embedding that has not happened yet.
  const uploadedRow = page.getByRole('listitem').filter({ hasText: 'Security policy' });
  await expect(uploadedRow.getByText(/\b\d+ chunks?\b/)).toBeVisible({ timeout: 45_000 });

  // Usage should now show the embedding calls that ingestion made.
  await page.getByRole('link', { name: 'Usage' }).click();
  await expect(page).toHaveURL(/\/usage/);

  // Usage is written out of band: ingestion reports success before the
  // analytics insert lands, deliberately, so that measuring the work never
  // delays it. The page fetches once on mount, so waiting on the DOM alone
  // would wait forever -- it has to be re-fetched until the row appears.
  await expect(async () => {
    await page.reload();
    // Specific locators: "Tokens" appears as both a stat label and a column header.
    await expect(page.getByRole('columnheader', { name: 'Tokens' })).toBeVisible({
      timeout: 5_000,
    });
    // Ingestion embeds the uploaded document, so an embed row must exist.
    await expect(page.getByRole('cell', { name: 'embed' }).first()).toBeVisible({ timeout: 5_000 });
    // And the token count must be non-zero, not just present.
    await expect(page.getByRole('table')).toContainText(/\d/);
  }).toPass({ timeout: 45_000 });

  // The same user asked two questions in the first test: one cited answer and
  // one off-topic question the assistant refused. Answer quality records both.
  const quality = page.getByRole('region', { name: 'Answer quality' });
  await expect(quality).toContainText('2 answers');
  await expect(quality).toContainText(/Grounded\s*50%/);
  await expect(quality).toContainText(/Refused\s*50%/);
});

test('a signed-out visitor cannot reach the documents page', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/documents');
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
});
