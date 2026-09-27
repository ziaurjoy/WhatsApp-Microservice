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
