/**
 * 🚀 Sovereign AIRA Founder Desk & WhatsApp Bridge
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
    delay
} = require('@whiskeysockets/baileys');

// Configuration
const CONFIG = {
    PORT: process.env.PORT || 3000,
    FOUNDER_PHONE: process.env.FOUNDER_PHONE || '918921584368',
    AIRA_API_URL: process.env.AIRA_API_URL || 'https://airaai-8ibs.onrender.com/v1/chat/completions',
    SESSION_DIR: path.join(__dirname, 'aira_session'),
    AUTO_FALLBACK_DELAY_MS: 45000, // 45 seconds before Aira 3 Ultra assists
    DEFAULT_MODEL: 'aira-3-ultra'
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

// Conversation Storage: userId -> { user: { name, email, avatar }, messages: [], pendingTimer: null }
const conversationStore = new Map();

// Stanza Mapping: waStanzaId -> { userId, userName }
const stanzaToUserMap = new Map();

// Helper: Format Uptime
function getUptime() {
    const sec = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h}h ${m}m ${s}s`;
}

// Helper: Query Aira 3 Ultra on Sovereign Cloud
async function queryAiraUltra(visitorName, visitorMessage, history = []) {
    const systemPrompt = 
`You are Aira 3 Ultra, the sovereign executive AI co-pilot engineered by Er. Adam Eehan, Founder & CEO of Aira Group of Technology.
You are responding on Er. Adam Eehan's Direct Desk at airaaigroup.in.
Er. Adam has received the visitor's message live on his personal WhatsApp and will review it shortly.
In the meantime, assist the visitor with utmost intelligence, clarity, and executive professionalism.

Tone & Language Directives:
- Match the visitor's language and script naturally.
  * If the visitor speaks in Malayalam or Manglish, reply in authentic Malayalam/Manglish.
  * If the visitor speaks English, reply in clean, elegant English.
  * If Hindi, Arabic, or another language, reply fluently in that exact language.
- Introduce yourself gracefully as "Aira 3 Ultra (Er. Adam Eehan's Executive AI Co-Pilot)".
- Keep responses helpful, grounded, and concise (2-4 paragraphs max).
- Zero corporate fluff, robotic disclaimers, or excessive emojis.
- Company details: Aira Group of Technology specializes in Sovereign AI platforms, bare-metal OS kernels, Flutter mobile applications, and enterprise cloud systems.`;

    const messages = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-6).map(m => ({
            role: m.sender === 'user' ? 'user' : 'assistant',
            content: m.text
        })),
        { role: 'user', content: visitorMessage }
    ];

    try {
        const resp = await axios.post(CONFIG.AIRA_API_URL, {
            model: CONFIG.DEFAULT_MODEL,
            messages,
            max_tokens: 650,
            temperature: 0.7
        }, { timeout: 30000 });

        const content = resp.data?.choices?.[0]?.message?.content;
        if (content) return content.trim();
    } catch (err) {
        console.warn(`[Aira Cloud Fallback Triggered]: ${err.message}`);
    }

    // Direct fast secondary fallback
    try {
        const direct = await axios.post('https://text.pollinations.ai/', {
            messages,
            model: 'openai'
        }, { timeout: 15000 });
        if (direct.data && typeof direct.data === 'string') {
            return direct.data.trim();
        }
    } catch (e) {}

    return `Hello ${visitorName}! Er. Adam Eehan has received your message on his personal WhatsApp and will reply shortly. Thank you for connecting with Aira Group!`;
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
        uptime: getUptime(),
        activeSessions: conversationStore.size
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
        whatsappConnected: isConnected,
        coPilot: 'Aira 3 Ultra Active',
        founder: 'Er. Adam Eehan',
        role: 'Founder & CEO, Aira Group'
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

    console.log(`\n📨 [Desk Incoming] From: ${cleanName} (${cleanEmail}) [${shortId}]`);
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
👉 *Swipe & Reply directly to this WhatsApp message* to send your answer live to ${cleanName} on airaaigroup.in!
_(Or send: .reply ${shortId} <your message>)_`;

        try {
            const sent = await sock.sendMessage(founderJid, { text: waText });
            if (sent?.key?.id) {
                stanzaToUserMap.set(sent.key.id, { userId, userName: cleanName });
                waSent = true;
                console.log(`✅ [WhatsApp Relay] Message forwarded to Founder (+${CONFIG.FOUNDER_PHONE})`);
            }
        } catch (waErr) {
            console.error(`❌ [WhatsApp Relay Error]:`, waErr.message);
        }
    }

    // 2. Setup Aira 3 Ultra Smart Fallback Timer (45 seconds)
    if (conv.pendingTimer) clearTimeout(conv.pendingTimer);

    conv.pendingTimer = setTimeout(async () => {
        console.log(`⏱️ [45s Fallback Triggered] Founder hasn't replied yet. Querying Aira 3 Ultra for ${cleanName}...`);
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

            // Notify Founder on WhatsApp that Aira 3 Ultra stepped in
            if (isConnected && sock) {
                const founderJid = `${CONFIG.FOUNDER_PHONE}@s.whatsapp.net`;
                const notifyText = 
`🤖 *[Aira 3 Ultra Auto-Response]*
━━━━━━━━━━━━━━━━━━━━━
Visitor *${cleanName}* waited 45s without reply. Aira 3 Ultra responded:
"${aiReply}"
━━━━━━━━━━━━━━━━━━━━━
_You can still swipe and reply at any time to add your personal message!_`;
                await sock.sendMessage(founderJid, { text: notifyText }).catch(() => {});
            }
        } catch (e) {
            console.error('[Fallback Exception]:', e.message);
        }
    }, CONFIG.AUTO_FALLBACK_DELAY_MS);

    return res.json({
        success: true,
        messageId: userMsgObj.id,
        waDelivered: waSent,
        timestamp: userMsgObj.timestamp
    });
});

// Poll for New Messages (Website Client Polling)
app.get('/api/desk/poll', (req, res) => {
    const { userId, after } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const conv = conversationStore.get(userId);
    if (!conv) return res.json({ messages: [] });

    const afterTime = parseInt(after) || 0;
    const newMessages = conv.messages.filter(m => m.timestamp > afterTime);
    res.json({ messages: newMessages });
});

// Get Entire Thread History
app.get('/api/desk/history', (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const conv = conversationStore.get(userId);
    res.json({
        user: conv?.user || null,
        messages: conv?.messages || []
    });
});

// Render Status Dashboard UI
app.get('/', (req, res) => {
    const statusColor = isConnected ? '#10b981' : '#f59e0b';
    const statusText = isConnected ? 'WhatsApp Connected & Active 24/7' : 'Waiting for WhatsApp Pairing';

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
      <div style="color: #94a3b8; font-size: 13px;">Live visitor messages from airaaigroup.in will arrive on Boss's WhatsApp instantly. Swipe-reply on WhatsApp to chat back!</div>
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
    console.log(`🚀 AIRA FOUNDER DESK & WHATSAPP BRIDGE`);
    console.log(`📡 Server listening on port: ${CONFIG.PORT}`);
    console.log(`👨‍💻 Founder: Er. Adam Eehan (+${CONFIG.FOUNDER_PHONE})`);
    console.log(`🤖 Sovereign AI Model: ${CONFIG.DEFAULT_MODEL}`);
    console.log(`======================================================\n`);
});

// ----------------------------------------------------
// 📱 BAILEYS WHATSAPP PROTOCOL CLIENT
// ----------------------------------------------------
async function startWhatsAppBridge() {
    console.log('🔄 Initializing Baileys WhatsApp Engine...');
    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.SESSION_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307], isLatest: true }));

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
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

            // Send boot confirmation to Boss
            try {
                await sock.sendMessage(`${CONFIG.FOUNDER_PHONE}@s.whatsapp.net`, {
                    text: `🚀 *[AIRA FOUNDER DESK ONLINE]*\nEr. Adam Eehan's Direct Desk is now connected to airaaigroup.in!\nVisitors chatting on the website will be relayed here live. Simply swipe to reply!`
                });
            } catch (e) {}
        }
    });

    // Message Upsert (Handling Boss's replies on WhatsApp)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!messages || messages.length === 0) return;
        const msg = messages[0];
        if (!msg.message) return;

        const senderJid = msg.key.remoteJid;
        const isFromBoss = msg.key.fromMe || senderJid?.includes(CONFIG.FOUNDER_PHONE);

        // Extract message text
        const rawText = msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        msg.message?.imageMessage?.caption || '';
        const text = rawText.trim();
        if (!text) return;

        // 1. Process Boss's WhatsApp Reply to Web Visitor
        if (isFromBoss) {
            // Check if Boss swipe-quoted a message
            const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
            let targetUserId = null;
            let targetUserName = null;

            if (stanzaId && stanzaToUserMap.has(stanzaId)) {
                const info = stanzaToUserMap.get(stanzaId);
                targetUserId = info.userId;
                targetUserName = info.userName;
            } else if (text.startsWith('.reply ') || text.startsWith('!reply ')) {
                // Manual command: .reply <shortId> <message>
                const parts = text.split(' ');
                const shortId = parts[1];
                const replyBody = parts.slice(2).join(' ');

                // Find matching user by shortId
                for (const [uid, c] of conversationStore.entries()) {
                    if (uid.startsWith(shortId)) {
                        targetUserId = uid;
                        targetUserName = c.user?.name;
                        break;
                    }
                }
            }

            if (targetUserId && conversationStore.has(targetUserId)) {
                const conv = conversationStore.get(targetUserId);

                // Cancel pending AI fallback timer because Boss replied!
                if (conv.pendingTimer) {
                    clearTimeout(conv.pendingTimer);
                    conv.pendingTimer = null;
                }

                // Clean reply text (strip .reply command if used)
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
                return;
            }
        }

        // 2. Boss Admin Commands on WhatsApp
        if (isFromBoss && text.startsWith('.')) {
            if (text === '.status') {
                const statusMsg = 
`📊 *AIRA FOUNDER DESK STATUS*
━━━━━━━━━━━━━━━━━━━━━
🟢 *WhatsApp Bridge:* Online
🌐 *Endpoint:* ${CONFIG.AIRA_API_URL}
⏱️ *Uptime:* ${getUptime()}
👥 *Active Web Sessions:* ${conversationStore.size}
📱 *Target Phone:* +${CONFIG.FOUNDER_PHONE}
━━━━━━━━━━━━━━━━━━━━━`;
                await sock.sendMessage(senderJid, { text: statusMsg }, { quoted: msg });
                return;
            }
        }
    });
}

// Global Exception Shields
process.on('uncaughtException', (err) => console.error('⚠️ Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('⚠️ Unhandled Rejection:', reason));

// Launch WhatsApp Bridge
startWhatsAppBridge();
