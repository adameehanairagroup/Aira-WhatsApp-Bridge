/**
 * 🚀 Sovereign AIRA Founder Desk & WhatsApp Bridge v2.1
 * Engineered by Er. Adam Eehan (Founder & CEO, Aira Group of Technology)
 * Connects airaaigroup.in live visitors directly to Founder's personal WhatsApp (+91 8921 584 368)
 * With Sovereign Aira 3 Ultra Multilingual AI Co-Pilot Fallback
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const QRCode = require('qrcode');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay
} = require('@whiskeysockets/baileys');

// Configuration
const CONFIG = {
    PORT: process.env.PORT || 3000,
    FOUNDER_PHONE: process.env.FOUNDER_PHONE || '918921584368',
    AIRA_API_URL: process.env.AIRA_API_URL || 'https://airaai-8ibs.onrender.com/v1/chat/completions',
    SESSION_DIR: path.join(__dirname, 'aira_session'),
    ACTIVE_TIMEOUT_MS: 60000, // 60 seconds when active
    DEFAULT_MODEL: 'aira-3-ultra',
    OPENROUTER_KEYS: [
        Buffer.from("c2stb3ItdjEtMTMwMmY5MTQ0Yjg2ZThhNTMxNzg5Nzc2ZTMwYzM0OGI5NjZlNjNiYTM0MWZhNzFjNDYzNGUxNGE0ZWRjNWUwZA==", "base64").toString("utf-8"),
        Buffer.from("c2stb3ItdjEtMGRjNDkwZjQzYmJlMGUxZTFlNmJjOTQzM2E5ODhhMjM4MTUwMDYzZWYzYWRkNWNlYTk5NTBlYzcyODU2M2QyNg==", "base64").toString("utf-8"),
        Buffer.from("c2stb3ItdjEtMGMwNzM4MWZmMDExY2Y0YTg5ODgxYzhiMmZmZjRiMmU2MTVkZThhOTljYjExMGY3MzJlNzg5YzI1MTBkYjZhOA==", "base64").toString("utf-8")
    ]
};

if (!fs.existsSync(CONFIG.SESSION_DIR)) {
    fs.mkdirSync(CONFIG.SESSION_DIR, { recursive: true });
}

// Global State
let sock = null;
let isConnected = false;
let currentPairingCode = null;
let currentQrDataUrl = null;
let codeGeneratedAt = 0;
let isGeneratingCode = false;
const startTime = Date.now();

// Desk Modes: 'ACTIVE' (60s timer for Boss) | 'OFFLINE' (0s instant AI)
let deskMode = 'ACTIVE';

// Active Session Tracking
let lastActiveUserId = null;

// Conversation Storage: userId -> { user: { name, email, avatar }, messages: [], pendingTimer: null }
const conversationStore = new Map();

// Stanza Mapping: waStanzaId -> { userId, userName }
const stanzaToUserMap = new Map();

// In-Memory Message Store (Fixes WhatsApp "Waiting for this message" decryption retries)
const messageStore = new Map();

function cacheMessage(id, message) {
    if (!id || !message) return;
    messageStore.set(id, message);
    if (messageStore.size > 1000) {
        const oldestKey = messageStore.keys().next().value;
        messageStore.delete(oldestKey);
    }
}

// Helper: Format Uptime
function getUptime() {
    const sec = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h}h ${m}m ${s}s`;
}

// Text Sanitizer: Eliminates degenerate token loops and crazy hallucinations
function sanitizeAiResponse(text) {
    if (!text) return "";
    let clean = text.trim();
    clean = clean.replace(/(\b[\w'-]+\b)(?:\s+\1){2,}/gi, '$1');
    clean = clean.replace(/(.{8,40}?)(?:\s*\1){2,}/gi, '$1');
    return clean.trim();
}

// Helper: Query Aira 3 Ultra on Sovereign Cloud / OpenRouter with Repetition Penalty
async function queryAiraUltra(visitorName, visitorMessage, history = []) {
    const systemPrompt = 
`You are Aira 3 Ultra, the sovereign executive AI co-pilot engineered by Er. Adam Eehan, Founder & CEO of Aira Group of Technology.
You are responding on Er. Adam Eehan's Direct Desk at airaaigroup.in.

Strict Directives:
- Er. Adam Eehan has received the visitor's message live on his personal WhatsApp (+91 8921 584 368) and will review it.
- In the meantime, assist the visitor with utmost intelligence, clarity, and executive professionalism.
- Tone: Warm, grounded, and highly articulate. Zero corporate fluff, zero robotic disclaimers.
- Multilingual Natural Matching:
  * If the visitor speaks Malayalam or Manglish, reply in authentic Malayalam/Manglish. NEVER use Hindi or broken mixed dialects.
  * If the visitor speaks English, reply in polished, executive English.
  * If Hindi, Arabic, or another language, reply fluently in that language.
- Introduce yourself gracefully as "Aira 3 Ultra (Er. Adam Eehan's Sovereign AI Co-Pilot)".
- Keep responses concise and structured (2-3 short paragraphs max). Never loop or repeat phrases.`;

    const cleanMessages = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-6).map(m => ({
            role: m.sender === 'user' ? 'user' : 'assistant',
            content: m.text
        })),
        { role: 'user', content: visitorMessage }
    ];

    // 1. Try Primary Cloud API (Render)
    try {
        const resp = await axios.post(CONFIG.AIRA_API_URL, {
            model: CONFIG.DEFAULT_MODEL,
            messages: cleanMessages,
            max_tokens: 450,
            temperature: 0.7
        }, { timeout: 25000 });

        const raw = resp.data?.choices?.[0]?.message?.content;
        if (raw) {
            const clean = sanitizeAiResponse(raw);
            if (clean && clean.length > 10) return clean;
        }
    } catch (err) {
        console.warn(`[Aira Primary Endpoint Warning]: ${err.message}`);
    }

    // 2. Direct High-Precision OpenRouter Swarm with Repetition Penalty
    for (const key of CONFIG.OPENROUTER_KEYS) {
        try {
            const resp = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                model: 'deepseek/deepseek-chat',
                messages: cleanMessages,
                max_tokens: 450,
                temperature: 0.7,
                frequency_penalty: 0.5,
                presence_penalty: 0.5
            }, {
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json'
                },
                timeout: 20000
            });

            const raw = resp.data?.choices?.[0]?.message?.content;
            if (raw) {
                const clean = sanitizeAiResponse(raw);
                if (clean && clean.length > 10) return clean;
            }
        } catch (orErr) {
            continue;
        }
    }

    return `Hello ${visitorName}! Er. Adam Eehan has received your message on his personal WhatsApp (+91 8921 584 368) and will reply shortly. Thank you for connecting with Aira Group!`;
}

// ----------------------------------------------------
// 🔄 CLEAN SOCKET RESET & PURGE STALE AUTH
// ----------------------------------------------------
async function resetAndRestartSocket() {
    console.log('🔄 Performing clean socket reset & purge...');
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            sock.end(undefined);
        } catch (e) {}
        sock = null;
    }
    isConnected = false;
    currentPairingCode = null;
    currentQrDataUrl = null;
    codeGeneratedAt = 0;

    // Purge unauthenticated session files if not yet registered
    if (fs.existsSync(CONFIG.SESSION_DIR)) {
        let isReg = false;
        try {
            const credsPath = path.join(CONFIG.SESSION_DIR, 'creds.json');
            if (fs.existsSync(credsPath)) {
                const c = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                if (c.registered) isReg = true;
            }
        } catch (e) {}
        if (!isReg) {
            console.log('🧹 Purging unauthenticated session files in ' + CONFIG.SESSION_DIR);
            fs.rmSync(CONFIG.SESSION_DIR, { recursive: true, force: true });
            fs.mkdirSync(CONFIG.SESSION_DIR, { recursive: true });
        }
    }

    await startWhatsAppBridge();
}

// ----------------------------------------------------
// 🔑 DYNAMIC PAIRING CODE REGENERATOR (Always Active)
// ----------------------------------------------------
async function getOrGeneratePairingCode(forceRefresh = false) {
    if (isConnected) return { connected: true, message: 'WhatsApp is already connected!' };

    const now = Date.now();
    const age = now - codeGeneratedAt;

    // Reuse existing code only if younger than 75s and not forcing refresh
    if (!forceRefresh && currentPairingCode && age < 75000) {
        const remaining = Math.max(0, Math.round((90000 - age) / 1000));
        return {
            connected: false,
            pairingCode: currentPairingCode,
            formattedCode: currentPairingCode.length === 8 ? (currentPairingCode.slice(0, 4) + '-' + currentPairingCode.slice(4)) : currentPairingCode,
            phone: CONFIG.FOUNDER_PHONE,
            qr: currentQrDataUrl,
            remainingSeconds: remaining
        };
    }

    if (isGeneratingCode) {
        return {
            connected: false,
            pairingCode: currentPairingCode || 'GENERATING...',
            formattedCode: currentPairingCode ? (currentPairingCode.slice(0, 4) + '-' + currentPairingCode.slice(4)) : 'GENERATING...',
            phone: CONFIG.FOUNDER_PHONE,
            qr: currentQrDataUrl,
            remainingSeconds: 60
        };
    }

    isGeneratingCode = true;
    try {
        console.log('📲 Resetting socket and generating FRESH pairing code for +' + CONFIG.FOUNDER_PHONE + '...');
        await resetAndRestartSocket();

        // Wait 3.5 seconds for Baileys to connect to WhatsApp registration servers
        await delay(3500);

        if (sock && !sock.authState.creds.registered) {
            const code = await sock.requestPairingCode(CONFIG.FOUNDER_PHONE);
            currentPairingCode = code;
            codeGeneratedAt = Date.now();
            console.log('🔑 NEW ACTIVE PAIRING CODE GENERATED: ' + code + ' (' + code.slice(0, 4) + '-' + code.slice(4) + ')');
            isGeneratingCode = false;
            return {
                connected: false,
                pairingCode: code,
                formattedCode: code.slice(0, 4) + '-' + code.slice(4),
                phone: CONFIG.FOUNDER_PHONE,
                qr: currentQrDataUrl,
                remainingSeconds: 90
            };
        }
    } catch (err) {
        console.error('Pairing code generation error: ' + err.message);
    }

    isGeneratingCode = false;
    return {
        connected: false,
        pairingCode: currentPairingCode || 'WAITING...',
        formattedCode: currentPairingCode ? (currentPairingCode.slice(0, 4) + '-' + currentPairingCode.slice(4)) : 'WAITING...',
        phone: CONFIG.FOUNDER_PHONE,
        qr: currentQrDataUrl,
        remainingSeconds: 30
    };
}

// ----------------------------------------------------
// 🌐 EXPRESS WEB & API SERVER (For Render & Website)
// ----------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// Health Check Endpoint (Render Keepalive)
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        whatsapp: isConnected ? 'connected' : 'connecting',
        mode: deskMode,
        uptime: getUptime(),
        activeSessions: conversationStore.size,
        lastActiveUser: lastActiveUserId ? lastActiveUserId.slice(0, 8) : null
    });
});

// Dynamic Pairing Code API (Always Fresh)
app.get('/api/pair', async (req, res) => {
    const force = req.query.refresh === 'true' || req.query.refresh === '1';
    const result = await getOrGeneratePairingCode(force);
    res.json(result);
});

// Raw QR Image Endpoint (Direct PNG view)
app.get('/api/qr', async (req, res) => {
    if (isConnected) {
        return res.send('WhatsApp is already connected to Er. Adam Eehan (+91 8921 584 368)!');
    }
    if (!currentQrDataUrl) {
        return res.status(404).send('QR code not ready or socket in pairing mode. Visit /api/pair for pairing code.');
    }
    try {
        const base64Data = currentQrDataUrl.replace(/^data:image\/png;base64,/, '');
        const imgBuffer = Buffer.from(base64Data, 'base64');
        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': imgBuffer.length
        });
        res.end(imgBuffer);
    } catch (e) {
        res.status(500).send('Error rendering QR image: ' + e.message);
    }
});

// Founder Desk Status
app.get('/api/desk/status', (req, res) => {
    res.json({
        online: true,
        mode: deskMode,
        whatsappConnected: isConnected,
        coPilot: 'Aira 3 Ultra Active',
        founder: 'Er. Adam Eehan',
        role: 'Founder & CEO, Aira Group',
        timeoutSeconds: deskMode === 'OFFLINE' ? 0 : (CONFIG.ACTIVE_TIMEOUT_MS / 1000)
    });
});

// Send Message from Web Visitor to Founder WhatsApp
app.post('/api/desk/send', async (req, res) => {
    const { userId, userName, userEmail, userAvatar, message } = req.body;

    if (!userId || !message || !message.trim()) {
        return res.status(400).json({ error: 'userId and message are required' });
    }

    const cleanMsg = message.trim();
    const cleanName = userName || 'Verified Visitor';
    const cleanEmail = userEmail || 'Not Provided';
    const shortId = userId.slice(0, 8);

    lastActiveUserId = userId;

    if (!conversationStore.has(userId)) {
        conversationStore.set(userId, {
            user: { name: cleanName, email: cleanEmail, avatar: userAvatar || '' },
            messages: [],
            pendingTimer: null
        });
    }

    const conv = conversationStore.get(userId);
    conv.user.name = cleanName;
    conv.user.email = cleanEmail;

    const userMsgObj = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        sender: 'user',
        senderName: cleanName,
        text: cleanMsg,
        timestamp: Date.now()
    };
    conv.messages.push(userMsgObj);

    console.log(`\n📨 [Desk Incoming] From: ${cleanName} (${cleanEmail}) [${shortId}] | Mode: ${deskMode}`);
    console.log(`💬 Message: "${cleanMsg}"`);

    // 1. Dispatch to Founder WhatsApp if connected
    let waSent = false;
    if (isConnected && sock) {
        const founderJid = `${CONFIG.FOUNDER_PHONE}@s.whatsapp.net`;
        const waText = 
`🌐 *[AIRA DIRECT DESK • NEW VISITOR MESSAGE]*
━━━━━━━━━━━━━━━━━━━━━
👤 *From:* ${cleanName}
📧 *Email:* ${cleanEmail}
🆔 *Session:* #${shortId}
💬 *Message:* "${cleanMsg}"
━━━━━━━━━━━━━━━━━━━━━
👉 *Type a reply directly in WhatsApp* or quote this message to send your answer live to ${cleanName}!
_(Commands: .leave | .offline | .active)_`;

        try {
            const sent = await sock.sendMessage(founderJid, { text: waText });
            if (sent?.key?.id) {
                cacheMessage(sent.key.id, sent.message);
                stanzaToUserMap.set(sent.key.id, { userId, userName: cleanName });
                waSent = true;
                console.log(`✅ [WhatsApp Relay] Message forwarded to Founder (+${CONFIG.FOUNDER_PHONE})`);
            }
        } catch (waErr) {
            console.error(`❌ [WhatsApp Relay Error]:`, waErr.message);
        }
    }

    // 2. Handle Modes (OFFLINE = Instant AI response; ACTIVE = 60s wait for Boss)
    if (conv.pendingTimer) {
        clearTimeout(conv.pendingTimer);
        conv.pendingTimer = null;
    }

    if (deskMode === 'OFFLINE') {
        console.log(`🌙 [OFFLINE MODE]: Generating instant Aira 3 Ultra response for ${cleanName}...`);
        queryAiraUltra(cleanName, cleanMsg, conv.messages).then(async (aiReply) => {
            const aiMsgObj = {
                id: `ai_${Date.now()}`,
                sender: 'aira_ultra',
                senderName: 'Aira 3 Ultra (Co-Pilot)',
                text: aiReply,
                timestamp: Date.now()
            };
            conv.messages.push(aiMsgObj);

            if (isConnected && sock) {
                const founderJid = `${CONFIG.FOUNDER_PHONE}@s.whatsapp.net`;
                const notify = await sock.sendMessage(founderJid, {
                    text: `🤖 *[Desk Offline Auto-Response]*\nReplied to *${cleanName}*:\n"${aiReply}"`
                }).catch(() => {});
                if (notify?.key?.id) cacheMessage(notify.key.id, notify.message);
            }
        });
    } else {
        conv.pendingTimer = setTimeout(async () => {
            console.log(`⏱️ [60s Timer Expired]: Founder hasn't replied. Aira 3 Ultra stepping in for ${cleanName}...`);
            try {
                const aiReply = await queryAiraUltra(cleanName, cleanMsg, conv.messages);
                const aiMsgObj = {
                    id: `ai_${Date.now()}`,
                    sender: 'aira_ultra',
                    senderName: 'Aira 3 Ultra (Co-Pilot)',
                    text: aiReply,
                    timestamp: Date.now()
                };
                conv.messages.push(aiMsgObj);

                if (isConnected && sock) {
                    const founderJid = `${CONFIG.FOUNDER_PHONE}@s.whatsapp.net`;
                    const notifyText = 
`🤖 *[Aira 3 Ultra Handled • 60s Expired]*
━━━━━━━━━━━━━━━━━━━━━
Visitor *${cleanName}* waited 60s without reply. Aira 3 Ultra assisted:
"${aiReply}"
━━━━━━━━━━━━━━━━━━━━━
_You can still send a message at any time to add your personal thoughts!_`;
                    const notify = await sock.sendMessage(founderJid, { text: notifyText }).catch(() => {});
                    if (notify?.key?.id) cacheMessage(notify.key.id, notify.message);
                }
            } catch (e) {
                console.error('[Fallback Exception]:', e.message);
            }
        }, CONFIG.ACTIVE_TIMEOUT_MS);
    }

    return res.json({
        success: true,
        messageId: userMsgObj.id,
        waDelivered: waSent,
        mode: deskMode,
        timestamp: userMsgObj.timestamp
    });
});

// Poll for New Messages (Website Client Polling)
app.get('/api/desk/poll', (req, res) => {
    const { userId, after } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const conv = conversationStore.get(userId);
    if (!conv) return res.json({ messages: [], mode: deskMode });

    const afterTime = parseInt(after) || 0;
    const newMessages = conv.messages.filter(m => m.timestamp > afterTime);
    res.json({
        messages: newMessages,
        mode: deskMode
    });
});

// Get Entire Thread History
app.get('/api/desk/history', (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const conv = conversationStore.get(userId);
    res.json({
        user: conv?.user || null,
        messages: conv?.messages || [],
        mode: deskMode
    });
});

// Render Dynamic Executive Dashboard UI
app.get('/', async (req, res) => {
    const statusColor = isConnected ? '#10b981' : '#f59e0b';
    const statusText = isConnected ? ('WhatsApp Connected (' + deskMode + ' Mode)') : 'Waiting for WhatsApp Pairing';
    const pairInfo = await getOrGeneratePairingCode(false);

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Aira Founder Desk & WhatsApp Relay</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0a2342; color: #fff; margin: 0; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #122b49; border: 1px solid rgba(255,255,255,0.1); border-radius: 20px; max-width: 540px; width: 100%; padding: 28px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); text-align: center; }
    .badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 100px; font-size: 13px; font-weight: 600; background: rgba(255,255,255,0.08); margin-bottom: 16px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: ${statusColor}; }
    h1 { margin: 0 0 6px 0; font-size: 22px; font-weight: 700; }
    p { color: #94a3b8; font-size: 13px; line-height: 1.5; margin: 0 0 20px 0; }
    .pair-box { background: #07172b; border: 2px dashed #3b82f6; border-radius: 14px; padding: 18px; margin-bottom: 20px; cursor: pointer; transition: all 0.2s; }
    .pair-box:hover { border-color: #60a5fa; background: #0b1e38; }
    .pair-code { font-family: monospace; font-size: 36px; font-weight: 800; letter-spacing: 4px; color: #38bdf8; user-select: all; }
    .pair-timer { font-size: 12px; color: #fbbf24; margin-top: 6px; font-weight: 600; }
    .step { display: flex; gap: 10px; margin-bottom: 10px; font-size: 12.5px; color: #cbd5e1; text-align: left; }
    .step-num { width: 22px; height: 22px; border-radius: 50%; background: #2563eb; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 11px; font-weight: bold; }
    .btn-row { display: flex; gap: 10px; justify-content: center; margin-top: 15px; flex-wrap: wrap; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; background: #2563eb; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 10px; font-weight: 600; font-size: 13px; cursor: pointer; border: none; transition: all 0.2s; }
    .btn:hover { background: #1d4ed8; transform: translateY(-1px); }
    .btn-secondary { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); }
    .btn-secondary:hover { background: rgba(255,255,255,0.18); }
    .qr-container { margin: 15px 0 8px 0; background: #fff; padding: 12px; border-radius: 12px; display: inline-block; }
    .qr-container img { width: 170px; height: 170px; display: block; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge"><span class="dot"></span> <span id="status-text">${statusText}</span></div>
    <h1>Er. Adam Eehan • Direct Desk</h1>
    <p>Aira Group WhatsApp Linked Device Bridge & Sovereign AI Co-Pilot Server.</p>

    ${!isConnected ? `
    <div class="pair-box" onclick="copyCode()">
      <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: #94a3b8; margin-bottom: 6px;">WhatsApp 8-Digit Pairing Code (Click to Copy)</div>
      <div class="pair-code" id="pair-code-val" data-code="${pairInfo.pairingCode || ''}">${pairInfo.formattedCode || pairInfo.pairingCode || 'LOADING...'}</div>
      <div class="pair-timer" id="timer-val">Code active • ${pairInfo.remainingSeconds || 90}s remaining</div>
      <div style="font-size: 11px; color: #64748b; margin-top: 6px;">Target Phone: +${CONFIG.FOUNDER_PHONE}</div>
    </div>

    <div style="margin-bottom: 18px;">
      <div class="step"><div class="step-num">1</div><div>Open WhatsApp on Boss's Phone (<b>+${CONFIG.FOUNDER_PHONE}</b>)</div></div>
      <div class="step"><div class="step-num">2</div><div>Tap <b>Menu (⋮)</b> or <b>Settings</b> &rarr; <b>Linked Devices</b> (ലിങ്ക് ചെയ്ത ഉപകരണങ്ങൾ)</div></div>
      <div class="step"><div class="step-num">3</div><div>Tap <b>Link a Device</b> &rarr; Click <b>"Link with phone number instead"</b> at bottom</div></div>
      <div class="step"><div class="step-num">4</div><div>Type this 8-digit code to connect instantly!</div></div>
    </div>

    <div class="btn-row">
      <button class="btn" onclick="copyCode()">📋 Copy Code</button>
      <button class="btn btn-secondary" id="refresh-btn" onclick="generateFreshCode()">⚡ Generate Fresh Code</button>
    </div>

    ${pairInfo.qr ? `
    <div style="margin-top: 20px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 15px;">
      <div style="font-size: 12px; color: #94a3b8; margin-bottom: 8px;">Or Scan QR Code with WhatsApp:</div>
      <div class="qr-container">
        <img id="qr-img" src="${pairInfo.qr}" alt="WhatsApp QR Code" />
      </div>
      <div>
        <a href="/api/qr" target="_blank" style="color: #38bdf8; font-size: 11.5px; text-decoration: underline;">Open QR image full-screen</a>
      </div>
    </div>
    ` : ''}
    ` : `
    <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 12px; padding: 16px; margin-bottom: 20px;">
      <div style="color: #34d399; font-weight: 600; font-size: 15px; margin-bottom: 4px;">✓ WhatsApp Connected to +${CONFIG.FOUNDER_PHONE}</div>
      <div style="color: #94a3b8; font-size: 13px;">Desk Mode: <b>${deskMode}</b>. Live visitor messages from airaaigroup.in arrive on Boss's WhatsApp.</div>
    </div>
    <div style="font-size: 13px; color: #64748b;">
      Uptime: ${getUptime()} • Active Visitor Sessions: ${conversationStore.size}
    </div>
    `}
  </div>

  <script>
    let remaining = ${pairInfo.remainingSeconds || 90};
    const timerEl = document.getElementById("timer-val");

    const timerInterval = setInterval(() => {
      if (remaining > 0) {
        remaining--;
        if (timerEl) timerEl.innerText = "Code active • " + remaining + "s remaining";
      } else {
        if (timerEl) timerEl.innerText = "Code expired • Refreshing...";
        generateFreshCode();
      }
    }, 1000);

    function copyCode() {
      const el = document.getElementById("pair-code-val");
      const raw = el?.getAttribute("data-code") || el?.innerText?.replace(/[^A-Za-z0-9]/g, "");
      if (raw && raw.length >= 8) {
        navigator.clipboard.writeText(raw).then(() => {
          alert("✓ Code copied to clipboard: " + raw);
        }).catch(() => {
          alert("Code: " + raw);
        });
      }
    }

    async function generateFreshCode() {
      const el = document.getElementById("pair-code-val");
      const timer = document.getElementById("timer-val");
      const qrImg = document.getElementById("qr-img");
      const btn = document.getElementById("refresh-btn");
      if (btn) btn.disabled = true;
      if (el) el.innerText = "GENERATING...";
      if (timer) timer.innerText = "Connecting to WhatsApp...";

      try {
        const res = await fetch("/api/pair?refresh=true");
        const data = await res.json();
        if (data.connected) {
          location.reload();
          return;
        }
        if (data.pairingCode) {
          const display = data.formattedCode || (data.pairingCode.length === 8 ? (data.pairingCode.slice(0, 4) + "-" + data.pairingCode.slice(4)) : data.pairingCode);
          if (el) {
            el.innerText = display;
            el.setAttribute("data-code", data.pairingCode);
          }
          remaining = data.remainingSeconds || 90;
          if (timer) timer.innerText = "Fresh code active • " + remaining + "s remaining";
        }
        if (data.qr && qrImg) {
          qrImg.src = data.qr;
        }
      } catch (e) {
        if (el) el.innerText = "RETRY";
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    // Auto-check connection status every 4 seconds
    setInterval(async () => {
      try {
        const res = await fetch("/health");
        const data = await res.json();
        if (data.whatsapp === "connected") {
          location.reload();
        }
      } catch (e) {}
    }, 4000);
  </script>
</body>
</html>
    `);
});


// Start Express Server
app.listen(CONFIG.PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 AIRA FOUNDER DESK & WHATSAPP BRIDGE v2.1`);
    console.log(`📡 Server listening on port: ${CONFIG.PORT}`);
    console.log(`👨‍💻 Founder: Er. Adam Eehan (+${CONFIG.FOUNDER_PHONE})`);
    console.log(`🤖 Desk Mode: ${deskMode} (Active Timeout: ${CONFIG.ACTIVE_TIMEOUT_MS / 1000}s)`);
    console.log(`======================================================\n`);
});

// ----------------------------------------------------
// 📱 BAILEYS WHATSAPP PROTOCOL CLIENT
// ----------------------------------------------------
async function startWhatsAppBridge() {
    console.log('🔄 Initializing Baileys WhatsApp Engine with Cached KeyStore...');
    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        getMessage: async (key) => {
            if (messageStore.has(key.id)) {
                return messageStore.get(key.id);
            }
            return undefined;
        },
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        keepAliveIntervalMs: 15000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        markOnlineOnConnect: true,
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 5
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                currentQrDataUrl = await QRCode.toDataURL(qr);
            } catch (e) {}
        }

        if (connection === 'close') {
            isConnected = false;
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`🔌 Connection closed (Code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(startWhatsAppBridge, 5000);
            } else {
                console.log('🛑 Logged out. Delete session folder to rescan.');
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentPairingCode = null;
            currentQrDataUrl = null;
            console.log('\n' + '*'.repeat(55));
            console.log('✅ AIRA FOUNDER DESK CONNECTED TO WHATSAPP!');
            console.log(`📱 Founder Phone: +${CONFIG.FOUNDER_PHONE}`);
            console.log('*'.repeat(55) + '\n');

            try {
                const initMsg = await sock.sendMessage(`${CONFIG.FOUNDER_PHONE}@s.whatsapp.net`, {
                    text: `🚀 *[AIRA FOUNDER DESK ONLINE]*\nEr. Adam Eehan's Direct Desk is connected to airaaigroup.in!\n• Desk Mode: *${deskMode}*\n• Reply directly or type .leave | .offline | .active`
                });
                if (initMsg?.key?.id) cacheMessage(initMsg.key.id, initMsg.message);
            } catch (e) {}
        }
    });

    // Message Upsert (Handling Boss's replies on WhatsApp)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!messages || messages.length === 0) return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const senderJid = msg.key.remoteJid;
            if (senderJid === 'status@broadcast') continue;

            if (msg.key?.id) cacheMessage(msg.key.id, msg.message);

            const isFromBoss = msg.key.fromMe || senderJid?.includes(CONFIG.FOUNDER_PHONE) || msg.key.participant?.includes(CONFIG.FOUNDER_PHONE);
            if (!isFromBoss) continue;

            const rawText = msg.message?.conversation ||
                            msg.message?.extendedTextMessage?.text ||
                            msg.message?.imageMessage?.caption || '';
            const text = rawText.trim();
            if (!text) continue;

            console.log(`📩 [Boss Message]: "${text}"`);

            // Command: .leave
            if (text === '.leave' || text.startsWith('.leave ')) {
                let targetId = lastActiveUserId;
                if (!targetId && stanzaToUserMap.size > 0) {
                    targetId = Array.from(stanzaToUserMap.values()).pop()?.userId;
                }

                if (targetId && conversationStore.has(targetId)) {
                    const conv = conversationStore.get(targetId);
                    if (conv.pendingTimer) {
                        clearTimeout(conv.pendingTimer);
                        conv.pendingTimer = null;
                    }
                    const leaveMsg = {
                        id: `sys_${Date.now()}`,
                        sender: 'system',
                        senderName: 'Direct Desk',
                        text: 'Er. Adam Eehan has left the chat. Aira 3 Ultra Co-Pilot is now actively assisting you.',
                        timestamp: Date.now()
                    };
                    conv.messages.push(leaveMsg);

                    try {
                        await sock.sendMessage(senderJid, { react: { text: '👋', key: msg.key } });
                        const rep = await sock.sendMessage(senderJid, {
                            text: `👋 *[Direct Desk]* You left the chat with *${conv.user.name}*. Aira 3 Ultra Co-Pilot is now actively assisting.`
                        });
                        if (rep?.key?.id) cacheMessage(rep.key.id, rep.message);
                    } catch (e) {}

                    lastActiveUserId = null;
                } else {
                    const rep = await sock.sendMessage(senderJid, { text: `ℹ️ No active visitor session to leave.` });
                    if (rep?.key?.id) cacheMessage(rep.key.id, rep.message);
                }
                continue;
            }

            // Command: .offline
            if (text === '.offline') {
                deskMode = 'OFFLINE';
                try {
                    await sock.sendMessage(senderJid, { react: { text: '🌙', key: msg.key } });
                    const rep = await sock.sendMessage(senderJid, {
                        text: `🌙 *[Desk Mode: OFFLINE]* Enabled!\nAll visitor messages will now be answered INSTANTLY by Aira 3 Ultra without waiting for your reply.\n(Send .active to switch back).`
                    });
                    if (rep?.key?.id) cacheMessage(rep.key.id, rep.message);
                } catch (e) {}
                continue;
            }

            // Command: .active
            if (text === '.active') {
                deskMode = 'ACTIVE';
                try {
                    await sock.sendMessage(senderJid, { react: { text: '⚡', key: msg.key } });
                    const rep = await sock.sendMessage(senderJid, {
                        text: `⚡ *[Desk Mode: ACTIVE]* Boss is online!\nIncoming visitor messages will wait 60 seconds for your direct reply before Aira 3 Ultra assists.`
                    });
                    if (rep?.key?.id) cacheMessage(rep.key.id, rep.message);
                } catch (e) {}
                continue;
            }

            // Command: .status
            if (text === '.status') {
                const statusMsg = 
`📊 *AIRA FOUNDER DESK STATUS*
━━━━━━━━━━━━━━━━━━━━━
🟢 *WhatsApp Bridge:* Online
⚙️ *Desk Mode:* ${deskMode} (${deskMode === 'OFFLINE' ? 'Instant AI' : '60s Boss wait'})
⏱️ *Uptime:* ${getUptime()}
👥 *Active Sessions:* ${conversationStore.size}
👤 *Last Active User:* ${lastActiveUserId ? lastActiveUserId.slice(0, 8) : 'None'}
━━━━━━━━━━━━━━━━━━━━━`;
                const rep = await sock.sendMessage(senderJid, { text: statusMsg }, { quoted: msg });
                if (rep?.key?.id) cacheMessage(rep.key.id, rep.message);
                continue;
            }

            // Direct Founder Reply to Visitor
            const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
            let targetUserId = null;
            let targetUserName = null;

            if (stanzaId && stanzaToUserMap.has(stanzaId)) {
                const info = stanzaToUserMap.get(stanzaId);
                targetUserId = info.userId;
                targetUserName = info.userName;
            } else if (text.startsWith('.reply ') || text.startsWith('!reply ')) {
                const parts = text.split(' ');
                const shortId = parts[1];
                for (const [uid, c] of conversationStore.entries()) {
                    if (uid.startsWith(shortId)) {
                        targetUserId = uid;
                        targetUserName = c.user?.name;
                        break;
                    }
                }
            } else if (lastActiveUserId && conversationStore.has(lastActiveUserId)) {
                targetUserId = lastActiveUserId;
                targetUserName = conversationStore.get(lastActiveUserId)?.user?.name;
            }

            if (targetUserId && conversationStore.has(targetUserId)) {
                const conv = conversationStore.get(targetUserId);

                if (conv.pendingTimer) {
                    clearTimeout(conv.pendingTimer);
                    conv.pendingTimer = null;
                }

                const cleanReply = text.startsWith('.reply ') ? text.split(' ').slice(2).join(' ') : text;

                const founderMsgObj = {
                    id: `founder_${Date.now()}`,
                    sender: 'founder',
                    senderName: 'Er. Adam Eehan (Founder & CEO)',
                    text: cleanReply,
                    timestamp: Date.now()
                };
                conv.messages.push(founderMsgObj);

                console.log(`\n👑 [Founder Replied via WhatsApp] To: ${targetUserName} [${targetUserId.slice(0, 8)}]`);
                console.log(`💬 Reply: "${cleanReply}"`);

                try {
                    await sock.sendMessage(senderJid, { react: { text: '✅', key: msg.key } });
                } catch (e) {}
            }
        }
    });
}

// Global Exception Shields
process.on('uncaughtException', (err) => console.error('⚠️ Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('⚠️ Unhandled Rejection:', reason));

// Launch WhatsApp Bridge
startWhatsAppBridge();
