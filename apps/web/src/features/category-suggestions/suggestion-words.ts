// SPDX-License-Identifier: MIT
/**
 * Category suggestions, in words (WP 11.2). Pure functions over the api's shapes, so every sentence the chip and the
 * settings card can say is tested without rendering, and no state is ever carried by colour alone.
 */
import { formatDate } from '../narrator/narrator-words.ts';
import type {
  CategorySuggestion,
  CategorySuggestionEval,
  SuggestionModel,
  SuggestionSettings,
} from './suggestion-api.ts';

/** The chip, exactly: "Suggested by the model: Groceries — <the model's reason, verbatim>". */
export function chipWords(
  suggestion: Pick<CategorySuggestion, 'categoryLabel' | 'reason'>,
): string {
  return `Suggested by the model: ${suggestion.categoryLabel} — ${suggestion.reason}`;
}

/** 0.724 → "72 %"; `null` → "—". */
export function percentWords(value: number | null): string {
  return value === null ? '—' : `${String(Math.round(value * 100))} %`;
}

/** "1 row" / "31 rows". */
export function rowsWords(n: number): string {
  return `${String(n)} ${n === 1 ? 'row' : 'rows'}`;
}

/** The model the settings say is chosen, if the api lists it. */
export function chosenModel(settings: SuggestionSettings): SuggestionModel | undefined {
  return settings.models.find((model) => model.choice === settings.modelChoice);
}

/** The chosen model's latest measurement, or `null`. */
export function chosenLatest(settings: SuggestionSettings): CategorySuggestionEval | null {
  return chosenModel(settings)?.latest ?? null;
}

/** What each radio reads: "The narrator's model (qwen2.5:7b)", "Second local model (llama3.2:3b)". */
export function modelChoiceWords(model: Pick<SuggestionModel, 'choice' | 'label'>): string {
  const label = model.label ?? 'none set';
  return model.choice === 'narrator'
    ? `The narrator's model (${label})`
    : `Second local model (${label})`;
}

/** A model's latest measurement in one line, for comparing the choices side by side. */
export function measurementSummary(latest: CategorySuggestionEval | null): string {
  if (latest === null) return 'Not measured yet.';
  const when = formatDate(latest.measuredAt);
  if (latest.status === 'failed') {
    return `Measured ${when}: did not finish${latest.failure === null ? '' : ` (${latest.failure})`}.`;
  }
  return `Measured ${when}: ${percentWords(latest.precision)} precision, ${percentWords(latest.coverage)} coverage, ${rowsWords(latest.scored)} scored.`;
}

/** The gate's figures, as the api sends them: "85 %" and 20. */
function gateFigures(settings: SuggestionSettings): { precision: string; rows: number } {
  return {
    precision: percentWords(settings.gate.minPrecision),
    rows: settings.gate.minScored,
  };
}

/** The status line at the top of the card. */
export function statusWords(settings: SuggestionSettings): string {
  const latest = chosenLatest(settings);
  const gate = gateFigures(settings);
  switch (settings.state) {
    case 'on':
      return 'On';
    case 'ready':
      return 'Ready to turn on';
    case 'no_model':
      return 'Off: no model';
    case 'not_measured':
      return 'Off: not measured yet';
    case 'below_gate': {
      if (settings.gate.reason === 'measurement_failed' || latest?.status === 'failed') {
        return 'Off: the last measurement did not finish';
      }
      if (latest === null || latest.precision === null) {
        return `Off: below the ${gate.precision} gate`;
      }
      const scored = `${rowsWords(latest.scored)} scored`;
      return settings.gate.reason === 'too_few_rows'
        ? `Off: below the ${gate.precision} gate — ${percentWords(latest.precision)} on your history, but only ${scored} (${String(gate.rows)} needed)`
        : `Off: below the ${gate.precision} gate — ${percentWords(latest.precision)} on your history, ${scored}`;
    }
    default:
      return String(settings.state);
  }
}

/**
 * Why the Enable switch is where it is, as visible text beside it: what turns it on, and the last measurement; or
 * what it does now that it can be turned on.
 */
export function enableWords(settings: SuggestionSettings): string {
  const model = chosenModel(settings);
  const latest = model?.latest ?? null;
  const gate = gateFigures(settings);
  const rule = `Turns on at ${gate.precision} precision over at least ${String(gate.rows)} of your own transactions`;
  if (settings.enabled) {
    return 'Suggestions appear in the Inbox and the transaction list. Nothing is filed until you confirm one. Turning this off hides them.';
  }
  if (model === undefined || !model.available || settings.state === 'no_model') {
    const why = model?.unavailableReason ?? null;
    return `No model can suggest categories${why === null ? '' : `: ${why}`}. ${rule}.`;
  }
  if (settings.gate.open) {
    return `Measured ${percentWords(latest?.precision ?? null)} on ${String(latest?.scored ?? 0)} of your own transactions. Turning this on shows suggestions in the Inbox and the transaction list; nothing is filed until you confirm one.`;
  }
  if (latest === null) return `${rule}; not measured yet.`;
  if (latest.status === 'failed') return `${rule}; the last measurement did not finish.`;
  return `${rule}; last measured ${percentWords(latest.precision)} on ${String(latest.scored)}.`;
}

/** "Groceries" for a key the chart knows, else the key itself. */
export function categoryWords(key: string, labels: ReadonlyMap<string, string>): string {
  return labels.get(key) ?? key;
}
