// SPDX-License-Identifier: MIT
/**
 * F-94-1 (docs/evidence/phase-9/wp9.4-upgrade.md, 18:00Z; fixed in WP 9.1).
 *
 * `docker/backup/backup.sh` ran
 *
 *     if ! printf '%s\n' "${TOC}" | grep -qE 'TABLE ... schema_migrations'; then
 *
 * under `set -o pipefail`. `grep -q` exits at its FIRST match; once the TOC is
 * larger than the 64 KiB pipe buffer, `printf` is still writing, dies of
 * SIGPIPE, and pipefail reports the pipeline as failed -- a match read as "did
 * not find the schema_migrations table -- refusing to promote it". 300 of 300
 * runs in isolation refused a perfectly good backup, and which runs fail
 * depends on the size of the dump, so a test with a small TOC never sees it.
 *
 * So the control is structural and permanent: no script in `docker/backup/` may
 * pipe into `grep -q` (or `--quiet`/`--silent`) under pipefail. Use
 * `grep ... >/dev/null`, which reads all its input, or a `[[ ... =~ ... ]]`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BACKUP_DIR = join(REPO_ROOT, 'docker', 'backup');

/** `| grep -q`, `| grep -qE`, `| grep -Eq`, `| grep --quiet`, `| grep --silent`, also via `egrep`/`fgrep`. */
const PIPE_INTO_QUIET_GREP =
  /\|\s*(?:e|f)?grep\s+(?:-[A-Za-z]*\s+)*(?:-[A-Za-z]*q[A-Za-z]*|--quiet|--silent)(?=\s|$)/u;

/** The line numbers (1-based) in `script` that pipe into a quiet grep, comment lines excluded. */
export function quietGrepPipes(script: string): number[] {
  return script
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => !/^\s*#/u.test(line) && PIPE_INTO_QUIET_GREP.test(line))
    .map(({ number }) => number);
}

const PIPEFAIL = /\bset\s+-[A-Za-z]*o\s+pipefail\b|\bset\s+-[A-Za-z]*e[A-Za-z]*o\s+pipefail\b/u;

describe('backup scripts never pipe into grep -q under pipefail (F-94-1)', () => {
  it('the detector sees the exact line F-94-1 found, and ignores the safe forms', () => {
    const bad = `if ! printf '%s\\n' "\${TOC}" | grep -qE 'TABLE[[:space:]]+public[[:space:]]+schema_migrations'; then`;
    expect(quietGrepPipes(bad)).toEqual([1]);
    expect(quietGrepPipes(`x | grep -q foo`)).toEqual([1]);
    expect(quietGrepPipes(`x | grep -Eq foo`)).toEqual([1]);
    expect(quietGrepPipes(`x | grep --quiet foo`)).toEqual([1]);
    expect(quietGrepPipes(`x | grep -E -q foo`)).toEqual([1]);
    // Safe: reads all its input, or no pipe at all, or only a comment.
    expect(quietGrepPipes(`x | grep -E foo >/dev/null`)).toEqual([]);
    expect(quietGrepPipes(`grep -q foo file`)).toEqual([]);
    expect(quietGrepPipes(`# x | grep -q foo (the rule, in a comment)`)).toEqual([]);
    expect(quietGrepPipes(`x | grep -c foo`)).toEqual([]);
  }, 30_000);

  it('neither backup.sh nor pre-migrate.sh pipes into grep -q while pipefail is set', () => {
    // The two scripts that read a `pg_restore --list` TOC, whose size is unbounded.
    // (`backup-loop.sh` has one `psql ... | grep -q 1`: psql prints a single
    // line there, far below the pipe buffer, so it cannot SIGPIPE. It is not
    // covered here and is recorded in the WP 9.1 evidence as an observation.)
    const scripts = ['backup.sh', 'pre-migrate.sh'].filter((name) =>
      readdirSync(BACKUP_DIR).includes(name),
    );
    expect(scripts).toEqual(['backup.sh', 'pre-migrate.sh']);
    const offenders: string[] = [];
    for (const name of scripts) {
      const text = readFileSync(join(BACKUP_DIR, name), 'utf8');
      if (!PIPEFAIL.test(text)) continue;
      for (const line of quietGrepPipes(text)) offenders.push(`docker/backup/${name}:${line}`);
    }
    expect(offenders, 'grep -q at the end of a pipe under pipefail (F-94-1)').toEqual([]);
  }, 30_000);
});
