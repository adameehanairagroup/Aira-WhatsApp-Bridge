# 🚀 Sovereign AIRA Founder Desk & WhatsApp Bridge
**Engineered by Er. Adam Eehan • Founder & CEO, Aira Group of Technology**

This service acts as the live real-time bridge connecting visitors on `https://airaaigroup.in` directly to Er. Adam Eehan's personal WhatsApp (`+91 8921 584 368`).

### Architecture & Features:
- **WhatsApp Web Multi-Device Protocol:** Powered by Baileys (`@whiskeysockets/baileys`).
- **Zero-Friction Phone Pairing:** Connects seamlessly with WhatsApp via 8-digit phone pairing code (no QR camera scan required).
- **Bi-Directional Chat:**
  - Visitor messages on `airaaigroup.in` are forwarded instantly to Er. Adam Eehan's WhatsApp.
  - Er. Adam Eehan swipe-replies on WhatsApp, and the response is relayed back to the visitor in real-time.
- **Sovereign Aira 3 Ultra Co-Pilot Fallback:**
  - If Er. Adam Eehan is occupied or offline for more than 45 seconds, Aira 3 Ultra automatically steps in.
  - Multilingual native response (Malayalam, Manglish, English, Hindi, Arabic, etc.).
- **Google Identity Verified:** Visitors authenticate via Google OAuth before messaging, eliminating bot spam.

### Deployment on Render:
1. Connect this repo `adameehanairagroup/Aira-WhatsApp-Bridge` to Render as a Web Service.
2. Build Command: `npm install`
3. Start Command: `node index.js`
4. Environment Variables:
   - `FOUNDER_PHONE`: `918921584368`
   - `AIRA_API_URL`: `https://airaai-8ibs.onrender.com/v1/chat/completions`
