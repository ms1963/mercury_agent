/**
 * Gateway controller: owns the configured adapters and turns inbound platform
 * messages into agent turns.
 *
 * Pipeline for each inbound message:
 *   group filter → identity lookup (unknown → DM pairing code) → /approve /deny
 *   → attachments saved (voice memos transcribed) → optional Jev triage
 *   (low confidence → human review queue) → agent turn (session continuity) → reply.
 */
import {
  newId,
  nowIso,
  type ApprovalService,
  type Attachment,
  type AttachmentStore,
  type Db,
  type EventBus,
  type Judgment,
  type Logger,
  type MercuryConfig,
  type PairingService,
  type Principal,
  type UserService,
  type VoiceService,
} from '@mercury/core';
import { adapterFactory } from './registry.js';
import { FetchTransport } from './transport.js';
import type { Adapter, AdapterStatus, HttpTransport, InboundMessage, WebhookRequest, WebhookResponse } from './types.js';

export interface TurnContext {
  platform: string;
  chatId: string;
  sessionId?: string;
  attachments: Attachment[];
}

export type TurnHandler = (principal: Principal, text: string, ctx: TurnContext) => Promise<{ output: string; sessionId: string }>;

export interface GatewayDeps {
  config: MercuryConfig;
  db: Db;
  bus: EventBus;
  logger: Logger;
  users: UserService;
  pairing: PairingService;
  approvals: ApprovalService;
  attachments: AttachmentStore;
  voice: VoiceService;
  judgment: Judgment;
  handleTurn: TurnHandler;
  transport?: HttpTransport;
}

export const TRIAGE_CATEGORIES = {
  respond: 'A normal request or question the assistant should answer.',
  ignore: 'Spam, automated notifications or messages that need no answer.',
  urgent: 'Time-critical issues a human should look at immediately.',
};

export class Gateway {
  readonly adapters = new Map<string, Adapter>();
  private errors = new Map<string, string>();
  /** Last chat per (platform,user) so approval prompts reach the right conversation. */
  private lastChat = new Map<string, string>();
  private unsubscribe?: () => void;

  constructor(private deps: GatewayDeps) {}

  /** Instantiate adapters from config (`gateway.adapters.<name>.type`, defaults to name). */
  async start(): Promise<void> {
    const { config, logger } = this.deps;
    for (const [name, raw] of Object.entries(config.gateway.adapters)) {
      if (raw.enabled === false) continue;
      await this.add(name, raw).catch((err: unknown) => {
        this.errors.set(name, String(err));
        logger.warn(`gateway adapter ${name} failed to start`, { error: String(err) });
      });
    }
    // Route approval prompts for gateway-originated runs to the originating chat.
    this.unsubscribe = this.deps.bus.on('approval.request', (e) => {
      const platform = String(e.data.platform ?? '');
      const chat = this.lastChat.get(`${platform}:${e.userId}`);
      if (!this.adapters.has(platform) || !chat) return;
      const text = `Approval needed: ${String(e.data.title ?? e.data.tool)}\n${String(e.data.detail ?? '').slice(0, 500)}\nReply /approve ${String(e.data.id)} or /deny ${String(e.data.id)}${e.data.requireAdmin ? '\n(Only an admin can approve this request.)' : ''}`;
      void this.deliver(platform, chat, text).catch(() => undefined);
    });
  }

  /** Add and start one adapter (also used by plugins and tests). */
  async add(name: string, config: Record<string, unknown>, adapter?: Adapter): Promise<Adapter> {
    const type = String(config.type ?? name);
    if (!adapter) {
      const factory = adapterFactory(type);
      if (!factory) throw new Error(`unknown adapter type "${type}"`);
      adapter = factory(name, config, { transport: this.deps.transport ?? new FetchTransport(), logger: this.deps.logger, publicUrl: this.deps.config.server.publicUrl });
    }
    await adapter.start((msg) => this.onInbound(msg));
    this.adapters.set(name, adapter);
    this.errors.delete(name);
    return adapter;
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    await Promise.all([...this.adapters.values()].map((a) => a.stop().catch(() => undefined)));
    this.adapters.clear();
  }

  status(): Array<{ name: string; type: string; status: AdapterStatus }> {
    const list = [...this.adapters.values()].map((a) => ({ name: a.name, type: a.type, status: a.status() }));
    for (const [name, error] of this.errors) list.push({ name, type: String(this.deps.config.gateway.adapters[name]?.type ?? name), status: { connected: false, error } });
    return list;
  }

  platforms(): string[] {
    return [...this.adapters.keys()];
  }

  async deliver(platform: string, chatId: string, text: string, attachments?: Attachment[]): Promise<void> {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`platform "${platform}" is not connected`);
    await adapter.send({ chatId, text, attachments });
    this.deps.bus.emit({ type: 'gateway.outbound', data: { platform, chatId, chars: text.length } });
  }

  async handleWebhook(name: string, req: WebhookRequest): Promise<WebhookResponse> {
    const adapter = this.adapters.get(name);
    if (!adapter?.handleWebhook) return { status: 404, body: { error: `no webhook adapter "${name}"` } };
    return adapter.handleWebhook(req);
  }

  // ---- review queue (triage) --------------------------------------------------
  reviewQueue(status = 'pending'): Array<Record<string, unknown>> {
    return this.deps.db.all<Record<string, unknown>>('SELECT * FROM review_queue WHERE status = ? ORDER BY created_at DESC LIMIT 200', status).map((r) => ({
      ...r,
      item: JSON.parse(String(r.item)),
      decision: r.decision ? JSON.parse(String(r.decision)) : null,
    }));
  }

  /** Resolve a queued item: "respond" runs the agent turn now, "dismiss" drops it. */
  async resolveReview(id: string, action: 'respond' | 'dismiss'): Promise<void> {
    const row = this.deps.db.get<{ item: string }>('SELECT item FROM review_queue WHERE id = ?', id);
    if (!row) throw new Error('review item not found');
    this.deps.db.run('UPDATE review_queue SET status = ? WHERE id = ?', action === 'respond' ? 'responded' : 'dismissed', id);
    if (action === 'respond') await this.process(JSON.parse(row.item) as InboundMessage, true);
  }

  // ---- inbound pipeline -------------------------------------------------------
  /** Entry point for adapters. Never throws (errors are logged and reported to the chat). */
  async onInbound(msg: InboundMessage): Promise<void> {
    try {
      await this.process(msg, false);
    } catch (err) {
      this.deps.logger.warn('gateway turn failed', { platform: msg.platform, error: String(err) });
      await this.deliver(msg.platform, msg.chatId, `Sorry, something went wrong: ${String(err)}`).catch(() => undefined);
    }
  }

  private async process(msg: InboundMessage, skipTriage: boolean): Promise<void> {
    const { users, pairing, config, bus } = this.deps;
    if (msg.isGroup && !msg.mentioned) return;
    bus.emit({ type: 'gateway.inbound', data: { platform: msg.platform, chatId: msg.chatId, from: msg.userId, displayName: msg.displayName, subject: msg.subject, preview: (msg.text ?? '').slice(0, 280) } });

    const user = users.findIdentity(msg.platform, msg.userId);
    if (!user) {
      if (!config.gateway.pairing) return this.reply(msg, 'This assistant is private. Ask the owner for access.');
      const req = pairing.request(msg.platform, msg.userId, msg.chatId, msg.displayName);
      return this.reply(
        msg,
        `Hi! I don't know you yet. Your pairing code is ${req.code}.\nAsk a Mercury user to approve it (web UI → Integrations, or \`mercury gateway pair ${req.code}\`). It expires at ${req.expiresAt}.`,
      );
    }
    const principal = users.principalFor(user);
    this.lastChat.set(`${msg.platform}:${user.id}`, msg.chatId);

    // Approval replies from chat.
    const ap = /^\/(approve|deny)\s+(\S+)/i.exec(msg.text.trim());
    if (ap) {
      const ok = this.deps.approvals.resolveAs(ap[2]!, ap[1]!.toLowerCase() === 'approve', principal);
      return this.reply(msg, ok ? `Request ${ap[1]!.toLowerCase()}d.` : 'No pending approval with that id.');
    }

    const { text, attachments } = await this.prepare(msg, user.id);
    if (!text.trim() && !attachments.length) return;

    if (config.gateway.triage && !skipTriage) {
      const verdict = await this.deps.judgment.triage({ from: msg.displayName ?? msg.userId, subject: msg.subject, body: text }, TRIAGE_CATEGORIES);
      if (verdict.category === 'ignore' && !verdict.needsReview) return;
      if (verdict.needsReview || verdict.category === 'urgent') {
        this.deps.db.run(
          'INSERT INTO review_queue (id, user_id, source, item, decision, status, created_at) VALUES (?,?,?,?,?,?,?)',
          newId('rev'), user.id, msg.platform, JSON.stringify({ ...msg, text, attachments: undefined }), JSON.stringify(verdict), 'pending', nowIso(),
        );
        return this.reply(msg, 'Thanks — your message was queued for human review.');
      }
    }

    const key = config.gateway.continuity === 'per-chat' ? `gw.session.chat:${msg.platform}:${msg.chatId}` : `gw.session.user:${user.id}`;
    const prev = this.deps.db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value;
    const result = await this.deps.handleTurn(principal, text, { platform: msg.platform, chatId: msg.chatId, sessionId: prev, attachments });
    this.deps.db.run('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, result.sessionId);
    if (result.output) await this.reply(msg, result.output);
  }

  /** Save attachments; voice memos are transcribed and their text becomes the prompt. */
  private async prepare(msg: InboundMessage, userId: string): Promise<{ text: string; attachments: Attachment[] }> {
    let text = msg.text;
    const saved: Attachment[] = [];
    for (const a of msg.attachments ?? []) {
      if (!a.data) continue;
      const att = await this.deps.attachments.save(userId, a.name, a.data, a.mime);
      if (a.voice && att.path) {
        const transcript = await this.deps.voice.transcribe(att.path, att.mime).catch((e: unknown) => `(transcription failed: ${String(e)})`);
        text = `${text ? `${text}\n` : ''}[voice memo] ${transcript}`;
      } else saved.push(att);
    }
    return { text, attachments: saved };
  }

  private async reply(msg: InboundMessage, text: string): Promise<void> {
    await this.deliver(msg.platform, msg.chatId, text);
  }
}
