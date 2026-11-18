# Messaging-Gateway

Das Gateway verbindet Mercury mit Chat-Plattformen: Telegram, Discord, Slack, WhatsApp (Cloud API),
Signal (signal-cli REST), Matrix, Mattermost, E-Mail (IMAP/SMTP), SMS (Twilio), Microsoft Teams,
IRC, Home Assistant, RSS-Feeds, generische Webhooks, Web-Chat und die CLI.

1. Konfigurieren Sie einen Adapter in `~/.mercury/config.yaml` unter `gateway.adapters` (Tokens über Umgebungsvariablen).
2. Führen Sie `mercury serve` aus (oder `mercury gateway start`).
3. Unbekannte Chat-Benutzer erhalten einen **Kopplungscode** (Pairing-Code). Verknüpfen Sie ihn mit `mercury gateway pair CODE`
   oder dem Integrations-Panel; die Chat-Identität wird dann Ihrem Mercury-Benutzer zugeordnet und
   Gespräche werden plattformübergreifend fortgesetzt.

Sprachnachrichten werden automatisch transkribiert. Nachrichten, bei denen sich die Jev-Triage unsicher ist, landen in
der menschlichen Prüfungs-Warteschlange.
