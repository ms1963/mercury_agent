/**
 * Structured JSON-lines logger with automatic secret redaction.
 * Pretty single-line output when attached to a TTY.
 */
import { redactDeep } from '../security/redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
  level: LogLevel;
}

export function createLogger(level: LogLevel = 'info', base: Record<string, unknown> = {}, sink: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Logger {
  const pretty = process.stderr.isTTY && !process.env.MERCURY_LOG_JSON;
  const log = (lvl: LogLevel, msg: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[lvl] < ORDER[logger.level]) return;
    const entry = redactDeep({ ts: new Date().toISOString(), level: lvl, msg, ...base, ...fields });
    if (pretty) {
      const { ts, level: l, msg: m, ...rest } = entry;
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      sink(`${String(ts).slice(11, 19)} ${String(l).toUpperCase().padEnd(5)} ${m}${extra}`);
    } else sink(JSON.stringify(entry));
  };
  const logger: Logger = {
    level,
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (f) => createLogger(logger.level, { ...base, ...f }, sink),
  };
  return logger;
}

export const silentLogger = createLogger('silent');
