// SPDX-License-Identifier: MIT
import { FileUp, Landmark, Link2, PencilLine } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** `ConnectorManifest.iconKey` → glyph. Unknown keys (a future adapter) fall back to a generic link icon rather than rendering nothing. Exported (not just the lookup function) so a call site can do a plain indexed lookup — react-compiler's `static-components` rule accepts a stable object index but not a function-call result as a JSX tag, even one this pure. */
export const CONNECTOR_ICON_BY_KEY: Record<string, LucideIcon> = {
  pencil: PencilLine,
  file_arrow_up: FileUp,
  bank: Landmark,
};

export const DEFAULT_CONNECTOR_ICON: LucideIcon = Link2;

export function iconForConnector(iconKey: string): LucideIcon {
  return CONNECTOR_ICON_BY_KEY[iconKey] ?? DEFAULT_CONNECTOR_ICON;
}
