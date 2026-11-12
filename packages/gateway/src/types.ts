/**
 * Adapter SDK contract. An adapter connects one messaging platform to the gateway:
 * it turns platform events into `InboundMessage`s (pushed into the sink) and sends
 * `OutboundMessage`s back. Network I/O goes through an injectable `HttpTransport`
 * so adapters can be tested with mock transports.
 */
import type { Attachment } from '@mercury/core';

export interface InboundAttachment {
  name: string;
  mime?: string;
  data?: Buffer;
  url?: string;
  /** Voice memo → transcribed automatically by the gateway. */
  voice?: boolean;
}

export interface InboundMessage {
  /** Adapter name (e.g. "telegram"). */
  platform: string;
  /** Sender id on the platform (used for pairing / identity). */
  userId: string;
  /** Conversation id to reply to (chat, channel, phone number, address). */
  chatId: string;
  text: string;
  displayName?: string;
  messageId?: string;
  subject?: string;
  attachments?: InboundAttachment[];
  isGroup?: boolean;
  /** For group chats: whether the bot was mentioned (otherwise ignored). */
  mentioned?: boolean;
}

export interface OutboundMessage {
  chatId: string;
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  subject?: string;
}

export type InboundSink = (msg: InboundMessage) => Promise<void>;

export interface AdapterStatus {
  connected: boolean;
  detail?: string;
  error?: string;
  lastActivity?: string;
}

export interface WebhookRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  query: Record<string, string>;
  /** Raw body (needed for signature verification). */
  body: string;
}

export interface WebhookResponse {
  status: number;
  body?: string | object;
  contentType?: string;
}

export interface Adapter {
  readonly name: string;
  readonly type: string;
  /** Platform renders plain text only (no markdown tables etc.). */
  readonly textOnly?: boolean;
  start(sink: InboundSink): Promise<void>;
  stop(): Promise<void>;
  send(out: OutboundMessage): Promise<void>;
  status(): AdapterStatus;
  /** Platforms that push events over HTTP implement this (mounted at /webhooks/<name>). */
  handleWebhook?(req: WebhookRequest): Promise<WebhookResponse>;
}

export type AdapterFactory = (name: string, config: Record<string, unknown>, deps: AdapterDeps) => Adapter;

/** Shared services an adapter may use. */
export interface AdapterDeps {
  transport: HttpTransport;
  logger: { info(m: string, d?: object): void; warn(m: string, d?: object): void; debug(m: string, d?: object): void };
  /** Public base URL of the server (for webhook registration). */
  publicUrl?: string;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  buffer(): Promise<Buffer>;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | FormData | URLSearchParams;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpTransport {
  request(url: string, init?: HttpRequestInit): Promise<HttpResponse>;
}
