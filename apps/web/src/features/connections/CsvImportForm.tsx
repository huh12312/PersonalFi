// SPDX-License-Identifier: MIT
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ChangeEvent } from 'react';

import {
  importFilesMutation,
  listConnectionsOptions,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import type { Account, ImportFile } from '../../api/generated/types.gen.ts';

const PRESETS: Array<{ id: NonNullable<ImportFile['presetId']>; label: string }> = [
  { id: 'iso_signed', label: 'ISO date, one signed amount column' },
  { id: 'us_signed', label: 'US date (MM/DD/YYYY), one signed amount column' },
  { id: 'us_debit_credit', label: 'US date, separate debit/credit columns' },
  { id: 'uk_dmy', label: 'UK date (DD/MM/YYYY)' },
  { id: 'european_semicolon', label: 'European (semicolon-delimited, comma decimal)' },
];

const ACCOUNT_TYPES: Array<Account['type']> = [
  'depository',
  'credit',
  'loan',
  'investment',
  'crypto',
];

export interface CsvImportFormProps {
  /** Omit to create a new file-import connection; pass an existing one to append (re-upload is a no-op per wp1.5-api.md). */
  connectionId?: string;
  onDone: () => void;
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsText(file);
  });
}

/**
 * `POST /imports/csv` — the CSV connector endpoint (deliverable 3), with the
 * column-mapping the API expects: `presetId` for one of the five built-in
 * mappings, or `account` (required for CSV/QIF, which carry no account
 * identity of their own). A hand-built `profile` mapping is not exposed here
 * — only the presets — since building a column-mapper UI is out of scope for
 * this pass (see docs/evidence/phase-1/wp1.6-ui.md).
 */
export function CsvImportForm({ connectionId, onDone }: CsvImportFormProps) {
  const [file, setFile] = useState<File | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [presetId, setPresetId] = useState<NonNullable<ImportFile['presetId']>>('iso_signed');
  const [accountName, setAccountName] = useState('');
  const [accountType, setAccountType] = useState<Account['type']>('depository');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const importFiles = useMutation({
    ...importFilesMutation(),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: listConnectionsOptions().queryKey }),
  });

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    setFile(event.target.files?.[0] ?? null);
  }

  async function handleSubmit(): Promise<void> {
    if (file === null) {
      setError('Choose a CSV file first.');
      return;
    }
    setError(null);
    try {
      const content = await readFileAsText(file);
      await importFiles.mutateAsync({
        body: {
          ...(connectionId !== undefined
            ? { connectionId }
            : { displayName: displayName || file.name }),
          files: [
            {
              name: file.name,
              content,
              format: 'csv',
              presetId,
              ...(connectionId === undefined
                ? {
                    account: {
                      providerAccountId: crypto.randomUUID(),
                      name: accountName || file.name,
                      type: accountType,
                      currency: currency.toUpperCase(),
                    },
                  }
                : {}),
            },
          ],
        },
      });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not import this file.');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="csv-file">CSV file</Label>
        <input
          id="csv-file"
          type="file"
          accept=".csv,text/csv"
          onChange={handleFileChange}
          className="text-small text-text-secondary"
        />
      </div>

      {connectionId === undefined && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="csv-display-name">Connection name</Label>
          <Input
            id="csv-display-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="e.g. Old bank statements"
          />
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="csv-preset">Column mapping</Label>
        <select
          id="csv-preset"
          className="h-10 rounded-md border border-border-strong bg-bg-surface px-2 text-body text-text-primary focus-visible:outline-none"
          value={presetId}
          onChange={(event) =>
            setPresetId(event.target.value as NonNullable<ImportFile['presetId']>)
          }
        >
          {PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </div>

      {connectionId === undefined && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="csv-account-name">Account name</Label>
            <Input
              id="csv-account-name"
              value={accountName}
              onChange={(event) => setAccountName(event.target.value)}
              placeholder="e.g. Checking ••1234"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="csv-account-type">Type</Label>
              <select
                id="csv-account-type"
                className="h-10 rounded-md border border-border-strong bg-bg-surface px-2 text-body text-text-primary focus-visible:outline-none"
                value={accountType}
                onChange={(event) => setAccountType(event.target.value as Account['type'])}
              >
                {ACCOUNT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="csv-account-currency">Currency</Label>
              <Input
                id="csv-account-currency"
                maxLength={3}
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
              />
            </div>
          </div>
        </>
      )}

      {error !== null && <p className="text-small text-status-critical">{error}</p>}

      <Button onClick={() => void handleSubmit()} disabled={importFiles.isPending || file === null}>
        {importFiles.isPending ? 'Importing…' : 'Import'}
      </Button>
    </div>
  );
}
