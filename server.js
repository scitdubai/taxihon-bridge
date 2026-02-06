/**
 * TaxiHon Bridge - Diamond Edition 💎 (High Load Optimized)
 * Status: FINAL PRODUCTION READY
 * Features:
 * 1. 🛡️ Crash-Proof & Memory Safe.
 * 2. ⚡ Smart Reaction Queue.
 * 3. 🗓️ 32-Day Rolling Window (Accounting Mode).
 * 4. 🚀 Async Saving (Non-blocking I/O).
 */

import { 
    default as makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    downloadMediaMessage,
    delay,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';

import pino from 'pino';
import express from 'express';
import axios from 'axios';
import qrcodeTerminal from 'qrcode-terminal';
import fs from 'fs';
import cors from 'cors';

const PORT = 3000;
const DJANGO_WEBHOOK_URL = 'http://127.0.0.1:8000/webhook/'; 
const SESSION_DIR = 'auth_info_baileys'; 
const STORE_FILE = 'baileys_store.json'; 
const ADMIN_BOT_NUMBERS = ['963931698698', '963931697697'];

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- 🔥 إعدادات الذاكرة الزمنية ---
const MAX_DAYS_RETENTION = 32; // الاحتفاظ بآخر 32 يوم
const MAX_MESSAGES_LIMIT = 100000; // سقف أمان عالٍ جداً
const SAVE_INTERVAL_MS = 5 * 60 * 1000; // الحفظ كل 5 دقائق

// --- 🔥 المخزن الذكي (Smart Store) ---
const store = {
    messages: {}, 
    isSaving: false,

    readFromFile: () => {
        try {
            if (fs.existsSync(STORE_FILE)) {
                const data = fs.readFileSync(STORE_FILE, 'utf-8');
                store.messages = JSON.parse(data);
                console.log(`📂 Loaded history for ${Object.keys(store.messages).length} chats.`);
                store.cleanup(); 
            }
        } catch (e) { console.error("⚠️ Store load error:", e.message); }
    },
    
    writeToFile: () => {
        if (store.isSaving) return;
        store.isSaving = true;
        
        console.log("💾 Saving data to disk...");
        try {
            const data = JSON.stringify(store.messages);
            fs.writeFile(STORE_FILE, data, (err) => {
                store.isSaving = false;
                if (err) console.error("⚠️ Write Error:", err);
                else console.log("✅ Data saved successfully.");
            });
        } catch (e) {
            store.isSaving = false;
            console.error("⚠️ Serialization Error:", e.message);
        }
    },
    
    // ✅ دالة التنظيف الذكية (تزيل التكرار وتحافظ على المجال الزمني)
    cleanup: () => {
        const cutoff = (Date.now() / 1000) - (MAX_DAYS_RETENTION * 24 * 60 * 60);
        let cleanedCount = 0;

        for (const jid in store.messages) {
            const initialLen = store.messages[jid].length;

            // 1. إزالة التكرار (Deduplication) - أهم خطوة لضمان دقة البيانات
            // نستخدم Map للاحتفاظ بنسخة واحدة فقط من كل رسالة بناءً على ID
            const uniqueMap = new Map();
            store.messages[jid].forEach(m => {
                if (m.key && m.key.id) uniqueMap.set(m.key.id, m);
            });
            store.messages[jid] = Array.from(uniqueMap.values());

            // 2. الفلترة الزمنية (32 يوم)
            store.messages[jid] = store.messages[jid].filter(m => {
                const t = m.messageTimestamp || 0;
                return t >= cutoff;
            });

            // 3. الترتيب الزمني (الأقدم أولاً -> الأحدث آخراً)
            store.messages[jid].sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));

            // 4. سقف الأمان (فقط للطوارئ)
            if (store.messages[jid].length > MAX_MESSAGES_LIMIT) {
                // نحتفظ بآخر 100 ألف رسالة (الأحدث)
                store.messages[jid] = store.messages[jid].slice(-MAX_MESSAGES_LIMIT);
            }

            cleanedCount += (initialLen - store.messages[jid].length);
        }
        
        if (cleanedCount > 0) {
            console.log(`🧹 [Cleanup] Optimized store. Removed/Deduped: ${cleanedCount} msgs.`);
        }
    },

    // ✅ دالة الإضافة السريعة (بدون فحص تكرار لإلتقاط الدفعات الكبيرة)
    upsertMessage: (msg) => {
        if (!msg || !msg.key) return; 
        const jid = msg.key.remoteJid;
        if (!jid) return; 

        if (!store.messages[jid]) store.messages[jid] = [];
        
        // نضيف الرسالة فوراً للذاكرة (حتى لو مكررة مؤقتاً)
        // سيقوم الـ cleanup بعد 5 دقائق بإزالة التكرار وترتيبها
        store.messages[jid].push(msg);
    },

    loadHistory: (chats) => {
        if (!chats) return;
        let count = 0;
        for (const chat of chats) {
            if (chat.messages) {
                for (const msg of chat.messages) {
                    const messageObj = msg.message ? msg : (msg.messageStubType ? null : msg);
                    if (messageObj) {
                        store.upsertMessage(messageObj);
                        count++;
                    }
                }
            }
        }
        console.log(`📚 Imported ${count} messages.`);
    }
};

// تشغيل القراءة عند البدء
store.readFromFile();

// دورة الحياة: تنظيف ثم حفظ كل 5 دقائق
setInterval(() => {
    store.cleanup();
    store.writeToFile();
}, SAVE_INTERVAL_MS);

// حفظ الطوارئ
process.on('SIGINT', () => { 
    try { fs.writeFileSync(STORE_FILE, JSON.stringify(store.messages)); } catch(e){}
    process.exit(); 
});

// --- 🧠 2. إدارة الطوابير ---
let sock;
let isWaConnected = false;
let messageQueue = []; 
let reactionQueue = []; 
let isProcessingReactions = false;

// --- Helpers ---
const getJid = (number) => {
    if (!number) return null;
    let clean = String(number).replace(/\D/g, '');
    if (String(number).includes('@')) return number;
    if (clean.length < 5) return null;
    if (clean.startsWith('09')) clean = '963' + clean.substring(1);
    return `${clean}@s.whatsapp.net`;
};

const cleanId = (jid) => jid ? jid.split('@')[0].split(':')[0] : null;
const extractPhoneNumber = (jid) => jid ? jid.split('@')[0].split(':')[0] : null;

// --- 🚦 3. معالجات الطوابير ---
const processMessageQueue = async () => {
    if (messageQueue.length === 0) return;
    const batch = [...messageQueue];
    messageQueue = [];
    for (const item of batch) {
        try {
            await sendToDjango(item.payload, item.key);
        } catch (e) {
            messageQueue.push(item);
        }
    }
};

const processReactionQueue = async () => {
    if (isProcessingReactions || reactionQueue.length === 0) return;
    isProcessingReactions = true;
    while (reactionQueue.length > 0) {
        const item = reactionQueue.shift();
        if (sock && isWaConnected) {
            try {
                await sock.sendMessage(item.chatId, { react: { text: item.reaction, key: item.key } });
                await delay(600);
            } catch (e) { console.error("React Error:", e.message); }
        }
    }
    isProcessingReactions = false;
};

// --- 🌐 4. الإرسال للباك إند ---
async function sendToDjango(payload, msgKey = null) {
    try {
        const response = await axios.post(DJANGO_WEBHOOK_URL, payload, { timeout: 10000 });
        
        if (response.status >= 200 && response.status < 300) {
            if (!payload.is_sync && response.data?.reaction && msgKey) {
                reactionQueue.push({
                    chatId: msgKey.remoteJid,
                    reaction: response.data.reaction,
                    key: msgKey
                });
                processReactionQueue();
            }
        }
    } catch (error) {
        console.error(`❌ [Django Error] ${error.message}`);
        if (!error.response && !payload.is_sync) { 
            messageQueue.push({ payload, key: msgKey });
            setTimeout(processMessageQueue, 5000);
        }
    }
}

// --- 🔌 5. الاتصال الرئيسي ---
async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`🚀 Starting Bridge v${version.join('.')} on Port ${PORT}`);

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        generateHighQualityLinkPreview: true,
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        syncFullHistory: true, 
        markOnlineOnConnect: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n🔵 Scan QR Code:\n');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️ Reconnecting:', shouldReconnect);
            if (shouldReconnect) setTimeout(startWhatsApp, 2000);
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Connected Successfully!');
            isWaConnected = true;
            if (messageQueue.length > 0) processMessageQueue();
        }
    });

    sock.ev.on('messaging-history.set', async ({ chats, messages }) => {
        console.log(`📥 [History Event] Received bulk data...`);
        if (chats) store.loadHistory(chats); 
        if (messages) {
             for (const msg of messages) store.upsertMessage(msg.message ? msg : msg);
             store.writeToFile(); // حفظ أولي
             console.log(`📚 [History] Direct messages saved: ${messages.length}`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            store.upsertMessage(msg);
        }

        if (type === 'notify') {
            for (const msg of messages) {
                try {
                    if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') continue;
                    await processSingleMessage(msg, false); 
                } catch (err) {}
            }
        } 
        else if (type === 'append') {
            console.log(`📥 [Append] Archived ${messages.length} older messages.`);
            // لا نحفظ فوراً هنا، نترك الحفظ الدوري يتولى الأمر لتخفيف الضغط
        }
    });
}

// --- 📨 6. معالج الرسالة ---
async function processSingleMessage(msg, isSync = false) {
    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.endsWith('@g.us');
    const senderId = cleanId(remoteJid);
    const participant = msg.key.participant || remoteJid;

    if (ADMIN_BOT_NUMBERS.includes(senderId)) return;

    const messageContent = msg.message;
    if (!messageContent) return; 

    let body = messageContent.conversation || 
               messageContent.extendedTextMessage?.text || 
               messageContent.imageMessage?.caption || "";
    
    if (isSync) {
        if (!body || body.trim().length === 0) return;
        else console.log(`✅ [SYNC] ${new Date(msg.messageTimestamp*1000).toLocaleDateString()} | ${body.substring(0, 30)}...`);
    }

    if (!body || body.trim().length === 0) return;

    const msgType = Object.keys(messageContent)[0];

    let payload = {
        event_type: 'new_message',
        is_sync: isSync, 
        whatsapp_message_id: msg.key.id,
        sender_id: senderId,
        participant_phone: extractPhoneNumber(participant),
        participant_raw: participant,
        group_id: isGroup ? remoteJid : null,
        author_id: isGroup ? participant : null,
        is_group: isGroup,
        message_text: body,
        timestamp: msg.messageTimestamp,
        pushName: msg.pushName
    };

    if (['imageMessage', 'audioMessage', 'videoMessage', 'pttMessage'].includes(msgType)) {
        try {
            const buffer = await downloadMediaMessage(
                msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
            );
            if (buffer) {
                payload.has_media = true;
                payload.media_data = buffer.toString('base64');
                if (!body || body === "") payload.message_text = `[MEDIA: ${msgType}]`;
            }
        } catch (e) {}
    }

    if (!isSync) console.log(`📤 Live Msg: ${msg.key.id}`);
    await sendToDjango(payload, msg.key);
}

// --- 🔌 7. الروابط الخارجية ---
// أ) المزامنة القسرية (مع فلتر التاريخ + فلتر الحذف الذكي 🗑️)
app.post('/force-sync', async (req, res) => {
    const { phone, limit, startDate, endDate } = req.body;
    
    try {
        const jid = getJid(phone);
        const messages = store.messages[jid]; 

        const totalAvailable = messages ? messages.length : 0;
        console.log(`🧐 [DEBUG] RAM Messages: ${totalAvailable}`);

        if (!messages || totalAvailable === 0) {
            return res.json({ status: "empty", message: "الأرشيف فارغ." });
        }

        // --- 🗑️ 1. بناء قائمة المحذوفات (Blacklist) ---
        // نقوم بمسح كامل الرسائل للبحث عن أوامر الحذف (Revoke)
        const revokedIds = new Set();
        messages.forEach(msg => {
            const proto = msg.message?.protocolMessage;
            // Baileys: نوع REVOKE عادة يكون 0
            if (proto && (proto.type === 'REVOKE' || proto.type === 0)) {
                if (proto.key && proto.key.id) {
                    revokedIds.add(proto.key.id);
                }
            }
        });
        
        if (revokedIds.size > 0) {
            console.log(`🧹 [Smart Filter] Found ${revokedIds.size} deleted messages. They will be ignored.`);
        }

        // --- 2. الفلترة والتجهيز ---
        let msgsToSync = messages.filter(m => {
            // أ) استبعاد الرسالة إذا كانت هي نفسها أمر حذف (protocolMessage)
            if (m.message?.protocolMessage) return false;

            // ب) استبعاد الرسالة إذا كان الـ ID الخاص بها موجود في قائمة المحذوفات
            if (m.key && revokedIds.has(m.key.id)) return false;

            // ج) فلتر التاريخ (إذا وجد)
            if (startDate) {
                const startTimestamp = new Date(startDate).getTime() / 1000;
                let endTimestamp = Infinity;
                if (endDate) {
                    endTimestamp = (new Date(endDate).getTime() / 1000) + 86400; // نهاية اليوم + 24 ساعة
                }
                const t = m.messageTimestamp || 0;
                return t >= startTimestamp && t <= endTimestamp;
            }
            
            return true;
        });

        // تطبيق الـ Limit (نأخذ آخر العدد المطلوب من الرسائل الصافية)
        if (!startDate) {
            const actualLimit = limit || 100;
            msgsToSync = msgsToSync.slice(-actualLimit);
        }

        const totalCount = msgsToSync.length;
        
        if (totalCount === 0) {
            return res.json({ status: "skipped", message: "لا توجد رسائل صالحة (قد تكون كلها محذوفة أو خارج التاريخ)." });
        }
        
        res.json({ 
            status: "started", 
            message: `جاري معالجة ${totalCount} رسالة (بعد استبعاد المحذوف)...`, 
            target_id: jid 
        });

        // --- 3. التنفيذ في الخلفية ---
        (async () => {
            console.log(`🔄 [Sync] Start sending ${totalCount} clean messages...`);
            for (const msg of msgsToSync) {
                try {
                    // نرسل مع flag: true للمزامنة
                    await processSingleMessage(msg, true);
                    // تأخير بسيط جداً لمنع اختناق الشبكة
                    await delay(10); 
                } catch (err) { console.error("Sync msg error:", err.message); }
            }
            console.log(`✅ [Sync] Done.`);
        })();

    } catch (e) {
        console.error("Force Sync Error:", e);
        if (!res.headersSent) res.status(500).json({ error: e.message });
    }
});

// ب) ماسح الأشباح (Scan Revoked) 👻
app.post('/scan-revoked', async (req, res) => {
    const { phone } = req.body;
    const jid = getJid(phone);
    const messages = store.messages[jid];

    if (!messages) return res.json({ status: "empty", ids: [] });

    // البحث عن كل رسائل الحذف في أرشيف الهاتف
    const revokedIds = new Set();
    messages.forEach(msg => {
        const proto = msg.message?.protocolMessage;
        if (proto && (proto.type === 'REVOKE' || proto.type === 0)) {
            if (proto.key && proto.key.id) {
                revokedIds.add(proto.key.id);
            }
        }
    });

    console.log(`👻 [Ghost Scanner] Found ${revokedIds.size} deletion requests in WhatsApp history.`);
    
    // إرسال القائمة للباك إند ليطابقها مع الموجود
    res.json({ 
        status: "success", 
        count: revokedIds.size, 
        ids: Array.from(revokedIds) 
    });
});
// أ) المزامنة القسرية (مع فلتر التاريخ)
// app.post('/force-sync', async (req, res) => {
//     const { phone, limit, startDate, endDate } = req.body;
    
//     try {
//         const jid = getJid(phone);
//         const messages = store.messages[jid]; 

//         const totalAvailable = messages ? messages.length : 0;
//         console.log(`🧐 [DEBUG] RAM Messages: ${totalAvailable}`);

//         if (!messages || totalAvailable === 0) {
//             return res.json({ status: "empty", message: "الأرشيف فارغ." });
//         }

//         let msgsToSync = [];
        
//         if (startDate) {
//             const startTimestamp = new Date(startDate).getTime() / 1000;
//             let endTimestamp = Infinity;
//             if (endDate) {
//                 endTimestamp = new Date(endDate).getTime() / 1000;
//                 endTimestamp += 86400; 
//             }

//             console.log(`📅 [Filter] ${startDate} -> ${endDate || 'NOW'}`);
            
//             msgsToSync = messages.filter(m => {
//                 const t = m.messageTimestamp || 0;
//                 return t >= startTimestamp && t <= endTimestamp;
//             });

//             if (msgsToSync.length === 0 && totalAvailable > 0) {
//                 const first = new Date((messages[0].messageTimestamp || 0) * 1000).toLocaleDateString();
//                 const last = new Date((messages[messages.length-1].messageTimestamp || 0) * 1000).toLocaleDateString();
//                 console.log(`⚠️ [Mismatch] RAM Range: [${first}] to [${last}]`);
//             }

//         } else {
//             const actualLimit = limit || 100;
//             msgsToSync = messages.slice(-actualLimit);
//         }

//         const totalCount = msgsToSync.length;
        
//         res.json({ 
//             status: "started", 
//             message: `جاري معالجة ${totalCount} رسالة...`, 
//             target_id: jid 
//         });

//         (async () => {
//             console.log(`🔄 [Sync] Start: ${totalCount}`);
//             for (const msg of msgsToSync) {
//                 try {
//                     await processSingleMessage(msg, true);
//                     await delay(5); 
//                 } catch (err) { }
//             }
//             console.log(`✅ [Sync] Done.`);
//         })();

//     } catch (e) {
//         if (!res.headersSent) res.status(500).json({ error: e.message });
//     }
// });

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

app.get("/health", (req, res) => res.json({ status: "ok" }));

(async () => {
    await startWhatsApp();
    app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Bridge Running on ${PORT}`));
})();