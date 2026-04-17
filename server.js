// ============================================================
//  Sterling AI Academy — Razorpay Payment Server
//  server.js
// ============================================================

require('dotenv').config();
const express = require('express');
const Razorpay = require('razorpay');
const crypto  = require('crypto');
const cors    = require('cors');
const path    = require('path');

const app = express();

// ── CORS — allow requests from Lovable & your custom domain ──
const corsOptions = {
    origin: function (origin, callback) {
        // Allow: no origin (curl/Postman), Lovable domains, Railway itself, localhost
        const allowed = [
            /\.lovable\.app$/,           // Lovable preview URLs
            /\.lovableproject\.com$/,    // Lovable project URLs
            /localhost/,                 // Local dev
            /127\.0\.0\.1/,             // Local dev
            /\.railway\.app$/,           // Railway itself
            /\.up\.railway\.app$/,       // Railway public URLs
        ];
        if (!origin || allowed.some(r => r.test(origin))) {
            callback(null, true);
        } else {
            // Also allow any custom domain — edit this if you want to restrict
            callback(null, true);
        }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Pre-flight
app.use(express.urlencoded({ extended: true }));

// ── Serve static files (index.html, assets/) ─────────────
app.use(express.static(path.join(__dirname)));

// ── Razorpay instance ─────────────────────────────────────
const razorpay = new Razorpay({
    key_id    : process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Expose Razorpay Key ID to frontend (safe — not the secret) ──
app.get('/api/key', (req, res) => {
    res.json({ key_id: process.env.RAZORPAY_KEY_ID });
});

// ─────────────────────────────────────────────────────────
//  POST /api/create-order
//  Called by frontend before opening the Razorpay popup.
//  Creates a server-side order and returns the order_id.
// ─────────────────────────────────────────────────────────
app.post('/api/create-order', async (req, res) => {
    try {
        const { name, email, whatsapp } = req.body;

        if (!name || !email || !whatsapp) {
            return res.status(400).json({ error: 'Name, email and WhatsApp are required.' });
        }

        const options = {
            amount  : 49900,           // Amount in PAISE (₹499 × 100 = 49900)
            currency: 'INR',
            receipt : `receipt_${Date.now()}`,
            notes   : {                // Store registrant details in the order
                name,
                email,
                whatsapp,
                source: 'Sterling AI Academy Landing Page',
            },
        };

        const order = await razorpay.orders.create(options);
        console.log(`[Order Created] ID: ${order.id} | ₹${order.amount / 100} | ${email}`);

        res.json({
            order_id : order.id,
            amount   : order.amount,
            currency : order.currency,
            key_id   : process.env.RAZORPAY_KEY_ID,
        });

    } catch (err) {
        console.error('[Create Order Error]', err);
        res.status(500).json({ error: 'Could not create Razorpay order. Check your API keys in .env' });
    }
});

// ─────────────────────────────────────────────────────────
//  POST /api/verify-payment
//  Called by frontend after successful Razorpay checkout.
//  Verifies the HMAC signature to prevent fraud.
// ─────────────────────────────────────────────────────────
app.post('/api/verify-payment', async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            name,
            email,
            whatsapp,
        } = req.body;

        // ── Signature Verification ────────────────────────
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            console.warn(`[Signature Mismatch] Order: ${razorpay_order_id}`);
            return res.status(400).json({ verified: false, error: 'Payment signature mismatch. Possible fraud attempt.' });
        }

        console.log(`[Payment Verified ✅] Order: ${razorpay_order_id} | Payment: ${razorpay_payment_id} | ${email}`);

        // ── Optional: Forward to n8n Webhook ─────────────
        const n8nUrl = process.env.N8N_WEBHOOK_URL;
        if (n8nUrl && n8nUrl.startsWith('http')) {
            try {
                await fetch(n8nUrl, {
                    method : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body   : JSON.stringify({
                        name,
                        email,
                        whatsapp,
                        payment_id : razorpay_payment_id,
                        order_id   : razorpay_order_id,
                        amount     : '₹499',
                        source     : 'Sterling AI Academy — Razorpay Payment',
                        timestamp  : new Date().toISOString(),
                    }),
                });
                console.log('[n8n Webhook] Registration forwarded successfully.');
            } catch (n8nErr) {
                // Non-fatal: payment is verified even if n8n fails
                console.warn('[n8n Webhook] Failed to forward:', n8nErr.message);
            }
        }

        res.json({
            verified   : true,
            payment_id : razorpay_payment_id,
            order_id   : razorpay_order_id,
        });

    } catch (err) {
        console.error('[Verify Payment Error]', err);
        res.status(500).json({ verified: false, error: 'Server error during payment verification.' });
    }
});

// ── Catch-all — serve index.html for any unknown route ───
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start server ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║  Sterling AI Academy — Server Running        ║');
    console.log(`║  http://localhost:${PORT}                       ║`);
    console.log('╚══════════════════════════════════════════════╝\n');
    console.log(`  Razorpay Key: ${process.env.RAZORPAY_KEY_ID || '⚠️  NOT SET — edit .env!'}`);
    console.log(`  n8n Webhook : ${process.env.N8N_WEBHOOK_URL || 'Not configured (optional)'}`);
    console.log('');
});
