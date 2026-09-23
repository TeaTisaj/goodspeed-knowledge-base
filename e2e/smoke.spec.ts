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
  await page.getByRole('button', { name: /new document/i }).first().click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}/, { timeout: 30_000 });

  await page.getByLabel('Title').fill('Deployment runbook');
  await page.getByLabel(/^Tags/).fill('ops');
  await page.getByLabel(/^Content/).fill(DOC);
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // --- ingestion completes without a reload -------------------------------
  await expect(page.getByText('Ready')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/chunk(s)? indexed/)).toBeVisible();

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

  // The answer must be grounded in the document, not a generic refusal.
  await expect(assistantTurn).not.toContainText(/could not find|do not contain/i);

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

  // --- conversation persists ----------------------------------------------
  await page.reload();
  await expect(page.getByRole('button', { name: /how do i roll back/i })).toBeVisible({
    timeout: 30_000,
  });
});

test('a signed-out visitor cannot reach the documents page', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/documents');
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
});
