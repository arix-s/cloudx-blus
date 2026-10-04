const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SALT = 543210;
const MULTIPLIER = 10007;
const ADDEND = 73;

/**
 * Encodes Telegram messageId to a clean 6-character short code (e.g. fWhBKD)
 */
export function messageIdToShortCode(messageId: number): string {
  if (!messageId || messageId <= 0) return '';
  const num = (messageId + SALT) * MULTIPLIER + ADDEND;
  let code = '';
  let n = num;
  while (n > 0) {
    code = CHARS[n % CHARS.length] + code;
    n = Math.floor(n / CHARS.length);
  }
  return code;
}

/**
 * Decodes 6-character short code back to Telegram messageId
 */
export function shortCodeToMessageId(code: string): number | null {
  if (!code || code.length < 4) return null;
  let num = 0;
  for (let i = 0; i < code.length; i++) {
    const idx = CHARS.indexOf(code[i]);
    if (idx === -1) return null;
    num = num * CHARS.length + idx;
  }
  const original = (num - ADDEND) / MULTIPLIER - SALT;
  if (Number.isInteger(original) && original > 0) {
    return original;
  }
  return null;
}
