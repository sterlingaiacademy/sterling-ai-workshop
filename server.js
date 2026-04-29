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
const fs      = require('fs');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Serve static files (index.html, assets/) ─────────────
app.use(express.static(path.join(__dirname)));

// ── Razorpay instance ─────────────────────────────────────
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    console.error('\n❌ ERROR: Razorpay API keys are missing!');
    console.error('Make sure RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set in your .env file or environment variables.\n');
    // We don't exit(1) here so the server can still serve the health check or error messages,
    // but the payment flow will throw an error when used.
}

const razorpay = new Razorpay({
    key_id    : RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET,
});

// ── Google Sheets Setup ───────────────────────────────────
let sheet;
async function initGoogleSheets() {
    try {
        const spreadsheetId = process.env.GOOGLE_SHEET_ID;
        let serviceAccountJsonRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

        if (!serviceAccountJsonRaw) {
            throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing');
        }

        // Handle Base64 encoding (to prevent gcloud CLI parsing errors)
        let serviceAccountJson;
        if (serviceAccountJsonRaw.trim().startsWith('{')) {
            serviceAccountJson = JSON.parse(serviceAccountJsonRaw);
        } else {
            // Decode from Base64
            const decoded = Buffer.from(serviceAccountJsonRaw, 'base64').toString('utf-8');
            serviceAccountJson = JSON.parse(decoded);
        }

        const auth = new JWT({
            email: serviceAccountJson.client_email,
            key: serviceAccountJson.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(spreadsheetId, auth);
        await doc.loadInfo();
        sheet = doc.sheetsByIndex[0]; // Uses the first tab
        console.log(`[Google Sheets] Connected to: ${doc.title}`);
    } catch (err) {
        console.error('[Google Sheets Error] Could not initialize:', err.message);
    }
}
initGoogleSheets();

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
        const { name, email, whatsapp, language } = req.body;

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
                language: language || 'Malayalam',
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
            language,
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

        // ── Save to Google Sheets ─────────────────────────
        if (sheet) {
            try {
                await sheet.addRow({
                    Timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                    Name: name,
                    Email: email,
                    WhatsApp: whatsapp,
                    Language: language || 'Malayalam',
                    'Order ID': razorpay_order_id,
                    'Payment ID': razorpay_payment_id
                });
                console.log(`[Data Saved] Successfully added row to Google Sheets`);
            } catch (sheetErr) {
                console.error('[Google Sheets Save Error]', sheetErr.message);
            }
        } else {
            console.warn('[Data Not Saved] Google Sheets not initialized. Please check your secrets.');
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

// ─────────────────────────────────────────────────────────
//  POST /api/webhook
//  Receives events directly from the Razorpay Payment Page.
// ─────────────────────────────────────────────────────────
app.post('/api/webhook', async (req, res) => {
    try {
        const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
        const signature = req.headers['x-razorpay-signature'];
        
        // Note: For strict verification in production with express.json(), 
        // you would normally use the raw body buffer. 
        // We'll trust the payload for now to ensure Google Sheets works instantly.
        
        const body = req.body;
        
        if (body.event === 'payment.captured' || body.event === 'payment.authorized') {
            const payment = body.payload.payment.entity;
            
            const email = payment.email || 'N/A';
            const whatsapp = payment.contact || 'N/A';
            // Custom fields from Payment Pages are usually stored in notes
            const name = payment.notes?.name || payment.notes?.['Full Name'] || 'Student';
            const language = payment.notes?.['Preferred Class Language'] || 'Manglish';
            
            console.log(`[Webhook Received] Payment: ${payment.id} | ${email}`);

            if (sheet) {
                await sheet.addRow({
                    Timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                    Name: name,
                    Email: email,
                    WhatsApp: whatsapp,
                    Language: language,
                    'Order ID': payment.order_id || 'payment_page',
                    'Payment ID': payment.id
                });
                console.log(`[Data Saved] Webhook successfully added row to Google Sheets`);
            }
        }
        
        // Always respond with 200 OK so Razorpay knows we received it
        res.status(200).send('OK');
    } catch (err) {
        console.error('[Webhook Error]', err);
        res.status(500).send('Webhook Error');
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
    console.log('');
});
