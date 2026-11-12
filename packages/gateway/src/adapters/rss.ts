/**
 * RSS/Atom adapter (inbound-only). Polls feeds and turns each *new* item into a
 * message from user `rss:<feed>` — e.g. to let the agent summarise news. Replies
 * are delivered to `deliverTo` ("platform:chatId") by the gateway, or dropped.
 * Config: feeds (array of URLs), intervalMs (default 15 min), prompt (prefix text).
 */
import { BaseAdapter } from '../base.js';
import type { OutboundMessage } from '../types.js';

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  summary: string;
}

/** Tiny RSS 2.0 / Atom parser (regex-based; good enough for well-formed feeds). */
export function parseFeedItems(xml: string): FeedItem[] {
  const tag = (block: string, name: string) => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
    return (m?.[1] ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
  };
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  return blocks.map((b) => {
    const link = tag(b, 'link') || (/<link[^>]*href="([^"]+)"/i.exec(b)?.[1] ?? '');
    return { id: tag(b, 'guid') || tag(b, 'id') || link, title: tag(b, 'title'), link, summary: tag(b, 'description') || tag(b, 'summary') };
  });
}

export class RssAdapter extends BaseAdapter {
  readonly type = 'rss';
  private seen = new Set<string>();
  private primed = false;

  protected override async connect(): Promise<void> {
    this.state.detail = `${this.feeds.length} feed(s)`;
    this.poll(() => this.pollOnce(), Number(this.config.intervalMs ?? 15 * 60_000));
  }

  private get feeds(): string[] {
    return (this.config.feeds as string[] | undefined) ?? [];
  }

  /** Check all feeds. The first run only records existing items (no flood on startup). */
  async pollOnce(): Promise<void> {
    for (const url of this.feeds) {
      const items = parseFeedItems(await (await this.deps.transport.request(url)).text());
      for (const item of items) {
        if (this.seen.has(item.id)) continue;
        this.seen.add(item.id);
        if (!this.primed && !this.config.includeExisting) continue;
        const prompt = (this.config.prompt as string | undefined) ?? 'New feed item:';
        await this.receive({ userId: `rss:${new URL(url).hostname}`, chatId: url, text: `${prompt}\n${item.title}\n${item.link}\n\n${item.summary}`.trim(), messageId: item.id });
      }
    }
    this.primed = true;
  }

  async send(_out: OutboundMessage): Promise<void> {
    // Inbound-only: the gateway forwards replies to `deliverTo` when configured.
  }
}
