// SPDX-License-Identifier: MIT
import { createFileRoute, redirect } from '@tanstack/react-router';
import { AlertTriangle, Sparkles, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';

import { TokenGallery } from '../components/dev/TokenGallery.tsx';
import { DateOnlyText } from '../components/finance/DateOnlyText.tsx';
import { InlineInsight } from '../components/finance/InlineInsight.tsx';
import { Money } from '../components/finance/Money.tsx';
import { Percent } from '../components/finance/Percent.tsx';
import { ProgressRing } from '../components/finance/ProgressRing.tsx';
import { StatTile } from '../components/finance/StatTile.tsx';
import { EmptyState } from '../components/patterns/EmptyState.tsx';
import { Skeleton, SkeletonText } from '../components/patterns/Skeleton.tsx';
import { SyncStatusPill } from '../components/patterns/SyncStatusPill.tsx';
import { Avatar, AvatarFallback } from '../components/ui/avatar.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { Separator } from '../components/ui/separator.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../components/ui/tabs.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip.tsx';
import { NetWorthAreaChart } from '../charts/NetWorthAreaChart.tsx';

/**
 * `/dev/kitchen-sink` — every primitive and vendored component, in both
 * themes, on one page (05-frontend-architecture.md §9: "no Storybook... a
 * dev-only route instead — it costs one file, it lives inside the real app so
 * it can never drift from real providers/styles"). This is also the target
 * for the axe-core accessibility check and Playwright visual regression.
 *
 * Guarded rather than route-excluded: `autoCodeSplitting` already puts this
 * route's component in its own chunk, so a production build never *fetches*
 * it unless someone navigates here directly — and this redirect stops that.
 * (The chunk itself is additionally excluded from the service worker's
 * precache manifest — vite.config.ts's `injectManifest.globIgnores`,
 * so it's neither reachable nor prefetched to
 * disk in a real deployment.)
 *
 * `import.meta.env.MODE === 'e2e-csp'` is the one deliberate exception: it's
 * a `vite build --mode e2e-csp` output, never `vite build`'s default
 * (real, shipped) production mode, built only so
 * `e2e/csp.spec.ts` can serve this route from a real `dist/`-shaped artifact
 * behind the exact production `Content-Security-Policy` header and exercise
 * this page's toast and dialog under it — every other primitive on this page
 * is already reachable pre-auth on `/login`'s screen or not at all, and a
 * CSP regression in, say, `Toaster` or `Dialog` would otherwise go
 * completely untested until a real financial screen exists to catch it.
 * `pnpm run build` (the artifact that actually ships) never sets this mode,
 * so the real production guard is unchanged.
 */
export const Route = createFileRoute('/dev/kitchen-sink')({
  beforeLoad: () => {
    if (!import.meta.env.DEV && import.meta.env.MODE !== 'e2e-csp') {
      throw redirect({ to: '/' });
    }
  },
  component: KitchenSinkRoute,
});

function KitchenSinkRoute() {
  return (
    <div className="flex flex-col">
      <Theme label="Light" value="light" />
      <Theme label="Dark" value="dark" />
    </div>
  );
}

function Theme({ label, value }: { label: string; value: 'light' | 'dark' }) {
  return (
    <div data-theme={value} className="bg-bg-page px-4 py-10 text-text-primary md:px-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-10">
        <h1 className="text-display">{label} theme</h1>

        <Section title="Colour tokens">
          {/* Every class below is a literal string — Tailwind's scanner can't see a
              class name built from a template-literal interpolation, so the series/
              sequential/status swatches are spelled out rather than looped from a number. */}
          <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
            <Swatch label="series-1" className="bg-series-1" />
            <Swatch label="series-2" className="bg-series-2" />
            <Swatch label="series-3" className="bg-series-3" />
            <Swatch label="series-4" className="bg-series-4" />
            <Swatch label="series-5" className="bg-series-5" />
            <Swatch label="series-6" className="bg-series-6" />
            <Swatch label="series-7" className="bg-series-7" />
            <Swatch label="series-8" className="bg-series-8" />
          </div>
          <div className="mt-3 grid grid-cols-4 gap-3 sm:grid-cols-6">
            <Swatch label="money-pos" className="bg-money-pos" />
            <Swatch label="money-neg" className="bg-money-neg" />
            <Swatch label="accent" className="bg-accent" />
            <Swatch label="status-good" className="bg-status-good" />
            <Swatch label="status-warning" className="bg-status-warning" />
            <Swatch label="status-serious" className="bg-status-serious" />
            <Swatch label="status-critical" className="bg-status-critical" />
          </div>
          {/* `--seq-*` are raw CSS custom properties, not mapped into the Tailwind
              `@theme` colour namespace (theme.css only maps the ones actually used
              as utility classes elsewhere) — arbitrary-value syntax reaches them directly. */}
          <div className="mt-3 grid grid-cols-[repeat(13,minmax(0,1fr))] gap-1">
            <div className="h-8 rounded-sm bg-[var(--seq-1)]" />
            <div className="h-8 rounded-sm bg-[var(--seq-2)]" />
            <div className="h-8 rounded-sm bg-[var(--seq-3)]" />
            <div className="h-8 rounded-sm bg-[var(--seq-4)]" />
            <div className="h-8 rounded-sm bg-[var(--seq-5)]" />
            <div className="h-8 rounded-sm bg-[var(--seq-6)]" />
            <div className="h-8 rounded-sm bg-[var(--seq-7)]" />
            <div className="h-8 rounded-sm bg-[var(--seq-8)]" />
            <div className="h-8 rounded-sm bg-[var(--seq-9)]" />
            <div className="h-8 rounded-sm bg-[var(--seq-10)]" />
            <div className="h-8 rounded-sm bg-[var(--seq-11)]" />
            <div className="h-8 rounded-sm bg-[var(--seq-12)]" />
            <div className="h-8 rounded-sm bg-[var(--seq-13)]" />
          </div>
        </Section>

        <Section title="Tokens">
          <TokenGallery />
        </Section>

        <Section title="Typography">
          <p className="text-hero">Hero 48</p>
          <p className="text-display">Display 34</p>
          <p className="text-h1">Heading 1</p>
          <p className="text-h2">Heading 2</p>
          <p className="text-h3">Heading 3</p>
          <p className="text-body">Body text, the default paragraph size.</p>
          <p className="text-body-strong">Body strong, used for row primary lines.</p>
          <p className="text-small text-text-secondary">Small / secondary line.</p>
          <p className="text-caption text-text-muted">Caption / chart ticks.</p>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="link">Link</Button>
            <Button disabled>Disabled</Button>
          </div>
        </Section>

        <Section title="Badges">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">Neutral</Badge>
            <Badge variant="accent">Accent</Badge>
            <Badge variant="good" icon={<Sparkles size={12} aria-hidden="true" />}>
              Good
            </Badge>
            <Badge variant="warning" icon={<AlertTriangle size={12} aria-hidden="true" />}>
              Warning
            </Badge>
            <Badge variant="serious">Serious</Badge>
            <Badge variant="critical">Critical</Badge>
          </div>
        </Section>

        <Section title="Form controls">
          <div className="flex max-w-sm flex-col gap-4">
            <div>
              <Label htmlFor={`${value}-input`}>Label</Label>
              <Input id={`${value}-input`} className="mt-1.5" placeholder="Placeholder text" />
            </div>
            <div className="flex items-center gap-2">
              {/* Base UI's `Switch.Root` renders `role="switch"` on a visible
                  `<span>` and redirects a plain `id` prop to its paired hidden
                  `<input type="checkbox">` instead — a `<label htmlFor>`
                  pointing at that id still gets click-to-toggle for free, but
                  the accessible name axe checks lives on the visible switch,
                  which needs its own `aria-labelledby` (aria-toggle-field-name). */}
              <Switch
                id={`${value}-switch`}
                aria-labelledby={`${value}-switch-label`}
                defaultChecked
              />
              <Label id={`${value}-switch-label`} htmlFor={`${value}-switch`}>
                Switch
              </Label>
            </div>
          </div>
        </Section>

        <Section title="Tabs">
          <Tabs defaultValue="one" className="max-w-sm">
            <TabsList>
              <TabsTab value="one">One</TabsTab>
              <TabsTab value="two">Two</TabsTab>
              <TabsTab value="three">Three</TabsTab>
            </TabsList>
            <TabsPanel value="one">Panel one content.</TabsPanel>
            <TabsPanel value="two">Panel two content.</TabsPanel>
            <TabsPanel value="three">Panel three content.</TabsPanel>
          </Tabs>
        </Section>

        <Section title="Toasts">
          {/* sonner's `<Toaster>` is mounted once at the app root
              (src/app/App.tsx), not here — this button only calls `toast()`
              so this page can exercise it, the same way every other
              primitive above is exercised in place rather than described. */}
          <Button
            variant="secondary"
            onClick={() =>
              toast('This is a toast.', { description: 'Triggered from the kitchen sink.' })
            }
          >
            Show toast
          </Button>
        </Section>

        <Section title="Tooltip, avatar, separator, dialog">
          <div className="flex flex-wrap items-center gap-4">
            <Tooltip>
              <TooltipTrigger className="rounded-md border border-border-strong px-3 py-1.5 text-small">
                Hover me
              </TooltipTrigger>
              <TooltipContent>A tooltip</TooltipContent>
            </Tooltip>
            <Avatar>
              <AvatarFallback>CB</AvatarFallback>
            </Avatar>
            <Separator orientation="vertical" className="h-8" />
            <Dialog>
              <DialogTrigger className="rounded-md border border-border-strong px-3 py-1.5 text-small">
                Open dialog
              </DialogTrigger>
              <DialogContent>
                <DialogTitle>Dialog title</DialogTitle>
                <DialogDescription>Dialog description text.</DialogDescription>
              </DialogContent>
            </Dialog>
          </div>
        </Section>

        <Section title="Cards & stat tiles">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Card title</CardTitle>
                <CardDescription>Card description text.</CardDescription>
              </CardHeader>
              <CardContent>
                <StatTile
                  label="Net worth"
                  value={<Money value={{ minor: '842500', currency: 'USD' }} colorBySign={false} />}
                  delta={<Percent value={0.034} colorBySign />}
                />
              </CardContent>
            </Card>
            <Card className="sm:col-span-2">
              <CardHeader>
                <CardTitle>Stat tiles in a flex row</CardTitle>
                <CardDescription>
                  Three tiles in a row that gives them no width (WP 10.7): each keeps its own and
                  the row wraps.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-6" data-testid="stat-tile-flex-row">
                  <StatTile
                    label="Safe to spend"
                    size="hero"
                    value={<Money value={{ minor: '6749800', currency: 'USD' }} colorBySign />}
                    hint="Cash on hand, less the worst case of every charge due"
                  />
                  <StatTile
                    label="Expected net (30 days)"
                    size="standard"
                    value={<Money value={{ minor: '0', currency: 'USD' }} />}
                    hint="After every expected charge"
                  />
                  <StatTile
                    label="Worst case"
                    size="standard"
                    value={<Money value={{ minor: '0', currency: 'USD' }} colorBySign={false} />}
                    hint="If every uncertain charge lands at its worst"
                  />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Budget ring</CardTitle>
              </CardHeader>
              <CardContent className="flex items-center gap-6">
                <ProgressRing value={0.72} label="$432 of $600 spent">
                  <Money value={{ minor: '43200', currency: 'USD' }} className="text-small" />
                </ProgressRing>
                <ProgressRing value={1.1} label="$660 of $600 spent">
                  <Money value={{ minor: '66000', currency: 'USD' }} className="text-small" />
                </ProgressRing>
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section title="Finance primitives">
          <div className="flex flex-col gap-2">
            <Money value={{ minor: '124099', currency: 'USD' }} />
            <Money value={{ minor: '-4599', currency: 'USD' }} />
            <Percent value={0.021} colorBySign />
            <DateOnlyText value="2026-03-01" />
            <InlineInsight
              headline="Spending in Dining is 62% above your 6-month average."
              detail="Comparison window: last 30 days vs. the trailing 6-month average. 8 transactions contributed."
            />
          </div>
        </Section>

        <Section title="Empty states & skeletons">
          <div className="grid gap-4 sm:grid-cols-2">
            <EmptyState
              icon={Wallet}
              headline="Connect your first account"
              description="Link a bank, connect Coinbase, or add a manual account."
              action={{ label: 'Connect account' }}
            />
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <Skeleton variant="circle" width={36} height={36} />
                <SkeletonText lines={2} className="flex-1" />
              </div>
              <Skeleton variant="block" height={80} />
            </div>
          </div>
        </Section>

        <Section title="Sync status">
          <div className="flex flex-wrap gap-2">
            <SyncStatusPill status={{ kind: 'synced', label: 'Synced 4m ago' }} />
            <SyncStatusPill status={{ kind: 'syncing', current: 3, total: 5 }} />
            <SyncStatusPill status={{ kind: 'stale', label: 'Stale — last synced 3d ago' }} />
            <SyncStatusPill status={{ kind: 'error', label: '1 account needs attention' }} />
          </div>
        </Section>

        <Section title="Chart pipeline (visx)">
          <NetWorthAreaChart />
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-h3 text-text-secondary">{title}</h2>
      {children}
    </section>
  );
}

function Swatch({ label, className }: { label: string; className: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className={`h-10 rounded-md border border-border-hairline ${className}`} />
      <span className="text-caption text-text-muted">{label}</span>
    </div>
  );
}
