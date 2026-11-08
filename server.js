const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const BACKEND_API_URL = process.env.BACKEND_API_URL || 'http://localhost:8000';
const WHATSAPP_SERVICE_SECRET = process.env.WHATSAPP_SERVICE_SECRET || '';
const BACKEND_EVENTS_PATH = '/api/integrations/whatsapp/baileys/events/';

if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// In-memory store for active sessions
// Map<sessionId, { sock, status, qr, user, phone, lastQrTime }>
const sessions = new Map();

const logger = pino({ level: 'warn' });

async function relayBackendEvent(event) {
  if (!WHATSAPP_SERVICE_SECRET) {
    throw new Error('WHATSAPP_SERVICE_SECRET is not configured.');
  }

  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${BACKEND_API_URL.replace(/\/$/, '')}${BACKEND_EVENTS_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WhatsApp-Service-Secret': WHATSAPP_SERVICE_SECRET,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return;
      lastError = new Error(`Backend rejected WhatsApp event (${response.status}).`);
    } catch (error) {
      lastError = error;
    }

    await delay(250 * (attempt + 1));
  }

  throw lastError;
}

function extractMessageText(message) {
  let content = message;
  while (content?.ephemeralMessage?.message || content?.viewOnceMessage?.message) {
    content = content.ephemeralMessage?.message || content.viewOnceMessage?.message;
  }

  if (content?.conversation) return { text: content.conversation, type: 'text' };
  if (content?.extendedTextMessage?.text) return { text: content.extendedTextMessage.text, type: 'text' };
  if (content?.imageMessage) return { text: content.imageMessage.caption || '[Image message]', type: 'image' };
  if (content?.videoMessage) return { text: content.videoMessage.caption || '[Video message]', type: 'video' };
  if (content?.documentMessage) return { text: content.documentMessage.fileName || '[Document message]', type: 'document' };
  if (content?.audioMessage) return { text: '[Audio message]', type: 'audio' };
  if (content?.stickerMessage) return { text: '[Sticker message]', type: 'sticker' };
  return { text: '[Unsupported message]', type: 'unsupported' };
}

async function initBaileysSession(sessionId) {
  const sessionAuthPath = path.join(AUTH_DIR, sessionId);
  if (!fs.existsSync(sessionAuthPath)) {
    fs.mkdirSync(sessionAuthPath, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionAuthPath);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[Baileys] Session ${sessionId} starting with Baileys v${version.join('.')}`);

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state,
    generateHighQualityLinkPreview: true,
  });

  const sessionObj = {
    sock,
    status: 'connecting',
    qr: null,
    qrDataUrl: null,
    user: null,
    phone: null,
    lastUpdated: Date.now()
  };

  sessions.set(sessionId, sessionObj);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessionObj.qr = qr;
      sessionObj.status = 'qr';
      sessionObj.lastUpdated = Date.now();
      try {
        sessionObj.qrDataUrl = await QRCode.toDataURL(qr);
      } catch (e) {
        console.error(`[Baileys] Error generating QR Data URL for ${sessionId}:`, e);
      }
      console.log(`[Baileys] New QR code generated for session ${sessionId}`);
    }

    if (connection === 'connecting') {
      sessionObj.status = 'connecting';
      sessionObj.lastUpdated = Date.now();
      console.log(`[Baileys] Session ${sessionId} is connecting...`);
    }

    if (connection === 'open') {
      sessionObj.status = 'open';
      sessionObj.qr = null;
      sessionObj.qrDataUrl = null;
      sessionObj.lastUpdated = Date.now();

      const rawUser = sock.user;
      sessionObj.user = rawUser;

      // Format clean phone number e.g. +8801700000000
      let rawId = rawUser?.id ? rawUser.id.split(':')[0].split('@')[0] : '';
      if (rawId) {
        sessionObj.phone = rawId.startsWith('+') ? rawId : `+${rawId}`;
      } else {
        sessionObj.phone = 'Connected Account';
      }

      console.log(`[Baileys] Session ${sessionId} connected successfully! Phone: ${sessionObj.phone}`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[Baileys] Session ${sessionId} closed. StatusCode: ${statusCode}, ShouldReconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        sessionObj.status = 'reconnecting';
        sessionObj.lastUpdated = Date.now();
        console.log(`[Baileys] Attempting reconnect for session ${sessionId}...`);
        setTimeout(() => {
          initBaileysSession(sessionId).catch(console.error);
        }, 3000);
      } else {
        sessionObj.status = 'disconnected';
        sessionObj.lastUpdated = Date.now();
        console.log(`[Baileys] Session ${sessionId} logged out. Cleaning up credentials.`);
        try {
          fs.rmSync(sessionAuthPath, { recursive: true, force: true });
        } catch (e) {
          console.error(`Error deleting auth path for ${sessionId}:`, e);
        }
        sessions.delete(sessionId);
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type === 'notify') {
      for (const msg of m.messages) {
        const remoteJid = msg.key.remoteJid || '';
        if (msg.key.fromMe || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') continue;

        const rawPhone = remoteJid.split('@')[0].split(':')[0];
        const digits = rawPhone.replace(/\D/g, '');
        if (!digits || !msg.key.id) continue;

        const { text, type } = extractMessageText(msg.message);
        try {
          await relayBackendEvent({
            event: 'message',
            session_id: sessionId,
            message_id: msg.key.id,
            remote_jid: remoteJid,
            phone: `+${digits}`,
            contact_name: msg.pushName || '',
            text,
            message_type: type,
            timestamp: Number(msg.messageTimestamp) || Date.now() / 1000,
          });
        } catch (error) {
          console.error(`[Baileys] Could not sync message ${msg.key.id} to backend:`, error);
        }
      }
    }
  });

  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (!key?.fromMe || !key.id || update?.status === undefined) continue;
      try {
        await relayBackendEvent({
          event: 'status',
          session_id: sessionId,
          message_id: key.id,
          status: String(update.status),
          timestamp: Date.now() / 1000,
        });
      } catch (error) {
        console.error(`[Baileys] Could not sync message status ${key.id} to backend:`, error);
      }
    }
  });

  return sessionObj;
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeSessions: sessions.size });
});

// Start or retrieve session
app.post('/session/connect', async (req, res) => {
  const sessionId = req.body.session_id || req.body.sessionId || 'default_session';

  try {
    let session = sessions.get(sessionId);

    if (!session || session.status === 'disconnected') {
      session = await initBaileysSession(sessionId);
      // Wait up to 3 seconds for initial QR or connection event
      let waited = 0;
      while (waited < 30 && !session.qr && session.status !== 'open') {
        await delay(100);
        waited++;
      }
    }

    return res.json({
      sessionId,
      status: session.status,
      qr: session.qr,
      qrDataUrl: session.qrDataUrl,
      phone: session.phone,
      user: session.user
    });
  } catch (err) {
    console.error(`[Baileys Error] Connect failed for ${sessionId}:`, err);
    return res.status(500).json({ error: err.message });
  }
});

// Get session status
app.get('/session/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.json({
      sessionId,
      status: 'not_found',
      qr: null,
      phone: null
    });
  }

  return res.json({
    sessionId,
    status: session.status,
    qr: session.qr,
    qrDataUrl: session.qrDataUrl,
    phone: session.phone,
    user: session.user
  });
});

// Logout / disconnect session
app.post('/session/logout/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (session && session.sock) {
    try {
      await session.sock.logout();
    } catch (e) {
      console.error(`Error during sock.logout for ${sessionId}:`, e);
      try {
        session.sock.end();
      } catch (err) {}
    }
  }

  const sessionAuthPath = path.join(AUTH_DIR, sessionId);
  if (fs.existsSync(sessionAuthPath)) {
    try {
      fs.rmSync(sessionAuthPath, { recursive: true, force: true });
    } catch (e) {
      console.error(`Error deleting auth dir for ${sessionId}:`, e);
    }
  }

  sessions.delete(sessionId);
  return res.json({ message: `Session ${sessionId} successfully disconnected and cleared.` });
});

// Send message
app.post('/message/send', async (req, res) => {
  const { sessionId, to, message } = req.body;

  if (!sessionId || !to || !message) {
    return res.status(400).json({ error: 'sessionId, to, and message are required.' });
  }

  let session = sessions.get(sessionId);
  if (!session && fs.existsSync(path.join(AUTH_DIR, sessionId))) {
    console.log(`[Baileys Auto-Restore] Attempting to restore session ${sessionId} from disk...`);
    try {
      session = await initBaileysSession(sessionId);
      let waited = 0;
      while (waited < 50 && session.status !== 'open' && session.status !== 'disconnected') {
        await delay(100);
        waited++;
      }
    } catch (e) {
      console.error(`[Baileys Auto-Restore Error] Failed for ${sessionId}:`, e);
    }
  }

  if (!session || session.status !== 'open' || !session.sock) {
    return res.status(400).json({ error: `Session ${sessionId} is not connected or active.` });
  }

  try {
    const cleanNumber = to.replace(/[^0-9]/g, '');
    const jid = cleanNumber.includes('@s.whatsapp.net') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
    const result = await session.sock.sendMessage(jid, { text: message });

    return res.json({
      status: 'sent',
      to: jid,
      result
    });
  } catch (err) {
    console.error(`[Baileys Error] Send message failed for ${sessionId}:`, err);
    return res.status(500).json({ error: err.message });
  }
});

// Check WhatsApp number registration
app.post(['/number/check', '/whatsapp/check-number'], async (req, res) => {
  const { sessionId, phone, phones } = req.body;

  if (!sessionId || (!phone && (!phones || !phones.length))) {
    return res.status(400).json({ error: 'sessionId and phone (or phones array) are required.' });
  }

  let session = sessions.get(sessionId);
  if (!session && fs.existsSync(path.join(AUTH_DIR, sessionId))) {
    console.log(`[Baileys Auto-Restore] Attempting to restore session ${sessionId} from disk...`);
    try {
      session = await initBaileysSession(sessionId);
      let waited = 0;
      while (waited < 50 && session.status !== 'open' && session.status !== 'disconnected') {
        await delay(100);
        waited++;
      }
    } catch (e) {
      console.error(`[Baileys Auto-Restore Error] Failed for ${sessionId}:`, e);
    }
  }

  if (!session || session.status !== 'open' || !session.sock) {
    return res.status(400).json({ error: `Session ${sessionId} is not connected or active.` });
  }

  const phoneList = phones && Array.isArray(phones) ? phones : [phone];

  try {
    const results = [];
    for (const rawPhone of phoneList) {
      if (!rawPhone) continue;
      const cleanNumber = String(rawPhone).replace(/[^0-9]/g, '');
      if (!cleanNumber) {
        results.push({
          phone: rawPhone,
          exists: false,
          error: 'Invalid phone number format'
        });
        continue;
      }

      try {
        const jid = `${cleanNumber}@s.whatsapp.net`;
        const checkResults = await session.sock.onWhatsApp(jid);
        const match = Array.isArray(checkResults) && checkResults.find(r => r.exists);
        results.push({
          phone: rawPhone,
          e164: `+${cleanNumber}`,
          exists: Boolean(match),
          jid: match ? match.jid : null
        });
      } catch (checkErr) {
        console.error(`[Baileys Error] Check number failed for ${rawPhone}:`, checkErr);
        results.push({
          phone: rawPhone,
          exists: false,
          error: checkErr.message
        });
      }
    }

    if (phone && !phones) {
      const single = results[0] || { phone, exists: false };
      return res.json({
        status: 'success',
        ...single
      });
    }

    return res.json({
      status: 'success',
      results
    });
  } catch (err) {
    console.error(`[Baileys Error] Check numbers failed for ${sessionId}:`, err);
    return res.status(500).json({ error: err.message });
  }
});

function autoRestoreSessions() {
  if (fs.existsSync(AUTH_DIR)) {
    const entries = fs.readdirSync(AUTH_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sessionId = entry.name;
        console.log(`[Baileys Auto-Restore] Initializing saved session: ${sessionId}`);
        initBaileysSession(sessionId).catch(err => {
          console.error(`[Baileys Auto-Restore Error] Failed for ${sessionId}:`, err);
        });
      }
    }
  }
}

app.listen(PORT, () => {
  console.log(`[Baileys Microservice] WhatsApp service running on http://localhost:${PORT}`);
  autoRestoreSessions();
});
