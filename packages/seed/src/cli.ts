// SPDX-License-Identifier: MIT
/**
 * `just seed-stats` and the general-purpose seed CLI.
 *
 *   node packages/seed/src/cli.ts --seed=1 --stats
 *   node packages/seed/src/cli.ts --seed=1 --out=/tmp/demo-seed
 *
 * Argv only, never `process.env` (CONVENTIONS.md restricts that to
 * `@core/config`, and a CLI's flags are the correct place for this anyway —
 * `--seed` should be visible in a shell history, not hidden in an exported
 * variable).
 */
import { generateDemoData } from './generate.ts';
import { computeStats, formatStats } from './stats.ts';
import { writeJson } from './write-json.ts';

interface ParsedArgs {
  readonly seed: number;
  readonly out: string | undefined;
  readonly stats: boolean;
  readonly monthCount: number | undefined;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let seed = 1;
  let out: string | undefined;
  let monthCount: number | undefined;
  let stats = false;

  for (const arg of argv) {
    if (arg === '--stats') {
      stats = true;
    } else if (arg.startsWith('--seed=')) {
      seed = Number(arg.slice('--seed='.length));
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    } else if (arg.startsWith('--months=')) {
      monthCount = Number(arg.slice('--months='.length));
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: seed [--seed=N] [--out=DIR] [--months=N] [--stats]\n' +
          '  --seed=N     PRNG seed (default 1)\n' +
          '  --out=DIR    write accounts/merchants/transactions/holdings/prices/labels JSON to DIR\n' +
          '  --months=N   months of history to generate (default 24)\n' +
          '  --stats      print summary counts to stdout\n',
      );
      process.exit(0);
    } else {
      throw new Error(`unrecognised argument: ${arg}`);
    }
  }

  if (!Number.isFinite(seed)) throw new Error('--seed must be a number');
  return { seed, out, stats, monthCount };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataset = generateDemoData(args.seed, {
    ...(args.monthCount === undefined ? {} : { monthCount: args.monthCount }),
  });

  if (args.out !== undefined) {
    await writeJson(args.out, dataset);
    process.stdout.write(`wrote seed ${args.seed} to ${args.out}\n`);
  }

  if (args.stats || args.out === undefined) {
    process.stdout.write(`${formatStats(computeStats(dataset))}\n`);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}
