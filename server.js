/**
 * TaxiHon Bridge - V12 Titanium Edition 💎
 * Status: HIGH LOAD OPTIMIZED & SQLITE WAL ENABLED
 */

import { 
    default as makeWASocket, useMultiFileAuthState, DisconnectReason, 
    fetchLatestBaileysVersion, downloadMediaMessage, delay, makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import express from 'express';
import axios from 'axios';
import qrcodeTerminal from 'qrcode-terminal';
import fs from 'fs';
import cors from 'cors';
import Database from 'better-sqlite3'; // 👈 محرك الداتابيز الجديد

const PORT = 3000;
const DJANGO_WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://api.taxihon.com/webhook/';
// const PORT = 4000;

// const DJANGO_WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://127.0.0.1:8000/webhook/';
const SESSION_DIR = 'auth_info_baileys'; 
const ADMIN_BOT_NUMBERS = ['963931698698', '963931697697'];

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ==============================================================
// 🗄️ 1. إعداد قاعدة البيانات (SQLite WAL Mode)
// ==============================================================
// إنشاء مجلد للداتا إذا لم يكن موجوداً (لضمان الصلاحيات)
const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const db = new Database(`${DATA_DIR}/taxihon_archive.db`);
db.pragma('journal_mode = WAL'); // السحر: قراءة وكتابة متزامنة بدون قفل

// إنشاء الجداول
db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        jid TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        is_invoice BOOLEAN NOT NULL,
        payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_time ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_jid ON messages(jid);
`);

const insertMsg = db.prepare('INSERT OR IGNORE INTO messages (id, jid, timestamp, is_invoice, payload_json) VALUES (?, ?, ?, ?, ?)');
const getMsgsByDate = db.prepare('SELECT payload_json FROM messages WHERE jid = ? AND timestamp >= ? AND timestamp <= ? AND is_invoice = 1 ORDER BY timestamp ASC');
const deleteOldChats = db.prepare('DELETE FROM messages WHERE is_invoice = 0 AND timestamp < ?');
const deleteOldInvoices = db.prepare('DELETE FROM messages WHERE is_invoice = 1 AND timestamp < ?');

// دالة التنظيف الآلي (Garbage Collector)
// دالة التنظيف الآلي (Garbage Collector) - تم الإصلاح
function runDbCleanup() {
    const now = Math.floor(Date.now() / 1000);
    const thirtyFiveDaysAgo = now - (35 * 24 * 60 * 60);

    // 🔥 تم توحيد مدة الحفظ لـ 35 يوماً لجميع الرسائل لحماية المزامنة والتعديلات
    const chatsDeleted = deleteOldChats.run(thirtyFiveDaysAgo).changes;
    const invoicesDeleted = deleteOldInvoices.run(thirtyFiveDaysAgo).changes;
    
    if (chatsDeleted > 0 || invoicesDeleted > 0) {
        console.log(`🧹 [DB Cleanup] Deleted ${chatsDeleted} old chats, ${invoicesDeleted} old invoices.`);
    }
}
setInterval(runDbCleanup, 60 * 60 * 1000); // تنظيف كل ساعة

// ==============================================================
// 🧠 2. إدارة الطوابير المتوازية (Concurrent Queues)
// ==============================================================
let sock;
let isWaConnected = false;
let messageQueue = []; 
let reactionQueue = []; 
let isProcessingMessages = false;
let isProcessingReactions = false;
let currentQR = null;
let reconnectAttempts = 0;

const getJid = (number) => { /* ... نفس الدالة السابقة ... */ 
    if (!number) return null;
    let clean = String(number).replace(/\D/g, '');
    if (String(number).includes('@')) return number;
    if (clean.length < 5) return null;
    if (clean.startsWith('09')) clean = '963' + clean.substring(1);
    return `${clean}@s.whatsapp.net`;
};
const cleanId = (jid) => jid ? jid.split('@')[0].split(':')[0] : null;
const extractPhoneNumber = (jid) => { /* ... نفس الدالة السابقة ... */ 
    if (!jid) return null;
    const cleanJid = jid.split('@')[0].split(':')[0];
    if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) return cleanJid;
    return cleanJid;
};

// المعالج المتوازي لجانغو
// المعالج المتوازي لجانغو - تم الإصلاح لمنع الـ DDoS
const processMessageQueue = async () => {
    if (isProcessingMessages || messageQueue.length === 0) return;
    isProcessingMessages = true;
    while (messageQueue.length > 0) {
        const item = messageQueue.shift(); // نأخذ رسالة واحدة فقط
        await sendToDjango(item.payload, item.key, true);
        await delay(50); // استراحة 50ms بين كل رسالة (أمان تام لجانغو)
    }
    isProcessingMessages = false;
};

const processReactionQueue = async () => {
    if (isProcessingReactions || reactionQueue.length === 0) return;
    isProcessingReactions = true;
    while (reactionQueue.length > 0) {
        if (!sock || !isWaConnected) break; 
        const item = reactionQueue.shift();
        try {
            await sock.sendMessage(item.chatId, { react: { text: item.reaction, key: item.key } });
            await delay(400); 
        } catch (e) { }
    }
    isProcessingReactions = false;
};

async function sendToDjango(payload, msgKey = null, isFromQueue = false) {
    try {
        const response = await axios.post(DJANGO_WEBHOOK_URL, payload, { timeout: 8000 });
        if (response.status >= 200 && response.status < 300) {
            if (!payload.is_sync && response.data?.reaction && msgKey) {
                reactionQueue.push({ chatId: msgKey.remoteJid, reaction: response.data.reaction, key: msgKey });
                processReactionQueue();
            }
        }
    } catch (error) {
        // 🔥 طباعة التفاصيل الدقيقة القادمة من جانغو بدلاً من رسالة عامة
        const djangoReason = error.response?.data?.error || error.response?.data?.message || error.message;
        console.error(`❌ [Django Error] Failed: ${djangoReason} | Status: ${error.response?.status}`);
        
        if (!isFromQueue && !payload.is_sync) { 
            messageQueue.push({ payload, key: msgKey });
            setTimeout(processMessageQueue, 2000);
        }
    }
}

// ==============================================================
// 🔌 3. الاتصال ومعالجة الرسائل
// ==============================================================
async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`🚀 Starting Bridge v${version.join('.')} on Port ${PORT}`);

    sock = makeWASocket({
        version, logger: pino({ level: 'silent' }), printQRInTerminal: false,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })) },
        connectTimeoutMs: 60000, keepAliveIntervalMs: 10000, syncFullHistory: true, markOnlineOnConnect: true,
    });

    sock.ev.on('creds.update', saveCreds);

    // 👈 2. هذا هو المحرك الذي يسحب البيانات القديمة عند ربط الواتساب
    sock.ev.on('messaging-history.set', async ({ messages }) => {
        console.log(`📥 [History Event] Received bulk historical data from phone...`);
        
        if (!messages) return;

        let count = 0;
        // نستخدم transaction لتسريع إدخال آلاف الرسائل لقاعدة البيانات بلمح البصر
        const insertMany = db.transaction((msgs) => {
            for (const msg of msgs) {
                const messageObj = msg.message ? msg : (msg.messageStubType ? null : msg);
                if (!messageObj || !messageObj.key) continue;

                const remoteJid = messageObj.key.remoteJid;
                if (!remoteJid || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') continue;

                const isGroup = remoteJid.endsWith('@g.us');
                let participantRaw = messageObj.key.participant || remoteJid;
                let phone = extractPhoneNumber(participantRaw);
                if (!isGroup && !phone) phone = extractPhoneNumber(remoteJid);
                const senderId = cleanId(remoteJid); 

                if (ADMIN_BOT_NUMBERS.includes(senderId)) continue;

                // استخراج النص
                let body = "";
                const mContent = messageObj.message;
                if (mContent) {
                    body = mContent.conversation || mContent.extendedTextMessage?.text || mContent.imageMessage?.caption || "";
                    const proto = mContent.protocolMessage;
                    if (proto && (proto.type === 'EDIT_MESSAGE' || proto.type === 'MESSAGE_EDIT' || proto.type === 14)) {
                        body = proto.editedMessage?.conversation || proto.editedMessage?.extendedTextMessage?.text || ""; 
                    }
                }

                if (!body || body.trim().length === 0) continue;

                // استخراج التوقيت
                let msgTime = messageObj.messageTimestamp;
                if (typeof msgTime !== 'number') msgTime = msgTime?.low || Math.floor(Date.now() / 1000);

                let payload = {
                    event_type: 'new_message', target_message_id: null, is_sync: true, 
                    whatsapp_message_id: messageObj.key.id, sender_id: senderId, participant_phone: phone,          
                    participant_raw: participantRaw, pushName: messageObj.pushName || "",     
                    group_id: isGroup ? remoteJid : null, author_id: isGroup ? participantRaw : null,
                    is_group: isGroup, message_text: body, timestamp: msgTime
                };

                const isInvoiceLike = /فاتور|اجر|أجر|توصيل|تعويض|غرام|مخالف|كابتن|سائق|مندوب|منسق/i.test(body);
                const isInvoice = (isInvoiceLike && body.length > 15) ? 1 : 0;

                try {
                    insertMsg.run(messageObj.key.id, remoteJid, msgTime, isInvoice, JSON.stringify(payload));
                    count++;
                } catch (e) { /* تجاهل المكرر */ }
            }
        });

        insertMany(messages);
        console.log(`📚 [History] Successfully saved ${count} historical messages to SQLite DB.`);
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { currentQR = qr; qrcodeTerminal.generate(qr, { small: true }); }

        if (connection === 'close') {
            isWaConnected = false;
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                let delayMs = statusCode === DisconnectReason.restartRequired ? 1000 : Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
                reconnectAttempts++; setTimeout(startWhatsApp, delayMs);
            } else {
                console.log('❌ LOGGED OUT! Cleaning up session...');
                try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); currentQR = null; setTimeout(startWhatsApp, 3000); } catch(e) {}
            }
        } 
        else if (connection === 'open') {
            console.log('✅ WhatsApp Connected Successfully!');
            currentQR = null; isWaConnected = true; reconnectAttempts = 0;
            processMessageQueue(); processReactionQueue();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                try {
                    if (msg.message?.messageContextInfo) delete msg.message.messageContextInfo;
                    if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') continue;
                    processSingleMessage(msg, false); 
                } catch (err) {}
            }
        } 
    });
}

async function processSingleMessage(msg, isSync = false) {
    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.endsWith('@g.us');
    let participantRaw = msg.key.participant || remoteJid;
    let phone = extractPhoneNumber(participantRaw);
    if (!isGroup && !phone) phone = extractPhoneNumber(remoteJid);
    const senderId = cleanId(remoteJid); 

    if (ADMIN_BOT_NUMBERS.includes(senderId)) return;
    const messageContent = msg.message;
    if (!messageContent) return;

    const proto = messageContent.protocolMessage;
    let eventType = 'new_message';
    let targetMsgId = null;
    let body = "";

    if (proto) {
        if (proto.type === 'REVOKE' || proto.type === 0) {
            eventType = 'message_revoke'; targetMsgId = proto.key?.id; body = "[REVOKE]"; 
        } else if (proto.type === 'EDIT_MESSAGE' || proto.type === 'MESSAGE_EDIT' || proto.type === 14) {
            eventType = 'message_edit'; targetMsgId = proto.key?.id;
            body = proto.editedMessage?.conversation || proto.editedMessage?.extendedTextMessage?.text || ""; 
        }
    }

    if ((!body || body === "") && eventType === 'new_message') {
        body = messageContent.conversation || messageContent.extendedTextMessage?.text || messageContent.imageMessage?.caption || "";
    }

    if ((!body || body.trim().length === 0) && eventType === 'new_message') return;

    let finalMsgId = msg.key.id;
    let finalEventType = eventType;

    if (isSync && eventType === 'message_edit') {
        finalMsgId = targetMsgId || msg.key.id; finalEventType = 'new_message'; 
    }

    let payload = {
        event_type: finalEventType, target_message_id: targetMsgId, is_sync: isSync, 
        whatsapp_message_id: finalMsgId, sender_id: senderId, participant_phone: phone,          
        participant_raw: participantRaw, pushName: msg.pushName || "",     
        group_id: isGroup ? remoteJid : null, author_id: isGroup ? participantRaw : null,
        is_group: isGroup, message_text: body, timestamp: msg.messageTimestamp
    };

    // 🔥 الأرشفة في الداتابيز (SQLite)
    try {
        let msgTime = msg.messageTimestamp;
        if (typeof msgTime !== 'number') msgTime = msgTime?.low || Math.floor(Date.now() / 1000);
        
        // 🛡️ التصفية الذكية: هل هي فاتورة أم شات عادي؟
        const isInvoiceLike = /فاتور|اجر|أجر|توصيل|تعويض|غرام|مخالف|كابتن|سائق|مندوب|منسق/i.test(body);
        const isInvoice = (isInvoiceLike && body.length > 15) ? 1 : 0;

        insertMsg.run(finalMsgId, remoteJid, msgTime, isInvoice, JSON.stringify(payload));
    } catch (e) {
        console.error("⚠️ Failed to insert into SQLite:", e.message);
    }

    // إرسال لجانغو
    sendToDjango(payload, msg.key, false);
}

// ==============================================================
// 🚀 4. الروابط الـ APIs (متصلة بقاعدة البيانات)
// ==============================================================

app.post('/force-sync', async (req, res) => {
    const { phone, start_ts, end_ts } = req.body;
    
    try {
        const jid = getJid(phone);
        if (!jid || !start_ts || !end_ts) return res.status(400).json({ error: "Missing parameters" });

        // سحب الفواتير من القرص الصلب (سريع جداً)
        const rows = getMsgsByDate.all(jid, start_ts, end_ts);
        
        if (rows.length === 0) {
            return res.json({ status: "skipped", message: "لا توجد فواتير في الأرشيف لهذا النطاق الزمني." });
        }

        res.json({ status: "started", message: `جاري ترحيل ${rows.length} فاتورة من الأرشيف السري...` });

        // إرسالها لجانغو بالخلفية
        (async () => {
            console.log(`🔄 [Auto-Sync] Exporting ${rows.length} invoices...`);
            for (const row of rows) {
                try {
                    const payload = JSON.parse(row.payload_json);
                    payload.is_sync = true; // مهم ليعرف جانغو أنها مزامنة
                    await sendToDjango(payload, null, true);
                    await delay(10); 
                } catch (e) {}
            }
            console.log(`✅ [Auto-Sync] Done.`);
        })();

    } catch (e) {
        console.error("🔥 Sync Error:", e);
        if (!res.headersSent) res.status(500).json({ error: e.message });
    }
});

// ==============================================================
// 🛠️ 5. الروابط الإضافية (تمت ترقيتها لتعمل على SQLite بدلاً من RAM)
// ==============================================================

// 1. جلب جرد الفواتير (Get Inventory)
app.post('/get-inventory', async (req, res) => {
    const { phone, startDate, endDate, start_ts, end_ts } = req.body;
    try {
        const jid = getJid(phone);
        
        let safeStartTs = 0;
        let safeEndTs = 9999999999; // رقم كبير يمثل اللانهاية

        if (start_ts && end_ts) {
            safeStartTs = Number(start_ts);
            safeEndTs = Number(end_ts);
        } else if (startDate) {
            const startD = new Date(`${startDate}T00:00:00+03:00`);
            safeStartTs = Math.floor(startD.getTime() / 1000);
            if (endDate) {
                const endD = new Date(`${endDate}T23:59:59+03:00`);
                safeEndTs = Math.floor(endD.getTime() / 1000);
            }
        }

        // 🔥 استعلام سريع جداً من قاعدة البيانات
        const stmt = db.prepare('SELECT id FROM messages WHERE jid = ? AND timestamp >= ? AND timestamp <= ? AND is_invoice = 1');
        const rows = stmt.all(jid, safeStartTs, safeEndTs);
        
        const cleanInvoiceIds = rows.map(r => r.id.toUpperCase());

        res.json({ status: "success", clean_ids: cleanInvoiceIds });
    } catch (error) {
        console.error("Inventory Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// 2. الاستطلاع النطاقي (Check Inventory Range)
app.post('/check-inventory-range', async (req, res) => {
    const { phone, start_ts, end_ts } = req.body; 
    try {
        const jid = getJid(phone);
        
        // 🔥 استعلام تجميعي (Aggregate) يحسب العدد والحدود في 1 ميلي ثانية
        const stmt = db.prepare('SELECT COUNT(*) as count, MIN(timestamp) as min_ts, MAX(timestamp) as max_ts FROM messages WHERE jid = ? AND timestamp >= ? AND timestamp <= ?');
        const result = stmt.get(jid, start_ts, end_ts);

        if (!result || result.count === 0) {
            return res.json({ status: "empty", message: "لا توجد بيانات لهذا النطاق الزمني في الأرشيف" });
        }

        res.json({ 
            status: "success", 
            count: result.count,
            min_timestamp: result.min_ts,
            max_timestamp: result.max_ts 
        });

    } catch (error) {
        console.error("Check Range Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// 3. جلب رسائل محددة بالـ ID (Fetch Batch)
app.post('/fetch-messages-batch', async (req, res) => {
    const { phone, messageIds } = req.body;
    try {
        const jid = getJid(phone);
        if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
            return res.json({ status: "empty", messages: [] });
        }

        // تحضير الاستعلام الديناميكي بناءً على عدد الـ IDs
        const placeholders = messageIds.map(() => '?').join(',');
        const stmt = db.prepare(`SELECT id, timestamp, payload_json FROM messages WHERE jid = ? AND id IN (${placeholders})`);
        
        const rows = stmt.all(jid, ...messageIds);
        const foundMessages = rows.map(row => {
            const payload = JSON.parse(row.payload_json);
            return {
                id: row.id,
                text: payload.message_text,
                timestamp: new Date(row.timestamp * 1000).toISOString(),
                sender: payload.participant_raw || payload.participant_phone
            };
        });

        res.json({ status: "success", count: foundMessages.length, messages: foundMessages });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. ماسح الأشباح والمحذوفات (Scan Revoked) 👻
app.post('/scan-revoked', async (req, res) => {
    const { phone } = req.body;
    try {
        const jid = getJid(phone);
        
        // 🔥 نبحث في الـ payload_json عن كلمة message_revoke
        const stmt = db.prepare("SELECT payload_json FROM messages WHERE jid = ? AND payload_json LIKE '%message_revoke%'");
        const rows = stmt.all(jid);

        const revokedIds = new Set();
        rows.forEach(row => {
            const payload = JSON.parse(row.payload_json);
            if (payload.target_message_id) {
                revokedIds.add(payload.target_message_id);
            }
        });

        console.log(`👻 [Ghost Scanner] Found ${revokedIds.size} deletion requests in SQLite archive.`);
        
        res.json({ status: "success", count: revokedIds.size, ids: Array.from(revokedIds) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. أوامر التحكم المباشرة (Send/React/Kick) - مطابقة للقديم تماماً
app.post('/send-message', async (req, res) => {
    if (!sock || !isWaConnected) return res.status(503).json({ error: "Disconnected" });
    try {
        await sock.sendMessage(getJid(req.body.phone), { text: req.body.message });
        res.json({ status: 'success' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/send-reaction', async (req, res) => {
    if (!isWaConnected) return res.status(503).json({ error: "Disconnected" });
    reactionQueue.push({
        chatId: getJid(req.body.chat_id),
        reaction: req.body.reaction,
        key: { remoteJid: getJid(req.body.chat_id), id: req.body.message_id, fromMe: false }
    });
    processReactionQueue();
    res.json({ status: 'queued' });
});

app.post('/kick-member', async (req, res) => {
    if (!sock) return res.status(503).json({ error: "Disconnected" });
    try {
        await sock.groupParticipantsUpdate(getJid(req.body.group_id), [getJid(req.body.phone)], "remove");
        res.json({ status: 'success' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. أداة التشريح الجنائي المعمق (Debug Message)
app.post('/debug-message', async (req, res) => {
    const { phone, message_id } = req.body;
    try {
        const jid = getJid(phone);
        // نبحث عن الرسالة نفسها، أو أي رسالة تستهدفها (مثل التعديل أو الحذف)
        const stmt = db.prepare(`SELECT * FROM messages WHERE jid = ? AND (id = ? OR payload_json LIKE ?)`);
        const rows = stmt.all(jid, message_id, `%${message_id}%`);

        console.log(`\n🕵️‍♂️ [FORENSIC DEBUG] Found ${rows.length} SQLite records for ID: ${message_id}`);
        
        res.json({
            status: "success",
            count: rows.length,
            raw_data: rows.map(r => JSON.parse(r.payload_json))
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. أداة البحث المجهري (Search Archive بدل Search RAM)
app.post('/search-archive', async (req, res) => {
    const { search_text } = req.body;
    if (!search_text) return res.json({ error: "أرسل نصاً للبحث" });

    try {
        // بحث نصي داخل JSON المخزن
        const stmt = db.prepare("SELECT * FROM messages WHERE payload_json LIKE ? LIMIT 50");
        const rows = stmt.all(`%${search_text}%`);
        
        let found_messages = rows.map(r => {
            const payload = JSON.parse(r.payload_json);
            return {
                id: r.id,
                time_epoch: r.timestamp,
                time_syria: new Date(r.timestamp * 1000).toLocaleString('en-US', {timeZone: 'Asia/Damascus'}),
                text: payload.message_text.substring(0, 100) + "..."
            };
        });

        // لحساب إجمالي السجلات في الداتابيز
        const totalRows = db.prepare("SELECT COUNT(*) as count FROM messages").get().count;

        res.json({
            total_in_archive: totalRows,
            found_count: found_messages.length,
            results: found_messages
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get('/qr-code', async (req, res) => {
    try {
        if (isWaConnected) {
            return res.send(`
                <div style="font-family:sans-serif; text-align:center; padding-top:50px;">
                    <h1 style="color:green;">✅ متصل بنجاح (WhatsApp Connected)</h1>
                </div>
            `);
        }

        if (!currentQR) {
            return res.send(`
                <div style="font-family:sans-serif; text-align:center; padding-top:50px;">
                    <h1>⏳ جاري توليد الرمز...</h1>
                    <script>setTimeout(function(){location.reload()}, 2000);</script>
                </div>
            `);
        }

        // تحويل كود الـ QR إلى صورة Base64
        const url = await QRCode.toDataURL(currentQR);
        
        res.send(`
            <div style="display:flex; justify-content:center; align-items:center; height:100vh; background:#f0f2f5; font-family:sans-serif;">
                <div style="background:white; padding:20px; border-radius:15px; box-shadow:0 4px 15px rgba(0,0,0,0.1); text-align:center;">
                    <h2 style="margin-bottom:20px; color:#333;">مسح الرمز للربط 📱</h2>
                    <img src="${url}" style="width:300px; height:300px;" />
                    <p style="margin-top:15px; color:#666;">يتم التحديث تلقائياً...</p>
                </div>
            </div>
            <script>setTimeout(function(){location.reload()}, 15000);</script>
        `);

    } catch (e) {
        res.status(500).send("Error generating QR");
    }
});

(async () => {
    await startWhatsApp();
    app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Bridge Titanium Edition Running on ${PORT}`));
})();