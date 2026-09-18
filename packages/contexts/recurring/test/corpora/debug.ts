import { runDetection } from './metrics.ts';
import { syntheticCorpus } from './synthetic.ts';
import { inferCadence, CADENCES } from '../../src/index.ts';
import { DateOnly } from '@core/kernel';
const w = (s: string) => process.stdout.write(s + '\n');
const corpus = syntheticCorpus();
const result = runDetection(corpus.inputs, corpus.facts, corpus.today);
let ties = 0;
for (const s of result.streams) {
  if (s.cadence === 'UNKNOWN') continue;
  const dates = [...new Set(s.occurrences.map((o) => o.date))].sort() as DateOnly[];
  const inf = inferCadence(dates);
  const sorted = [...inf.considered].sort((a, b) => b.score - a.score);
  const top = sorted[0]!, second = sorted[1];
  if (second && top.score - second.score < 0.05) {
    ties++;
    w(`TIE ${s.merchantId} n=${dates.length} chosen=${s.cadence} top=${top.cadence}/${top.score.toFixed(3)} 2nd=${second.cadence}/${second.score.toFixed(3)}`);
  }
}
w(`ties=${ties} of ${result.streams.length}`);
