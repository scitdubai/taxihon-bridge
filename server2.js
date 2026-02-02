/**
 * TaxiHon WhatsApp Bridge - Ultimate Resilient Version
 * Features: 
 * - Retry Queue (Offline Support)
 * - LIDs Handling & Detection
 * - Auto-Reactions (Fixed)
 * - Group Info Extraction
 * - Robust Sending logic & QR Code for Server
 */
process.on('unhandledRejection', (r) => console.error('❌ UNHANDLED REJECTION:', r));
process.on('uncaughtException', (e) => console.error('❌ UNCAUGHT EXCEPTION:', e));

const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json({ limit: '50mb' }));

// إعداد البورت والرابط من البيئة
const PORT = process.env.PORT || 3000;
const DJANGO_WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://127.0.0.1:8000/webhook/';
const ADMIN_BOT_NUMBERS = ['963931698698', '963931697697'];

// متغير للـ QR
let currentQrCode = null;

// --- 🔥 نظام الطابور (Retry Queue) ---
let pendingQueue = [];
let isRetrying = false;

async function processQueue() {
    if (isRetrying || pendingQueue.length === 0) return;
    isRetrying = true;

    console.log(`🔄 [Queue] Attempting to resend ${pendingQueue.length} pending messages...`);
    const currentBatch = [...pendingQueue];
    pendingQueue = [];

    for (const item of currentBatch) {
        try {
            await axios.post(DJANGO_WEBHOOK_URL, item.payload);
            console.log(`✅ [Recovered] Message from ${item.payload.sender_id} sent to Django.`);
        } catch (error) {
            console.warn(`⚠️ [Queue] Retry failed, requeuing...`);
            pendingQueue.push(item);
        }
    }
    isRetrying = false;
    if (pendingQueue.length > 0) setTimeout(processQueue, 10000);
}

async function sendToDjango(payload, originalMsg) {
    try {
        const response = await axios.post(DJANGO_WEBHOOK_URL, payload);
        
        // إذا طلب جانغو رياكشن في الرد المباشر (للحالات الخفيفة)
        if (response.data && response.data.reaction && originalMsg) {
            try { await originalMsg.react(response.data.reaction); } catch (e) {}
        }

        if (pendingQueue.length > 0) processQueue();
    } catch (error) {
        console.error(`❌ [Django Offline] Queuing message...`);
        pendingQueue.push({ payload, originalMsg });
        if (!isRetrying) setTimeout(processQueue, 10000);
    }
}

// --- إعداد العميل ---
// const client = new Client({
//     authStrategy: new LocalAuth(),
//     puppeteer: { 
//         headless: true,
//         args: [
//             '--no-sandbox', 
//             '--disable-setuid-sandbox', 
//             '--disable-dev-shm-usage',
//             '--disable-accelerated-2d-canvas',
//             '--no-first-run',
//             '--no-zygote',
//             '--disable-gpu'
//         ] 
//     }
// });

const client = new Client({
    authStrategy: new LocalAuth({ clientId: "wa-bridge-v2" }),
    puppeteer: {
        headless: true, // اتركيه true ليتمكن من المزامنة بهدوء
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions' // إضافة لتقليل الضغط
        ],
        // ⚠️ أضيفي هذا السطر لزيادة وقت الانتظار
        authTimeoutMs: 0, 
        navigationTimeout: 0 
    }
});


function cleanId(id) {
    if (!id) return null;
    return id.replace('@c.us', '').replace('@s.whatsapp.net', '').replace('@g.us', '');
}

// --- الأحداث ---
client.on('qr', qr => { 
    qrcode.generate(qr, { small: true }); 
    currentQrCode = qr;
    
    console.log('--------------------------------------------------');
    console.log('⚠️ **SCAN REQUIRED** ⚠️');
    console.log(`🔗 Open this URL in your browser to scan: http://localhost:${PORT}/qr-code`);
    console.log('--------------------------------------------------');
});

client.on('ready', () => {
    console.log('✅ WhatsApp Bridge Ready & Connected!');
    currentQrCode = null;
    console.log(`🚀 API Listening on http://localhost:${PORT}`);
    if (pendingQueue.length > 0) processQueue();
});

client.on('disconnected', (reason) => {
    console.error(`❌ Disconnected! Reason: ${reason}. Waiting for new QR code...`);
});

client.on('message_create', async msg => {
    console.log(`🔍 استلمت شيئاً: من ${msg.from} نوعه ${msg.type}`);
    if (msg.fromMe || msg.from === 'status@broadcast') return;

    const senderFullId = msg.from;
    const isGroup = msg.from.includes('@g.us');
    let chatNumber = cleanId(senderFullId);
    let authorNumber = msg.author ? cleanId(msg.author) : null;

    if (ADMIN_BOT_NUMBERS.includes(chatNumber) || (authorNumber && ADMIN_BOT_NUMBERS.includes(authorNumber))) return;

    let groupName = null;
    let groupId = null;

    if (isGroup) {
        groupId = chatNumber;
        try {
            const chat = await msg.getChat();
            groupName = chat.name;
            console.log(`🔍 [GROUP] "${groupName}" | ID: ${groupId}`);
        } catch (e) { groupName = "Unknown"; }
    }

    // اللوج المختصر
    const typeIcon = msg.type === 'ptt' ? '🎤' : (msg.type === 'image' ? '🖼️' : '📄');
    const content = (msg.body || "").substring(0, 30).replace(/\n/g, ' ');
    
    if (isGroup) {
        console.log(`📢 [GP: ${groupName}] ${groupId} | 👤 ${authorNumber} | ${typeIcon} "${content}..."`);
    } else {
        console.log(`📩 [DM] ${chatNumber} | ${typeIcon} "${content}..."`);
    }

    let payload = {
        event_type: 'new_message',
        whatsapp_message_id: msg.id.id,
        sender_id: chatNumber,
        author_id: authorNumber,
        reply_to_id: senderFullId,
        is_group: isGroup,
        group_name: groupName,
        group_id: groupId,
        type: msg.type,
        message_text: msg.body,
        has_media: false
    };

    if (msg.type === 'location') {
        payload.location = { lat: msg.location.latitude, lng: msg.location.longitude };
        payload.message_text = `GPS: ${msg.location.latitude},${msg.location.longitude}`;
    } else if (msg.hasMedia) {
        try {
            const media = await msg.downloadMedia();
            if (media) {
                payload.has_media = true;
                payload.media_data = media.data;
                payload.media_type = media.mimetype;
                if(msg.type==='ptt' || msg.type==='audio') payload.message_text = "";
            }
        } catch (e) { console.error('Media Error:', e.message); }
    }

    await sendToDjango(payload, msg);
});

client.on('message_edit', async (msg, newBody, prevBody) => {
    console.log(`✏️ [EDIT] From ${cleanId(msg.author || msg.from)}`);
    await sendToDjango({
        event_type: 'message_edit',
        whatsapp_message_id: msg.id.id,
        message_text: newBody,
        sender_id: cleanId(msg.from),
        is_group: msg.from.includes('@g.us')
    }, msg);
});

client.on('message_revoke_everyone', async (after, before) => {
    console.log(`🗑️ [REVOKE] Message deleted`);
    const msgId = before ? before.id.id : (after ? after.id.id : null);
    if (msgId) {
        await sendToDjango({
            event_type: 'message_revoke',
            whatsapp_message_id: msgId
        }, null);
    }
});

// --- API Endpoints ---

// 1. فحص الصحة
app.get("/health", (req, res) => res.json({ status: "ok", service: "wa-bridge", uptime: process.uptime() }));

// 2. عرض الرمز (مع دعم السيرفر)
app.get('/qr-code', (req, res) => {
    if (currentQrCode) {
        const qrCodeDataUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(currentQrCode)}`;
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>WhatsApp Scan</title></head>
            <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
                <h1>⚠️ WhatsApp Scan Required</h1>
                <p>Please scan this code using WhatsApp Settings -> Linked Devices.</p>
                <img src="${qrCodeDataUrl}" alt="QR Code" style="border: 1px solid #ccc; padding: 10px;"/>
                <p>Status: Scanning... Last Checked: ${new Date().toLocaleTimeString()}</p>
                <script>
                    setTimeout(() => window.location.reload(), 5000); 
                </script>
            </body>
            </html>
        `);
    } else {
        res.status(200).send("✅ Bridge Connected. QR code not needed.");
    }
});

// 3. الطرد (LID Support)
app.post('/kick-member', async (req, res) => {
    const { group_id, phone, target_lid } = req.body;
    if (!group_id) return res.status(400).json({ error: "Missing group_id" });

    try {
        let chatGroupId = group_id.includes('@g.us') ? group_id : `${group_id}@g.us`;
        let idToRemove = null;

        if (target_lid) {
            idToRemove = target_lid.includes('@') ? target_lid : (target_lid.length > 15 ? `${target_lid}@lid` : `${target_lid}@c.us`);
            console.log(`🎯 [KICK FAST] Using LID: ${idToRemove}`);
        } 
        
        if (!idToRemove && phone) {
            let targetNumber = phone.toString().replace(/\D/g, '');
            if (targetNumber.startsWith('09')) targetNumber = '963' + targetNumber.substring(1);
            
            const chat = await client.getChatById(chatGroupId);
            const victim = chat.participants.find(p => p.id.user === targetNumber);
            if (victim) idToRemove = victim.id._serialized;
        }

        if (idToRemove) {
            const chat = await client.getChatById(chatGroupId);
            await chat.removeParticipants([idToRemove]);
            console.log(`👋 [KICK SUCCESS] Removed ${idToRemove}`);
            res.json({ status: 'success' });
        } else {
            res.status(404).json({ error: "User not found" });
        }
    } catch (e) {
        console.error(`❌ Kick Error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// 4. إرسال رسالة (المصحح مع LID Support)
app.post('/send-message', async (req, res) => {
  const { phone, message, reply_id } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  try {
    let chatId = reply_id;

    if (!chatId) {
      let clean = String(phone ?? '').replace(/\D/g, '');
      if (clean.startsWith('09')) clean = '963' + clean.substring(1);

      const wid = await client.getNumberId(clean);
      if (!wid) {
        console.log(`❌ [SEND] Number not on WhatsApp: ${clean}`);
        return res.status(404).json({ error: "Number not on WhatsApp", phone: clean });
      }
      chatId = wid._serialized;
    }

    console.log(`⏳ [SEND] To: ${chatId}`);

    try {
      await client.sendMessage(chatId, message);
    } catch (err1) {
      console.warn(`⚠️ Direct send failed: ${err1?.message || err1}`);
      try {
        const chat = await client.getChatById(chatId);
        await chat.sendMessage(message);
      } catch (err2) {
        console.error(`❌ Send Error (Ignored): ${err2?.message || err2}`);
      }
    }

    console.log(`📤 [SENT] Success`);
    return res.json({ status: 'success' });

  } catch (e) {
    console.error(`❌ Send Error (Ignored): ${e?.message || e}`);
    return res.json({ status: 'success', note: 'Sent with potential error' });
  }
});

// 5. 🔥🔥 إرسال الرياكشن (المصحح والفعال) 🔥🔥
app.post('/send-reaction', async (req, res) => {
    const { chat_id, message_id, reaction } = req.body;

    console.log(`📥 [REACTION REQUEST] Msg: ${message_id} | Chat: ${chat_id}`);

    if (!chat_id || !message_id) {
        return res.status(400).json({ error: "Missing chat_id or message_id" });
    }

    try {
        let targetChatId = chat_id;
        if (!targetChatId.includes('@')) {
             // إضافة اللاحقة الصحيحة للمجموعات أو الأفراد
            targetChatId = targetChatId.length > 15 ? `${targetChatId}@g.us` : `${targetChatId}@c.us`;
        }

        console.log(`🔍 Searching in chat: ${targetChatId}`);

        const chat = await client.getChatById(targetChatId);
        // جلب الرسائل الأخيرة (زدنا العدد لضمان العثور عليها)
        const messages = await chat.fetchMessages({ limit: 40 });
        
        const targetMsg = messages.find(m => m.id.id === message_id);

        if (targetMsg) {
            await targetMsg.react(reaction || '✅');
            console.log(`✅ [REACTION SUCCESS] Added to ${message_id}`);
            res.json({ status: 'success' });
        } else {
            console.warn(`⚠️ [REACTION FAIL] Msg ${message_id} not found in last 40 messages.`);
            res.status(404).json({ error: "Message not found in recent history" });
        }

    } catch (e) {
        console.error(`❌ Reaction Error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});


console.log("⏳ Starting WhatsApp Client...");
client.on('loading_screen', (percent, message) => {
    console.log('LOADING SCREEN', percent, message);
});

client.on('authenticated', () => {
    console.log('✅ Authenticated Success!');
});
client.on('change_state', state => {
    console.log('🔄 Current Connection State:', state);
});
client.on('auth_failure', msg => {
    console.error('❌ Authentication failure, restarting...', msg);
});
client.initialize();
app.listen(PORT, () => console.log(`🚀 Bridge on ${PORT}`));

// const { Client, LocalAuth } = require('whatsapp-web.js');
// const express = require('express');
// const axios = require('axios');
// const qrcode = require('qrcode-terminal');

// const app = express();
// app.use(express.json({ limit: '50mb' }));
// const ADMIN_BOT_NUMBERS = ['963931698698', '963931697697'];
// // إعداد البورت (3000 للجسر، لأن Next.js على 3001)
// // const PORT = 3000;
// // const DJANGO_WEBHOOK_URL = 'http://127.0.0.1:8000/webhook/';
// // const DJANGO_WEBHOOK_URL = 'https://api.taxihon.com/webhook/';
// // ✅ التعديل: قراءة البورت والرابط من متغيرات البيئة (أو استخدام المحلي كاحتياطي)
// const PORT = process.env.PORT || 3000;

// // هذا السطر هو الأهم: سيقرأ الرابط من Coolify، وإذا لم يجده سيستخدم الرابط المحلي
// const DJANGO_WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://127.0.0.1:8000/webhook/';
// // --- 🔥 متغير حالة عام لتخزين الرمز 🔥 ---
// let currentQrCode = null;
// // --- 🔥 نهاية متغير الحالة ---


// // --- 🔥 نظام الطابور (Retry Queue) ---
// let pendingQueue = [];
// let isRetrying = false;

// // دالة لمعالجة الطابور عند عودة الاتصال
// async function processQueue() {
//     if (isRetrying || pendingQueue.length === 0) return;
//     isRetrying = true;

//     console.log(`🔄 [Queue] Attempting to resend ${pendingQueue.length} pending messages...`);

//     const currentBatch = [...pendingQueue];
//     pendingQueue = []; // تفريغ الطابور مؤقتاً

//     for (const item of currentBatch) {
//         try {
//             await axios.post(DJANGO_WEBHOOK_URL, item.payload);
//             console.log(`✅ [Recovered] Message from ${item.payload.sender_id} sent to Django.`);
//         } catch (error) {
//             // إذا فشل مجدداً، نعيده للطابور
//             console.warn(`⚠️ [Queue] Retry failed for ${item.payload.sender_id}, requeuing...`);
//             pendingQueue.push(item);
//         }
//     }

//     isRetrying = false;
    
//     // إذا بقي شيء في الطابور، نعيد المحاولة بعد 10 ثواني
//     if (pendingQueue.length > 0) {
//         setTimeout(processQueue, 10000);
//     }
// }

// // دالة الإرسال الذكية لجانغو (مع الطابور)
// async function sendToDjango(payload, originalMsg) {
//     try {
//         const response = await axios.post(DJANGO_WEBHOOK_URL, payload);
        
//         // معالجة التفاعل (Reaction) إذا طلبه جانغو
//         if (response.data && response.data.reaction && originalMsg) {
//             try { await originalMsg.react(response.data.reaction); } catch (e) {}
//         }

//         // إذا نجح الاتصال وكان هناك رسائل عالقة، نحاول إرسالها الآن
//         if (pendingQueue.length > 0) {
//             processQueue();
//         }

//     } catch (error) {
//         console.error(`❌ [Django Offline] Connection failed! Queuing message from ${payload.sender_id}`);
        
//         // إضافة الرسالة للطابور
//         pendingQueue.push({ payload, originalMsg });
        
//         // بدء محاولة إعادة الإرسال (إذا لم تكن تعمل بالفعل)
//         if (!isRetrying) {
//             setTimeout(processQueue, 10000); // محاولة كل 10 ثواني
//         }
//     }
// }

// // --- إعداد عميل الواتساب ---
// const client = new Client({
//     authStrategy: new LocalAuth(),
//     puppeteer: { 
//         headless: true,
//         args: [
//             '--no-sandbox', 
//             '--disable-setuid-sandbox', 
//             '--disable-dev-shm-usage',
//             '--disable-accelerated-2d-canvas',
//             '--no-first-run',
//             '--no-zygote',
//             '--disable-gpu'
//         ] 
//     }
// });

// // --- دوال مساعدة ---
// function cleanId(id) {
//     if (!id) return null;
//     return id.replace('@c.us', '').replace('@s.whatsapp.net', '').replace('@g.us', '');
// }

// // --- الأحداث ---

// client.on('qr', qr => { 
//     qrcode.generate(qr, { small: true }); 
    
//     // 🔥 التعديل: تخزين الرمز في المتغير العام وطباعة رابط API
//     currentQrCode = qr; 
    
//     console.log('--------------------------------------------------');
//     console.log('⚠️ **SCAN REQUIRED** ⚠️');
//     // ملاحظة: localhost سيعمل فقط إذا كنت تشغل السيرفر محلياً. على Hertz استخدم IP أو اسم النطاق.
//     console.log(`🔗 Open this URL in your browser to scan: http://localhost:${PORT}/qr-code`);
//     console.log('--------------------------------------------------');
// });

// client.on('ready', () => {
//     console.log('✅ WhatsApp Bridge Ready & Connected!');
//     currentQrCode = null; // تفريغ الرمز عند الاتصال الناجح
//     console.log(`🚀 API Listening on http://localhost:${PORT}`);
    
//     // عند التشغيل، نحاول معالجة أي شيء عالق في الذاكرة
//     if (pendingQueue.length > 0) processQueue();
// });

// // 🚨 مهم للمراقبة: عند فقدان الاتصال، ننتظر رمز QR جديد
// client.on('disconnected', (reason) => {
//     console.error(`❌ Disconnected! Reason: ${reason}. Waiting for new QR code...`);
//     // لا نحتاج لتعيين currentQrCode = null هنا، لأن حدث 'qr' سيقوم بذلك عند توليده.
// });


// // استقبال الرسائل (تم التعديل لدعم المجموعات)
// client.on('message', async msg => {
//     if (msg.fromMe || msg.from === 'status@broadcast') return;

//     const senderFullId = msg.from;
//     const isGroup = msg.from.includes('@g.us');
    
//     let chatNumber = cleanId(senderFullId); // رقم المجموعة أو الشخص
//     let authorNumber = msg.author ? cleanId(msg.author) : null; // رقم الشخص المرسل (داخل المجموعة)

//     // ✅ أضف التعديل هنا (بعد استخراج الأرقام وقبل أي شيء آخر)
//     if (ADMIN_BOT_NUMBERS.includes(chatNumber) || (authorNumber && ADMIN_BOT_NUMBERS.includes(authorNumber))) {
//         return; 
//     }
// // التعديل لضمان استخراج الرقم الصافي حتى لو كان LID
//     // let chatNumber = cleanId(senderFullId);
//     // if (chatNumber && chatNumber.includes(':')) chatNumber = chatNumber.split(':')[1];

//     // let authorNumber = msg.author ? cleanId(msg.author) : null;
//     // if (authorNumber && authorNumber.includes(':')) authorNumber = authorNumber.split(':')[1];
//     // 🔥 استخراج بيانات المجموعة (الاسم + المعرف)
//     let groupName = null;
//     let groupId = null;

//     if (isGroup) {
//         groupId = chatNumber; // المعرف هو رقم الشات نفسه
//         try {
//             const chat = await msg.getChat();
//             groupName = chat.name;
//             // طباعة المعرف واسم المجموعة في التيرمينال لسهولة النسخ
//             console.log(`🔍 [GROUP DETECTED] Name: "${groupName}" | ID: ${groupId}`);
//         } catch (e) {
//             console.error('⚠️ Could not fetch group metadata:', e.message);
//             groupName = "Unknown Group";
//         }
//     }

//     // اللوج المختصر
//     const typeIcon = msg.type === 'ptt' ? '🎤' : (msg.type === 'image' ? '🖼️' : '📄');
//     const content = (msg.body || "").substring(0, 30).replace(/\n/g, ' ');
    
//     if (isGroup) {
//         console.log(`📢 [GP: ${groupName}] ${groupId} | 👤 ${authorNumber} | ${typeIcon} "${content}..."`);
//     } else {
//         console.log(`📩 [DM] ${chatNumber} | ${typeIcon} "${content}..."`);
//     }

//     // تجهيز البايلود مع إضافة بيانات المجموعة
//     let payload = {
//         event_type: 'new_message',
//         whatsapp_message_id: msg.id.id,
//         sender_id: chatNumber,        // في حال المجموعة، هذا هو معرف المجموعة
//         author_id: authorNumber,      // رقم الشخص الذي أرسل الرسالة داخل المجموعة
//         reply_to_id: senderFullId,
//         is_group: isGroup,
//         group_name: groupName,        // ✅ اسم المجموعة (جديد)
//         group_id: isGroup ? groupId : null, // ✅ معرف المجموعة بشكل صريح (جديد)
//         type: msg.type,
//         message_text: msg.body,
//         has_media: false,
//         location: null
//     };

//     // معالجة الموقع
//     if (msg.type === 'location') {
//         payload.location = { lat: msg.location.latitude, lng: msg.location.longitude };
//         payload.message_text = `GPS: ${msg.location.latitude},${msg.location.longitude}`;
//     } 
//     // معالجة الميديا
//     else if (msg.hasMedia) {
//         try {
//             const media = await msg.downloadMedia();
//             if (media) {
//                 payload.has_media = true;
//                 payload.media_data = media.data;
//                 payload.media_type = media.mimetype;
//                 if(msg.type==='ptt' || msg.type==='audio') payload.message_text = "";
//             }
//         } catch (e) { console.error('Media Error:', e.message); }
//     }

//     // إرسال عبر الطابور الذكي
//     await sendToDjango(payload, msg);
// });

// // تعديل وحذف الرسائل
// client.on('message_edit', async (msg, newBody, prevBody) => {
//     console.log(`✏️ [EDIT] From ${cleanId(msg.author || msg.from)}`);
//     await sendToDjango({
//         event_type: 'message_edit',
//         whatsapp_message_id: msg.id.id,
//         message_text: newBody,
//         sender_id: cleanId(msg.from),
//         is_group: msg.from.includes('@g.us')
//     }, msg);
// });

// client.on('message_revoke_everyone', async (after, before) => {
//     console.log(`🗑️ [REVOKE] Message deleted`);
//     const msgId = before ? before.id.id : (after ? after.id.id : null);
//     if (msgId) {
//         await sendToDjango({
//             event_type: 'message_revoke',
//             whatsapp_message_id: msgId
//         }, null);
//     }
// });

// // --- 🔥 API Endpoint لعرض الرمز 🔥 ---

// app.get('/qr-code', (req, res) => {
//     if (currentQrCode) {
//         // نستخدم خدمة خارجية لتحويل نص QR إلى صورة (لأننا في خادم بدون واجهة)
//         const qrCodeDataUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(currentQrCode)}`;
        
//         // نعرض صفحة HTML بسيطة تفتح الصورة وتحدث كل 5 ثوانٍ
//         res.send(`
//             <!DOCTYPE html>
//             <html>
//             <head><title>WhatsApp Scan</title></head>
//             <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
//                 <h1>⚠️ WhatsApp Scan Required</h1>
//                 <p>Please scan this code using WhatsApp Settings -> Linked Devices.</p>
//                 <img src="${qrCodeDataUrl}" alt="QR Code" style="border: 1px solid #ccc; padding: 10px;"/>
//                 <p>Status: Scanning... Last Checked: ${new Date().toLocaleTimeString()}</p>
//                 <script>
//                     // تحديث الصفحة كل 5 ثواني
//                     setTimeout(() => window.location.reload(), 5000); 
//                 </script>
//             </body>
//             </html>
//         `);
//     } else {
//         res.status(200).send("✅ Bridge Connected. QR code not needed.");
//     }
// });

// app.get("/health", (req, res) => {
//   res.status(200).json({
//     status: "ok",
//     service: "wa-bridge",
//     uptime: process.uptime()
//   });
// });

// // API الطرد (LID Support)
// app.post('/kick-member', async (req, res) => {
//     const { group_id, phone, target_lid } = req.body;
//     if (!group_id) return res.status(400).json({ error: "Missing group_id" });

//     try {
//         let chatGroupId = group_id.includes('@g.us') ? group_id : `${group_id}@g.us`;
//         let idToRemove = null;

//         // 1. الأولوية للـ LID القادم من جانغو (لأنه دقيق 100%)
//         if (target_lid) {
//             idToRemove = target_lid.includes('@') ? target_lid : (target_lid.length > 15 ? `${target_lid}@lid` : `${target_lid}@c.us`);
//             console.log(`🎯 [KICK FAST] Using LID: ${idToRemove}`);
//         } 
        
//         // 2. البحث عن طريق الرقم إذا فشل الـ LID
//         if (!idToRemove && phone) {
//             let targetNumber = phone.toString().replace(/\D/g, '');
//             if (targetNumber.startsWith('09')) targetNumber = '963' + targetNumber.substring(1);
            
//             const chat = await client.getChatById(chatGroupId);
//             const victim = chat.participants.find(p => p.id.user === targetNumber);
//             if (victim) idToRemove = victim.id._serialized;
//         }

//         if (idToRemove) {
//             const chat = await client.getChatById(chatGroupId);
//             await chat.removeParticipants([idToRemove]);
//             console.log(`👋 [KICK SUCCESS] Removed ${idToRemove}`);
//             res.json({ status: 'success' });
//         } else {
//             res.status(404).json({ error: "User not found" });
//         }
//     } catch (e) {
//         console.error(`❌ Kick Error: ${e.message}`);
//         res.status(500).json({ error: e.message });
//     }
// });

// app.post('/send-message', async (req, res) => {
//   const { phone, message, reply_id } = req.body;
//   if (!message) return res.status(400).json({ error: "No message" });

//   try {
//     let chatId = reply_id;

//     // 1) If replying to an existing chat (lid or c.us) use it directly
//     if (!chatId) {
//       let clean = String(phone ?? '').replace(/\D/g, '');

//       // normalize Syria mobile starting with 09xxxxxxxx
//       if (clean.startsWith('09')) clean = '963' + clean.substring(1);

//       // IMPORTANT: do NOT guess @lid from "long number"
//       // Instead: ask WhatsApp for the correct id
//       const wid = await client.getNumberId(clean);
//       if (!wid) {
//         console.log(`❌ [SEND] Number not on WhatsApp: ${clean}`);
//         return res.status(404).json({ error: "Number not on WhatsApp", phone: clean });
//       }

//       chatId = wid._serialized; // e.g. 9715...@c.us
//     }

//     console.log(`⏳ [SEND] To: ${chatId}`);

//     // 2) Send message (chat object optional; direct is enough)
//     try {
//       await client.sendMessage(chatId, message);
//     } catch (err1) {
//       console.warn(`⚠️ Direct send failed: ${err1?.message || err1}`);

//       // Fallback: try chat object send (sometimes helps with some sessions)
//       try {
//         const chat = await client.getChatById(chatId);
//         await chat.sendMessage(message);
//       } catch (err2) {
//         console.error(`❌ Send Error (Ignored): ${err2?.message || err2}`);
//       }
//     }

//     console.log(`📤 [SENT] Success`);
//     return res.json({ status: 'success' });

//   } catch (e) {
//     console.error(`❌ Send Error (Ignored): ${e?.message || e}`);
//     // Keep your "success anyway" behavior if you want
//     return res.json({ status: 'success', note: 'Sent with potential error' });
//   }
// });

// // في server.js

// app.post('/send-reaction', async (req, res) => {
//     const { chat_id, message_id, reaction } = req.body;

//     console.log(`📥 [REACTION REQUEST] Msg: ${message_id} | Chat: ${chat_id}`);

//     if (!chat_id || !message_id) {
//         return res.status(400).json({ error: "Missing chat_id or message_id" });
//     }

//     try {
//         // 1. تنظيف معرف الشات
//         let targetChatId = chat_id;
//         // إذا كان الرقم طويلاً (مجموعة) ولا ينتهي بـ g.us، أضفه
//         if (!targetChatId.includes('@')) {
//              // 12036... هو معرف مجموعة دائم
//             targetChatId = targetChatId.length > 15 ? `${targetChatId}@g.us` : `${targetChatId}@c.us`;
//         }

//         console.log(`🔍 Searching in chat: ${targetChatId}`);

//         // 2. جلب الشات
//         const chat = await client.getChatById(targetChatId);
        
//         // 3. البحث عن الرسالة
//         // ملاحظة: fetchMessages تجلب الرسائل الحديثة. نزيد العدد قليلاً لضمان وجودها
//         const messages = await chat.fetchMessages({ limit: 30 });
        
//         const targetMsg = messages.find(m => m.id.id === message_id);

//         if (targetMsg) {
//             await targetMsg.react(reaction || '✅');
//             console.log(`✅ [REACTION SUCCESS] Added to ${message_id}`);
//             res.json({ status: 'success' });
//         } else {
//             console.warn(`⚠️ [REACTION FAIL] Msg ${message_id} not found in last 30 messages.`);
            
//             // 🔥 محاولة أخيرة: إرسال رد نصي صغير إذا فشل الرياكشن (خطة ب)
//             // await chat.sendMessage(`✅ تم`, { quotedMessageId: message_id }); // (اختياري)
            
//             res.status(404).json({ error: "Message not found in recent history" });
//         }

//     } catch (e) {
//         console.error(`❌ Reaction Error: ${e.message}`);
//         res.status(500).json({ error: e.message });
//     }
// });

// client.initialize();
// app.listen(PORT, () => console.log(`🚀 Bridge on ${PORT}`));
// /**
//  * TaxiHon WhatsApp Bridge - Ultimate Resilient Version
//  * Features: 
//  * - Retry Queue (Offline Support)
//  * - LIDs Handling & Detection
//  * - Auto-Reactions
//  * - Group Info Extraction (Name & ID) ✅ NEW
//  * - Robust Sending logic
//  */

// const { Client, LocalAuth } = require('whatsapp-web.js');
// const express = require('express');
// const axios = require('axios');
// const qrcode = require('qrcode-terminal');

// const app = express();
// app.use(express.json({ limit: '50mb' }));

// // إعداد البورت (3000 للجسر، لأن Next.js على 3001)
// const PORT = 3000;
// const DJANGO_WEBHOOK_URL = 'http://127.0.0.1:8000/webhook/';

// // --- 🔥 نظام الطابور (Retry Queue) ---
// let pendingQueue = [];
// let isRetrying = false;

// // دالة لمعالجة الطابور عند عودة الاتصال
// async function processQueue() {
//     if (isRetrying || pendingQueue.length === 0) return;
//     isRetrying = true;

//     console.log(`🔄 [Queue] Attempting to resend ${pendingQueue.length} pending messages...`);

//     const currentBatch = [...pendingQueue];
//     pendingQueue = []; // تفريغ الطابور مؤقتاً

//     for (const item of currentBatch) {
//         try {
//             await axios.post(DJANGO_WEBHOOK_URL, item.payload);
//             console.log(`✅ [Recovered] Message from ${item.payload.sender_id} sent to Django.`);
//         } catch (error) {
//             // إذا فشل مجدداً، نعيده للطابور
//             console.warn(`⚠️ [Queue] Retry failed for ${item.payload.sender_id}, requeuing...`);
//             pendingQueue.push(item);
//         }
//     }

//     isRetrying = false;
    
//     // إذا بقي شيء في الطابور، نعيد المحاولة بعد 10 ثواني
//     if (pendingQueue.length > 0) {
//         setTimeout(processQueue, 10000);
//     }
// }

// // دالة الإرسال الذكية لجانغو (مع الطابور)
// async function sendToDjango(payload, originalMsg) {
//     try {
//         const response = await axios.post(DJANGO_WEBHOOK_URL, payload);
        
//         // معالجة التفاعل (Reaction) إذا طلبه جانغو
//         if (response.data && response.data.reaction && originalMsg) {
//             try { await originalMsg.react(response.data.reaction); } catch (e) {}
//         }

//         // إذا نجح الاتصال وكان هناك رسائل عالقة، نحاول إرسالها الآن
//         if (pendingQueue.length > 0) {
//             processQueue();
//         }

//     } catch (error) {
//         console.error(`❌ [Django Offline] Connection failed! Queuing message from ${payload.sender_id}`);
        
//         // إضافة الرسالة للطابور
//         pendingQueue.push({ payload, originalMsg });
        
//         // بدء محاولة إعادة الإرسال (إذا لم تكن تعمل بالفعل)
//         if (!isRetrying) {
//             setTimeout(processQueue, 10000); // محاولة كل 10 ثواني
//         }
//     }
// }

// // --- إعداد عميل الواتساب ---
// const client = new Client({
//     authStrategy: new LocalAuth(),
//     puppeteer: { 
//         headless: true,
//         args: [
//             '--no-sandbox', 
//             '--disable-setuid-sandbox', 
//             '--disable-dev-shm-usage',
//             '--disable-accelerated-2d-canvas',
//             '--no-first-run',
//             '--no-zygote',
//             '--disable-gpu'
//         ] 
//     }
// });

// // --- دوال مساعدة ---
// function cleanId(id) {
//     if (!id) return null;
//     return id.replace('@c.us', '').replace('@s.whatsapp.net', '').replace('@g.us', '');
// }

// // --- الأحداث ---

// client.on('qr', qr => { 
//     qrcode.generate(qr, { small: true }); 
//     console.log('📱 QR Code Generated'); 
// });

// client.on('ready', () => {
//     console.log('✅ WhatsApp Bridge Ready & Connected!');
//     console.log(`🚀 API Listening on http://localhost:${PORT}`);
    
//     // عند التشغيل، نحاول معالجة أي شيء عالق في الذاكرة
//     if (pendingQueue.length > 0) processQueue();
// });

// // استقبال الرسائل (تم التعديل لدعم المجموعات)
// client.on('message', async msg => {
//     if (msg.fromMe || msg.from === 'status@broadcast') return;

//     const senderFullId = msg.from;
//     const isGroup = msg.from.includes('@g.us');
    
//     let chatNumber = cleanId(senderFullId); // رقم المجموعة أو الشخص
//     let authorNumber = msg.author ? cleanId(msg.author) : null; // رقم الشخص المرسل (داخل المجموعة)

//     // 🔥 استخراج بيانات المجموعة (الاسم + المعرف)
//     let groupName = null;
//     let groupId = null;

//     if (isGroup) {
//         groupId = chatNumber; // المعرف هو رقم الشات نفسه
//         try {
//             const chat = await msg.getChat();
//             groupName = chat.name;
//             // طباعة المعرف واسم المجموعة في التيرمينال لسهولة النسخ
//             console.log(`🔍 [GROUP DETECTED] Name: "${groupName}" | ID: ${groupId}`);
//         } catch (e) {
//             console.error('⚠️ Could not fetch group metadata:', e.message);
//             groupName = "Unknown Group";
//         }
//     }

//     // اللوج المختصر
//     const typeIcon = msg.type === 'ptt' ? '🎤' : (msg.type === 'image' ? '🖼️' : '📄');
//     const content = (msg.body || "").substring(0, 30).replace(/\n/g, ' ');
    
//     if (isGroup) {
//         console.log(`📢 [GP: ${groupName}] ${groupId} | 👤 ${authorNumber} | ${typeIcon} "${content}..."`);
//     } else {
//         console.log(`📩 [DM] ${chatNumber} | ${typeIcon} "${content}..."`);
//     }

//     // تجهيز البايلود مع إضافة بيانات المجموعة
//     let payload = {
//         event_type: 'new_message',
//         whatsapp_message_id: msg.id.id,
//         sender_id: chatNumber,        // في حال المجموعة، هذا هو معرف المجموعة
//         author_id: authorNumber,      // رقم الشخص الذي أرسل الرسالة داخل المجموعة
//         reply_to_id: senderFullId,
//         is_group: isGroup,
//         group_name: groupName,        // ✅ اسم المجموعة (جديد)
//         group_id: isGroup ? groupId : null, // ✅ معرف المجموعة بشكل صريح (جديد)
//         type: msg.type,
//         message_text: msg.body,
//         has_media: false,
//         location: null
//     };

//     // معالجة الموقع
//     if (msg.type === 'location') {
//         payload.location = { lat: msg.location.latitude, lng: msg.location.longitude };
//         payload.message_text = `GPS: ${msg.location.latitude},${msg.location.longitude}`;
//     } 
//     // معالجة الميديا
//     else if (msg.hasMedia) {
//         try {
//             const media = await msg.downloadMedia();
//             if (media) {
//                 payload.has_media = true;
//                 payload.media_data = media.data;
//                 payload.media_type = media.mimetype;
//                 if(msg.type==='ptt' || msg.type==='audio') payload.message_text = "";
//             }
//         } catch (e) { console.error('Media Error:', e.message); }
//     }

//     // إرسال عبر الطابور الذكي
//     await sendToDjango(payload, msg);
// });

// // تعديل وحذف الرسائل
// client.on('message_edit', async (msg, newBody, prevBody) => {
//     console.log(`✏️ [EDIT] From ${cleanId(msg.author || msg.from)}`);
//     await sendToDjango({
//         event_type: 'message_edit',
//         whatsapp_message_id: msg.id.id,
//         message_text: newBody,
//         sender_id: cleanId(msg.from),
//         is_group: msg.from.includes('@g.us')
//     }, msg);
// });

// client.on('message_revoke_everyone', async (after, before) => {
//     console.log(`🗑️ [REVOKE] Message deleted`);
//     const msgId = before ? before.id.id : (after ? after.id.id : null);
//     if (msgId) {
//         await sendToDjango({
//             event_type: 'message_revoke',
//             whatsapp_message_id: msgId
//         }, null);
//     }
// });

// // --- 🔥 API الإرسال (المصحح مع LID Support) 🔥 ---
// app.post('/send-message', async (req, res) => {
//     if (!req.body || (!req.body.phone && !req.body.reply_id) || !req.body.message) {
//         return res.status(400).json({ error: "Missing required fields" });
//     }

//     let { phone, message, reply_id } = req.body;

//     try {
//         let chatId;

//         if (reply_id) {
//             chatId = reply_id;
//         } else {
//             let cleanPhone = phone.toString().replace(/\D/g, '');
//             if (cleanPhone.startsWith('09')) cleanPhone = '963' + cleanPhone.substring(1);
            
//             // كشف LID
//             if (cleanPhone.length >= 15 && !cleanPhone.startsWith('963')) { 
//                 chatId = `${cleanPhone}@lid`;
//             } else {
//                 chatId = `${cleanPhone}@c.us`;
//             }
//         }

//         console.log(`⏳ [SEND] To: ${chatId}`);

//         try {
//             await client.sendMessage(chatId, message);
//         } catch (sendError) {
//             console.warn(`⚠️ Direct send failed to ${chatId}, attempting fallback...`);
//             // التبديل بين @c.us و @lid
//             let fallbackId = chatId.endsWith('@c.us') ? chatId.replace('@c.us', '@lid') : chatId.replace('@lid', '@c.us');
//             console.log(`🔄 Retrying with: ${fallbackId}`);
//             await client.sendMessage(fallbackId, message);
//         }

//         console.log(`📤 [SENT] Success`);
//         res.json({ status: 'success' });

//     } catch (e) {
//         console.error(`❌ Send Failed: ${e.message}`);
//         res.status(500).json({ error: e.message });
//     }
// });

// // تشغيل الخادم
// client.initialize();
// app.listen(PORT, () => console.log(`🚀 Bridge Running on ${PORT}`));
