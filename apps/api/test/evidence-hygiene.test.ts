// SPDX-License-Identifier: MIT
/**
 * **P0-10 evidence: no live credential may be committed, least of all to the
 * directory that exists to demonstrate the control working.**
 *
 * The Phase 0 security gate (§2.8) found a live single-use bootstrap enrolment
 * token pasted verbatim into `docs/evidence/phase-0/wp0.2-summary.md`, where it
 * had survived review, and a real `__Host-pfi_csrf` cookie value in the gate
 * report itself. gitleaks caught the first and missed the second, because
 * gitleaks matches rules about *providers*, and neither of those is a provider
 * credential — they are this application's own tokens, whose shape and spelling
 * only this repository knows.
 *
 * That gap is what this test closes, and it is why the test lives here rather
 * than in `.gitleaks.toml`: a scanner that only knows other people's secrets
 * cannot be the control for our own.
 *
 * **Shape plus context, not shape alone.** Every token this application mints —
 * `UserService.createRegistrationToken`, `mintToken` — is 32 random bytes in
 * base64url, 43 characters. That shape by itself is not evidence: a support-article
 * URL slug in `docs/research/01-aggregation-plaid.md` matches it exactly, and an
 * entropy threshold does not separate the two (the slug scores 4.19 bits/char
 * against a measured floor of 4.10 for real tokens over 200 000 samples). What
 * *is* evidence is a value of that shape sitting next to a word that says it is a
 * credential. `token=`, `token only:`, `set-cookie:` — the forms the CLI and the
 * HTTP layer actually print. That pairing has no false positives in this
 * repository and flagged all four of the gate's real findings.
 *
 * The non-vacuity guards matter more than usual. A "no secrets found" assertion
 * passes just as happily against a broken regex — which is exactly the defect the
 * gate found in the old `REDACTED_PATHS` test — so the first case mints real
 * tokens and plants them in the real output formats, and the last one checks the
 * sweep actually read a corpus.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomBytes } from '@core/secretbox';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** base64url of 32 bytes, bounded so a longer run does not match a window of itself. */
const TOKEN_SHAPE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

/** Words that turn a high-entropy blob into a credential. */
const CREDENTIAL_CONTEXT =
  /(token|secret|cookie|passphrase|password|bearer|authorization|api[_-]?key|credential)/i;

/** How far back to look for that context. One `set-cookie:` line's worth. */
const CONTEXT_WINDOW = 60;

/** Mint a token the way the application does, for the non-vacuity guards. */
function mintTokenLikeTheApplicationDoes(): string {
  return Buffer.from(randomBytes(32)).toString('base64url');
}

/** Every token-shaped value that a credential word vouches for. */
function findLeakedTokens(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(TOKEN_SHAPE)) {
    const index = match.index;
    const before = text.slice(Math.max(0, index - CONTEXT_WINDOW), index);
    if (CREDENTIAL_CONTEXT.test(before)) found.push(match[0]);
  }
  return found;
}

function markdownFilesUnder(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      out.push(...markdownFilesUnder(path));
    } else if (entry.endsWith('.md')) {
      out.push(path);
    }
  }
  return out;
}

describe('committed documentation carries no live token (P0-10)', () => {
  it('catches a freshly minted token in every format the application prints it', () => {
    // The exact lines `just bootstrap-user` and the HTTP layer emit. These are
    // the shapes that were actually committed.
    const formats = [
      (token: string) => `  http://127.0.0.1:8080/enrol#token=${token}`,
      (token: string) => `  token only: ${token}`,
      (token: string) => `set-cookie: __Host-pfi_csrf=${token}; Path=/; Secure; SameSite=Strict`,
      (token: string) => `Authorization: Bearer ${token}`,
      (token: string) => `the access_token is ${token} and it expires soon`,
    ];

    for (let attempt = 0; attempt < 32; attempt += 1) {
      const token = mintTokenLikeTheApplicationDoes();
      expect(token).toHaveLength(43);
      for (const format of formats) {
        expect(findLeakedTokens(format(token)), `missed a token in: ${format('<token>')}`).toEqual([
          token,
        ]);
      }
    }
  });

  it('does not fire on prose, a URL slug, a git SHA, or a digest', () => {
    // A detector that cries wolf gets an exemption list, and an exemption list is
    // how the next real token gets waved through. The first entry is a real line
    // from docs/research/01-aggregation-plaid.md: 43 characters of the right
    // alphabet, and not a secret.
    const innocuous = [
      '([Plaid](https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan))',
      'The quick brown fox jumps over the lazy dog, repeatedly and at some length.',
      'pinned at 376a9570e5d2c1b4a8f3e6d9c0b7a4e1f8d5c2b9 on main',
      'zricethezav/gitleaks:v8.30.0@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9',
    ];
    for (const text of innocuous) expect(findLeakedTokens(text)).toEqual([]);
  });

  it('finds no token in any committed markdown', () => {
    const offenders: string[] = [];
    for (const path of markdownFilesUnder(join(REPO_ROOT, 'docs'))) {
      const found = findLeakedTokens(readFileSync(path, 'utf8'));
      if (found.length === 0) continue;
      // The file and the count, never the value: a CI log is a log.
      offenders.push(`${relative(REPO_ROOT, path)} (${String(found.length)})`);
    }

    expect(
      offenders,
      'live-token-shaped values found next to credential wording in committed documentation. ' +
        'Redact them with an obviously fake placeholder AND invalidate the underlying ' +
        'credential — see docs/evidence/phase-0/gate-remediation-api.md.',
    ).toEqual([]);
  });

  it('scanned a non-trivial corpus, so an empty result means something', () => {
    // Guards the sweep against silently passing because `docs/` moved, the
    // recursion broke, or the extension filter stopped matching.
    expect(markdownFilesUnder(join(REPO_ROOT, 'docs')).length).toBeGreaterThan(10);
  });
});
