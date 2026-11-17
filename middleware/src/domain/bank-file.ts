/**
 * Record of every file exchanged with the bank (both directions).
 * WHY: proves what was sent and received, and when, by checksum. It is also how duplicate files are detected.
 */
export interface BankFileRecord {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  status: 'PROCESSED' | 'DUPLICATE' | 'QUARANTINED' | 'CREATED' | 'TRANSMITTED';
  name: string;
  checksum: string;
  fileType?: string;
  batchRef?: string;
  createdAt?: string;
  receivedAt?: string;
  error?: string;
  result?: unknown;
}
