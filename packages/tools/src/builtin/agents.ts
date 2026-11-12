/**
 * Multi-agent, scheduling and messaging tools.
 * - delegate_task: spawn isolated subagents (max N parallel per agent, max depth)
 * - run_workflow / list_workflows: multi-agent workflow templates
 * - schedule_*: cron / natural-language jobs with delivery
 * - send_message: deliver text to a gateway platform (Telegram, Slack, ...)
 */
import { defineTool, type AnyTool, type ToolContext } from '@mercury/core';
import { arr, anyObj, num, params, str, strEnum } from '../util.js';

const parentOf = (ctx: ToolContext) => ({
  principal: ctx.principal,
  runId: ctx.runId ?? 'adhoc',
  depth: ctx.depth,
  platform: ctx.platform,
  signal: ctx.signal,
});

interface DelegateArgs {
  goal?: string;
  context?: string;
  toolsets?: string[];
  tasks?: Array<{ goal: string; context?: string; toolsets?: string[]; role?: string }>;
}

export const delegateTask = defineTool<DelegateArgs>({
  name: 'delegate_task',
  description:
    'Delegate work to isolated subagents with fresh context. Pass one goal, or tasks=[...] to run several in parallel (bounded by the max-subagents limit). Each subagent only returns its final summary. Give each goal full context: subagents cannot see this conversation.',
  toolset: 'agents',
  risk: 'moderate',
  parameters: params({
    goal: str('Task for a single subagent'),
    context: str('Background information the subagent needs'),
    toolsets: arr(str('toolset'), 'Restrict the subagent to these toolsets'),
    tasks: arr(anyObj('{goal, context?, toolsets?, role?}'), 'Multiple tasks run in parallel'),
  }),
  async execute(a, ctx) {
    const spawner = ctx.services.spawner;
    if (!spawner) return { content: 'Subagents are not available in this context.', isError: true };
    const tasks = a.tasks?.length ? a.tasks : a.goal ? [{ goal: a.goal, context: a.context, toolsets: a.toolsets }] : [];
    if (!tasks.length) return { content: 'Provide goal or tasks.', isError: true };
    const parent = parentOf(ctx);
    if (!spawner.canSpawn(parent)) return { content: `Maximum delegation depth reached; do the task yourself.`, isError: true };
    ctx.emit('subagent.spawn', { count: tasks.length });
    const results = await spawner.spawnMany(parent, tasks.map((t) => ({ goal: t.goal, context: t.context, toolsets: t.toolsets, role: t.role })));
    return {
      content: results.map((r, i) => `### Subagent ${i + 1} (${r.status}${r.error ? `: ${r.error}` : ''})\n${r.output}`).join('\n\n'),
      data: results.map((r) => ({ runId: r.runId, status: r.status })),
    };
  },
});

export const runWorkflow = defineTool<{ workflow: string; input: string }>({
  name: 'run_workflow',
  description: 'Run a multi-agent workflow (pipeline, coordinator-worker, debate, map-reduce, ...) by name, or "auto" to let the router pick one.',
  toolset: 'agents',
  risk: 'moderate',
  parameters: params({ workflow: str('Workflow name or "auto"'), input: str('Input for the workflow') }, ['workflow', 'input']),
  async execute(a, ctx) {
    const wf = ctx.services.workflows;
    if (!wf) return { content: 'Workflows are not available.', isError: true };
    const r = await wf.run(a.workflow, a.input, { principal: ctx.principal, platform: ctx.platform, signal: ctx.signal, parentRunId: ctx.runId, depth: ctx.depth });
    return { content: `[workflow ${r.workflow}, ${r.steps.length} steps]\n${r.output}`, data: { runId: r.runId } };
  },
});

export const listWorkflows = defineTool<Record<string, never>>({
  name: 'list_workflows',
  description: 'List available workflow definitions and template types.',
  toolset: 'agents',
  risk: 'safe',
  parameters: params({}),
  async execute(_a, ctx) {
    const wf = ctx.services.workflows;
    if (!wf) return 'Workflows are not available.';
    const specs = wf.list().map((s) => `- ${s.name} (${s.type}): ${s.description ?? ''}`);
    return `${specs.join('\n')}\n\nTemplate types: ${wf.listTemplates().map((t) => t.type).join(', ')}`;
  },
});

export const scheduleCreate = defineTool<{ when: string; task: string; name?: string; deliver_to?: string }>({
  name: 'schedule_create',
  description:
    'Schedule a recurring or one-time task. when: natural language ("every weekday at 9am", "every 2 hours", "in 10 minutes", "tomorrow at 8") or cron. deliver_to: "platform:target" (e.g. "telegram:12345"); defaults to the current chat.',
  toolset: 'schedule',
  risk: 'moderate',
  parameters: params({ when: str('When to run'), task: str('Prompt to run (may reference a skill: "use skill X to ...")'), name: str('Short name'), deliver_to: str('platform:target') }, ['when', 'task']),
  async execute(a, ctx) {
    const s = ctx.services.scheduler;
    if (!s) return { content: 'Scheduler is disabled.', isError: true };
    const target = a.deliver_to ?? (ctx.chatId ? `${ctx.platform}:${ctx.chatId}` : undefined);
    const delivery = target?.includes(':') ? { platform: target.split(':')[0]!, target: target.split(':').slice(1).join(':') } : undefined;
    const job = s.create(ctx.principal.userId, { when: a.when, task: a.task, name: a.name, delivery });
    return `Scheduled "${job.name}" (${job.id}), kind=${job.kind} ${job.spec}; next run ${job.nextRun ?? 'n/a'}${delivery ? `, delivering to ${delivery.platform}` : ''}.`;
  },
});

export const scheduleList = defineTool<Record<string, never>>({
  name: 'schedule_list',
  description: 'List your scheduled jobs.',
  toolset: 'schedule',
  risk: 'safe',
  parameters: params({}),
  async execute(_a, ctx) {
    const jobs = ctx.services.scheduler?.list(ctx.principal.userId) ?? [];
    return jobs.map((j) => `- ${j.id} [${j.status}] "${j.name}" ${j.nl ?? j.spec} → next ${j.nextRun ?? '-'} (runs: ${j.runCount})`).join('\n') || 'No scheduled jobs.';
  },
});

export const scheduleManage = defineTool<{ id: string; action: 'pause' | 'resume' | 'delete' | 'run_now' | 'edit'; when?: string; task?: string }>({
  name: 'schedule_manage',
  description: 'Pause, resume, delete, edit (when/task) or immediately run a scheduled job.',
  toolset: 'schedule',
  risk: 'moderate',
  parameters: params({ id: str('Job id'), action: strEnum(['pause', 'resume', 'delete', 'run_now', 'edit'], 'Action'), when: str('New schedule (edit)'), task: str('New task (edit)') }, ['id', 'action']),
  async execute(a, ctx) {
    const s = ctx.services.scheduler;
    if (!s) return { content: 'Scheduler is disabled.', isError: true };
    const owner = ctx.principal.role === 'admin' ? undefined : ctx.principal.userId;
    switch (a.action) {
      case 'pause':
        return `Paused ${s.pause(a.id, owner).name}.`;
      case 'resume':
        return `Resumed ${s.resume(a.id, owner).name}.`;
      case 'delete':
        s.delete(a.id, owner);
        return `Deleted ${a.id}.`;
      case 'edit':
        return `Updated: next run ${s.update(a.id, { when: a.when, task: a.task }, owner).nextRun ?? '-'}.`;
      default: {
        const run = await s.runNow(a.id, owner);
        return `Run ${run.status}: ${(run.output ?? run.error ?? '').slice(0, 2000)}`;
      }
    }
  },
});

export const sendMessage = defineTool<{ platform: string; target: string; text: string }>({
  name: 'send_message',
  description: 'Send a message through a connected messaging platform (telegram, discord, slack, email, ...). target = chat id / channel / address.',
  toolset: 'messaging',
  risk: 'moderate',
  sensitive: true,
  needsApproval: (a, ctx) => (ctx.platform === a.platform ? undefined : `send to ${a.platform}:${a.target}`),
  parameters: params({ platform: str('Platform name'), target: str('Chat/channel/address'), text: str('Message text') }, ['platform', 'target', 'text']),
  async execute(a, ctx) {
    if (!ctx.services.deliver) return { content: 'Messaging gateway is not running.', isError: true };
    await ctx.services.deliver(a.platform, a.target, a.text);
    return `Sent to ${a.platform}:${a.target}.`;
  },
});

export const pairingStatus = defineTool<{ limit?: number }>({
  name: 'list_platforms',
  description: 'List messaging platforms that can be used with send_message.',
  toolset: 'messaging',
  risk: 'safe',
  parameters: params({ limit: num('unused') }),
  async execute(_a, ctx) {
    const platforms = (ctx.services.extra.platforms as (() => string[]) | undefined)?.() ?? [];
    return platforms.length ? platforms.join(', ') : 'No messaging adapters are running.';
  },
});

export const agentTools: AnyTool[] = [delegateTask, runWorkflow, listWorkflows, scheduleCreate, scheduleList, scheduleManage, sendMessage, pairingStatus];
