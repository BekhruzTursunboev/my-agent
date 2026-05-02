require('dotenv').config();
const { Telegraf } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const { neon } = require('@neondatabase/serverless');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const sql = neon(process.env.DATABASE_URL);

const spartanPersona = `You are a harsh, spartan, Genghis Khan-esque life advisor, professional commander, and friend. 
You do not use generic AI language. You speak like a real MAN, highly masculine, high testosterone. 
You use dirty language (swearing is highly preferred) to emphasize points and roast the user when they are lazy or making excuses. 
However, your advice is deeply academic, highly accurate, and extremely reliable. You research facts when necessary. 
You are stoic and ruthless but ultimately want the user to succeed. 
No fluff, no warnings about AI limitations. Just straight, harsh, brilliant advice. 

CRITICAL VERBOSITY RULES:
1. FOR CASUAL CHAT/EXCUSES: If the user is just making an excuse, complaining, or asking a simple non-academic question, your response MUST be extremely short, brutal, and concise (1-3 sentences maximum). Roast them, give a command, and shut up.
2. FOR ACADEMIC/COMPLEX REQUESTS: If the user explicitly asks an academic question, asks for code, or demands deep research, you MUST switch into deep-dive mode. Provide a highly detailed, comprehensive, and perfectly structured response.

CRITICAL FORMATTING RULES:
You are communicating via Telegram. You MUST format your responses using HTML tags ONLY. 
- Use <b> for bold text.
- Use <i> for italic text.
- Use <code> for inline code or <pre> for code blocks.
- DO NOT use markdown like ** or * or \`\`. You will break the system if you use markdown. ONLY use HTML tags.

When the user sends audio, acknowledge you are listening to their comms.
When the user sends an image, analyze it ruthlessly and accurately.
When the user sends a document, read it and provide a tactical breakdown.`;

const model = genAI.getGenerativeModel({ 
    model: "gemini-flash-latest",
    systemInstruction: spartanPersona,
});

async function getHistory(chatId) {
    const rows = await sql`SELECT history FROM chats WHERE chat_id = ${chatId}`;
    if (rows.length > 0) return rows[0].history;
    return [];
}

async function saveHistory(chatId, history) {
    const jsonStr = JSON.stringify(history);
    await sql`
        INSERT INTO chats (chat_id, history) 
        VALUES (${chatId}, ${jsonStr}::jsonb)
        ON CONFLICT (chat_id) 
        DO UPDATE SET history = EXCLUDED.history;
    `;
}

async function processMessage(chatId, messagePart) {
    const history = await getHistory(chatId);
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(messagePart);
    
    const newHistory = await chat.getHistory();
    const formattedHistory = newHistory.map(h => ({ role: h.role, parts: h.parts }));
    await saveHistory(chatId, formattedHistory);
    
    return result.response.text();
}

async function sendSafeMessage(ctx, text) {
    const chunkSize = 4000;
    for (let i = 0; i < text.length; i += chunkSize) {
        let chunk = text.substring(i, i + chunkSize);
        try {
            await ctx.reply(chunk, { parse_mode: 'HTML' });
        } catch (e) {
            console.error("HTML Parse Error", e);
            await ctx.reply(chunk);
        }
    }
}

// ElevenLabs Voice Generator
async function generateVoice(text) {
    if (!process.env.ELEVENLABS_API_KEY) return null;
    try {
        const VOICE_ID = "pNInz6obpgDQGcFmaJgB"; // Deep Male Voice (Adam)
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;
        
        // Strip HTML tags for the text-to-speech engine
        const cleanText = text.replace(/<[^>]*>?/gm, '');

        const response = await axios.post(url, {
            text: cleanText,
            model_id: "eleven_monolingual_v1",
            voice_settings: { stability: 0.5, similarity_boost: 0.7 }
        }, {
            headers: {
                'xi-api-key': process.env.ELEVENLABS_API_KEY,
                'Content-Type': 'application/json'
            },
            responseType: 'arraybuffer'
        });
        return Buffer.from(response.data);
    } catch (error) {
        console.error("ElevenLabs Error:", error.response?.data || error.message);
        return null;
    }
}

bot.start((ctx) => ctx.reply("System active. Comms secure. Neon Database Online. Speak, soldier."));

bot.on('text', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        ctx.sendChatAction('typing');
        const responseText = await processMessage(chatId, ctx.message.text);
        await sendSafeMessage(ctx, responseText);
    } catch (error) {
        console.error("Error processing text:", error);
        ctx.reply("System error. The comms are jammed.");
    }
});

// If user sends VOICE, bot replies with VOICE
bot.on('voice', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        ctx.sendChatAction('record_voice');
        const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        
        const audioPart = {
            inlineData: { data: Buffer.from(response.data).toString('base64'), mimeType: "audio/ogg" }
        };

        const responseText = await processMessage(chatId, [audioPart, { text: "Audio comms received. Analyze and reply." }]);
        
        // ALWAYS send text first
        await sendSafeMessage(ctx, responseText);
        
        // Try to generate and send voice
        const audioBuffer = await generateVoice(responseText);
        if (audioBuffer) {
            await ctx.replyWithVoice({ source: audioBuffer });
        }
    } catch (error) {
        console.error("Error processing voice:", error);
        ctx.reply("Comms failure. I couldn't decrypt your audio.");
    }
});

bot.on('photo', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        ctx.sendChatAction('typing');
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const fileLink = await ctx.telegram.getFileLink(photo.file_id);
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        
        const imagePart = {
            inlineData: { data: Buffer.from(response.data).toString('base64'), mimeType: "image/jpeg" }
        };

        const responseText = await processMessage(chatId, [imagePart, { text: "Visual intel received. Analyze this image." }]);
        await sendSafeMessage(ctx, responseText);
    } catch (error) {
        console.error("Error processing photo:", error);
        ctx.reply("Visual feed corrupted.");
    }
});

module.exports = async (req, res) => {
    try {
        await bot.handleUpdate(req.body, res);
    } catch (e) {
        res.status(200).send('Error handling update');
    }
};
