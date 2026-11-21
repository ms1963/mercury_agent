/**
 * Self-distilling skills subsystem: distil reusable, parameterized skills from winning run
 * traces, govern them (review → approve, versioned, auto-retire by success-rate) and reuse an
 * approved matching skill to run proven paths. See {@link DistillerService}.
 */
export * from './ports.js';
export * from './generalize.js';
export * from './store.js';
export * from './distiller.js';
