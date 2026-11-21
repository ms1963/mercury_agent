/**
 * Evaluation-driven self-improvement: promote real runs into labeled eval cases, replay suites into
 * a scored, charted time series, and run a governed auto-tuner that keeps ONLY changes that improve
 * the score without breaking governance or budget. See {@link EvalService}.
 */
export * from './ports.js';
export * from './scorer.js';
export * from './store.js';
export * from './tuner.js';
export * from './service.js';
