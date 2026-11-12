/**
 * WorkflowEngine — loads workflow specs (YAML/JSON) from `<assets>/workflows` and
 * `<dataDir>/workflows`, keeps the template registry, and runs workflows with budgets.
 * `run('auto', ...)` lets the decision engine choose the best workflow.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import YAML from 'yaml';
import type { Db } from '../db/db.js';
import type { Judgment } from '../decision/judgment.js';
import type { EventBus } from '../events/bus.js';
import type { LLMService } from '../llm/service.js';
import type { Blackboard } from '../memory/blackboard.js';
import { MercuryError, NotFoundError, errorMessage, newId, nowIso, type Principal } from '../types/common.js';
import type { Spawner, ParentInfo } from './spawner.js';
import { blackboardTemplate, debateTemplate } from './templates/collaborative.js';
import { coordinatorWorkerTemplate, mapReduceTemplate, routerTemplate, treeTemplate } from './templates/hierarchical.js';
import { pipelineTemplate, roundRobinTemplate, singleTemplate } from './templates/linear.js';
import type { WorkflowContext, WorkflowResult, WorkflowSpec, WorkflowStep, WorkflowTemplate } from './types.js';

export const BUILTIN_TEMPLATES: WorkflowTemplate[] = [singleTemplate, pipelineTemplate, roundRobinTemplate, coordinatorWorkerTemplate, treeTemplate, mapReduceTemplate, routerTemplate, blackboardTemplate, debateTemplate];

export interface WorkflowRunOptions {
  principal: Principal;
  platform?: string;
  signal?: AbortSignal;
  parentRunId?: string;
  depth?: number;
}

export class WorkflowEngine {
  private templates = new Map<string, WorkflowTemplate>();

  constructor(
    private dirs: { bundled?: string; user: string },
    private spawner: Spawner,
    private judgment: Judgment,
    private llm: LLMService,
    private blackboard: Blackboard,
    private db: Db,
    private bus: EventBus,
  ) {
    for (const t of BUILTIN_TEMPLATES) this.registerTemplate(t);
    mkdirSync(dirs.user, { recursive: true });
  }

  registerTemplate(t: WorkflowTemplate): void {
    this.templates.set(t.type, t);
  }

  listTemplates(): Array<{ type: string; description: string }> {
    return [...this.templates.values()].map((t) => ({ type: t.type, description: t.description }));
  }

  /** All specs; user specs override bundled ones with the same name. */
  list(): WorkflowSpec[] {
    const specs = new Map<string, WorkflowSpec>();
    for (const dir of [this.dirs.bundled, this.dirs.user]) {
      if (!dir || !existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => /\.(ya?ml|json)$/.test(x))) {
        try {
          const spec = parseSpec(readFileSync(join(dir, f), 'utf8'), basename(f).replace(/\.\w+$/, ''));
          specs.set(spec.name, spec);
        } catch {
          /* ignore invalid spec files (reported by `mercury doctor`) */
        }
      }
    }
    return [...specs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): WorkflowSpec | undefined {
    return this.list().find((s) => s.name === name);
  }

  save(spec: WorkflowSpec): WorkflowSpec {
    const valid = validateSpec(spec, this.templates);
    writeFileSync(join(this.dirs.user, `${valid.name}.yaml`), YAML.stringify(valid));
    return valid;
  }

  async run(nameOrSpec: string | WorkflowSpec, input: string, opts: WorkflowRunOptions): Promise<WorkflowResult & { runId: string; workflow: string }> {
    let spec: WorkflowSpec | undefined;
    if (typeof nameOrSpec !== 'string') spec = validateSpec(nameOrSpec, this.templates);
    else if (nameOrSpec === 'auto') {
      const all = this.list();
      const pick = await this.judgment.selectWorkflow(input, Object.fromEntries(all.map((s) => [s.name, s.description ?? s.type])));
      spec = all.find((s) => s.name === pick?.workflow) ?? all[0];
    } else spec = this.get(nameOrSpec);
    if (!spec) throw new NotFoundError(`Workflow "${String(nameOrSpec)}" not found`, 'workflows');
    const template = this.templates.get(spec.type);
    if (!template) throw new MercuryError(`Unknown workflow type "${spec.type}"`, 'workflow_type', 'workflows');

    const runId = newId('run');
    const controller = new AbortController();
    opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    const depth = opts.depth ?? 0;
    const parent: ParentInfo = { principal: opts.principal, runId, depth, platform: opts.platform ?? 'web', signal: controller.signal, maxSubagents: spec.budget?.maxSubagents, maxDepth: spec.budget?.maxDepth !== undefined ? depth + spec.budget.maxDepth : undefined, maxRuns: spec.budget?.maxRuns ?? 30 };
    this.db.run('INSERT INTO runs (id, user_id, parent_run_id, kind, status, input, workflow, depth, started_at) VALUES (?,?,?,?,?,?,?,?,?)', runId, opts.principal.userId, opts.parentRunId, 'workflow', 'running', input.slice(0, 10_000), spec.name, depth, nowIso());
    this.bus.emit({ type: 'workflow.start', runId, userId: opts.principal.userId, data: { workflow: spec.name, type: spec.type, agents: spec.agents.map((a) => a.name) } });

    const steps: WorkflowStep[] = [];
    const ctx: WorkflowContext = {
      spec,
      input,
      principal: opts.principal,
      runId,
      signal: controller.signal,
      judgment: this.judgment,
      blackboard: this.blackboard,
      steps,
      option: <T>(key: string, fallback: T) => (spec.options?.[key] as T | undefined) ?? fallback,
      emit: (type, data) => this.bus.emit({ type, runId, data }),
      runAgent: async (agent, task) => {
        this.bus.emit({ type: 'workflow.step', runId, data: { agent: agent.name, task: task.slice(0, 500) } });
        const r = await this.spawner.spawn(parent, { goal: task, name: agent.name, role: agent.role, toolsets: agent.toolsets, model: agent.model, pattern: agent.pattern });
        steps.push({ agent: agent.name, input: task, output: r.output, runId: r.runId, status: r.status });
        return r;
      },
      runMany: (items) => Promise.all(items.map((i) => ctx.runAgent(i.agent, i.task))),
      complete: async (system, user, json) =>
        (await this.llm.complete(opts.principal, [{ role: 'system', content: system }, { role: 'user', content: user }], { responseFormat: json ? 'json' : 'text', runId, kind: 'workflow' })).content,
    };

    try {
      const output = await template.run(ctx);
      this.db.run('UPDATE runs SET status=?, output=?, ended_at=? WHERE id=?', 'completed', output.slice(0, 20_000), nowIso(), runId);
      this.bus.emit({ type: 'workflow.end', runId, data: { workflow: spec.name, status: 'completed', steps: steps.length } });
      return { output, steps, runId, workflow: spec.name };
    } catch (err) {
      this.db.run('UPDATE runs SET status=?, output=?, ended_at=? WHERE id=?', 'error', errorMessage(err), nowIso(), runId);
      this.bus.emit({ type: 'workflow.end', runId, data: { workflow: spec.name, status: 'error', error: errorMessage(err) } });
      throw err;
    } finally {
      this.spawner.release(runId);
    }
  }
}

export function parseSpec(text: string, fallbackName: string): WorkflowSpec {
  const raw = (text.trim().startsWith('{') ? JSON.parse(text) : YAML.parse(text)) as Partial<WorkflowSpec>;
  return { ...raw, name: raw.name ?? fallbackName, type: raw.type ?? 'single', agents: raw.agents ?? [] } as WorkflowSpec;
}

function validateSpec(spec: WorkflowSpec, templates: Map<string, WorkflowTemplate>): WorkflowSpec {
  if (!spec.name || !/^[\w-]{1,64}$/.test(spec.name)) throw new MercuryError('Workflow needs a name (letters, digits, - or _)', 'invalid_workflow', 'workflows', 400);
  if (!templates.has(spec.type)) throw new MercuryError(`Unknown workflow type "${spec.type}". Types: ${[...templates.keys()].join(', ')}`, 'invalid_workflow', 'workflows', 400);
  const agents = (spec.agents ?? []).filter((a) => a && typeof a.name === 'string');
  return { ...spec, agents: agents.length ? agents : [{ name: 'agent' }] };
}
