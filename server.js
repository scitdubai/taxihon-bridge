/**
 * TaxiHon Bridge - Diamond Edition 💎 (High Load Optimized)
 * Status: FINAL PRODUCTION READY
 * Features:
 * 1. 🛡️ Crash-Proof & Memory Safe (Atomic Saves).
 * 2. ⚡ Smart Reaction Queue & Connection Backoff.
 * 3. 🗓️ 32-Day Rolling Window (Accounting Mode).
 * 4. 🚀 Async Saving (Non-blocking I/O).
 * 5. 🚨 Auto-Healing & SOS Alerts to Django.
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
import QRCode from 'qrcode';
import pino from 'pino';
import express from 'express';
import axios from 'axios';
import qrcodeTerminal from 'qrcode-terminal';
import fs from 'fs';
import cors from 'cors';

const PORT = 3000;
//  const DJANGO_WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://api.taxihon.com/webhook/';

 const DJANGO_WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://127.0.0.1:8000/webhook/';

const SESSION_DIR = 'auth_info_baileys'; 
const STORE_FILE = 'baileys_store.json'; 
const ADMIN_BOT_NUMBERS = ['963931698655', '963931697655'];

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
    
    // 🛡️ [تعديل أمني]: الحفظ الذري الآمن (Atomic Save) لمنع تلف الملفات عند انقطاع الكهرباء
    writeToFile: () => {
        if (store.isSaving) return;
        store.isSaving = true;
        
        console.log("💾 Saving data to disk safely...");
        try {
            const data = JSON.stringify(store.messages);
            const tmpFile = STORE_FILE + '.tmp'; 
            
            fs.writeFile(tmpFile, data, (err) => {
                if (err) {
                    store.isSaving = false;
                    return console.error("⚠️ Write Error:", err);
                }
                fs.rename(tmpFile, STORE_FILE, (renameErr) => {
                    store.isSaving = false;
                    if (renameErr) console.error("⚠️ Rename Error:", renameErr);
                    // else console.log("✅ Data saved atomically.");
                });
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

// 🛡️ [تعديل أمني]: حفظ الطوارئ (تنظيف وإغلاق آمن)
process.on('SIGINT', () => { 
    console.log("\n🛑 Shutting down safely...");
    try { 
        store.cleanup();
        fs.writeFileSync(STORE_FILE, JSON.stringify(store.messages)); 
    } catch(e) {}
    process.exit(); 
});

// --- 🧠 2. إدارة الطوابير ---
let sock;
let isWaConnected = false;
let messageQueue = []; 
let reactionQueue = []; 
let isProcessingReactions = false;
let currentQR = null;
let reconnectAttempts = 0; // 💡 عداد محاولات الاتصال للتباعد الذكي

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
// const extractPhoneNumber = (jid) => jid ? jid.split('@')[0].split(':')[0] : null;
const extractPhoneNumber = (jid) => {
    if (!jid) return null;

    // تنظيف المعرف من الـ Device ID (مثل 9639xxx:1@s.whatsapp.net)
    // نأخذ ما قبل الـ @ ثم ما قبل الـ :
    const cleanJid = jid.split('@')[0].split(':')[0];

    // 1. إذا كان رقم هاتف عادي
    if (jid.endsWith('@s.whatsapp.net')) {
        return cleanJid;
    }

    // 2. إذا كان رقم مشفر (LID)
    if (jid.endsWith('@lid')) {
        return cleanJid; // سيعيد المعرف المشفر الصافي (أرقام فقط بدون @lid)
    }

    // 3. المجموعات أو غيرها
    return cleanJid;
};

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
        // 🛡️ [تعديل أمني]: حماية الطابور من التوقف في حال انقطاع السوكيت
        if (!sock || !isWaConnected) {
            console.log("⚠️ Socket disconnected, pausing reaction queue.");
            break; 
        }

        const item = reactionQueue.shift();
        try {
            await sock.sendMessage(item.chatId, { react: { text: item.reaction, key: item.key } });
            await delay(600);
        } catch (e) { console.error("⚠️ React Error:", e.message); }
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

    // 🛡️ [تعديل أمني]: خوارزمية التباعد الذكي ونداء الاستغاثة (SOS)
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentQR = qr; // ✅ حفظ الرمز في المتغير لعرضه في المتصفح
            console.log('\n🔵 Scan QR Code:\n');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isWaConnected = false;
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`⚠️ Connection closed (Code: ${statusCode}). Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                // خوارزمية التباعد الذكي لمنع الحظر
                let delayMs = statusCode === DisconnectReason.restartRequired 
                              ? 1000 
                              : Math.min(1000 * Math.pow(2, reconnectAttempts), 60000);
                
                reconnectAttempts++;
                console.log(`⏳ Attempt ${reconnectAttempts}: Reconnecting in ${delayMs/1000} seconds...`);
                setTimeout(startWhatsApp, delayMs);
            } else {
                // تدمير الجلسة الميتة آلياً
                console.log('❌ LOGGED OUT! Device unlinked. Cleaning up session for new QR...');
                
                // 🚨🚨 إرسال نداء استغاثة لجانغو (SOS Alert) 🚨🚨
                const alertUrl = DJANGO_WEBHOOK_URL.replace('webhook/', 'api/v1/system-configs/bridge_alert/');
                axios.post(alertUrl, {
                    alert_type: "LOGGED_OUT",
                    message: "تم فصل جسر الواتساب! يرجى الدخول ومسح الـ QR."
                }).catch(err => console.error("⚠️ Failed to send SOS to Django"));

                try {
                    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                    currentQR = null;
                    setTimeout(startWhatsApp, 3000); // إعادة تشغيل نظيفة لتوليد QR جديد
                } catch(e) { console.error("Session delete error:", e); }
            }
        } 
        else if (connection === 'open') {
            console.log('✅ WhatsApp Connected Successfully!');
            currentQR = null; 
            isWaConnected = true;
            reconnectAttempts = 0; // تصفير العداد
            if (messageQueue.length > 0) processMessageQueue();
            if (reactionQueue.length > 0) processReactionQueue();
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
                    // 🛡️ [تعديل أمني]: تنظيف البيانات غير الضرورية من الرام لمنع تضخم الـ Store
                    if (msg.message?.messageContextInfo) delete msg.message.messageContextInfo;

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

// --- 📨 6. معالج الرسالة (المحدث لاستخراج الرقم بذكاء + حل مشاكل الحذف والتعديل) ---
async function processSingleMessage(msg, isSync = false) {
    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.endsWith('@g.us');
    
    // 1. استخراج المشارك الخام (JID أو LID)
    // في المجموعات نأخذ participant، في الخاص نأخذ remoteJid
    let participantRaw = msg.key.participant || remoteJid;
    
    // 2. محاولة استخراج الرقم الحقيقي أو المعرف الصافي (LID)
    // الدالة المحدثة ستعيد الرقم لـ @s.whatsapp.net أو المعرف لـ @lid
    let phone = extractPhoneNumber(participantRaw);
    
    // في الخاص، إذا كان المشارك LID، نستخدم الرقم المباشر من remoteJid إن أمكن
    if (!isGroup && !phone) {
        phone = extractPhoneNumber(remoteJid);
    }

    const senderId = cleanId(remoteJid); // ID الجروب أو الشخص

    if (ADMIN_BOT_NUMBERS.includes(senderId)) return;

    const messageContent = msg.message;
    if (!messageContent) return;

    // 🔥 فحص البروتوكول (حذف / تعديل)
    const proto = messageContent.protocolMessage;
    let eventType = 'new_message';
    let targetMsgId = null;
    let body = "";

    if (proto) {
        // حالة الحذف (Revoke)
        if (proto.type === 'REVOKE' || proto.type === 0) {
            eventType = 'message_revoke';
            targetMsgId = proto.key?.id; 
            body = "[REVOKE]"; 
        } 
        // حالة التعديل (Edit)
        else if (proto.type === 'EDIT_MESSAGE' || proto.type === 14) {
            eventType = 'message_edit';
            targetMsgId = proto.key?.id;
            body = proto.editedMessage?.conversation || 
                   proto.editedMessage?.extendedTextMessage?.text || 
                   proto.editedMessage?.imageMessage?.caption || ""; 
        }
    }

    // استخراج النص من كافة الحقول المحتملة بما فيها الأزرار
    if ((!body || body === "") && eventType === 'new_message') {
        body = messageContent.conversation || 
               messageContent.extendedTextMessage?.text || 
               messageContent.imageMessage?.caption || 
               messageContent.templateButtonReplyMessage?.selectedId || 
               messageContent.buttonsResponseMessage?.selectedButtonId || 
               "";
    }

    // تجاهل الرسائل الفارغة (إلا إذا كانت حذف أو تعديل)
    if ((!body || body.trim().length === 0) && eventType === 'new_message') return;

    if (isSync) {
        console.log(`✅ [SYNC] ${new Date(msg.messageTimestamp*1000).toLocaleDateString()} | ${body.substring(0, 30)}...`);
    }

    // تجهيز البايلود الشامل لضمان وصول كل التفاصيل لـ Django
    let payload = {
        event_type: eventType, 
        target_message_id: targetMsgId, 
        is_sync: isSync, 
        whatsapp_message_id: msg.key.id, 
        sender_id: senderId,
        
        // الحقول المحسنة لضمان الدقة مع الأرقام المشفرة
        participant_phone: phone,          // الرقم الصافي أو الـ LID الصافي
        participant_raw: participantRaw,   // المعرف الكامل (للرد المباشر)
        pushName: msg.pushName || "",     // اسم المستخدم على واتساب
        
        group_id: isGroup ? remoteJid : null,
        author_id: isGroup ? participantRaw : null,
        is_group: isGroup,
        message_text: body,
        timestamp: msg.messageTimestamp
    };

    // معالجة الميديا (صور، صوت، فيديو)
    const msgType = Object.keys(messageContent)[0];
    if (eventType === 'new_message' && ['imageMessage', 'audioMessage', 'videoMessage', 'pttMessage'].includes(msgType)) {
        try {
            const buffer = await downloadMediaMessage(
                msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
            );
            if (buffer) {
                payload.has_media = true;
                payload.media_data = buffer.toString('base64');
                if (!body || body === "") payload.message_text = `[MEDIA: ${msgType}]`;
            }
        } catch (e) {
            console.error("❌ Media download error:", e.message);
        }
    }

    if (!isSync) {
        console.log(`📤 Live Event: ${eventType} | ID: ${msg.key.id} | Target: ${targetMsgId || 'None'}`);
        console.log(`   📞 Extracted: ${phone} | 🔢 RawID: ${participantRaw}`);
    }
    
    // الإرسال للسيرفر (Django Webhook)
    await sendToDjango(payload, msg.key);
}
// async function processSingleMessage(msg, isSync = false) {
//     const remoteJid = msg.key.remoteJid;
//     const isGroup = remoteJid.endsWith('@g.us');
//     const senderId = cleanId(remoteJid);
//     const participant = msg.key.participant || remoteJid;

//     if (ADMIN_BOT_NUMBERS.includes(senderId)) return;

//     const messageContent = msg.message;
//     if (!messageContent) return; 

//     let body = messageContent.conversation || 
//                messageContent.extendedTextMessage?.text || 
//                messageContent.imageMessage?.caption || "";
    
//     if (isSync) {
//         if (!body || body.trim().length === 0) return;
//         else console.log(`✅ [SYNC] ${new Date(msg.messageTimestamp*1000).toLocaleDateString()} | ${body.substring(0, 30)}...`);
//     }

//     if (!body || body.trim().length === 0) return;

//     const msgType = Object.keys(messageContent)[0];

//     let payload = {
//         event_type: 'new_message',
//         is_sync: isSync, 
//         whatsapp_message_id: msg.key.id,
//         sender_id: senderId,
//         participant_phone: extractPhoneNumber(participant),
//         participant_raw: participant,
//         group_id: isGroup ? remoteJid : null,
//         author_id: isGroup ? participant : null,
//         is_group: isGroup,
//         message_text: body,
//         timestamp: msg.messageTimestamp,
//         pushName: msg.pushName
//     };

//     if (['imageMessage', 'audioMessage', 'videoMessage', 'pttMessage'].includes(msgType)) {
//         try {
//             const buffer = await downloadMediaMessage(
//                 msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
//             );
//             if (buffer) {
//                 payload.has_media = true;
//                 payload.media_data = buffer.toString('base64');
//                 if (!body || body === "") payload.message_text = `[MEDIA: ${msgType}]`;
//             }
//         } catch (e) {}
//     }

//     if (!isSync) console.log(`📤 Live Msg: ${msg.key.id}`);
//     await sendToDjango(payload, msg.key);
// }

// رابط عرض الـ QR Code في المتصفح
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

// --- 🔌 7. الروابط الخارجية ---
// أ) المزامنة القسرية (مع فلتر التاريخ الدقيق + فلتر الحذف الذكي 🗑️)
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

        // --- 🗑️ 1. بناء قائمة المحذوفات الشاملة (Blacklist) ---
        const revokedIds = new Set();
        messages.forEach(msg => {
            // صيد أوامر الـ REVOKE الصريحة
            const proto = msg.message?.protocolMessage;
            if (proto && (proto.type === 'REVOKE' || proto.type === 0)) {
                if (proto.key && proto.key.id) revokedIds.add(proto.key.id);
            }
            // صيد الأشباح المتخفية (StubType 68)
            if (msg.messageStubType === 68 && msg.key && msg.key.id) {
                revokedIds.add(msg.key.id);
            }
        });
        
        if (revokedIds.size > 0) {
            console.log(`🧹 [Smart Filter] Found ${revokedIds.size} deleted messages. They will be ignored.`);
        }

        // --- 2. الفلترة والتجهيز ---
        let msgsToSync = messages.filter(m => {
            // استبعاد المحذوفات بكل أنواعها
            if (m.message?.protocolMessage) return false;
            if (m.messageStubType === 68) return false;
            if (m.key && revokedIds.has(m.key.id)) return false;

            // التأكد من وجود نص حقيقي وفعلي (يمنع مرور غلاف الرسالة المحذوفة)
            const text = m.message?.conversation || 
                         m.message?.extendedTextMessage?.text || 
                         m.message?.imageMessage?.caption || "";
            
            if (!text || text.trim().length < 15) return false;

            // ج) فلتر التاريخ الدقيق (بدون أي تلاعب أو إضافات)
            if (startDate) {
                const startTimestamp = new Date(startDate).getTime() / 1000;
                let endTimestamp = Infinity;
                if (endDate) {
                    endTimestamp = new Date(endDate).getTime() / 1000; 
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

// ج) الجرد المبني على حالة الواتساب الحالية (State-based Inventory)
// ج) الجرد بنظام "الفلاج" (Mark-and-Sweep Inventory)
// ج) الجرد المبني على حالة الواتساب الحالية (State-based Inventory)
// ج) الجرد بنظام "الفلاج" (Mark-and-Sweep Inventory)
app.post('/get-inventory', async (req, res) => {
    const { phone, startDate, endDate } = req.body;
    
    try {
        const jid = getJid(phone);
        const messages = store.messages[jid] || [];
        const cleanInvoiceIds = [];

        // 1. تحديد حدود التاريخ
        const startTimestamp = startDate ? new Date(startDate).getTime() / 1000 : 0;
        let endTimestamp = Infinity;
        if (endDate) {
            // 🔥 تمت استعادة الكود الخاص بك لضمان شمول آخر ثانية من اليوم
            const endD = new Date(endDate);
            endD.setHours(23, 59, 59, 999);
            endTimestamp = endD.getTime() / 1000;
        }

        // 2. بناء قائمة المحذوفات الشاملة لاستبعادها
        const revokedIds = new Set();
        messages.forEach(msg => {
            const proto = msg.message?.protocolMessage;
            if (proto && (proto.type === 'REVOKE' || proto.type === 0)) {
                if (proto.key && proto.key.id) revokedIds.add(proto.key.id);
            }
            // 👻 صيد الأشباح
            if (msg.messageStubType === 68 && msg.key && msg.key.id) {
                revokedIds.add(msg.key.id);
            }
        });

        // 3. بناء القائمة النظيفة (فواتير فقط، ضمن التاريخ، غير محذوفة)
        messages.forEach(msg => {
            if (msg.key && msg.key.id) {
                let msgTime = (typeof msg.messageTimestamp === 'number') 
                              ? msg.messageTimestamp 
                              : (msg.messageTimestamp ? msg.messageTimestamp.low : 0);

                if (msgTime >= startTimestamp && msgTime <= endTimestamp) {
                    const isProtocol = !!msg.message?.protocolMessage;
                    const isFromMe = msg.key.fromMe;
                    const isStubGhost = msg.messageStubType === 68; // 🛡️ حماية الأشباح
                    
                    if (!isProtocol && !isFromMe && !isStubGhost && !revokedIds.has(msg.key.id)) {
                        const text = msg.message?.conversation || 
                                     msg.message?.extendedTextMessage?.text || 
                                     msg.message?.imageMessage?.caption || "";
                        
                        // فلتر الفواتير + التأكد من طول النص لمنع مرور الأشباح
                        const isInvoiceLike = /فاتور|اجر|أجر|توصيل|تعويض|غرام|مخالف|كابتن|سائق|مندوب|منسق|كونترول|كنترول/i.test(text);
                        if (isInvoiceLike && text.length > 15) {
                            cleanInvoiceIds.push(msg.key.id.toUpperCase());
                        }
                    }
                }
            }
        });

        console.log(`✅ [Inventory] Dates: ${startDate} -> ${endDate} | Clean Sent: ${cleanInvoiceIds.length}`);
        res.json({ status: "success", clean_ids: cleanInvoiceIds });

    } catch (error) {
        console.error("Inventory Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// 📡 دالة الاستطلاع (The Probe): تعيد النطاق الزمني الفعلي المتوفر في الرام
// 📡 دالة الاستطلاع (The Probe): تعيد النطاق الزمني الفعلي المتوفر في الرام
app.post('/check-inventory-range', async (req, res) => {
    const { phone, target_date } = req.body; // يتوقع YYYY-MM-DD
    
    try {
        const jid = getJid(phone);
        const messages = store.messages[jid] || [];
        
        // حساب بداية ونهاية اليوم المطلوب بالثواني
        const startOfDay = new Date(`${target_date}T00:00:00`).getTime() / 1000;
        const endOfDay = new Date(`${target_date}T23:59:59.999`).getTime() / 1000;

        let minTs = Infinity;
        let maxTs = 0;
        let validCount = 0;

        messages.forEach(msg => {
            let msgTime = (typeof msg.messageTimestamp === 'number') 
                          ? msg.messageTimestamp 
                          : (msg.messageTimestamp ? msg.messageTimestamp.low : 0);

            // إذا كانت الرسالة ضمن اليوم المطلوب وليست من البوت
            if (msgTime >= startOfDay && msgTime <= endOfDay && !msg.key.fromMe) {
                
                // 🔥 [التعديل الأمني هنا]: استبعاد الأشباح الصريحة والأشباح الخفية (Stub 68)
                const proto = msg.message?.protocolMessage;
                const isRevoke = proto && (proto.type === 'REVOKE' || proto.type === 0);
                const isStubGhost = msg.messageStubType === 68;

                // نقبل الرسالة في حساب الوقت فقط إذا لم تكن محذوفة نهائياً
                if (!isRevoke && !isStubGhost) {
                    if (msgTime < minTs) minTs = msgTime;
                    if (msgTime > maxTs) maxTs = msgTime;
                    validCount++;
                }
            }
        });

        if (validCount === 0) {
            return res.json({ status: "empty", message: "لا توجد بيانات لهذا اليوم في ذاكرة الجسر" });
        }

        res.json({ 
            status: "success", 
            count: validCount,
            min_timestamp: minTs, // أقدم رسالة حقيقية في الرام
            max_timestamp: maxTs  // أحدث رسالة حقيقية في الرام
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// د) جلب رسائل محددة بالـ ID (لاسترجاع المفقودات فقط - Smart Fetch)
app.post('/fetch-messages-batch', async (req, res) => {
    const { phone, messageIds } = req.body;
    const jid = getJid(phone);
    const messages = store.messages[jid];

    if (!messages || !messageIds || !Array.isArray(messageIds)) {
        return res.json({ status: "empty", messages: [] });
    }

    // نوحد الـ IDs للبحث (Uppercase)
    const messageIdsSet = new Set(messageIds.map(id => id.toUpperCase()));
    const foundMessages = [];

    messages.forEach(msg => {
        if (msg.key && msg.key.id) {
            const currentId = msg.key.id.toUpperCase();
            
            if (messageIdsSet.has(currentId)) {
                const text = msg.message?.conversation || 
                             msg.message?.extendedTextMessage?.text || 
                             msg.message?.imageMessage?.caption || "";
                
                // التعامل الآمن مع التوقيت
                let msgTime = (typeof msg.messageTimestamp === 'number') 
                              ? msg.messageTimestamp 
                              : (msg.messageTimestamp ? msg.messageTimestamp.low : Math.floor(Date.now()/1000));

                foundMessages.push({
                    id: msg.key.id,
                    text: text,
                    timestamp: new Date(msgTime * 1000).toISOString(),
                    sender: msg.key.participant || msg.key.remoteJid
                });
            }
        }
    });

    res.json({ 
        status: "success", 
        count: foundMessages.length, 
        messages: foundMessages 
    });
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
        // إضافة صيد الأشباح هنا أيضاً لضمان التوافق
        if (msg.messageStubType === 68 && msg.key && msg.key.id) {
            revokedIds.add(msg.key.id);
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

// 🔍 أداة التشريح الجنائي المعمق لرسالة محددة (Deep Forensic Debugger)
app.post('/debug-message', async (req, res) => {
    const { phone, message_id } = req.body;
    
    try {
        const jid = getJid(phone);
        const messages = store.messages[jid] || [];
        
        const foundLogs = [];
        
        messages.forEach(msg => {
            let isTarget = false;
            
            // 1. هل هي الرسالة الأصلية؟
            if (msg.key && msg.key.id === message_id) {
                isTarget = true;
            }
            // 2. هل هي رسالة بروتوكول (حذف/تعديل) تستهدف هذه الرسالة؟
            if (msg.message?.protocolMessage?.key?.id === message_id) {
                isTarget = true;
            }
            
            if (isTarget) {
                foundLogs.push(msg);
            }
        });

        console.log(`\n🕵️‍♂️ [FORENSIC DEBUG] Found ${foundLogs.length} records for ID: ${message_id}`);
        console.log(JSON.stringify(foundLogs, null, 2));
        console.log("---------------------------------------------------\n");

        res.json({
            status: "success",
            count: foundLogs.length,
            raw_data: foundLogs
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

(async () => {
    await startWhatsApp();
    app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Bridge Running on ${PORT}`));
})();