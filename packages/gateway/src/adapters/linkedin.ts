/**
 * LinkedIn adapter — outbound posting to a member or organization feed via the
 * UGC Posts API (`/v2/ugcPosts`, scope `w_member_social`). Each delivered message
 * becomes a public text share authored by `authorUrn`.
 *
 * Inbound is intentionally not implemented: LinkedIn offers no general-purpose
 * inbound messaging webhook for standard apps (the Messaging API is partner-only),
 * so this adapter is send-only — ideal for scheduled agents that publish updates.
 * Config: token — OAuth2 access token (LINKEDIN_TOKEN), authorUrn — e.g.
 * "urn:li:person:abc123" or "urn:li:organization:456" (LINKEDIN_AUTHOR_URN), apiBase.
 */
import { BaseAdapter } from '../base.js';
import type { OutboundMessage } from '../types.js';

export class LinkedInAdapter extends BaseAdapter {
  readonly type = 'linkedin';

  private get api(): string {
    return this.opt('apiBase') ?? 'https://api.linkedin.com/v2';
  }

  protected override async connect(): Promise<void> {
    this.need('token', 'LINKEDIN_TOKEN');
    this.need('authorUrn', 'LINKEDIN_AUTHOR_URN');
    this.state.detail = 'UGC posts (outbound only)';
  }

  async send(out: OutboundMessage): Promise<void> {
    const author = this.need('authorUrn', 'LINKEDIN_AUTHOR_URN');
    const res = await this.deps.transport.request(`${this.api}/ugcPosts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.need('token', 'LINKEDIN_TOKEN')}`,
        'content-type': 'application/json',
        'x-restli-protocol-version': '2.0.0',
      },
      body: JSON.stringify({
        author,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: { text: out.text },
            shareMediaCategory: 'NONE',
          },
        },
        visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
      }),
    });
    if (!res.ok) throw new Error(`linkedin: post failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}
