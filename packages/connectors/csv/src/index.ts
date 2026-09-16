// SPDX-License-Identifier: MIT
/**
 * `@connector/csv` — CSV, OFX/QFX and QIF as a provider.
 *
 * The parsers are exported alongside the connector because they are pure
 * `string → structure` functions and the golden tests call them directly: a
 * fixture that has to go through a connection handle to be parsed is a fixture
 * whose failures are three frames from their cause.
 *
 * See `NOTICE` for the third-party position (short version: nothing is vendored,
 * and the reason is written down).
 */
export {
  CSV_CAPABILITIES,
  CSV_MANIFEST,
  CsvImportConnector,
  type CsvConnectInput,
  type CsvConnectorOptions,
  type CsvFileInput,
} from './connector.ts';
export {
  FILE_FORMATS,
  IMPORT_PROVIDER,
  importFile,
  type FileFormat,
  type ImportFileInput,
  type ImportResult,
  type TargetAccount,
} from './import.ts';
export { CSV_PRESETS, presetById, type CsvProfile } from './presets.ts';
export {
  csvColumnMappingSchema,
  csvConnectionConfigSchema,
  csvProfileSchema,
  parseCsvConnectionConfig,
  parseCsvProfile,
  resolveCsvProfile,
  type CsvConnectionConfig,
} from './config.ts';
export { cell, readCsv, resolveColumns, type ColumnRef, type CsvColumnMapping } from './csv.ts';
export {
  child,
  descendants,
  ofxDate,
  parseOfx,
  readOfxStatements,
  text,
  type OfxNode,
  type OfxStatement,
  type OfxTransaction,
} from './ofx.ts';
export { parseQif, type QifFile, type QifTransaction } from './qif.ts';
export {
  DATE_FORMATS,
  parseAmount,
  parseFileDate,
  type AmountSign,
  type DateFormat,
  type DecimalSeparator,
} from './scalars.ts';
export { ImportError, asInvalidInput } from './errors.ts';
export type {
  StagedEntry,
  StagedTransactionInput,
  StagedTransactionKind,
  StagingStore,
} from './staging.ts';
