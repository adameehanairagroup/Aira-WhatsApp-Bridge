/**
 * 🚀 Sovereign AIRA Founder Desk & WhatsApp Bridge v2.0
 * Engineered by Er. Adam Eehan (Founder & CEO, Aira Group of Technology)
 * Connects airaaigroup.in live visitors directly to Founder's personal WhatsApp (+91 8921 584 368)
 * With Sovereign Aira 3 Ultra Multilingual AI Co-Pilot Fallback
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
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
let pairingRequested = false;
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
    // Remove consecutive word repetitions (e.g. "finish finish finish finish")
    clean = clean.replace(/(\b[\w'-]+\b)(?:\s+\1){2,}/gi, '$1');
    // Remove consecutive phrase repetitions
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

// Pairing Code Endpoint
app.get('/api/pair', async (req, res) => {
    if (isConnected) {
        return res.json({ connected: true, message: 'WhatsApp is already connected!' });
    }
    if (currentPairingCode) {
        return res.json({ connected: false, pairingCode: currentPairingCode, phone: CONFIG.FOUNDER_PHONE });
    }
    if (sock && !sock.authState.creds.registered) {
        try {
            const code = await sock.requestPairingCode(CONFIG.FOUNDER_PHONE);
            currentPairingCode = code;
            return res.json({ connected: false, pairingCode: code, phone: CONFIG.FOUNDER_PHONE });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
    res.json({ connected: false, message: 'Pairing engine initializing. Refresh in 3 seconds.' });
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

    // Track active user
    lastActiveUserId = userId;

    // Initialize conversation in store if not present
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

    // Append visitor message to history
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
        // Instant response in visitor's language
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

            // Notify Boss on WhatsApp
            if (isConnected && sock) {
                const founderJid = `${CONFIG.FOUNDER_PHONE}@s.whatsapp.net`;
                const notify = await sock.sendMessage(founderJid, {
                    text: `🤖 *[Desk Offline Auto-Response]*\nReplied to *${cleanName}*:\n"${aiReply}"`
                }).catch(() => {});
                if (notify?.key?.id) cacheMessage(notify.key.id, notify.message);
            }
        });
    } else {
        // ACTIVE MODE: Exactly 60 seconds timer as Boss requested
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

                // Notify Founder on WhatsApp that Aira 3 Ultra responded
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

// Render Status Dashboard UI
app.get('/', (req, res) => {
    const statusColor = isConnected ? '#10b981' : '#f59e0b';
    const statusText = isConnected ? `WhatsApp Connected (${deskMode} Mode)` : 'Waiting for WhatsApp Pairing';

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Aira Founder Desk & WhatsApp Relay</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0a2342; color: #fff; margin: 0; padding: 24px; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #122b49; border: 1px solid rgba(255,255,255,0.1); border-radius: 20px; max-width: 520px; width: 100%; padding: 32px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
    .badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 100px; font-size: 13px; font-weight: 600; background: rgba(255,255,255,0.08); margin-bottom: 20px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: ${statusColor}; }
    h1 { margin: 0 0 8px 0; font-size: 24px; font-weight: 700; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0; }
    .pair-box { background: #07172b; border: 2px dashed #3b82f6; border-radius: 14px; padding: 20px; text-align: center; margin-bottom: 20px; }
    .pair-code { font-family: monospace; font-size: 32px; font-weight: 800; letter-spacing: 4px; color: #38bdf8; user-select: all; }
    .step { display: flex; gap: 12px; margin-bottom: 12px; font-size: 13px; color: #cbd5e1; text-align: left; }
    .step-num { width: 22px; height: 22px; border-radius: 50%; background: #2563eb; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 12px; font-weight: bold; }
    .btn { display: inline-block; background: #2563eb; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 10px; font-weight: 600; font-size: 14px; cursor: pointer; border: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge"><span class="dot"></span> ${statusText}</div>
    <h1>Er. Adam Eehan • Direct Desk</h1>
    <p>Aira Group WhatsApp Linked Device Bridge & Sovereign AI Co-Pilot Server.</p>

    ${!isConnected ? `
    <div class="pair-box">
      <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; color: #94a3b8; margin-bottom: 8px;">WhatsApp 8-Digit Pairing Code</div>
      <div class="pair-code" id="code-val">${currentPairingCode || 'GENERATING...'}</div>
      <div style="font-size: 12px; color: #64748b; margin-top: 8px;">Target Phone: +${CONFIG.FOUNDER_PHONE}</div>
    </div>

    <div style="margin-bottom: 24px;">
      <div class="step"><div class="step-num">1</div><div>Open WhatsApp on Boss's Phone (+91 8921 584 368)</div></div>
      <div class="step"><div class="step-num">2</div><div>Tap <b>Menu (⋮)</b> or <b>Settings</b> &rarr; <b>Linked Devices</b></div></div>
      <div class="step"><div class="step-num">3</div><div>Tap <b>Link a Device</b> &rarr; <b>Link with phone number instead</b></div></div>
      <div class="step"><div class="step-num">4</div><div>Enter the 8-digit code shown above to connect!</div></div>
    </div>
    <button class="btn" onclick="location.reload()">Refresh Status</button>
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
</body>
</html>
    `);
});

// Start Express Server
app.listen(CONFIG.PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 AIRA FOUNDER DESK & WHATSAPP BRIDGE v2.0`);
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
        generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    // Auto-request pairing code if session is not yet registered
    if (!sock.authState.creds.registered && !pairingRequested) {
        pairingRequested = true;
        setTimeout(async () => {
            try {
                console.log(`📲 Requesting 8-digit pairing code for +${CONFIG.FOUNDER_PHONE}...`);
                const code = await sock.requestPairingCode(CONFIG.FOUNDER_PHONE);
                currentPairingCode = code;
                console.log('\n' + '='.repeat(50));
                console.log(`🔑 WHATSAPP 8-DIGIT PAIRING CODE: ${code}`);
                console.log(`👉 Open WhatsApp -> Linked Devices -> Link with phone number`);
                console.log('='.repeat(50) + '\n');
            } catch (err) {
                console.error(`❌ Pairing code request error: ${err.message}`);
                pairingRequested = false;
            }
        }, 5000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

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

            // Cache message for decrypt retries
            if (msg.key?.id) cacheMessage(msg.key.id, msg.message);

            const isFromBoss = msg.key.fromMe || senderJid?.includes(CONFIG.FOUNDER_PHONE) || msg.key.participant?.includes(CONFIG.FOUNDER_PHONE);
            if (!isFromBoss) continue;

            // Extract message text
            const rawText = msg.message?.conversation ||
                            msg.message?.extendedTextMessage?.text ||
                            msg.message?.imageMessage?.caption || '';
            const text = rawText.trim();
            if (!text) continue;

            console.log(`📩 [Boss Message]: "${text}"`);

            // ----------------------------------------------------
            // 🛠️ BOSS ADMIN COMMANDS
            // ----------------------------------------------------

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

            // ----------------------------------------------------
            // 💬 DIRECT FOUNDER REPLY TO VISITOR
            // ----------------------------------------------------
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
                // Natural typing fallback: If Boss just sends a message in chat, route to the active visitor!
                targetUserId = lastActiveUserId;
                targetUserName = conversationStore.get(lastActiveUserId)?.user?.name;
            }

            if (targetUserId && conversationStore.has(targetUserId)) {
                const conv = conversationStore.get(targetUserId);

                // Cancel pending 60s AI fallback timer because Boss replied!
                if (conv.pendingTimer) {
                    clearTimeout(conv.pendingTimer);
                    conv.pendingTimer = null;
                }

                const cleanReply = text.startsWith('.reply ') ? text.split(' ').slice(2).join(' ') : text;

                // Push Founder reply into conversation
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

                // React with checkmark on WhatsApp to confirm delivery to website
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
