// SPDX-License-Identifier: MIT
import { z } from 'zod';

/**
 * Must be the *first* import in `main.tsx` — not just the first statement.
 * Zod v4's `ZodObject` constructor probes `new Function` support at *schema
 * construction* time, not at first `.parse()` call (confirmed by walking the
 * actual call stack in a real browser: `new ZodObject` → `.keyof()` →
 * `allowsEval.value`'s cached getter → `new Function('')`), and this app
 * defines zod schemas at module scope — `src/routes/login.tsx`'s
 * `validateSearch: z.object(...)`, every schema in
 * `src/api/pending-contracts.ts` — which run during the static `import`
 * graph's evaluation, before any of `main.tsx`'s own top-level statements
 * do. Putting `z.config({ jitless: true })` in `main.tsx`'s *body* (even as
 * its first statement) was too late: `import { App } from './app/App.tsx'`
 * on the next line had already pulled in every route file, and every
 * `z.object(...)` in them had already run zod's `new Function` CSP probe by
 * the time that statement executed.
 *
 * ES modules execute a program's `import` statements depth-first, in the
 * order they're written, each module's body running exactly once the first
 * time it's reached — so a module containing *only* `z.config(...)`,
 * imported before anything that defines a schema, is guaranteed to run
 * first regardless of how deep the schema-defining imports are nested.
 *
 * See `zod/v4/core/util.js`'s own comment on `allowsEval`: "strict CSPs
 * report the caught `new Function` as a `securitypolicyviolation` even
 * though the throw is swallowed" — `jitless: true` skips the probe (and the
 * compiled fast-path validators) entirely, gate-remediation-web.md H-3.
 */
z.config({ jitless: true });
