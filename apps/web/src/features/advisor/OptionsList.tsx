// SPDX-License-Identifier: MIT
import { Button } from '../../components/ui/button.tsx';
import {
  NO_OPTIONS_WORDS,
  optionsDroppedWords,
  optionsWithCost,
  type AdvisorOption,
  type AdvisorSession,
} from './advisor-words.ts';

function Figures({
  heading,
  figures,
  empty,
  testId,
}: {
  readonly heading: string;
  readonly figures: readonly { readonly label: string; readonly text: string }[];
  readonly empty?: string;
  readonly testId: string;
}) {
  return (
    <div data-testid={testId}>
      <h5 className="text-caption font-medium uppercase tracking-wide text-text-muted">
        {heading}
      </h5>
      {figures.length === 0 ? (
        <p className="mt-1 text-small text-text-muted">{empty ?? 'None listed.'}</p>
      ) : (
        <dl className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-small">
          {figures.map((figure, index) => (
            <div key={`${figure.label}-${String(index)}`} className="contents">
              <dt className="text-text-secondary [overflow-wrap:anywhere]">{figure.label}</dt>
              <dd className="text-right font-medium tabular-nums text-text-primary">
                {figure.text}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function OptionCard({
  option,
  busy,
  onPick,
}: {
  readonly option: AdvisorOption;
  readonly busy: boolean;
  readonly onPick: (id: string) => void;
}) {
  return (
    <li
      className="flex flex-col gap-3 rounded-md border border-border-hairline bg-bg-surface p-3"
      data-testid="advisor-option"
      data-option-id={option.id}
    >
      <div>
        <h4 className="text-small font-medium text-text-primary [overflow-wrap:anywhere]">
          {option.label}
        </h4>
        <p className="mt-1 text-small text-text-secondary [overflow-wrap:anywhere]">
          {option.summary}
        </p>
      </div>
      <Figures heading="Gains" figures={option.benefit} testId="advisor-option-gains" />
      <Figures heading="Costs" figures={option.cost} testId="advisor-option-costs" />
      {option.backing.length > 0 && (
        <Figures heading="Based on" figures={option.backing} testId="advisor-option-backing" />
      )}
      {option.note !== '' && (
        <p
          className="text-small text-text-secondary [overflow-wrap:anywhere]"
          data-testid="advisor-option-note"
        >
          {option.note}
        </p>
      )}
      <div>
        <Button
          variant="secondary"
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          aria-label={`Pick this option: ${option.label}`}
          aria-disabled={busy ? 'true' : undefined}
          onClick={() => {
            if (!busy) onPick(option.id);
          }}
          data-testid="advisor-pick"
        >
          Pick this option
        </Button>
      </div>
    </li>
  );
}

export interface OptionsListProps {
  readonly session: AdvisorSession;
  readonly busy: boolean;
  readonly onPick: (id: string) => void;
}

/**
 * The options as cards: label, summary, what each gains, what each costs, and a note. An option never reaches the
 * screen without its cost: one whose cost list is empty is skipped here as well as refused by the api's validator
 * (`tradeoffs.cost_missing`), so a reply that slips one through still shows none.
 */
export function OptionsList({ session, busy, onPick }: OptionsListProps) {
  const options = optionsWithCost(session);
  const left = session.optionsDropped + ((session.options?.length ?? 0) - options.length);
  return (
    <div className="mt-3" data-testid="advisor-options">
      {options.length === 0 ? (
        <p className="text-small text-text-primary" data-testid="advisor-no-options">
          {NO_OPTIONS_WORDS}
        </p>
      ) : (
        <>
          <p className="mb-2 text-small text-text-secondary">
            Each option below sets what it gains beside what it costs. Picking one asks the advisor
            to write the steps; nothing is done for you.
          </p>
          <ul className="flex flex-col gap-3">
            {options.map((option) => (
              <OptionCard key={option.id} option={option} busy={busy} onPick={onPick} />
            ))}
          </ul>
        </>
      )}
      {left > 0 && (
        <p className="mt-2 text-caption text-text-muted" data-testid="advisor-options-dropped">
          {optionsDroppedWords(left)}
        </p>
      )}
    </div>
  );
}
