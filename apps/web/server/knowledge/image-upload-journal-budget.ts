import { createHash } from 'node:crypto';
import type { KnowledgeUploadRecord } from './image-upload-receipts';
export const KNOWLEDGE_JOURNAL_SUFFIX_BYTES = 79;
export const KNOWLEDGE_JOURNAL_MAX_NOTES = 3;
export interface KnowledgeJournalBudgetQuote {
  preparedBytes: number;
  maxBytes: number;
  maxNotes: 3;
  preparedSha256: string;
}
export const encodeKnowledgeJournalPrepared = (record: KnowledgeUploadRecord) =>
  JSON.stringify({ ...record, state: 'prepared' }) + '\n';
export const encodeKnowledgeJournalNote = (state: string) => JSON.stringify({ state }) + '\n';
const byteCount = (line: string) => Buffer.byteLength(line, 'utf8');
const hash = (line: string) => createHash('sha256').update(line, 'utf8').digest('hex');
export function quoteKnowledgeUploadJournal(record: KnowledgeUploadRecord): KnowledgeJournalBudgetQuote {
  const line = encodeKnowledgeJournalPrepared(record),
    preparedBytes = byteCount(line);
  if (!preparedBytes || preparedBytes + KNOWLEDGE_JOURNAL_SUFFIX_BYTES > 8192)
    throw Error('KNOWLEDGE_JOURNAL_QUOTE_TOO_LARGE');
  return Object.freeze({
    preparedBytes,
    maxBytes: preparedBytes + KNOWLEDGE_JOURNAL_SUFFIX_BYTES,
    maxNotes: KNOWLEDGE_JOURNAL_MAX_NOTES,
    preparedSha256: hash(line)
  });
}
/** Charges requested bytes before IO. Failed/partial writes never refund that allowance. */
export class KnowledgeJournalAllowance {
  private spentBytes: number;
  private notes = 0;
  private sealed = false;
  private readonly quote: KnowledgeJournalBudgetQuote;
  constructor(quote: KnowledgeJournalBudgetQuote, prepared: string) {
    if (
      quote.preparedBytes !== byteCount(prepared) ||
      quote.maxBytes !== quote.preparedBytes + KNOWLEDGE_JOURNAL_SUFFIX_BYTES ||
      quote.maxBytes > 8192 ||
      quote.maxNotes !== 3 ||
      quote.preparedSha256 !== hash(prepared)
    )
      throw Error('KNOWLEDGE_JOURNAL_QUOTE_MISMATCH');
    this.quote = Object.freeze({ ...quote });
    this.spentBytes = quote.preparedBytes;
  }
  note(state: string): string {
    const line = encodeKnowledgeJournalNote(state),
      bytes = byteCount(line);
    if (this.sealed || this.notes >= this.quote.maxNotes || this.spentBytes + bytes > this.quote.maxBytes) {
      this.sealed = true;
      throw Error('KNOWLEDGE_JOURNAL_ALLOWANCE_EXHAUSTED');
    }
    this.notes++;
    this.spentBytes += bytes;
    return line;
  }
}
