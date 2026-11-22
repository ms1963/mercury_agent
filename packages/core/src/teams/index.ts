/**
 * Multi-agent orchestration ("teams"): define and persist named teams of roles/agents with an
 * orchestration strategy (coordinator→workers, pipeline, or debate/vote), then run one on a task.
 * Delegation reuses the workflow spawner + blackboard; runs are governed (budget ceiling, approval,
 * policy), degrade gracefully on member failure, and are fully auditable. See {@link TeamsService}.
 */
export * from './ports.js';
export * from './store.js';
export * from './service.js';
