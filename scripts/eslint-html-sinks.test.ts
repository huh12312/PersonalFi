// SPDX-License-Identifier: MIT
/**
 * G-15 (WP 9.10, ASVS V1.2 / V3.2.2; fixed in WP 9.14): React's escaping is the web app's only XSS control, and
 * nothing guarded it. The repo's ESLint config now bans the raw-HTML sinks in `apps/web/src`; this runs the
 * REAL config over text that uses each one and over text that does not, so the ban is seen to fire and a
 * config edit that drops it is seen to fail here.
 */
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const eslint = new ESLint({ cwd: ROOT });

async function messages(code: string, file = 'apps/web/src/features/x/Probe.tsx') {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, file) });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax');
}

describe('the raw-HTML sink ban in apps/web/src', () => {
  it.each([
    [
      'dangerouslySetInnerHTML',
      'export const A = (p: { h: string }) => <div dangerouslySetInnerHTML={{ __html: p.h }} />;',
    ],
    [
      'an innerHTML assignment',
      'export function f(el: HTMLElement, h: string) { el.innerHTML = h; }',
    ],
    [
      'an outerHTML assignment',
      'export function f(el: HTMLElement, h: string) { el.outerHTML = h; }',
    ],
    [
      'insertAdjacentHTML',
      "export function f(el: HTMLElement, h: string) { el.insertAdjacentHTML('beforeend', h); }",
    ],
    [
      'createContextualFragment',
      'export function f(r: Range, h: string) { return r.createContextualFragment(h); }',
    ],
    [
      'DOMParser.parseFromString',
      "export function f(p: DOMParser, h: string) { return p.parseFromString(h, 'text/html'); }",
    ],
    ['document.write', 'export function f(h: string) { document.write(h); }'],
  ])(
    'refuses %s',
    async (_name, code) => {
      const found = await messages(code);
      expect(found).toHaveLength(1);
      expect(found[0]?.message).toContain('G-15');
    },
    60_000,
  );

  it('does not trip on ordinary React and DOM code', async () => {
    const found = await messages(
      "export const A = ({ t }: { t: string }) => <p>{t}</p>;\nexport function f(el: HTMLElement) { el.textContent = 'x'; el.setAttribute('data-x', 'y'); }",
    );
    expect(found).toHaveLength(0);
  }, 60_000);

  it('is scoped to the web app: the e2e harness may build canary DOM with innerHTML', async () => {
    const found = await messages(
      'export function f(el: HTMLElement) { el.innerHTML = "<b></b>"; }',
      'apps/web/e2e/probe.ts',
    );
    expect(found).toHaveLength(0);
  }, 60_000);
});

describe('G-28 and G-18: the other properties that held only by reading', () => {
  it('refuses sql.raw and a spawned shell in server code', async () => {
    const raw = await messages(
      "import { sql } from 'drizzle-orm';\nexport const q = (t: string) => sql.raw(`SELECT * FROM ${t}`);",
      'apps/api/src/routes/probe.ts',
    );
    expect(raw).toHaveLength(1);
    expect(raw[0]?.message).toContain('G-28');
    const shell = await messages(
      "import { spawn } from 'node:child_process';\nexport const p = (c: string) => spawn(c, [], { shell: true });",
      'packages/platform/src/probe.ts',
    );
    expect(shell).toHaveLength(1);
    expect(shell[0]?.message).toContain('G-28');
  }, 60_000);

  it('keeps the wall-clock rule where it was (the new selectors extend it, they do not replace it)', async () => {
    const found = await messages(
      'export const now = () => Date.now();',
      'packages/contexts/identity/src/probe.ts',
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('Clock');
  }, 60_000);

  it('refuses Math.random where secrets are minted, and only there', async () => {
    for (const file of [
      'packages/contexts/identity/src/probe.ts',
      'packages/secretbox/src/probe.ts',
      'apps/api/src/auth/probe.ts',
    ]) {
      const found = await messages('export const n = () => Math.random();', file);
      expect(found, file).toHaveLength(1);
      expect(found[0]?.message).toContain('G-18');
    }
    // Backoff jitter is not a secret.
    expect(
      await messages('export const j = () => Math.random();', 'packages/platform/src/probe.ts'),
    ).toHaveLength(0);
  }, 60_000);

  it('refuses browser-storage writes in the web app except in the two files that own them', async () => {
    const code = "export function f() { window.localStorage.setItem('k', 'v'); }";
    const refused = await messages(code, 'apps/web/src/features/x/probe.ts');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.message).toContain('G-28');
    expect(await messages(code, 'apps/web/src/lib/persisted-store.ts')).toHaveLength(0);
    expect(await messages(code, 'apps/web/src/app/shell/Sidebar.tsx')).toHaveLength(0);
    // The allow-listed files keep the HTML-sink ban.
    expect(
      await messages(
        'export function f(el: HTMLElement) { el.innerHTML = "x"; }',
        'apps/web/src/lib/persisted-store.ts',
      ),
    ).toHaveLength(1);
  }, 60_000);
});
