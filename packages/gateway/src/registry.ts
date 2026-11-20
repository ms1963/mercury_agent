/** Adapter type registry: maps `type` names from config to adapter factories. */
import type { AdapterFactory } from './types.js';
import { TelegramAdapter } from './adapters/telegram.js';
import { DiscordAdapter } from './adapters/discord.js';
import { SlackAdapter } from './adapters/slack.js';
import { WhatsAppAdapter } from './adapters/whatsapp.js';
import { SignalAdapter } from './adapters/signal.js';
import { EmailAdapter } from './adapters/email.js';
import { MatrixAdapter } from './adapters/matrix.js';
import { HomeAssistantAdapter } from './adapters/homeassistant.js';
import { WebhookAdapter } from './adapters/webhook.js';
import { MattermostAdapter } from './adapters/mattermost.js';
import { TeamsAdapter } from './adapters/teams.js';
import { IrcAdapter } from './adapters/irc.js';
import { SmsAdapter } from './adapters/sms.js';
import { RssAdapter } from './adapters/rss.js';
import { WebChatAdapter } from './adapters/webchat.js';
import { CliAdapter } from './adapters/cli.js';
import { FacebookAdapter } from './adapters/facebook.js';
import { XAdapter } from './adapters/x.js';
import { LinkedInAdapter } from './adapters/linkedin.js';

const factories = new Map<string, AdapterFactory>([
  ['telegram', (n, c, d) => new TelegramAdapter(n, c, d)],
  ['discord', (n, c, d) => new DiscordAdapter(n, c, d)],
  ['slack', (n, c, d) => new SlackAdapter(n, c, d)],
  ['whatsapp', (n, c, d) => new WhatsAppAdapter(n, c, d)],
  ['signal', (n, c, d) => new SignalAdapter(n, c, d)],
  ['email', (n, c, d) => new EmailAdapter(n, c, d)],
  ['matrix', (n, c, d) => new MatrixAdapter(n, c, d)],
  ['homeassistant', (n, c, d) => new HomeAssistantAdapter(n, c, d)],
  ['webhook', (n, c, d) => new WebhookAdapter(n, c, d)],
  ['mattermost', (n, c, d) => new MattermostAdapter(n, c, d)],
  ['teams', (n, c, d) => new TeamsAdapter(n, c, d)],
  ['irc', (n, c, d) => new IrcAdapter(n, c, d)],
  ['sms', (n, c, d) => new SmsAdapter(n, c, d)],
  ['rss', (n, c, d) => new RssAdapter(n, c, d)],
  ['webchat', (n, c, d) => new WebChatAdapter(n, c, d)],
  ['cli', (n, c, d) => new CliAdapter(n, c, d)],
  ['facebook', (n, c, d) => new FacebookAdapter(n, c, d)],
  ['x', (n, c, d) => new XAdapter(n, c, d)],
  ['linkedin', (n, c, d) => new LinkedInAdapter(n, c, d)],
]);

/** Register a custom adapter type (used by plugins and `mercury new adapter`). */
export function registerAdapterType(type: string, factory: AdapterFactory): void {
  factories.set(type, factory);
}

export function adapterFactory(type: string): AdapterFactory | undefined {
  return factories.get(type);
}

export function adapterTypes(): string[] {
  return [...factories.keys()].sort();
}
