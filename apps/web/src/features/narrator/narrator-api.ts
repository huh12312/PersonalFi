// SPDX-License-Identifier: MIT
/**
 * `/narrator/*` (WP 10.6, decision D30): which language model narrates the Brief, and each provider's key,
 * model, local endpoint and consent - Settings › Language model.
 *
 * **Nothing here can hold a key in a response**: the settings shape has no field for one, only `key.hint`, the
 * last four characters. The key travels once, in the `PUT .../credentials` body; the form clears it from its own
 * state before the request is sent, and every mutation is built with `gcTime: 0` so TanStack Query's mutation
 * cache does not keep its variables once the form calls `reset()` (the market-data keys' rule, WP 10.4).
 *
 * Every write answers with the whole settings shape (some with `approvalsRevoked` beside it); it is written
 * straight into the query cache, so a card shows the new state without waiting for the refetch.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  deleteNarratorConsentMutation,
  deleteNarratorCredentialsMutation,
  deleteNarratorOllamaEndpointMutation,
  getNarratorSettingsOptions,
  putNarratorConsentMutation,
  putNarratorCredentialsMutation,
  putNarratorModelMutation,
  putNarratorOllamaEndpointMutation,
  putNarratorSettingsMutation,
  testNarratorProviderMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { GetNarratorSettingsResponse } from '../../api/generated/types.gen.ts';

export type NarratorSettings = GetNarratorSettingsResponse;
export type NarratorProviderState = NarratorSettings['providers'][number];
export type NarratorProvider = NarratorProviderState['provider'];
export type NarratorChoice = NarratorSettings['activeProvider'];
export type HostedNarratorProvider = Exclude<NarratorProvider, 'ollama'>;
export type NotReadyReason = NonNullable<NarratorProviderState['notReady']>;

/** The order the radio group and the cards are shown in. */
export const NARRATOR_PROVIDERS: readonly NarratorProvider[] = [
  'ollama',
  'openai',
  'openrouter',
  'anthropic',
];

/** The api's rule for a key or an Ollama bearer token, checked before anything is sent. */
export const NARRATOR_KEY_PATTERN = /^[A-Za-z0-9_.:=+/-]{16,512}$/u;
/** A vendor model id, or a local model's name (`HOSTED_MODEL_ID_PATTERN` in `@advisor/local-model`). */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function isHosted(provider: NarratorProvider): provider is HostedNarratorProvider {
  return provider !== 'ollama';
}

const settingsOptions = () => getNarratorSettingsOptions();

/** `GET /narrator/settings`. `retry: false`: an api that predates the route degrades to a sentence, not a spinner. */
export function useNarratorSettingsQuery() {
  return useQuery({ ...settingsOptions(), staleTime: 30_000, retry: false });
}

/** Writes the settings a write answered with into the cache (dropping `approvalsRevoked`), then refetches. */
function useApply() {
  const queryClient = useQueryClient();
  return async (response: NarratorSettings & { approvalsRevoked?: number }) => {
    const { approvalsRevoked: _ignored, ...settings } = response;
    queryClient.setQueryData(settingsOptions().queryKey, settings);
    await queryClient.invalidateQueries({ queryKey: settingsOptions().queryKey });
  };
}

/** `PUT /narrator/settings` - step-up. */
export function useSetActiveProviderMutation() {
  const apply = useApply();
  return useMutation({ ...putNarratorSettingsMutation(), gcTime: 0, onSuccess: apply });
}

/** `PUT /narrator/providers/{hosted}/model` - step-up. */
export function useSetModelMutation() {
  const apply = useApply();
  return useMutation({ ...putNarratorModelMutation(), gcTime: 0, onSuccess: apply });
}

/** `PUT /narrator/providers/ollama/endpoint` - step-up. */
export function useSetOllamaEndpointMutation() {
  const apply = useApply();
  return useMutation({ ...putNarratorOllamaEndpointMutation(), gcTime: 0, onSuccess: apply });
}

/** `DELETE /narrator/providers/ollama/endpoint` - step-up. */
export function useClearOllamaEndpointMutation() {
  const apply = useApply();
  return useMutation({ ...deleteNarratorOllamaEndpointMutation(), gcTime: 0, onSuccess: apply });
}

/** `PUT /narrator/providers/{hosted}/consent` - step-up. */
export function useGiveConsentMutation() {
  const apply = useApply();
  return useMutation({ ...putNarratorConsentMutation(), gcTime: 0, onSuccess: apply });
}

/** `DELETE /narrator/providers/{hosted}/consent` - step-up; withdrawing the active provider's turns narration off. */
export function useWithdrawConsentMutation() {
  const apply = useApply();
  return useMutation({ ...deleteNarratorConsentMutation(), gcTime: 0, onSuccess: apply });
}

/** `PUT /narrator/providers/{p}/credentials` - step-up. The key is not checked here: Test is the check. */
export function useSaveNarratorKeyMutation() {
  const apply = useApply();
  return useMutation({ ...putNarratorCredentialsMutation(), gcTime: 0, onSuccess: apply });
}

/** `DELETE /narrator/providers/{p}/credentials` - step-up; revokes nothing at the provider. */
export function useRemoveNarratorKeyMutation() {
  const apply = useApply();
  return useMutation({ ...deleteNarratorCredentialsMutation(), gcTime: 0, onSuccess: apply });
}

/** `POST /narrator/providers/{p}/test` - session only; one per provider per 20 s. */
export function useTestProviderMutation() {
  return useMutation({ ...testNarratorProviderMutation(), gcTime: 0 });
}

/** The api's `code` on a thrown problem, or `null`. */
export function problemCode(cause: unknown): string | null {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

/** The api's `detail` (plain words, fixed copy that never repeats a key), or `fallback`. */
export function problemDetail(cause: unknown, fallback: string): string {
  if (typeof cause === 'object' && cause !== null && 'detail' in cause) {
    const detail = (cause as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail !== '') return detail;
  }
  return fallback;
}
