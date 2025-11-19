const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');

// --- CONFIGURATION ---
const BOT_TOKEN = '8520641282:AAGlId3BC282mHugKeHtKmgi4ZFDRz7Uwq8'; 
const LOG_CHANNEL_ID = '-1003241628417'; // Yahan apna Channel ID dalein
const DOMAIN = 'https://storebyte.vercel.app'; // Render deploy hone ke baad yahan URL dalein

const DB_FILE = 'database.json';
const PORT = process.env.PORT || 3000;

// --- INITIALIZATION ---
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

// In-memory session (Upload karte waqt user ka data)
const userSessions = {};

// --- DATABASE FUNCTIONS ---
function loadData() {
    if (!fs.existsSync(DB_FILE)) return {};
    return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveData(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function generateId() {
    return Math.random().toString(36).substr(2, 6); // Short unique ID
}

console.log("🚀 SᴛᴏʀᴇBʏᴛᴇ Bᴏᴛ with Web Link Started...");

// --- WEB SERVER (Direct Link Logic) ---
app.get('/', (req, res) => res.send('Bot is running!'));

// Web Link Handler: /file/:id
app.get('/file/:id', async (req, res) => {
    const uniqueId = req.params.id;
    const db = loadData();
    
    if (!db[uniqueId]) return res.status(404).send('File not found or link expired.');

    const files = db[uniqueId];
    // Demo ke liye hum pehli file redirect karenge
    // Note: Telegram files > 20MB ke liye bot token se direct download link nahi banta
    try {
        const fileEntry = files[0]; // First file
        // Channel se file ka link nikalna (Copy karke path lena padta hai)
        // Note: Direct web download ke liye hume file_path chahiye hota hai
        const fileLink = await bot.getFileLink(fileEntry.file_id);
        
        // User ko direct telegram server par redirect kar do
        res.redirect(fileLink);
    } catch (error) {
        res.send(`
            <h2>View in Telegram</h2>
            <p>Browser view is limited. Please open in bot:</p>
            <a href="https://t.me/${(await bot.getMe()).username}?start=${uniqueId}">Open in Bot</a>
        `);
    }
});

app.listen(PORT, () => console.log(`Web Server running on port ${PORT}`));


// --- BOT LOGIC ---

// 1. /start Handler
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const param = match[1].trim();

    // Welcome Screen
    if (!param) {
        return bot.sendMessage(chatId, 
            "<b>📂 File Store Bot</b>\n\n" +
            "Files is secure <b>and full privacy</b> with.\n" +
            "AWS server:\n" +
            "🔹 Bot Share Link\n" +
            "🔹 Direct Web Download Link\n\n" +
            "👇 <b>Upload Now:</b>", 
            {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [[
                        { text: "📤 Upload New File", callback_data: "start_upload" }
                    ]]
                }
            }
        );
    }

    // File Retrieval (Bot Link se)
    const uniqueId = param;
    const db = loadData();
    
    if (!db[uniqueId]) return bot.sendMessage(chatId, "❌ Link expired or invalid.");

    const files = db[uniqueId];
    bot.sendMessage(chatId, `📂 <b>Sending ${files.length} files...</b>`, { parse_mode: "HTML" });

    // Files user ko forward karna (Channel se copy karke)
    for (const f of files) {
        try {
            // copyMessage use kar rahe hain taaki caption bhi copy ho jaye
            await bot.copyMessage(chatId, LOG_CHANNEL_ID, f.msg_id);
        } catch (e) {
            bot.sendMessage(chatId, "❌ Error retrieving a file.");
        }
    }
});

// 2. Callback Query (Inline Buttons)
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === "start_upload") {
        userSessions[chatId] = { files: [] }; // Session Start
        
        await bot.editMessageText(
            "📤 <b>Upload Mode ON</b>\n\n" +
            "Apni files bhejna shuru karein.\n" +
            "Jab ho jaye, tab niche <b>Done</b> button dabayein.", 
            {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [[ { text: "✅ Done & Save", callback_data: "save_files" } ]]
                }
            }
        );
    }

    if (data === "save_files") {
        const session = userSessions[chatId];

        if (!session || session.files.length === 0) {
            return bot.answerCallbackQuery(query.id, { text: "❌ Pehle kuch files upload karein!", show_alert: true });
        }

        // Generate ID and Save
        const uniqueId = generateId();
        const db = loadData();
        db[uniqueId] = session.files;
        saveData(db);

        const botUser = await bot.getMe();
        const botLink = `https://t.me/${botUser.username}?start=${uniqueId}`;
        const webLink = `${DOMAIN}/file/${uniqueId}`;

        await bot.editMessageText(
            "✅ <b>Files Stored Successfully!</b>\n\n" +
            `🤖 <b>Bot Link:</b>\n<code>${botLink}</code>\n\n` +
            `🌐 <b>Web/Direct Link:</b>\n<code>${webLink}</code>`, 
            {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: "HTML",
                disable_web_page_preview: true,
                reply_markup: {
                    inline_keyboard: [[ { text: "📤 Upload More", callback_data: "start_upload" } ]]
                }
            }
        );

        delete userSessions[chatId]; // Clear session
    }
});

// 3. File Handler (Automatic Forward to Channel)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    
    // Agar user upload mode me nahi hai to ignore karein
    if (!userSessions[chatId]) return;
    if (msg.text && msg.text.startsWith('/')) return; // Commands ignore

    // Check media
    let fileId = null;
    if (msg.photo) fileId = msg.photo[msg.photo.length - 1].file_id;
    else if (msg.video) fileId = msg.video.file_id;
    else if (msg.document) fileId = msg.document.file_id;
    else if (msg.audio) fileId = msg.audio.file_id;
    
    if (fileId) {
        // Step A: File ko Channel me forward karein (Storage)
        try {
            const sentMsg = await bot.copyMessage(LOG_CHANNEL_ID, chatId, msg.message_id);
            
            // Step B: Channel ka Message ID save karein
            userSessions[chatId].files.push({
                msg_id: sentMsg.message_id, // Channel wala Message ID
                file_id: fileId, // Web link generate karne ke liye
                type: "media"
            });

            // Optional: User ko chhota feedback dein (Deleting notification to keep chat clean)
            const reply = await bot.sendMessage(chatId, "✅ Added.");
            setTimeout(() => bot.deleteMessage(chatId, reply.message_id), 2000);

        } catch (error) {
            bot.sendMessage(chatId, "❌ Error: Bot channel me forward nahi kar pa raha. Kya bot admin hai?");
            console.log(error);
        }
    }
});
