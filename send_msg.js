const { default: makeWASocket, useMultiFileAuthState, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');

(async () => {
    console.log('🔄 Starting robust sender...');
    try {
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys_v3');
        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ["Ubuntu", "Chrome", "20.0.04"]
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (u) => {
            const { connection, lastDisconnect } = u;
            if (connection === 'open') {
                console.log('✅ Connected to WhatsApp!');
                const id = '918590294115@s.whatsapp.net';
                const text = "Hey AK STUDIO! Adam-inte AI aanu 🤖✨. Thank you for the message! 🚀 Enthokkeyundu vishesham? 🫵😁🔥";
                
                console.log('📤 Sending message to:', id);
                try {
                    const sentMsg = await sock.sendMessage(id, { text });
                    console.log('📨 Message object created. Waiting for network sync...');
                    
                    // Wait for 15 seconds to ensure the message is actually sent and synced
                    await delay(15000);
                    
                    console.log('🚀 Message process completed. Check your phone now!');
                    process.exit(0);
                } catch (err) {
                    console.error('❌ Error during sending:', err.message);
                    process.exit(1);
                }
            } else if (connection === 'close') {
                console.log('⚠️ Connection closed. Reason:', lastDisconnect?.error?.message);
            }
        });
    } catch (err) {
        console.error('Fatal error:', err.message);
        process.exit(1);
    }
})();
