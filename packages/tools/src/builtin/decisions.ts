/**
 * Decision tools (toolset "decisions"): give the agent direct access to the Jev-style
 * DecisionEngine for calibrated choices, yes/no judgments and graded scores;
 * plus an ad-hoc vector store (toolset "vector") for semantic search over snippets.
 */
import { cosine, defineTool, type AnyTool, type ToolContext } from '@mercury/core';
import { anyObj, arr, num, params, str } from '../util.js';

export const decideChoice = defineTool<{ state: string; instructions: string; options: Record<string, string> }>({
  name: 'decide_choice',
  description: 'Make a calibrated choice between options. options = {key: "criterion describing when to pick it"}. Returns the chosen key with confidence.',
  toolset: 'decisions',
  risk: 'safe',
  parameters: params({ state: str('Facts/situation to decide on'), instructions: str('The question'), options: anyObj('Map of option key → criterion') }, ['state', 'instructions', 'options']),
  async execute(a, ctx) {
    const r = await ctx.services.decisions.choice(a.state, a.instructions, a.options, 'tool', ctx.runId);
    return { content: `choice: ${r.choice} (confidence ${(r.confidence ?? r.probabilities?.[r.choice] ?? 0).toFixed(2)}, via ${r.provider})`, data: r };
  },
});

export const decideNoul = defineTool<{ state: string; instructions: string }>({
  name: 'decide_noul',
  description: 'Yes/no judgment with calibrated confidence (e.g. "Is this answer complete?").',
  toolset: 'decisions',
  risk: 'safe',
  parameters: params({ state: str('Facts/situation'), instructions: str('Yes/no question') }, ['state', 'instructions']),
  async execute(a, ctx) {
    const r = await ctx.services.decisions.noul(a.state, a.instructions, 'tool', ctx.runId);
    return { content: `answer: ${r.noul >= 0.5 ? 'yes' : 'no'} (p(yes)=${r.noul.toFixed(2)}, via ${r.provider})`, data: r };
  },
});

export const decideScore = defineTool<{ state: string; instructions: string; levels: string[] }>({
  name: 'decide_score',
  description: 'Grade something on an ordered scale. levels = ["poor", "ok", "good", "excellent"] (low → high).',
  toolset: 'decisions',
  risk: 'safe',
  parameters: params({ state: str('What to grade'), instructions: str('Grading question'), levels: arr(str('level'), 'Ordered levels, low to high') }, ['state', 'instructions', 'levels']),
  async execute(a, ctx) {
    const r = await ctx.services.decisions.score(a.state, a.instructions, a.levels, 'tool', ctx.runId);
    return { content: `score: ${a.levels[r.score] ?? r.score} (${(r.fraction * 100).toFixed(0)}%, confidence ${(r.confidence ?? 0).toFixed(2)}, via ${r.provider})`, data: r };
  },
});

interface VecEntry {
  id: string;
  text: string;
  vector: number[];
}

function collectionOf(ctx: ToolContext, name: string): VecEntry[] {
  const all = (ctx.services.extra.vectorCollections ??= new Map<string, VecEntry[]>()) as Map<string, VecEntry[]>;
  const key = `${ctx.principal.userId}:${name}`;
  if (!all.has(key)) all.set(key, []);
  return all.get(key)!;
}

export const vectorIndex = defineTool<{ collection: string; texts: string[] }>({
  name: 'vector_index',
  description: 'Add text snippets to a named in-memory vector collection for semantic search (session-scoped scratch index).',
  toolset: 'vector',
  risk: 'safe',
  parameters: params({ collection: str('Collection name'), texts: arr(str('snippet'), 'Snippets to index') }, ['collection', 'texts']),
  async execute(a, ctx) {
    const col = collectionOf(ctx, a.collection);
    const vectors = await ctx.services.memory.embedder.embed(a.texts);
    a.texts.forEach((text, i) => col.push({ id: `${a.collection}-${col.length + 1}`, text, vector: vectors[i]! }));
    return `Indexed ${a.texts.length} snippets (collection size ${col.length}).`;
  },
});

export const vectorSearch = defineTool<{ collection: string; query: string; k?: number }>({
  name: 'vector_search',
  description: 'Semantic search in a vector collection created with vector_index.',
  toolset: 'vector',
  risk: 'safe',
  parameters: params({ collection: str('Collection name'), query: str('Query'), k: num('Results (default 5)') }, ['collection', 'query']),
  async execute(a, ctx) {
    const col = collectionOf(ctx, a.collection);
    if (!col.length) return 'Collection is empty.';
    const [q] = await ctx.services.memory.embedder.embed([a.query]);
    return col
      .map((e) => ({ e, s: cosine(q!, e.vector) }))
      .sort((x, y) => y.s - x.s)
      .slice(0, a.k ?? 5)
      .map(({ e, s }) => `- (${s.toFixed(3)}) ${e.text}`)
      .join('\n');
  },
});

export const decisionTools: AnyTool[] = [decideChoice, decideNoul, decideScore, vectorIndex, vectorSearch];
