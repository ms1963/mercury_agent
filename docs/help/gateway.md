# Messaging gateway

The gateway connects Mercury to chat platforms: Telegram, Discord, Slack, WhatsApp, Signal,
Matrix, Mattermost, Email, SMS (Twilio), Microsoft Teams, Google Chat, LINE, Messenger,
Home Assistant, generic webhooks and more.

1. Configure an adapter in `~/.mercury/config.yaml` under `gateway.adapters` (tokens via env vars).
2. Run `mercury serve` (or `mercury gateway start`).
3. Unknown chat users receive a **pairing code**. Link it with `mercury gateway pair CODE`
   or the Integrations panel; the chat identity is then mapped to your Mercury user and
   conversations continue across platforms.

Voice memos are transcribed automatically. Messages the Jev triage is unsure about land in
the human review queue.
