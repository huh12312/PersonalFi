// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useRef } from 'react';

/**
 * WCAG 1.4.13 Content on Hover or Focus, for a chart's value readout: it can be **dismissed** (Escape, without
 * moving the pointer), it is **hoverable** (the pointer can travel from the chart onto the readout and the readout
 * stays — a short grace period on leaving the chart, cancelled by entering the readout) and **persistent** (it stays
 * until the pointer leaves both, or Escape). The readout is also in the chart's data table (`ChartDataTable`), so
 * nothing is only on hover.
 */
export function useChartTooltipRules(hide: () => void, open: boolean) {
  const timer = useRef<number | undefined>(undefined);

  const keep = useCallback(() => {
    window.clearTimeout(timer.current);
  }, []);

  const leave = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(hide, 250);
  }, [hide]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        window.clearTimeout(timer.current);
        hide();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, hide]);

  useEffect(() => keep, [keep]);

  return {
    /** Call on every pointer move over the chart: the pointer is back, so any pending hide is off. */
    keep,
    /** For the chart surface's `onPointerLeave`. */
    onChartLeave: leave,
    /** Spread onto the readout: it must be reachable by the pointer, and leaving it starts the same grace period. */
    readoutProps: { onPointerEnter: keep, onPointerLeave: leave },
  };
}
