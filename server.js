/**
 * TaxiHon WhatsApp Bridge - Baileys Ultimate Edition 🚀
 * Fixes: ERR_REQUIRE_ESM (Dynamic Import Implemented)
 */

import express from "express";
import axios from "axios";
import qrcodeTerminal from "qrcode-terminal";
import pino from "pino";

process.on("unhandledRejection", (r) => console.error("❌ UNHANDLED REJECTION:", r));
process.on("uncaughtException", (e) => console.error("❌ UNCAUGHT EXCEPTION:", e));

const app = express();
app.use(express.json({ limit: '50mb' }));

// --- الإعدادات ---
const PORT = process.env.PORT || 3000;
const DJANGO_WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://127.0.0.1:8000/webhook/';
const ADMIN_BOT_NUMBERS = ['963931698698', '963931697697'];

let sock;
let currentQrCode = null;
let isWaConnected = false;
let isStarting = false;

// --- 🔥 نظام الطابور (Queue System) 🔥 ---
let pendingQueue = [];
let isRetrying = false;

async function processQueue() {
    if (isRetrying || pendingQueue.length === 0) return;
    isRetrying = true;

    console.log(`🔄 [Queue] Retrying ${pendingQueue.length} messages...`);
    const currentBatch = [...pendingQueue];
    pendingQueue = [];

    // إرسال متوازي لزيادة السرعة
    await Promise.all(currentBatch.map(async (item) => {
        try {
            await axios.post(DJANGO_WEBHOOK_URL, item.payload, { timeout: 5000 });
            console.log(`✅ [Recovered] ${item.payload.whatsapp_message_id} sent.`);
        } catch (error) {
            pendingQueue.push(item); // فشل؟ أعده للطابور
        }
    }));

    isRetrying = false;
    if (pendingQueue.length > 0) setTimeout(processQueue, 5000);
}

async function sendToDjango(payload, msgKey = null) {
  try {
    const response = await axios.post(DJANGO_WEBHOOK_URL, payload, {
      timeout: 10000,
      headers: { "Content-Type": "application/json" },
      validateStatus: () => true, // مهم جداً
    });

    // نجاح
    if (response.status >= 200 && response.status < 300) {
      if (response.data?.reaction && msgKey) {
        await executeSmartReaction(
          msgKey.remoteJid,
          msgKey.id,
          response.data.reaction,
          msgKey.participant
        );
      }
      return;
    }

    // ❌ جانغو رد بس فيه خطأ
    console.error(
      `❌ [DJANGO ERROR] HTTP ${response.status}`,
      JSON.stringify(response.data)
    );
    return;

  } catch (error) {
    // ❌ خطأ شبكة حقيقي
    console.error("❌ [NETWORK ERROR]", {
      message: error.message,
      code: error.code,
      url: DJANGO_WEBHOOK_URL,
    });

    pendingQueue.push({ payload });
    if (!isRetrying) setTimeout(processQueue, 5000);
  }
}


// --- 🛠️ أدوات المعرفات (JID Helper) ---
const getJid = (number) => {
    if (!number) return null;
    let clean = String(number).replace(/\D/g, '');

    if (String(number).includes('@')) return number;
    if (clean.length < 5) return null;

    // 1. المجموعات
    if (clean.length >= 18 && clean.startsWith('1203')) return `${clean}@g.us`;

    // 2. LIDs (تصحيح الطول ليشمل 15 خانة)
    if (clean.length >= 15 && !clean.startsWith('963')) return `${clean}@lid`;

    // 3. أرقام عادية
    if (clean.startsWith('09')) clean = '963' + clean.substring(1);

    return `${clean}@s.whatsapp.net`;
};

function cleanId(jid) {
    if (!jid) return null;
    return jid.split('@')[0].split(':')[0];
}

// --- 🚀 تشغيل الواتساب (Baileys Engine) ---
async function startWhatsApp() {
    // ✅ قفل يمنع تشغيل startWhatsApp مرتين بنفس الوقت
    if (isStarting) {
        console.log("⏳ startWhatsApp skipped (already starting)...");
        return;
    }
    isStarting = true;

    try {
        // 🔥 التعديل هنا: استيراد ديناميكي (Dynamic Import) لحل مشكلة ESM
        const {
            default: makeWASocket,
            useMultiFileAuthState,
            DisconnectReason,
            fetchLatestBaileysVersion,
            downloadMediaMessage
        } = await import('@whiskeysockets/baileys');

        const { Boom } = await import('@hapi/boom');

        const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
        const { version } = await fetchLatestBaileysVersion();

        console.log(`⏳ Starting WhatsApp Client (v${version.join('.')})...`);

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false, // سنطبعه يدوياً
            logger: pino({ level: 'silent' }),
            browser: ["TaxiHon", "Chrome", "1.0.0"],
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            retryRequestDelayMs: 2000,
            markOnlineOnConnect: true
        });

        sock.ev.on('creds.update', saveCreds);

        // إدارة الاتصال
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            isWaConnected = connection === 'open';

            if (qr) {
                currentQrCode = qr;
                qrcodeTerminal.generate(qr, { small: true });
                console.log(`🔗 QR URL: http://localhost:${PORT}/qr-code`);
            }

            if (connection === 'close') {
                // ✅ حماية: lastDisconnect قد يكون undefined
                const err = lastDisconnect?.error;

                const shouldReconnect = (err instanceof Boom)
                    ? err.output.statusCode !== DisconnectReason.loggedOut
                    : true;

                console.error(`❌ Disconnected! Reconnecting: ${shouldReconnect}`);

                if (shouldReconnect) {
                    // ✅ مهم جداً: فك القفل قبل إعادة التشغيل
                    isStarting = false;
                    startWhatsApp();
                } else {
                    // Logged out: خلي القفل مفكوك حتى تقدر تعمل start لاحقاً بعد تنظيف auth مثلاً
                    isStarting = false;
                }
            } else if (connection === 'open') {
                console.log('✅ WhatsApp Bridge Ready!');
                currentQrCode = null;

                // ✅ نجاح: فك القفل
                isStarting = false;

                if (pendingQueue.length > 0) processQueue();
            }
        });

        // استقبال الرسائل
        // استقبال الرسائل
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            console.log("📩 Raw Message Received:", JSON.stringify(messages[0].key, null, 2));
            if (type !== 'notify') return;

            for (const msg of messages) {
                try {
                    if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') continue;

                    // --- استخراج البيانات الأساسية ---
                    const remoteJid = msg.key.remoteJid;
                    const isGroup = remoteJid.endsWith('@g.us');
                    const senderId = cleanId(remoteJid);
                    const participantFull = msg.key.participant || null;
                    const authorId = participantFull ? cleanId(participantFull) : null;

                    // فلترة البوتات والأدمن
                    if (ADMIN_BOT_NUMBERS.includes(senderId) || (authorId && ADMIN_BOT_NUMBERS.includes(authorId))) continue;

                    // ============================================================
                    // 1. معالجة التعديل والحذف (Protocol Messages) 🛠️
                    // ============================================================
                    if (msg.message?.protocolMessage) {
                        const protocolMsg = msg.message.protocolMessage;
                        const originalId = protocolMsg.key?.id; // 🔥 هذا هو المفتاح: آيدي الرسالة الأصلية

                        // أ) حالة التعديل (EDIT - Type 14)
                        if (protocolMsg.type === 14) {
                            const newText = protocolMsg.editedMessage?.conversation || 
                                          protocolMsg.editedMessage?.extendedTextMessage?.text || "";
                            
                            console.log(`✏️ [EDIT DETECTED] Target ID: ${originalId}`);
                            
                            await sendToDjango({
                                event_type: 'message_edit',
                                whatsapp_message_id: msg.key.id, // آيدي حدث التعديل نفسه
                                target_message_id: originalId,   // 🔥 آيدي الرسالة التي نريد تعديلها
                                message_text: newText,
                                sender_id: senderId,
                                group_id: isGroup ? remoteJid : null,
                                is_group: isGroup
                            }, msg.key);
                            continue; // انتهينا من التعديل
                        }
                        
                        // ب) حالة الحذف (REVOKE - Type 0)
                        if (protocolMsg.type === 0) {
                            console.log(`🗑️ [REVOKE DETECTED] Target ID: ${originalId}`);
                            
                            await sendToDjango({
                                event_type: 'message_revoke',
                                whatsapp_message_id: msg.key.id, 
                                target_message_id: originalId,   // 🔥 آيدي الرسالة التي نريد حذفها
                                sender_id: senderId,
                                group_id: isGroup ? remoteJid : null,
                                is_group: isGroup
                            }, null); 
                            continue; // انتهينا من الحذف
                        }
                    }

                    // ============================================================
                    // 2. معالجة الرسائل الجديدة (New Messages) 📩
                    // ============================================================
                    const messageContent = msg.message;
                    if (!messageContent) continue;

                    // 🔥🔥 (جديد) إعطاء الساعة الرملية فوراً لطمأنة المستخدم 🔥🔥
                    await sock.sendMessage(remoteJid, { 
                        react: { text: '⏳', key: msg.key } 
                    });

                    // تحديد النوع والنص
                    const msgType = Object.keys(messageContent)[0];
                    let body = messageContent.conversation ||
                        messageContent.extendedTextMessage?.text ||
                        messageContent.imageMessage?.caption || "";

                    // --- 🎨 اللوج ---
                    const typeIcon = (msgType === 'audioMessage' || msgType === 'pttMessage') ? '🎤' : (msgType === 'imageMessage' ? '🖼️' : '📄');
                    const lidTag = (participantFull && participantFull.includes('lid')) ? '(LID)' : '';

                    if (isGroup) {
                        console.log(`📢 [GP] ${senderId} | 👤 ${authorId} ${lidTag} | ${typeIcon}`);
                    } else {
                        console.log(`📩 [DM] ${senderId} | ${typeIcon}`);
                    }

                    // بناء البايلود
                    let payload = {
                        event_type: 'new_message',
                        whatsapp_message_id: msg.key.id,
                        sender_id: senderId,
                        group_id: isGroup ? remoteJid : null,
                        author_id: authorId,
                        participant_raw: participantFull,
                        is_group: isGroup,
                        message_text: body,
                        has_media: false
                    };

                    // معالجة الموقع
                    if (msgType === 'locationMessage') {
                        const loc = messageContent.locationMessage;
                        payload.location = { lat: loc.degreesLatitude, lng: loc.degreesLongitude };
                        payload.message_text = `GPS: ${loc.degreesLatitude},${loc.degreesLongitude}`;
                    }

                    // معالجة الميديا
                    if (['imageMessage', 'audioMessage', 'videoMessage'].includes(msgType)) {
                        try {
                            const buffer = await downloadMediaMessage(
                                msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                            );
                            if (buffer) {
                                payload.has_media = true;
                                payload.media_data = buffer.toString('base64');
                                payload.media_type = msgType === 'audioMessage' ? 'audio/ogg' : 'image/jpeg';
                                if (msgType === 'audioMessage') payload.message_text = "";
                            }
                        } catch (e) { console.error('⚠️ Media Download Skipped'); }
                    }

                    sendToDjango(payload, msg.key);

                } catch (err) {
                    console.error("Processing Error:", err.message);
                }
            }
        });

    } catch (err) {
        console.error("❌ startWhatsApp failed:", err?.message || err);
        // ✅ فشل بدء التشغيل: فك القفل
        isStarting = false;
    }
}

// --- 🔥 دالة الرياكشن الذكية (Smart Reaction Engine) 🔥 ---
async function executeSmartReaction(chatId, messageId, reaction, participant = null) {
    if (!sock) return;

    const targetChatId = getJid(chatId);

    const key = {
        remoteJid: targetChatId,
        id: messageId,
        fromMe: false
    };

    if (targetChatId.endsWith('@g.us')) {
        if (participant) {
            key.participant = getJid(participant);
        } else {
            console.warn(`⚠️ [Reaction Warning] Missing participant for group msg ${messageId}. Reaction might fail.`);
        }
    }

    try {
        console.log(`🔍 [Reacting] ${cleanId(targetChatId)} -> Msg: ${messageId} | User: ${cleanId(key.participant) || 'Direct'}`);
        await sock.sendMessage(targetChatId, {
            react: { text: reaction || '✅', key: key }
        });
        console.log(`✅ [REACT DONE]`);
    } catch (e) {
        console.error(`❌ [REACT FAILED] ${e.message}`);
    }
}

// --- API Endpoints ---

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get('/qr-code', (req, res) => {
    if (currentQrCode) {
        const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(currentQrCode)}`;
        res.send(`<html><body style="text-align:center;"><img src="${url}"/><br>Scan me!</body></html>`);
    } else {
        res.send("✅ Connected");
    }
});

app.post('/send-message', async (req, res) => {
    const { phone, message, reply_id } = req.body;

    if (!message) return res.status(400).json({ error: "No message" });
    if (!isWaConnected) return res.status(503).json({ error: "WhatsApp disconnected" });
    if (!sock) return res.status(503).json({ error: "WhatsApp not initialized" });

    try {
        const chatId = reply_id ? getJid(reply_id) : getJid(phone);
        console.log(`📤 [SEND] To: ${cleanId(chatId)}`);
        await sock.sendMessage(chatId, { text: message });
        res.json({ status: 'success' });
    } catch (e) {
        console.error(`❌ Send Error: ${e.message}`);
        res.status(500).json({ status: 'error', error: e.message });
    }
});

app.post('/send-reaction', async (req, res) => {
    const { chat_id, message_id, reaction, participant } = req.body;

    if (!chat_id || !message_id) return res.status(400).json({ error: "Missing fields" });
    if (!isWaConnected) return res.status(503).json({ error: "WhatsApp disconnected" });
    if (!sock) return res.status(503).json({ error: "WhatsApp not initialized" });

    res.json({ status: 'queued' });
    executeSmartReaction(chat_id, message_id, reaction, participant);
});

app.post('/kick-member', async (req, res) => {
    const { group_id, phone, target_lid } = req.body;
    try {
        const groupJid = getJid(group_id);
        const targetJid = target_lid ? getJid(target_lid) : getJid(phone);

        if (groupJid && targetJid) {
            console.log(`🔨 [KICK] ${cleanId(targetJid)} from ${cleanId(groupJid)}`);
            await sock.groupParticipantsUpdate(groupJid, [targetJid], "remove");
            res.json({ status: 'success' });
        } else {
            res.status(400).json({ error: "Invalid IDs" });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// تشغيل السيرفر
startWhatsApp();
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Baileys Bridge Running on 0.0.0.0:${PORT}`));

/**
 * TaxiHon WhatsApp Bridge - Baileys Replica Version
 * Features:
 * - Exact Match of server.js Logic & Logging
 * - Retry Queue (Offline Support)
 * - LIDs Handling & Detection
 * - Auto-Reactions & Edits/Deletes Handling
 * - Group Info Extraction
  */

// process.on('unhandledRejection', (r) => console.error('❌ UNHANDLED REJECTION:', r));
// process.on('uncaughtException', (e) => console.error('❌ UNCAUGHT EXCEPTION:', e));

// const express = require('express');
// const axios = require('axios');
// const qrcodeTerminal = require('qrcode-terminal');
// const pino = require('pino');
// const fs = require('fs');

// const app = express();
// app.use(express.json({ limit: '50mb' }));

// // إعداد البورت والرابط من البيئة
// const PORT = process.env.PORT || 3000;
// const DJANGO_WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://127.0.0.1:8000/webhook/';
// const ADMIN_BOT_NUMBERS = ['963931698698', '963931697697'];

// // متغيرات عامة
// let sock;
// let currentQrCode = null;

// // --- 🔥 نظام الطابور (Retry Queue) - مطابق للقديم تماماً ---
// let pendingQueue = [];
// let isRetrying = false;

// async function processQueue() {
//     if (isRetrying || pendingQueue.length === 0) return;
//     isRetrying = true;

//     console.log(`🔄 [Queue] Attempting to resend ${pendingQueue.length} pending messages...`);
//     const currentBatch = [...pendingQueue];
//     pendingQueue = [];

//     for (const item of currentBatch) {
//         try {
//             await axios.post(DJANGO_WEBHOOK_URL, item.payload);
//             console.log(`✅ [Recovered] Message from ${item.payload.sender_id} sent to Django.`);
//         } catch (error) {
//             console.warn(`⚠️ [Queue] Retry failed, requeuing...`);
//             pendingQueue.push(item);
//         }
//     }
//     isRetrying = false;
//     if (pendingQueue.length > 0) setTimeout(processQueue, 10000);
// }

// async function sendToDjango(payload, msgKey = null) {
//     try {
//         const response = await axios.post(DJANGO_WEBHOOK_URL, payload);
        
//         // إذا طلب جانغو رياكشن في الرد المباشر
//         if (response.data && response.data.reaction && msgKey) {
//             try { 
//                 await sock.sendMessage(msgKey.remoteJid, { react: { text: response.data.reaction, key: msgKey } }); 
//             } catch (e) {}
//         }

//         if (pendingQueue.length > 0) processQueue();
//     } catch (error) {
//         console.error(`❌ [Django Offline] Queuing message...`);
//         pendingQueue.push({ payload });
//         if (!isRetrying) setTimeout(processQueue, 10000);
//     }
// }

// // --- أدوات مساعدة ---
// function cleanId(id) {
//     if (!id) return null;
//     return id.replace('@c.us', '').replace('@s.whatsapp.net', '').replace('@g.us', '').split(':')[0];
// }

// const getJid = (number) => {
//     if (!number) return null;
//     let clean = String(number).replace(/\D/g, '');
//     if (clean.startsWith('09')) clean = '963' + clean.substring(1);
//     // إذا الرقم طويل جداً فهو غالباً LID أو مجموعة، وإلا فهو رقم عادي
//     return clean.length > 15 && !clean.includes('@') ? `${clean}@g.us` : (clean.includes('@') ? clean : `${clean}@s.whatsapp.net`);
// };

// // --- 🚀 المحرك الرئيسي (Baileys) ---
// async function startWhatsApp() {
//     // استيراد ديناميكي لتجنب مشاكل ESM
//     const { 
//         default: makeWASocket, 
//         useMultiFileAuthState, 
//         DisconnectReason, 
//         fetchLatestBaileysVersion,
//         downloadMediaMessage,
//         jidNormalizedUser,
//         proto
//     } = await import('@whiskeysockets/baileys');
//     const { Boom } = await import('@hapi/boom');

//     const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
//     const { version } = await fetchLatestBaileysVersion();

//     console.log("⏳ Starting WhatsApp Client...");

//     sock = makeWASocket({
//         version,
//         auth: state,
//         printQRInTerminal: false, // سنطبع الـ QR يدوياً ليتطابق مع القديم
//         logger: pino({ level: 'silent' }),
//         browser: ["TaxiHon Bridge", "Chrome", "1.0.0"],
//         syncFullHistory: false // لتسريع الإقلاع
//     });

//     sock.ev.on('creds.update', saveCreds);

//     // --- أحداث الاتصال ---
//     sock.ev.on('connection.update', (update) => {
//         const { connection, lastDisconnect, qr } = update;
        
//         if (qr) {
//             currentQrCode = qr;
//             qrcodeTerminal.generate(qr, { small: true });
//             console.log('--------------------------------------------------');
//             console.log('⚠️ **SCAN REQUIRED** ⚠️');
//             console.log(`🔗 Open this URL in your browser to scan: http://localhost:${PORT}/qr-code`);
//             console.log('--------------------------------------------------');
//         }
        
//         if (connection === 'close') {
//             const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
//                 lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
//             console.error(`❌ Disconnected! Reason: ${lastDisconnect.error}. Waiting for reconnection...`);
//             if (shouldReconnect) startWhatsApp();
//         } else if (connection === 'open') {
//             console.log('✅ WhatsApp Bridge Ready & Connected!');
//             currentQrCode = null;
//             console.log(`🚀 API Listening on http://localhost:${PORT}`);
//             if (pendingQueue.length > 0) processQueue();
//         }
//     });

//     // --- معالجة الرسائل والأحداث ---
//     sock.ev.on('messages.upsert', async ({ messages, type }) => {
//         if (type !== 'notify') return;

//         for (const msg of messages) {
//             try {
//                 // تجاهل رسائل البوت نفسه والستوري
//                 if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') continue;

//                 // --- معالجة التعديل والحذف (Protocol Messages) ---
//                 // Baileys يرسل التعديل والحذف كرسائل من نوع protocolMessage
//                 const protocolMsg = msg.message?.protocolMessage;
//                 if (protocolMsg) {
//                     // 1. حالة التعديل (EDIT)
//                     if (protocolMsg.type === 14) { // REVOKE = 0, EPHEMERAL = 3, EDIT = 14
//                         const originalId = protocolMsg.key.id;
//                         const newText = protocolMsg.editedMessage?.conversation || protocolMsg.editedMessage?.extendedTextMessage?.text || "";
                        
//                         console.log(`✏️ [EDIT] From ${cleanId(msg.key.participant || msg.key.remoteJid)}`);
//                         await sendToDjango({
//                             event_type: 'message_edit',
//                             whatsapp_message_id: originalId,
//                             message_text: newText,
//                             sender_id: cleanId(msg.key.remoteJid),
//                             is_group: msg.key.remoteJid.endsWith('@g.us')
//                         }, msg.key);
//                         continue;
//                     }
                    
//                     // 2. حالة الحذف (REVOKE)
//                     if (protocolMsg.type === 0) {
//                         console.log(`🗑️ [REVOKE] Message deleted`);
//                         await sendToDjango({
//                             event_type: 'message_revoke',
//                             whatsapp_message_id: protocolMsg.key.id
//                         }, null);
//                         continue;
//                     }
//                 }

//                 // --- معالجة الرسائل العادية ---
//                 if (!msg.message) continue;

//                 const senderFullId = msg.key.remoteJid;
//                 const isGroup = senderFullId.endsWith('@g.us');
//                 let chatNumber = cleanId(senderFullId);
//                 let authorNumber = msg.key.participant ? cleanId(msg.key.participant) : null;

//                 // فلترة أرقام الأدمن
//                 if (ADMIN_BOT_NUMBERS.includes(chatNumber) || (authorNumber && ADMIN_BOT_NUMBERS.includes(authorNumber))) continue;

//                 // استخراج بيانات المجموعة (الاسم)
//                 let groupName = null;
//                 let groupId = null;

//                 if (isGroup) {
//                     groupId = chatNumber;
//                     try {
//                         // نحاول جلب الاسم من الكاش أو الشبكة
//                         const groupMetadata = await sock.groupMetadata(senderFullId);
//                         groupName = groupMetadata.subject;
//                         console.log(`🔍 [GROUP] "${groupName}" | ID: ${groupId}`);
//                     } catch (e) { groupName = "Unknown"; }
//                 }

//                 // استخراج النص والميديا
//                 const messageType = Object.keys(msg.message)[0];
//                 let contentBody = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
                
//                 // لوج مطابق للقديم
//                 const typeIcon = (messageType === 'audioMessage' || messageType === 'pttMessage') ? '🎤' : (messageType === 'imageMessage' ? '🖼️' : '📄');
//                 const logContent = contentBody.substring(0, 30).replace(/\n/g, ' ');

//                 if (isGroup) {
//                     console.log(`📢 [GP: ${groupName}] ${groupId} | 👤 ${authorNumber} | ${typeIcon} "${logContent}..."`);
//                 } else {
//                     console.log(`📩 [DM] ${chatNumber} | ${typeIcon} "${logContent}..."`);
//                 }

//                 let payload = {
//                     event_type: 'new_message',
//                     whatsapp_message_id: msg.key.id,
//                     sender_id: chatNumber,
//                     author_id: authorNumber,
//                     reply_to_id: senderFullId,
//                     is_group: isGroup,
//                     group_name: groupName,
//                     group_id: groupId,
//                     type: messageType,
//                     message_text: contentBody,
//                     has_media: false
//                 };

//                 // معالجة الموقع
//                 if (messageType === 'locationMessage') {
//                     const loc = msg.message.locationMessage;
//                     payload.location = { lat: loc.degreesLatitude, lng: loc.degreesLongitude };
//                     payload.message_text = `GPS: ${loc.degreesLatitude},${loc.degreesLongitude}`;
//                 }
                
//                 // معالجة الميديا (تحميلها وإرسالها base64)
//                 const isMedia = messageType === 'imageMessage' || messageType === 'audioMessage' || messageType === 'videoMessage' || messageType === 'stickerMessage';
//                 if (isMedia) {
//                     try {
//                         const buffer = await downloadMediaMessage(
//                             msg,
//                             'buffer',
//                             { },
//                             { 
//                                 logger: pino({ level: 'silent' }),
//                                 reuploadRequest: sock.updateMediaMessage
//                             }
//                         );
//                         if (buffer) {
//                             payload.has_media = true;
//                             payload.media_data = buffer.toString('base64');
                            
//                             // تحديد النوع التقريبي
//                             if (messageType === 'imageMessage') payload.media_type = 'image/jpeg';
//                             else if (messageType === 'audioMessage') payload.media_type = 'audio/ogg'; // واتساب يستخدم ogg غالباً
//                             else if (messageType === 'videoMessage') payload.media_type = 'video/mp4';
                            
//                             if (messageType === 'audioMessage' || messageType === 'pttMessage') payload.message_text = "";
//                         }
//                     } catch (e) { console.error('Media Error:', e.message); }
//                 }

//                 await sendToDjango(payload, msg.key);

//             } catch (err) {
//                 console.error("Error processing message:", err);
//             }
//         }
//     });
// }

// // --- API Endpoints ---

// // 1. فحص الصحة
// app.get("/health", (req, res) => res.json({ status: "ok", service: "wa-bridge", uptime: process.uptime() }));

// // 2. عرض الرمز
// app.get('/qr-code', (req, res) => {
//     if (currentQrCode) {
//         const qrCodeDataUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(currentQrCode)}`;
//         res.send(`
//             <!DOCTYPE html>
//             <html>
//             <head><title>WhatsApp Scan</title></head>
//             <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
//                 <h1>⚠️ WhatsApp Scan Required</h1>
//                 <p>Please scan this code using WhatsApp Settings -> Linked Devices.</p>
//                 <img src="${qrCodeDataUrl}" alt="QR Code" style="border: 1px solid #ccc; padding: 10px;"/>
//                 <p>Status: Scanning... Last Checked: ${new Date().toLocaleTimeString()}</p>
//                 <script>setTimeout(() => window.location.reload(), 5000);</script>
//             </body>
//             </html>
//         `);
//     } else {
//         res.status(200).send("✅ Bridge Connected. QR code not needed.");
//     }
// });

// // 3. الطرد (LID Support)
// app.post('/kick-member', async (req, res) => {
//     const { group_id, phone, target_lid } = req.body;
//     if (!group_id) return res.status(400).json({ error: "Missing group_id" });

//     try {
//         // تنسيق معرف المجموعة
//         let chatGroupId = group_id.includes('@g.us') ? group_id : `${group_id}@g.us`;
//         let idToRemove = null;

//         // تحديد الهدف (الأولوية للـ LID)
//         if (target_lid) {
//             idToRemove = getJid(target_lid);
//             console.log(`🎯 [KICK FAST] Using LID: ${idToRemove}`);
//         } else if (phone) {
//             idToRemove = getJid(phone);
//         }

//         if (idToRemove) {
//             // تنفيذ الطرد في Baileys
//             await sock.groupParticipantsUpdate(chatGroupId, [idToRemove], "remove");
//             console.log(`👋 [KICK SUCCESS] Removed ${idToRemove}`);
//             res.json({ status: 'success' });
//         } else {
//             res.status(404).json({ error: "User ID could not be determined" });
//         }
//     } catch (e) {
//         console.error(`❌ Kick Error: ${e.message}`);
//         res.status(500).json({ error: e.message });
//     }
// });

// // 4. إرسال رسالة (مع LID Support)
// app.post('/send-message', async (req, res) => {
//     const { phone, message, reply_id } = req.body;
//     if (!message) return res.status(400).json({ error: "No message" });

//     try {
//         let chatId = reply_id;

//         if (!chatId) {
//             chatId = getJid(phone);
            
//             // تحقق بسيط (في Baileys يمكننا التأكد من وجود الرقم عبر onWhatsApp)
//             const exists = await sock.onWhatsApp(chatId);
//             if (!exists || exists.length === 0) {
//                  console.log(`❌ [SEND] Number not on WhatsApp: ${chatId}`);
//                  // ملاحظة: نكمل الإرسال أحياناً لأن الفحص قد يفشل مع المجموعات
//             }
//         }

//         console.log(`⏳ [SEND] To: ${chatId}`);
//         await sock.sendMessage(chatId, { text: message });

//         console.log(`📤 [SENT] Success`);
//         return res.json({ status: 'success' });

//     } catch (e) {
//         console.error(`❌ Send Error (Ignored): ${e?.message || e}`);
//         return res.json({ status: 'success', note: 'Sent with potential error' });
//     }
// });

// // 5. إرسال الرياكشن
// app.post('/send-reaction', async (req, res) => {
//     const { chat_id, message_id, reaction } = req.body;

//     console.log(`📥 [REACTION REQUEST] Msg: ${message_id} | Chat: ${chat_id}`);

//     if (!chat_id || !message_id) {
//         return res.status(400).json({ error: "Missing chat_id or message_id" });
//     }

//     try {
//         let targetChatId = getJid(chat_id);
//         console.log(`🔍 Sending Reaction to: ${targetChatId}`);

//         // في Baileys الرياكشن هو رسالة خاصة تحتوي على المفتاح
//         await sock.sendMessage(targetChatId, {
//             react: {
//                 text: reaction || '✅',
//                 key: { remoteJid: targetChatId, id: message_id, fromMe: false } // نفترض أن الرسالة ليست منا
//             }
//         });

//         console.log(`✅ [REACTION SUCCESS] Added to ${message_id}`);
//         res.json({ status: 'success' });

//     } catch (e) {
//         console.error(`❌ Reaction Error: ${e.message}`);
//         res.status(500).json({ error: e.message });
//     }
// });

// // تشغيل التطبيق
// startWhatsApp();
// app.listen(PORT, () => console.log(`🚀 Bridge on ${PORT}`));
