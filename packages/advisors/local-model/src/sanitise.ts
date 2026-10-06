// SPDX-License-Identifier: MIT
/**
 * The untrusted-block sanitiser (05-phase-5-dispatch.md §3 WP 5.2 part 2; 03
 * §8.2). Every string — value **and** key — that enters the `<untrusted_data>`
 * block passes through `sanitiseString`, in this order:
 *
 *   1. NFKC. Fullwidth `＜／` becomes `</`, `ﬁ` becomes `fi`: the forms a filter
 *      would miss are folded into the forms it looks for, *before* it looks.
 *   2. Invisible and control code points removed — an explicit, reviewable
 *      list (`CODE_POINT_CLASSES` below), not a package: C0/C1 controls except
 *      `\n` and `\t`, the line/paragraph separators, zero-width characters,
 *      bidi controls, Unicode tag characters (the "ASCII smuggling" block) and
 *      variation selectors.
 *   3. NFKC again — a removal in step 2 can leave a sequence step 1 would
 *      have composed.
 *   4. The contract's own length cap, enforced again (`caps.ts`).
 *   5. Fence and high-signal injection patterns removed, **to a fixed
 *      point**: removing `system:` from `</untrusted_system:_data>` must not
 *      leave a fence behind, so the whole pattern set re-runs until nothing
 *      changes.
 *
 * Every change is **flagged** with its kind, where it happened and how many
 * times — 03 §8.2: *"Log and flag rather than silently mangle."* The flags go
 * into the run's `diagnostics.warnings` (as kind and path, never the removed
 * text) and into the log line as counts per kind. The removed text itself
 * goes nowhere.
 *
 * 6. (WP 9.5, F-7) **Flag only, never remove:** a role marker or an
 *    "ignore previous" spelled in look-alike letters (`ѕуѕtеm:` in Cyrillic
 *    reads as `system:` to a model and to nothing above), found by folding a
 *    small explicit confusables table (`CONFUSABLES`) to Latin and matching
 *    the step-5 patterns on the fold; and a base64 run of the step-5 size
 *    wrapped across lines (60-column wrapping hid one from the `base64_run`
 *    pattern, wp5.4 I-20). These raise `confusable_marker` and
 *    `wrapped_base64` and change no byte: the red team showed the flag list
 *    is evadable with no effort, and F-7 asks only that a reader of the run
 *    inspector seeing "no flags" is not misled. The control remains the
 *    structure and the narrow trace.
 *
 * None of this is the control. 03 §8.2 is explicit that structural
 * segregation "raises the bar; it does not solve the problem" and that
 * "structural defense beats filtering": the real containment is that the model
 * has no tool, no handle and no network, and that its every word passes WP
 * 2.6's validator. This file makes the block hard to escape and makes an
 * attempt visible; it is not asked to make an attempt impossible.
 */
import { capFor, DEFAULT_STRING_CAP, RECORD_KEY_CAP } from './caps.ts';

export const SANITISER_FLAG_KINDS = [
  'nfkc',
  'control',
  'zero_width',
  'bidi',
  'invisible_tag',
  'variation_selector',
  'truncated',
  'fence',
  'chat_template_token',
  'inst_marker',
  'role_marker',
  'ignore_previous',
  'closing_tag',
  'base64_run',
  'key_collision',
  // WP 9.5 (F-7): flag-only — see `FLAG_ONLY_KINDS`.
  'confusable_marker',
  'wrapped_base64',
] as const;
export type SanitiserFlagKind = (typeof SANITISER_FLAG_KINDS)[number];

export interface SanitiserFlag {
  readonly kind: SanitiserFlagKind;
  /** `snapshot.goals_list.goals[0].name`. Keys that are not plain identifiers render as `[key#n]`. */
  readonly path: string;
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Step 2 — code points removed, by class
// ---------------------------------------------------------------------------

/**
 * The explicit list. Each range is `[first, last]`, inclusive. 05 §4 item 10:
 * "`String.prototype.normalize('NFKC')` and an explicit code-point list are the
 * whole of what is needed, and the list is reviewable."
 */
export const CODE_POINT_CLASSES: Readonly<
  Record<
    'control' | 'zero_width' | 'bidi' | 'invisible_tag' | 'variation_selector',
    readonly (readonly [number, number])[]
  >
> = Object.freeze({
  // C0 except \t (0x09) and \n (0x0A); DEL; C1 (NEL 0x85 included); and the
  // two Unicode line terminators JSON.stringify does not escape.
  control: [
    [0x00, 0x08],
    [0x0b, 0x1f],
    [0x7f, 0x9f],
    [0x2028, 0x2029],
  ],
  // U+200B–U+200F (ZWSP, ZWNJ, ZWJ, LRM, RLM), U+2060–U+2064 (word joiner,
  // invisible operators), U+FEFF (BOM / ZWNBSP) — the brief's list — plus
  // three more invisible characters a filter-evasion payload reaches for:
  // U+00AD soft hyphen ("ig\u00ADnore"), U+034F combining grapheme joiner, U+180E
  // Mongolian vowel separator.
  zero_width: [
    [0x200b, 0x200f],
    [0x2060, 0x2064],
    [0xfeff, 0xfeff],
    [0x00ad, 0x00ad],
    [0x034f, 0x034f],
    [0x180e, 0x180e],
  ],
  // U+202A–U+202E (embeddings, overrides), U+2066–U+2069 (isolates) — the
  // brief's list — plus U+061C, the Arabic letter mark, which is a bidi
  // control by any other name.
  bidi: [
    [0x202a, 0x202e],
    [0x2066, 0x2069],
    [0x061c, 0x061c],
  ],
  // U+E0000–U+E007F: Unicode tag characters. Invisible in every renderer, and
  // tokenised by most models as the ASCII they shadow — the documented way
  // to hide an instruction from a human reviewer and show it to a model.
  invisible_tag: [[0xe0000, 0xe007f]],
  // Variation selectors: invisible, and usable to smuggle bytes after an
  // innocent-looking character.
  variation_selector: [
    [0xfe00, 0xfe0f],
    [0xe0100, 0xe01ef],
  ],
});

type StrippedClass = keyof typeof CODE_POINT_CLASSES;
const STRIPPED_CLASSES = Object.keys(CODE_POINT_CLASSES) as StrippedClass[];

function classOf(codePoint: number): StrippedClass | null {
  for (const klass of STRIPPED_CLASSES) {
    for (const [first, last] of CODE_POINT_CLASSES[klass]) {
      if (codePoint >= first && codePoint <= last) return klass;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step 5 — patterns removed, by name
// ---------------------------------------------------------------------------

/**
 * The high-signal list. Each one is removed (the matched text only) and
 * flagged. Why each is here is in the evidence file, §4; the short form:
 */
export const INJECTION_PATTERNS: readonly {
  readonly kind: SanitiserFlagKind;
  readonly pattern: RegExp;
  readonly accept?: (match: string) => boolean;
}[] = Object.freeze([
  // Anything that could open or close our own fence, with or without its
  // `>`, with whitespace or `-` for `_`, in any case.
  { kind: 'fence', pattern: /<\s*\/?\s*untrusted[\s_-]*data\b[^<>]{0,64}>?/giu },
  // Chat-template control tokens (`<|im_start|>`, `<|im_end|>`,
  // `<|eot_id|>`, `<|start_header_id|>`). Some runtimes parse these as
  // special tokens even inside user content: a literal one is a role switch.
  { kind: 'chat_template_token', pattern: /<\|[^|<>\n]{0,64}\|>/gu },
  // Llama-2-style role markers.
  { kind: 'inst_marker', pattern: /\[\s*\/?\s*INST\s*\]|<<\s*\/?\s*SYS\s*>>/giu },
  // `system:` / `assistant:` / `developer:` — a role label in data is an
  // attempt to be read as a turn. No leading word boundary on purpose: a
  // payload glues it to whatever precedes it (`untrusted_system:_data`,
  // `Tripsystem:`) once a removal has joined the two. `ecosystem:` is flagged
  // too — a flagged false positive is visible; a missed marker is not.
  { kind: 'role_marker', pattern: /(?:system|assistant|developer)\s*:/giu },
  // "Ignore previous instructions" and its paraphrases — again with no leading
  // boundary, because a removal before it (a fence, a bidi override) can glue
  // it to the previous word: `Trip</untrusted_data>ignore previous`.
  {
    kind: 'ignore_previous',
    pattern:
      /(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|your|of|these|those)\s+)*(?:previous|prior|above|earlier|preceding|system)(?:\s+(?:instructions?|prompts?|messages?|rules?|directions?|context))?/giu,
  },
  // 03 §8.2's `</`: a closing tag of any kind.
  { kind: 'closing_tag', pattern: /<\s*\//gu },
  // Base64 runs over 64 characters. A pure-hex run (a sha256, a content
  // hash) is not base64-shaped instructions and is left alone: a real
  // base64 blob of that length all but always contains a letter past `f`.
  {
    kind: 'base64_run',
    pattern: /[A-Za-z0-9+/]{65,}={0,2}/gu,
    accept: (match) => /[G-Zg-z+/]/u.test(match),
  },
]);

/**
 * The kinds that flag without removing anything (step 6). The adapter's
 * diagnostics say "flagged" for these and "removed" for every other kind.
 */
export const FLAG_ONLY_KINDS: ReadonlySet<SanitiserFlagKind> = new Set([
  'confusable_marker',
  'wrapped_base64',
]);

/**
 * Latin look-alikes NFKC leaves alone: Cyrillic and Greek letters that render
 * as the Latin letter beside them. An explicit, reviewable table — the same
 * stance as `CODE_POINT_CLASSES` — not a confusables package. Used only to
 * *detect* (step 6); the text sent is never folded.
 */
export const CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  // Cyrillic, lower case
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  һ: 'h',
  і: 'i',
  ї: 'i',
  ј: 'j',
  к: 'k',
  ӏ: 'l',
  м: 'm',
  п: 'n',
  о: 'o',
  р: 'p',
  ԛ: 'q',
  г: 'r',
  ѕ: 's',
  т: 't',
  и: 'u',
  у: 'y',
  ԝ: 'w',
  х: 'x',
  ԁ: 'd',
  ɡ: 'g',
  // Cyrillic, upper case
  А: 'A',
  В: 'B',
  Е: 'E',
  Н: 'H',
  І: 'I',
  Ј: 'J',
  К: 'K',
  М: 'M',
  О: 'O',
  Р: 'P',
  С: 'C',
  с: 'c',
  Ѕ: 'S',
  Т: 'T',
  У: 'Y',
  Х: 'X',
  Ү: 'Y',
  // Greek
  α: 'a',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
});

/** `ѕуѕtеm` → `system`. Detection only. */
export function confusableSkeleton(text: string): string {
  let out = '';
  for (const char of text) out += CONFUSABLES[char] ?? char;
  return out;
}

const CONFUSABLE_TARGETS = INJECTION_PATTERNS.filter(
  (entry) => entry.kind === 'role_marker' || entry.kind === 'ignore_previous',
).map((entry) => entry.pattern);

/** Step 6a: markers that only appear once the look-alikes are folded. */
function confusableMarkers(value: string): number {
  const skeleton = confusableSkeleton(value);
  if (skeleton === value) return 0;
  let found = 0;
  for (const pattern of CONFUSABLE_TARGETS) {
    const before = value.match(new RegExp(pattern.source, pattern.flags))?.length ?? 0;
    const after = skeleton.match(new RegExp(pattern.source, pattern.flags))?.length ?? 0;
    found += Math.max(0, after - before);
  }
  return found;
}

/** Step 6b: a base64 run of step 5's size, wrapped across lines. */
// Segments of 16+ base64 characters joined by any whitespace (a newline in a
// memo, a space where a slug or a name cannot hold one — I-20 wraps at 60
// columns with a space), and a short tail.
const WRAPPED_BASE64 = /(?:[A-Za-z0-9+/]{16,}={0,2}\s+)+[A-Za-z0-9+/]{4,}={0,2}/gu;

function wrappedBase64Runs(value: string): number {
  let found = 0;
  for (const match of value.matchAll(WRAPPED_BASE64)) {
    const joined = match[0].replace(/\s+/gu, '');
    // Base64 of text mixes cases and carries digits or `+`/`/`; a run of long
    // plain words does not. A false positive is a visible flag, nothing more.
    if (
      joined.length >= 65 &&
      /[A-Z]/u.test(joined) &&
      /[a-z]/u.test(joined) &&
      /[0-9+/]/u.test(joined)
    ) {
      found += 1;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The string pipeline
// ---------------------------------------------------------------------------

export interface SanitisedString {
  readonly value: string;
  readonly flags: readonly SanitiserFlag[];
}

/** Sanitise one string that is about to enter the block. Pure. */
export function sanitiseString(input: string, path: string, cap: number): SanitisedString {
  const counts = new Map<SanitiserFlagKind, number>();
  const bump = (kind: SanitiserFlagKind, by = 1): void => {
    counts.set(kind, (counts.get(kind) ?? 0) + by);
  };

  // 1. NFKC
  let value = input.normalize('NFKC');
  if (value !== input) bump('nfkc');

  // 2. remove the listed code points
  let kept = '';
  for (const char of value) {
    const klass = classOf(char.codePointAt(0) ?? 0);
    if (klass === null) kept += char;
    else bump(klass);
  }
  value = kept;

  // 3. NFKC again
  const renormalised = value.normalize('NFKC');
  if (renormalised !== value) bump('nfkc');
  value = renormalised;

  // 4. the contract's cap, in code points
  const codePoints = [...value];
  if (codePoints.length > cap) {
    value = codePoints.slice(0, cap).join('');
    bump('truncated');
  }

  // 5. patterns, to a fixed point. After any removal the scan restarts from
  // the top of the list, so a fence that a removal *created* is caught as a
  // fence (and flagged as one) before anything else touches it. Every
  // removal shortens the string, so this terminates; the bound is a guard.
  for (let pass = 0; pass < 256; pass += 1) {
    let changed = false;
    for (const { kind, pattern, accept } of INJECTION_PATTERNS) {
      value = value.replace(pattern, (match) => {
        if (accept !== undefined && !accept(match)) return match;
        bump(kind);
        changed = true;
        return '';
      });
      if (changed) break;
    }
    if (!changed) break;
  }

  // 6. flag only (F-7): nothing below changes `value`.
  const confusable = confusableMarkers(value);
  if (confusable > 0) bump('confusable_marker', confusable);
  const wrapped = wrappedBase64Runs(value);
  if (wrapped > 0) bump('wrapped_base64', wrapped);

  const flags = [...counts.entries()].map(([kind, count]) => ({ kind, path, count }));
  return { value, flags };
}

// ---------------------------------------------------------------------------
// The tree walk
// ---------------------------------------------------------------------------

export interface SanitisedTree {
  readonly value: unknown;
  readonly flags: readonly SanitiserFlag[];
}

const PLAIN_KEY = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * Sanitise every string in a JSON value — keys included, because
 * `account_type_mix` is a record whose keys are data. `fieldName` is the
 * property a string sits under (the array's property for array items), which
 * is what `caps.ts` keys on.
 */
export function sanitiseTree(
  value: unknown,
  path: string,
  fieldName: string | null = null,
): SanitisedTree {
  const flags: SanitiserFlag[] = [];

  const walk = (node: unknown, at: string, field: string | null): unknown => {
    if (typeof node === 'string') {
      const result = sanitiseString(node, at, field === null ? DEFAULT_STRING_CAP : capFor(field));
      flags.push(...result.flags);
      return result.value;
    }
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node))
      return node.map((item, index) => walk(item, `${at}[${String(index)}]`, field));

    // Entries, then `Object.fromEntries`: a data key named `__proto__` becomes
    // an own property rather than a prototype assignment.
    const out: [string, unknown][] = [];
    const seen = new Set<string>();
    let index = 0;
    for (const [rawKey, item] of Object.entries(node as Record<string, unknown>)) {
      const keyPath = PLAIN_KEY.test(rawKey) ? `${at}.${rawKey}` : `${at}[key#${String(index)}]`;
      index += 1;
      let key = rawKey;
      if (!PLAIN_KEY.test(rawKey)) {
        const cleaned = sanitiseString(rawKey, keyPath, RECORD_KEY_CAP);
        flags.push(...cleaned.flags);
        key = cleaned.value.length === 0 ? '_' : cleaned.value;
      }
      if (seen.has(key)) {
        flags.push({ kind: 'key_collision', path: keyPath, count: 1 });
        continue; // first writer wins; the collision is flagged, not merged
      }
      seen.add(key);
      out.push([key, walk(item, keyPath, PLAIN_KEY.test(rawKey) ? rawKey : field)]);
    }
    return Object.fromEntries(out);
  };

  return { value: walk(value, path, fieldName), flags };
}

/** Counts per kind, for a log line: no paths, no text. */
export function countFlags(
  flags: readonly SanitiserFlag[],
): Partial<Record<SanitiserFlagKind, number>> {
  const counts: Partial<Record<SanitiserFlagKind, number>> = {};
  for (const flag of flags) counts[flag.kind] = (counts[flag.kind] ?? 0) + flag.count;
  return counts;
}
