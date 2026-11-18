/**
 * Services available to tools through `ToolContext.services`. The runtime fills this
 * bag; tools only depend on these interfaces, never on the runtime itself.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { LLMService } from '../llm/service.js';
import type { MemoryManager } from '../memory/manager.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { DecisionEngine } from '../decision/engine.js';
import type { Judgment } from '../decision/judgment.js';
import type { PathJail } from '../security/paths.js';
import type { CheckpointManager } from '../checkpoints/checkpoints.js';
import type { AttachmentStore } from '../attachments/store.js';
import type { VoiceService } from '../voice/voice.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { Spawner } from '../workflows/spawner.js';
import type { WorkflowEngine } from '../workflows/engine.js';
import type { WikiService } from '../wiki/service.js';
import type { ToolRegistry } from './registry.js';
import type { ToolExecutor } from './executor.js';
import type { Attachment } from '../types/messages.js';
import type { Logger } from '../logging/logger.js';

export type DeliverFn = (platform: string, target: string, text: string, attachments?: Attachment[]) => Promise<void>;

export interface ToolServices {
  config: MercuryConfig;
  logger: Logger;
  llm: LLMService;
  memory: MemoryManager;
  skills: SkillRegistry;
  decisions: DecisionEngine;
  judgment: Judgment;
  jail: PathJail;
  checkpoints: CheckpointManager;
  attachments: AttachmentStore;
  voice: VoiceService;
  tools: ToolRegistry;
  executor?: ToolExecutor;
  scheduler?: Scheduler;
  spawner?: Spawner;
  workflows?: WorkflowEngine;
  /** LLM-Wiki subsystem (ingest/query/lint). Present when `wiki.enabled`. */
  wiki?: WikiService;
  deliver?: DeliverFn;
  /** Extension slot for plugins and tool packages (terminal/browser backends...). */
  extra: Record<string, unknown>;
}
