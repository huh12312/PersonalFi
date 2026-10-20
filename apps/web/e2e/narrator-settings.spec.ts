// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations, scanBothThemes, setTheme } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { Journey } from './support/keyboard.ts';
import { installApiMocks, type MockApiState } from './support/mock-api.ts';
import { seedControlCheckRun } from './support/mock-narrator.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools, visit } from './support/sweep.ts';
import { installVirtualPasskey } from './support/virtual-passkey.ts';

/**
 * WP 10.6: Settings › Language model - Chris's "bring your own api key" for the narrator, by keyboard, against
 * `support/mock-narrator.ts` (through `installApiMocks`, with the api's rules and real state) and a real CDP
 * virtual authenticator for the passkey step-up (`support/virtual-passkey.ts`, the WP 10.4 keyboard journey's).
 *
 * The journey: save an Anthropic key (masked, emptied, never echoed), tick Anthropic's consent, Test it (the
 * result in words in a live region), make it the narrator, and read that the narrator's payload approval was
 * withdrawn, with the way to Advisor management.
 *
 * `evidenceDir` (C-16, O-3): a gitignored directory by default; `PLAYWRIGHT_EVIDENCE_DIR=docs/evidence/phase-10`
 * writes the committed `wp10.6-settings-language-model-{light,dark}.png` on purpose.
 */

interface EvidenceDirOptions {
  readonly evidenceDir?: string;
}

const test = base.extend<EvidenceDirOptions>({
  evidenceDir: [undefined, { option: true }],
});

const KEY = 'e2eAnthropicKey0123456789abcdQ7Zk'; // gitleaks:allow — synthetic canary, not an Anthropic key

function writes(api: MockApiState): string[] {
  return api.narrator.calls.filter((call) => !call.startsWith('GET'));
}

async function openLanguageModel(page: Page, journey: Journey): Promise<void> {
  // The tab list is one stop; arrows move along it and Enter chooses.
  await journey.tabTo(/^(Rules|Notifications|Market data|Language model|Crypto|Security)$/, {
    max: 40,
  });
  for (let n = 0; n < 6 && !/^Language model$/.test(await journey.focusedName()); n += 1) {
    await journey.press('ArrowRight', 'ArrowRight along the tabs');
  }
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Language model' })).toBeVisible();
  await expect(page.getByTestId('narrator-card-anthropic')).toBeVisible();
}

test.describe('Settings › Language model (WP 10.6)', () => {
  // The settings pane scrolls inside the app frame; a tall viewport keeps the section in one picture.
  test.use({ viewport: { width: 1280, height: 2200 } });

  test('by keyboard: save an Anthropic key with a passkey, tick its consent, Test it, make it the narrator, and read that the payload approval was withdrawn', async ({
    page,
    context,
    evidenceDir,
  }) => {
    test.setTimeout(150_000);
    const api = await installApiMocks(page);
    const passkey = await installVirtualPasskey(page, context);
    await visit(page, '/settings');
    await hideDevtools(page);
    const journey = new Journey(page, 'language model');
    await openLanguageModel(page, journey);

    const active = page.getByTestId('narrator-active');
    const anthropic = page.getByTestId('narrator-card-anthropic');
    const radio = page.getByRole('radio', { name: /^Anthropic/ });
    await expect(active).toHaveText('Narrating with the local model qwen2.5:7b-instruct-q4_K_M.');
    await expect(anthropic).toContainText('Not set.');
    await expect(anthropic).toContainText('Talks only to api.anthropic.com.');
    // W1: not a choice until it has both a consent and a key - and it says so.
    await expect(radio).toBeDisabled();
    await expect(
      page.getByText("Tick Anthropic's consent and save a key on its card first."),
    ).toBeVisible();
    await expectNoAxeViolations(page, 'settings › language model, as found (light)');

    // 1. The key: Tab to the masked field, type, Save with passkey (a real assertion), emptied, focus back.
    const field = anthropic.getByLabel('Anthropic API key');
    await expect(field).toHaveAttribute('type', 'password');
    const stop = await journey.tabTo(/^Anthropic API key$/, { max: 60 });
    expect(stop.type).toBe('password');
    await journey.type(KEY);
    await journey.tabTo(/^Save with passkey$/, { max: 3 });
    await passkey.respond(true);
    await page.keyboard.press('Enter');
    await expect(anthropic).toContainText(`ends in ${KEY.slice(-4)}`, { timeout: 15_000 });
    await journey.expectFocus(/^Anthropic API key$/, 'focus returns to the emptied key field');
    await expect(field).toHaveValue('');
    expect(passkey.assertions(), 'the save crossed the passkey step-up').toBeGreaterThan(0);
    expect(api.narrator.keyBodies).toEqual([{ key: KEY }]);
    expect(await page.content()).not.toContain(KEY);

    // 2. The consent: its label is the api's text, exactly; Space ticks it (the session is fresh by now).
    const consent = anthropic.getByRole('checkbox');
    await expect(consent).toHaveAccessibleName(
      /^Send the narrator's payload to Anthropic \(api\.anthropic\.com\) with my own key\. What leaves this machine: Brief findings: aggregated amounts, bucketed, merchants pseudonymised — never a transaction, never an account number\./,
    );
    await journey.tabTo(/^Send the narrator's payload to Anthropic/, { max: 6, backwards: true });
    await page.keyboard.press('Space');
    await expect(consent).toBeChecked({ timeout: 15_000 });
    await journey.expectFocus(
      /^Send the narrator's payload to Anthropic/,
      'focus stays on the consent',
    );
    await expect(radio).toBeEnabled();

    // 3. Test: the api's result in words, in a polite live region; focus stays on the button.
    await journey.tabTo(/^Test Anthropic$/, { max: 12 });
    await page.keyboard.press('Enter');
    const result = anthropic.getByTestId('narrator-test-anthropic');
    await expect(result).toHaveAttribute('aria-live', 'polite');
    await expect(result).toContainText(
      "Test passed. Anthropic answered in 412 ms with claude-sonnet-5-5, in the narration's reply format. Nothing personal was sent.",
    );
    await journey.expectFocus(/^Test Anthropic$/, 'focus is back on Test after the run');

    // 4. Make it the narrator: back to the radio group, arrows to Anthropic, Tab to "Use this provider", Enter.
    await journey.tabTo(/^Ollama \(local\)/, { max: 60, backwards: true });
    for (let n = 0; n < 4 && !/^Anthropic/.test(await journey.focusedName()); n += 1) {
      await journey.press('ArrowDown', 'ArrowDown along the providers');
    }
    await expect(radio).toBeChecked();
    await journey.tabTo(/^Use this provider$/, { max: 3 });
    await page.keyboard.press('Enter');
    const form = page.getByTestId('narrator-active-form');
    await expect(form.getByRole('status')).toContainText(
      'Saved. Narrating with Anthropic claude-sonnet-5-5.',
    );
    const note = page.getByTestId('narrator-approvals-withdrawn');
    await expect(note).toHaveText(
      "The narrator's payload approval was withdrawn: approve the payload again under Anthropic claude-sonnet-5-5 in Advisor management.",
    );
    await expect(note.getByRole('link', { name: 'Advisor management' })).toHaveAttribute(
      'href',
      '/settings/advisors',
    );
    await expect(active).toHaveText('Narrating with Anthropic claude-sonnet-5-5.');
    await journey.expectFocus(/^Anthropic/, 'focus returns to the chosen provider after the save');

    // The order of the writes: refused for want of a step-up, the retry, the consent, the test, the switch.
    expect(writes(api)).toEqual([
      'PUT /api/narrator/providers/anthropic/credentials',
      'PUT /api/narrator/providers/anthropic/credentials',
      'PUT /api/narrator/providers/anthropic/consent',
      'POST /api/narrator/providers/anthropic/test',
      'PUT /api/narrator/settings',
    ]);
    expect(api.narrator.activeProvider).toBe('anthropic');

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expectNoAxeViolations(
        page,
        `settings › language model, Anthropic narrating (${theme})`,
      );
      await page.screenshot({
        path: `${screenshotDir(evidenceDir)}wp10.6-settings-language-model-${theme}.png`,
        fullPage: true,
      });
    }
    await setTheme(page, 'light');
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test("Off says the Brief keeps its own wording; the operator's file is read-only; a stored key is removed only through a confirmation", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const api = await installApiMocks(page);
    await installFakeWebAuthnAssertion(page);
    await visit(page, '/settings');
    await page.getByRole('tab', { name: 'Language model' }).click();
    await expect(page.getByTestId('narrator-card-openai')).toBeVisible();

    // W7: the operator's file: no key field, no Save, no Remove.
    const openai = page.getByTestId('narrator-card-openai');
    await expect(openai).toContainText("Set by the operator's secret file");
    await expect(openai.locator('input[type="password"]')).toHaveCount(0);
    await expect(openai.getByRole('button', { name: 'Remove' })).toHaveCount(0);

    // W5: Remove asks first.
    const openrouter = page.getByTestId('narrator-card-openrouter');
    await openrouter.getByRole('button', { name: 'Remove' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove the stored OpenRouter key?' });
    await expect(dialog).toBeVisible();
    expect(writes(api)).toEqual([]);
    await scanBothThemes(page, 'settings › language model › confirm remove');
    await dialog.getByRole('button', { name: 'Remove key' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(openrouter.getByTestId('narrator-key-openrouter-status')).toHaveText('Not set.');

    // W10: Off.
    await page.getByRole('radio', { name: /^Off/ }).check();
    await page.getByRole('button', { name: 'Use this provider' }).click();
    await expect(page.getByTestId('narrator-active-form').getByRole('status')).toContainText(
      'Saved. Off: the Brief shows its own wording.',
    );
    await expect(page.getByTestId('narrator-active')).toHaveText(
      'Off: the Brief shows its own wording.',
    );
    expect(api.narrator.activeProvider).toBe('off');
    await scanBothThemes(page, 'settings › language model, off');
  });
});

// ---------------------------------------------------------------------------
// WP 10.16: Run control checks
// ---------------------------------------------------------------------------

const LOCAL_COST =
  'This runs up to 3 short probes on the local model through the worker; it can take a few minutes. Nothing leaves this machine.';

/**
 * WP 10.16: Settings › Language model › Control checks - Chris's "a 'Run control checks' button on the Language
 * model screen would exercise every control against your live instance with your own session". Against
 * `support/mock-narrator.ts`'s control-checks machine (202 with eleven pending checks; each read moves the run on by
 * three; the api's ten-minute 409), with a real CDP virtual authenticator for the passkey step-up.
 */
test.describe('Settings › Language model › Control checks (WP 10.16)', () => {
  test.use({ viewport: { width: 1280, height: 2200 } });

  test('WP 10.16: the cost is said first; Run control checks crosses the passkey step-up; the rows tick over to the final table and the run is in the history', async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    const api = await installApiMocks(page);
    const passkey = await installVirtualPasskey(page, context);
    await visit(page, '/settings');
    await hideDevtools(page);
    await page.getByRole('tab', { name: 'Language model' }).click();
    const section = page.getByTestId('control-checks');
    await expect(section.getByRole('heading', { name: 'Control checks' })).toBeVisible();

    // The cost, verbatim, before the button.
    const cost = section.getByTestId('control-checks-cost');
    await expect(cost).toHaveText(LOCAL_COST);
    // By its test id: its name reads "Running control checks…" while a run goes.
    const button = section.getByTestId('control-checks-run');
    await expect(button).toHaveAccessibleName('Run control checks');
    const costFirst = await cost.evaluate(
      (el, id) =>
        Boolean(
          el.compareDocumentPosition(document.querySelector(`[data-testid="${id}"]`) as Node) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      'control-checks-run',
    );
    expect(costFirst, 'the cost precedes the button').toBe(true);
    await expect(section.getByTestId('control-checks-never')).toHaveText(
      'The controls have not been checked on this install yet.',
    );

    await passkey.respond(true);
    await button.click();
    const live = section.getByTestId('control-checks-progress');
    await expect(live).toHaveAttribute('role', 'status');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toContainText(/Running control checks… \d+ of 11 checks done\./, {
      timeout: 15_000,
    });
    expect(passkey.assertions(), 'the run crossed the passkey step-up').toBeGreaterThan(0);
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAccessibleName('Running control checks…');
    // The rows tick over: some running while others still wait.
    const table = section.getByTestId('control-checks-table');
    await expect(table.locator('tbody tr[data-status="running"]').first()).toBeVisible();
    await expect(table.locator('tbody tr[data-status="pending"]').first()).toBeVisible();
    await expect(
      table.getByTestId('control-check-facts').getByText('Waiting to run.').first(),
    ).toBeVisible();

    await expect(live).toHaveText(
      'Control checks finished. Result: Partial: some checks could not run.',
      { timeout: 20_000 },
    );
    await expect(table.locator('tbody tr')).toHaveCount(11);
    await expect(
      table.locator('tbody tr[data-status="pending"], tbody tr[data-status="running"]'),
    ).toHaveCount(0);
    const result = (id: string) =>
      table.getByTestId(`control-check-${id}`).getByTestId('control-check-result');
    await expect(result('approval_gate')).toHaveText('Pass');
    await expect(result('consent_withdrawal')).toHaveText('Not applicable');
    await expect(result('inspector_digest')).toHaveText('Skipped');
    await expect(result('module_switch')).toHaveText('Reported');
    await expect(table.getByTestId('control-check-inspector_digest')).toContainText(
      'No narration has run yet with its payload retained (the last 30 days).',
    );
    await expect(table.getByTestId('control-check-kill_level_4_cancel')).toContainText('1.8 s');
    await expect(section.getByTestId('control-checks-summary')).toContainText(
      'Result: Partial: some checks could not run. 7 passed, 1 skipped, 2 not applicable, 1 reported.',
    );
    await expect(section.getByTestId('control-checks-wait')).toHaveText(
      /^You can run the checks again at \d{2}:\d{2}\.$/,
    );
    await expect(button).toHaveText('Run control checks');
    await expect(button).toHaveAttribute('aria-disabled', 'true');

    // The history: the run, its result in words; opening it shows its table.
    const history = section.getByTestId('control-checks-history');
    const summary = history.locator('summary');
    await expect(summary).toHaveCount(1);
    await expect(summary).toHaveText(
      /\(latest\) · Ollama \(local\), qwen2\.5:7b-instruct-q4_K_M at sha256:3f3f3f3f3f3f… · Partial: some checks could not run$/,
    );
    await summary.click();
    await expect(history.getByRole('table')).toBeVisible();
    await expect(history.getByRole('table').locator('tbody tr')).toHaveCount(11);

    // Refused once for want of a step-up, then the retry; the body asks for nothing extra.
    expect(api.narrator.controlChecks.calls.filter((c) => c.startsWith('POST'))).toEqual([
      'POST /api/narrator/control-checks',
      'POST /api/narrator/control-checks',
    ]);
    expect(api.narrator.controlChecks.bodies).toEqual([{}]);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('WP 10.16: kill switch 1 is proven only when asked, and a second run inside ten minutes is the api’s 409 in words', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const api = await installApiMocks(page);
    await installFakeWebAuthnAssertion(page);
    // A screen that does not know about the window (an older list): the api's own 409 is what stops the run.
    api.narrator.controlChecks.reportWindow = false;
    api.narrator.controlChecks.advancePerRead = 11;
    await visit(page, '/settings');
    await page.getByRole('tab', { name: 'Language model' }).click();
    const section = page.getByTestId('control-checks');
    await section
      .getByRole('checkbox', {
        name: 'Also prove kill switch 1 (turns the module off inside a transaction that is rolled back)',
      })
      .check();
    await section.getByRole('button', { name: 'Run control checks' }).click();
    const live = section.getByTestId('control-checks-progress');
    await expect(live).toHaveText(
      'Control checks finished. Result: Partial: some checks could not run.',
      {
        timeout: 20_000,
      },
    );
    expect(api.narrator.controlChecks.bodies).toEqual([{ proveSwitch: true }]);
    await expect(
      section
        .getByTestId('control-checks-table')
        .getByTestId('control-check-module_switch')
        .getByTestId('control-check-result'),
    ).toHaveText('Pass');

    await section.getByRole('button', { name: 'Run control checks' }).click();
    await expect(live).toHaveText(
      /^The controls were checked less than 10 minutes ago\. Try again in \d+ min\.$/,
    );
    await expect(section.getByRole('alert')).toHaveCount(0);
    expect(api.narrator.controlChecks.runs).toHaveLength(1);
  });
});

/**
 * WP 10.16 evidence: the results table on Settings › Language model, light and dark, at 1280 and 390. A finished run
 * is seeded (the passing one, kill switch 1 proven) over an older partial one, so the picture is the same every time.
 * `evidenceDir` unset writes to the gitignored directory; `PLAYWRIGHT_EVIDENCE_DIR` writes
 * `wp10.16-settings-control-checks-{light,dark}-{1280,390}.png` on purpose.
 */
test('WP 10.16 evidence: Settings › Language model › Control checks, light and dark, at 1280 and 390', async ({
  page,
  evidenceDir,
}) => {
  test.setTimeout(120_000);
  const api = await installApiMocks(page);
  seedControlCheckRun(api.narrator.controlChecks, {
    finishedAt: '2026-10-12T09:41:07.000Z',
    overall: 'partial',
  });
  seedControlCheckRun(api.narrator.controlChecks, {
    finishedAt: '2026-10-19T14:22:09.000Z',
    overall: 'pass',
  });
  // Tall viewports: the settings pane scrolls inside the app frame, and a section scrolled into view sits under the
  // sticky header, so the whole Language model tab is laid out at once and the section is cut from it.
  for (const [width, height] of [
    [1280, 3600],
    [390, 7600],
  ] as const) {
    await page.setViewportSize({ width, height });
    await visit(page, '/settings');
    await hideDevtools(page);
    await page.getByRole('tab', { name: 'Language model' }).click();
    const section = page.getByTestId('control-checks');
    await expect(section.getByTestId('control-checks-table')).toBeVisible();
    await expect(section.getByTestId('control-checks-summary')).toContainText('Result: Pass.');
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await section.screenshot({
        path: `${screenshotDir(evidenceDir)}wp10.16-settings-control-checks-${theme}-${String(width)}.png`,
        animations: 'disabled',
      });
    }
    await setTheme(page, 'light');
  }
});
