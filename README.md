# WhatsApp Baileys Microservice

A standalone Node.js Baileys microservice for QR code multi-device WhatsApp authentication and automated message sending.

## Features
- QR Code generation for WhatsApp Web (Linked Devices)
- Multi-session handling
- Session persistence on disk
- REST API for status checks, pairing, and sending messages

## Getting Started with Docker

```bash
# Build and run container
docker compose up -d --build

# View logs
docker compose logs -f
```

## API Endpoints
- `GET /health`: Health check & active sessions count
- `POST /session/connect`: Start/retrieve session & get QR code
- `GET /session/status/:sessionId`: Get connection status
- `POST /session/logout/:sessionId`: Disconnect & clear session
- `POST /message/send`: Send text message

## Inbox event delivery

The microservice forwards Baileys message and delivery events to the Django
backend at `POST /api/integrations/whatsapp/baileys/events/`. Configure
`BACKEND_API_URL` so it is reachable from this service, and set the same
non-empty `WHATSAPP_SERVICE_SECRET` in the microservice and backend. The
backend validates this secret before accepting events. For Docker deployments,
use a backend URL reachable from inside the container (the example uses
`host.docker.internal`).

Incoming Baileys events are retried when the backend request fails. Baileys is
an unofficial WhatsApp Web integration and does not provide the guarantees or
policy compliance of the official WhatsApp Business Platform.

## Meta WhatsApp Cloud API

Meta Cloud API webhooks and outbound Cloud API requests are handled by Django,
not by this microservice. Configure the backend's `META_WEBHOOK_VERIFY_TOKEN`
and `META_APP_SECRET`, expose the backend over HTTPS, and set the Meta app's
webhook callback to `/api/integrations/whatsapp/webhook/` with the `messages`
field subscribed. Configure the WhatsApp Cloud API integration and credentials
for the relevant business in the application.

Free-form Cloud API messages are accepted only within the 24-hour customer
service window. Template sending is not currently implemented.
