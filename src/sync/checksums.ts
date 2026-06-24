import { createHash } from 'node:crypto';

export function computeChecksum(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
