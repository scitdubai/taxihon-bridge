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
const DJANGO_WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://api.taxihon.com/webhook/';

//  const DJANGO_WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://127.0.0.1:8000/webhook/';

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
        // 🚨🚨 الحل الحاسم هنا: إضافة MESSAGE_EDIT ليتعرف عليها الجسر 🚨🚨
        // حالة التعديل (Edit)
        else if (proto.type === 'EDIT_MESSAGE' || proto.type === 'MESSAGE_EDIT' || proto.type === 14) {
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
    // تجاهل الرسائل الفارغة (إذا كانت رسالة جديدة فقط)
    if ((!body || body.trim().length === 0) && eventType === 'new_message') return;

    // تجهيز المعرفات للبايلود
    let finalMsgId = msg.key.id;
    let finalEventType = eventType;

    // 🔥 الخدعة الذكية: أثناء المزامنة، نحول التعديل إلى رسالة جديدة لكي يحفظها جانغو كفاتورة أصلية
    if (isSync && eventType === 'message_edit') {
        finalMsgId = targetMsgId || msg.key.id; 
        finalEventType = 'new_message'; 
        console.log(`🔄 [SYNC MAGIC] تم تحويل التعديل لرسالة أصلية برقم: ${finalMsgId}`);
    }

    if (isSync && finalEventType === 'new_message') {
        const timeStr = new Date(msg.messageTimestamp * 1000).toLocaleString('en-US', {timeZone: 'Asia/Damascus', hour12: false});
        console.log(`✅ [SYNC] ${timeStr} | ${body.substring(0, 40)}...`);
    }

    // تجهيز البايلود الشامل لضمان وصول كل التفاصيل لـ Django
    let payload = {
        event_type: finalEventType, 
        target_message_id: targetMsgId, 
        is_sync: isSync, 
        whatsapp_message_id: finalMsgId, 
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

    // === 📸 كاميرا مراقبة رسائل التعديل (في الجسر) ===
    if (eventType === 'message_edit' && !isSync) {
        console.log(`\n✏️✏️✏️ [BRIDGE -> DJANGO] إرسال رسالة تعديل ✏️✏️✏️`);
        console.log(`- رقم حدث التعديل: ${msg.key.id}`);
        console.log(`- رقم الرسالة الأصلية (Target): ${targetMsgId}`);
        console.log(`- هل هي من المزامنة؟: ${isSync}`);
        console.log(`- النص الجديد: ${body.substring(0, 60)}...`);
        console.log(`✏️✏️✏️✏️✏️✏️✏️✏️✏️✏️✏️✏️✏️✏️✏️✏️✏️✏️✏️\n`);
    }
    // ===============================================
    
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
// أ) المزامنة القسرية (النسخة النهائية والمحصنة - Diamond Edition)
// أ) المزامنة القسرية (النسخة النهائية والمحصنة - V12 Diamond Edition)
// أ) المزامنة القسرية (النسخة النهائية والمحصنة - V12 Diamond Edition مع محرك التشخيص الزمني)
app.post('/force-sync', async (req, res) => {
    // 1. استلام كل الصيغ المحتملة للتواريخ (القديمة من السيلري والحديثة من الواجهة)
    const { phone, limit, start_ts, end_ts, startDate, endDate } = req.body;
    
    // 🔥 بناء التوقيت الآمن (المترجم المزدوج للثواني المطلقة) 🔥
    let safeStartTs = null;
    let safeEndTs = null;

    if (start_ts && end_ts) {
        // إذا استلمنا ثواني مطلقة من الواجهة الجديدة
        safeStartTs = Number(start_ts);
        safeEndTs = Number(end_ts);
    } else if (startDate) {
        // إذا استلمنا نصوصاً من السيلري أو المهام المجدولة (نفرض توقيت دمشق إجبارياً)
        const startD = new Date(`${startDate}T00:00:00+03:00`);
        safeStartTs = Math.floor(startD.getTime() / 1000);
        
        if (endDate) {
            const endD = new Date(`${endDate}T23:59:59+03:00`);
            safeEndTs = Math.floor(endD.getTime() / 1000);
        } else {
            safeEndTs = Math.floor(Date.now() / 1000); 
        }
    }
    
    // ==============================================================
    // 🕵️‍♂️ [TIME X-RAY] أشعة سينية للزمن لمعرفة أين تضيع الفواتير 
    // ==============================================================
    const formatTime = (ts) => ts ? new Date(ts * 1000).toLocaleString('en-US', {timeZone: 'Asia/Damascus', hour12: false}) : 'N/A';
    
    console.log(`\n` + `⏳`.repeat(20));
    console.log(`🎯 [SYNC COMMAND RECEIVED]`);
    console.log(`   ➡️ Start Target: ${safeStartTs} => (${formatTime(safeStartTs)})`);
    console.log(`   ➡️ End Target:   ${safeEndTs} => (${formatTime(safeEndTs)})`);
    // ==============================================================
    
    try {
        const jid = getJid(phone);
        const messages = store.messages[jid]; 

        const totalAvailable = messages ? messages.length : 0;
        
        if (!messages || totalAvailable === 0) {
            console.log(`   ❌ RAM is Empty for this group.`);
            return res.json({ status: "empty", message: "الأرشيف فارغ في الذاكرة." });
        }

        // جلب توقيت أول وآخر رسالة في الذاكرة لفحص الانحراف
        let firstMsgTs = messages[0]?.messageTimestamp;
        let lastMsgTs = messages[messages.length - 1]?.messageTimestamp;
        let tFirst = typeof firstMsgTs === 'number' ? firstMsgTs : (firstMsgTs?.low || 0);
        let tLast = typeof lastMsgTs === 'number' ? lastMsgTs : (lastMsgTs?.low || 0);

        console.log(`   📊 RAM Contains: ${totalAvailable} Messages`);
        console.log(`   ⏮️ Oldest in RAM: ${tFirst} => (${formatTime(tFirst)})`);
        console.log(`   ⏭️ Newest in RAM: ${tLast} => (${formatTime(tLast)})`);
        console.log(`⏳`.repeat(20) + `\n`);

        // --- 🗑️ 2. بناء قائمة المحذوفات الشاملة (Blacklist) بصرامة ---
        const revokedIds = new Set();
        messages.forEach(msg => {
            // أ. صيد أوامر الحذف الصريحة (REVOKE)
            const proto = msg.message?.protocolMessage;
            if (proto && (proto.type === 'REVOKE' || proto.type === 0)) {
                if (proto.key && proto.key.id) revokedIds.add(proto.key.id);
            }
            // ب. صيد الأشباح المتخفية (StubType 68)
            if (msg.messageStubType === 68 && msg.key && msg.key.id) {
                revokedIds.add(msg.key.id);
            }
        });
        
        if (revokedIds.size > 0) {
            console.log(`🧹 [Smart Filter] Found ${revokedIds.size} deleted messages. They will be ignored.`);
        }

        // --- ⚙️ 3. الفلترة والتجهيز (The Core Engine) ---
        let skippedDueToTime = 0; 
        let editsChecked = 0;
        
        let msgsToSync = messages.filter(m => {
            // أ. استبعاد الأشباح والمحذوفات فوراً
            if (m.messageStubType === 68) return false;
            if (m.key && revokedIds.has(m.key.id)) return false;

            let isEdit = false;
            let targetId = null;
            let text = "";

            // 🚨 كاسحة الألغام: البحث عن التعديل في كل مسارات Baileys المحتملة 🚨
            const proto = m.message?.protocolMessage;
            const directEdit = m.message?.editedMessage; // بعض نسخ Baileys تضعها هنا مباشرة
            
            if (proto) {
                const pType = proto.type;
                // طباعة أي بروتوكول غريب لمعرفة كيف يخزن واتساب التعديلات
                if (pType !== 0 && pType !== 'REVOKE') {
                    console.log(`👽 [ALIEN PROTOCOL] Found Type: ${pType} | ID: ${m.key?.id}`);
                }

                if (pType === 14 || pType === 'EDIT_MESSAGE' || pType === 'MESSAGE_EDIT') {
                    isEdit = true;
                    targetId = proto.key?.id;
                    const editedMsg = proto.editedMessage;
                    if (editedMsg) {
                        text = editedMsg.conversation || editedMsg.extendedTextMessage?.text || editedMsg.imageMessage?.caption || "";
                    }
                } else {
                    return false; // بروتوكول آخر غير التعديل (يُرفض)
                }
            } else if (directEdit) {
                // حالة نادرة: التعديل مخزن مباشرة بدون بروتوكول
                isEdit = true;
                targetId = m.key?.id; // هنا يكون الـ ID هو نفسه
                text = directEdit.message?.protocolMessage?.editedMessage?.conversation || directEdit.conversation || "";
            } else {
                // رسالة عادية
                text = m.message?.conversation || 
                       m.message?.extendedTextMessage?.text || 
                       m.message?.imageMessage?.caption || "";
            }

            if (isEdit) {
                editsChecked++;
                console.log(`\n🔍 [EDIT FOUND] رسالة تعديل وُجدت! الأصل: ${targetId}`);
                console.log(`   - النص الجديد: "${text.substring(0, 30)}..."`);
            }
            
            // د. فلتر الطول (5 أحرف كما اتفقنا)
            if (!text || text.trim().length < 5) {
                if (isEdit) console.log(`   ❌ [DROP] رُفضت! النص فارغ.`);
                return false;
            }

            // هـ. الفلتر الزمني (المعدل لاصطياد التعديلات المتأخرة)
            if (safeStartTs && safeEndTs) {
                let msgTime = 0;
                if (typeof m.messageTimestamp === 'number') msgTime = m.messageTimestamp;
                else if (m.messageTimestamp && typeof m.messageTimestamp.low === 'number') msgTime = m.messageTimestamp.low;
                else if (m.messageTimestamp && typeof m.messageTimestamp.toString === 'function') msgTime = parseInt(m.messageTimestamp.toString(), 10);
                
                if (msgTime === 0 && m.message && m.message.messageContextInfo) {
                   let ctxTime = m.message.messageContextInfo.messageTimestamp;
                   if (typeof ctxTime === 'number') msgTime = ctxTime;
                   else if (ctxTime && typeof ctxTime.low === 'number') msgTime = ctxTime.low;
                }

                if (msgTime === 0) return false;

                const isInRange = msgTime >= safeStartTs && msgTime <= safeEndTs;
                
                if (!isInRange) {
                    skippedDueToTime++;
                    // ⚠️ إذا كان تعديلاً ووقع خارج النطاق، سنطبعه لنعرف كم تأخر!
                    if (isEdit) {
                        const timeStr = new Date(msgTime * 1000).toLocaleString('en-US', {timeZone: 'Asia/Damascus', hour12: false});
                        console.log(`   ❌ [DROP EDIT] رُفض التعديل بسبب الوقت! وقت التعديل: ${timeStr} | الحد المسموح: ${new Date(safeEndTs * 1000).toLocaleString('en-US', {timeZone: 'Asia/Damascus', hour12: false})}`);
                    }
                }

                return isInRange;
            }
            
            return true;
        });

        console.log(`   ✂️ Dropped due to Time Filter: ${skippedDueToTime} messages.`);
        console.log(`   ✏️ Total Edits Successfully Evaluated: ${editsChecked}`);

        // --- 📏 4. تطبيق حدود العدد (إذا لم يتم استخدام التاريخ) ---
        if (!safeStartTs) {
            const actualLimit = Number(limit) || 100;
            msgsToSync = msgsToSync.slice(-actualLimit);
        }

        const totalCount = msgsToSync.length;
        
        if (totalCount === 0) {
            return res.json({ 
                status: "skipped", 
                message: "لا توجد رسائل صالحة (قد تكون كلها محذوفة، نصوص قصيرة، أو خارج المجال الزمني)." 
            });
        }
        
        // إرسال الرد السريع للواجهة لفك تعليق زر التحميل
        res.json({ 
            status: "started", 
            message: `جاري معالجة ${totalCount} رسالة (بعد التصفية الدقيقة)...`, 
            target_id: jid 
        });

        // --- 🚀 5. التنفيذ في الخلفية (Non-blocking Queue) ---
        (async () => {
            console.log(`🔄 [Sync] Start sending ${totalCount} clean messages to Django...`);
            let successCount = 0;
            let failCount = 0;

            for (const msg of msgsToSync) {
                try {
                    // إرسال الرسالة إلى دالة المعالجة مع تفعيل الفلاج (isSync = true)
                    await processSingleMessage(msg, true);
                    successCount++;
                    // تأخير مدروس (10 ميلي ثانية) لمنع خنق شبكة السيرفر (DDoS الذاتي)
                    await delay(10); 
                } catch (err) { 
                    failCount++;
                    console.error(`⚠️ Sync msg error (ID: ${msg.key?.id}):`, err.message); 
                }
            }
            console.log(`✅ [Sync] Done. Success: ${successCount} | Failed: ${failCount}`);
        })();

    } catch (e) {
        console.error("🔥 Force Sync Critical Error:", e);
        if (!res.headersSent) {
            res.status(500).json({ error: e.message || "حدث خطأ داخلي في جسر الواتساب" });
        }
    }
});


// ج) الجرد بنظام "الفلاج" (Mark-and-Sweep Inventory)
app.post('/get-inventory', async (req, res) => {
    // استقبال كل الصيغ
    const { phone, startDate, endDate, start_ts, end_ts } = req.body;
    
    try {
        const jid = getJid(phone);
        const messages = store.messages[jid] || [];
        const cleanInvoiceIds = [];

        // 🔥 توحيد التوقيت (نفس محرك Force Sync)
        let safeStartTs = 0;
        let safeEndTs = Infinity;

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

        const revokedIds = new Set();
        messages.forEach(msg => {
            const proto = msg.message?.protocolMessage;
            if (proto && (proto.type === 'REVOKE' || proto.type === 0)) {
                if (proto.key && proto.key.id) revokedIds.add(proto.key.id);
            }
            if (msg.messageStubType === 68 && msg.key && msg.key.id) {
                revokedIds.add(msg.key.id);
            }
        });

        messages.forEach(msg => {
            if (msg.key && msg.key.id) {
                let msgTime = 0;
                if (typeof msg.messageTimestamp === 'number') {
                    msgTime = msg.messageTimestamp;
                } else if (msg.messageTimestamp && typeof msg.messageTimestamp.low === 'number') {
                    msgTime = msg.messageTimestamp.low;
                } else if (msg.messageTimestamp && typeof msg.messageTimestamp.toString === 'function') {
                    msgTime = parseInt(msg.messageTimestamp.toString(), 10);
                }

                if (msgTime >= safeStartTs && msgTime <= safeEndTs) {
                    const isProtocol = !!msg.message?.protocolMessage;
                    const isStubGhost = msg.messageStubType === 68;
                    
                    if (!isProtocol && !msg.key.fromMe && !isStubGhost && !revokedIds.has(msg.key.id)) {
                        const text = msg.message?.conversation || 
                                     msg.message?.extendedTextMessage?.text || 
                                     msg.message?.imageMessage?.caption || "";
                        
                        const isInvoiceLike = /فاتور|اجر|أجر|توصيل|تعويض|غرام|مخالف|كابتن|سائق|مندوب|منسق|كونترول|كنترول/i.test(text);
                        if (isInvoiceLike && text.length > 15) {
                            cleanInvoiceIds.push(msg.key.id.toUpperCase());
                        }
                    }
                }
            }
        });

        res.json({ status: "success", clean_ids: cleanInvoiceIds });

    } catch (error) {
        console.error("Inventory Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// 📡 دالة الاستطلاع (The Probe): تعيد النطاق الزمني الفعلي المتوفر في الرام
// 📡 دالة الاستطلاع (The Probe): تعيد النطاق الزمني الفعلي المتوفر في الرام
app.post('/check-inventory-range', async (req, res) => {
    const { phone, start_ts, end_ts } = req.body; 
    
    try {
        const jid = getJid(phone);
        const messages = store.messages[jid] || [];
        
        let minTs = Infinity;
        let maxTs = 0;
        let validCount = 0;

        messages.forEach(msg => {
            // 🔥🔥 محرك استخراج التوقيت الذكي (يدعم History Sync + Live) 🔥🔥
            let msgTime = 0;
            if (typeof msg.messageTimestamp === 'number') {
                msgTime = msg.messageTimestamp;
            } else if (msg.messageTimestamp && typeof msg.messageTimestamp.low === 'number') {
                msgTime = msg.messageTimestamp.low;
            } else if (msg.messageTimestamp && typeof msg.messageTimestamp.toString === 'function') {
                msgTime = parseInt(msg.messageTimestamp.toString(), 10);
            }
            
            // محاولة الملاذ الأخير: البحث داخل الكائن المتداخل
            if (msgTime === 0 && msg.message && msg.message.messageContextInfo) {
               let ctxTime = msg.message.messageContextInfo.messageTimestamp;
               if (typeof ctxTime === 'number') msgTime = ctxTime;
               else if (ctxTime && typeof ctxTime.low === 'number') msgTime = ctxTime.low;
            }

            // إذا التقطنا توقيتاً صالحاً
            if (msgTime > 0) {
                if (msgTime >= start_ts && msgTime <= end_ts && !msg.key.fromMe) {
                    const proto = msg.message?.protocolMessage;
                    const isRevoke = proto && (proto.type === 'REVOKE' || proto.type === 0);
                    const isStubGhost = msg.messageStubType === 68;

                    if (!isRevoke && !isStubGhost) {
                        if (msgTime < minTs) minTs = msgTime;
                        if (msgTime > maxTs) maxTs = msgTime;
                        validCount++;
                    }
                }
            }
        });

        if (validCount === 0) {
            // لمعرفة ماذا قرأ السيرفر كأول وأخر رسالة، مفيد للديباغ
            let realFirst = messages.length > 0 ? messages[0].messageTimestamp : "N/A";
            let realLast = messages.length > 0 ? messages[messages.length-1].messageTimestamp : "N/A";
            console.log(`⚠️ Check Range Failed. Wanted: ${start_ts}->${end_ts}. Have RAM limits: First:${JSON.stringify(realFirst)} Last:${JSON.stringify(realLast)}`);
            
            return res.json({ status: "empty", message: "لا توجد بيانات لهذا النطاق الزمني في ذاكرة الجسر" });
        }

        res.json({ 
            status: "success", 
            count: validCount,
            min_timestamp: minTs,
            max_timestamp: maxTs 
        });

    } catch (error) {
        console.error("Check Range Error:", error);
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
// 🔬 أداة البحث المجهري في الذاكرة (لكشف الرسائل المفقودة)
app.post('/search-ram', (req, res) => {
    const { search_text } = req.body;
    if (!search_text) return res.json({ error: "أرسل نصاً للبحث" });

    let found_messages = [];
    
    // البحث الشامل في كل المجموعات والرسائل في الذاكرة
    for (const jid in store.messages) {
        store.messages[jid].forEach(m => {
            const body = m.message?.conversation || 
                         m.message?.extendedTextMessage?.text || 
                         m.message?.imageMessage?.caption || "";
            
            if (body.includes(search_text)) {
                // استخراج التوقيت الفعلي للرسالة كما يراها السيرفر
                let msgTime = 0;
                if (typeof m.messageTimestamp === 'number') msgTime = m.messageTimestamp;
                else if (m.messageTimestamp?.low) msgTime = m.messageTimestamp.low;
                else if (m.messageTimestamp) msgTime = parseInt(m.messageTimestamp.toString(), 10);

                found_messages.push({
                    id: m.key?.id,
                    time_epoch: msgTime,
                    time_syria: msgTime ? new Date(msgTime * 1000).toLocaleString('en-US', {timeZone: 'Asia/Damascus'}) : 'N/A',
                    text: body.substring(0, 100) + "..."
                });
            }
        });
    }

    res.json({
        total_in_ram: Object.values(store.messages).reduce((acc, curr) => acc + curr.length, 0),
        found_count: found_messages.length,
        results: found_messages
    });
});
(async () => {
    await startWhatsApp();
    app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Bridge Running on ${PORT}`));
})();