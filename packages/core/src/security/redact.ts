/**
 * Secret and PII redaction applied to logs, tool outputs and (optionally) agent output.
 */

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['openrouter_key', /\bsk-or-[A-Za-z0-9_-]{20,}\b/g],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['telegram_bot_token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['mercury_token', /\bmrc_[A-Za-z0-9]{20,}\b/g],
  ['bearer', /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g],
  ['password_assignment', /\b((?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*)["']?[^\s"']{6,}["']?/gi],
];

const PII_PATTERNS: Array<[string, RegExp]> = [
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['phone', /(?<!\w)\+?\d[\d ()-]{8,}\d(?!\w)/g],
  ['credit_card', /\b(?:\d[ -]?){13,16}\b/g],
  ['iban', /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b/g],
];

export interface RedactionResult {
  text: string;
  found: string[];
}

export function redactSecrets(text: string): RedactionResult {
  const found: string[] = [];
  let out = text;
  for (const [name, re] of SECRET_PATTERNS) {
    out = out.replace(re, (_m, prefix?: string) => {
      found.push(name);
      return `${typeof prefix === 'string' && prefix.length < 40 ? prefix : ''}[REDACTED:${name}]`;
    });
  }
  return { text: out, found };
}

export function redactPii(text: string): RedactionResult {
  const found: string[] = [];
  let out = text;
  for (const [name, re] of PII_PATTERNS) {
    out = out.replace(re, () => {
      found.push(name);
      return `[REDACTED:${name}]`;
    });
  }
  return { text: out, found };
}

/** Deep-redact secrets in any JSON-like value (used by the logger and audit log). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value).text as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /pass(word)?|secret|api_?key|token|authorization/i.test(k) && typeof v === 'string' ? '[REDACTED]' : redactDeep(v);
    }
    return out as T;
  }
  return value;
}
