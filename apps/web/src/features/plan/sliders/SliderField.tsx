// SPDX-License-Identifier: MIT
import { Slider } from '@base-ui-components/react/slider';
import { useId } from 'react';

import { Input } from '../../../components/ui/input.tsx';
import { Label } from '../../../components/ui/label.tsx';

/**
 * One goal lever: a Base UI `Slider` (real range semantics, full keyboard
 * support — 05 §5.7) with an editable number input beside it, because
 * fine-grained values are hard to hit by dragging (05 §5.7's own words). Every
 * drag has a non-drag equivalent (WCAG 2.5.7): the number input, and the
 * slider thumb's own arrow-key stepping.
 *
 * `onChange` fires continuously while dragging or typing (the 250-path live
 * preview); `onCommit` fires once on pointer-up, a keyboard commit, or a
 * finished edit (the 5,000-path refine) — `../GoalSliders.tsx` is the only
 * caller and owns what each does.
 */
export interface SliderFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  /** The number input's own step, when it should be finer than the slider's. */
  readonly inputStep?: number;
  readonly unit?: string;
  readonly format?: (value: number) => string;
  readonly onChange: (value: number) => void;
  readonly onCommit: (value: number) => void;
}

export function SliderField({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  inputStep,
  unit,
  format,
  onChange,
  onCommit,
}: SliderFieldProps) {
  const reactId = useId();
  const numberId = `${id}-${reactId}`;
  const formatted = format ? format(value) : `${String(value)}${unit ?? ''}`;

  function clamp(raw: number): number {
    if (!Number.isFinite(raw)) return value;
    return Math.min(max, Math.max(min, raw));
  }

  function handleNumberChange(raw: string): void {
    if (raw.trim() === '') return;
    const next = clamp(Number(raw));
    onChange(next);
    onCommit(next);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={numberId}>{label}</Label>
        <Input
          id={numberId}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={inputStep ?? step}
          value={value}
          onChange={(e) => handleNumberChange(e.target.value)}
          className="h-8 w-28 text-right text-small tabular-nums"
          aria-describedby={`${numberId}-value`}
        />
      </div>
      <Slider.Root
        value={value}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => onChange(next as number)}
        onValueCommitted={(next) => onCommit(next as number)}
        className="relative flex h-6 w-full touch-none select-none items-center"
      >
        <Slider.Control className="flex w-full items-center py-2" data-testid={`${id}-control`}>
          <Slider.Track className="relative h-1.5 w-full grow rounded-full bg-bg-inset">
            <Slider.Indicator className="absolute h-full rounded-full bg-accent" />
            <Slider.Thumb
              aria-label={label}
              getAriaValueText={() => formatted}
              data-testid={`${id}-thumb`}
              className="block h-5 w-5 rounded-full border-2 border-accent bg-bg-surface shadow-elev-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <span id={`${numberId}-value`} className="sr-only">
        {formatted}
      </span>
    </div>
  );
}
