require('dotenv').config();
const { Telegraf } = require('telegraf');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const axios = require('axios');
const { neon } = require('@neondatabase/serverless');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const sql = neon(process.env.DATABASE_URL);

const spartanPersona = `You are a highly elite, brutally honest, and deeply academic professional life advisor.
You absolutely despise fake optimism, motivational fluff, and cliché AI responses. You do not cheerlead. You do not overreact. 
You speak with cold, clinical precision, delivering straightforward facts and ruthless logic. 
If the user is lazy or making excuses, you give them a harsh reality check. You may use strong language to emphasize your point, but do not sound like an exaggerated internet caricature. Be authentic, grounded, and intensely practical.
Your primary goal is to provide deeply academic, meticulously researched, and perfectly accurate advice. 

CRITICAL BEHAVIOR & FORMATTING RULES:
1. NO BULLSHIT: Never use fake enthusiasm, motivational quotes, or overly optimistic language. Be stoic and brutally direct.
2. CASUAL CHAT/EXCUSES: Destroy their argument with cold logic in 1-3 concise sentences. Be harsh and straightforward.
3. ACADEMIC/COMPLEX REQUESTS: Switch into a top-tier academic professional mode. Provide highly detailed, flawlessly structured, and comprehensively researched answers without any filler words.
4. TELEGRAM FORMATTING: You are communicating via Telegram. Use the following HTML tags to make your response highly interactive:
   - Use <blockquote expandable>...</blockquote> for long, deep-dive explanations or lists. This allows the user to expand the text.
   - Use <tg-spoiler>...</tg-spoiler> for harsh reality checks or punchlines.
   - Use <code>...</code> for key terms, formulas, or numbers so the user can tap to copy them.

When the user sends audio, acknowledge the comms directly.
When the user sends an image, analyze it factually and accurately.
When the user sends a document, read it and provide a cold, tactical breakdown.`;

const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const model = genAI.getGenerativeModel({ 
    model: "gemini-flash-latest",
    systemInstruction: spartanPersona,
    safetySettings,
});

// Database memory access
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

// Serverless message processing
async function processMessage(chatId, messagePart) {
    const history = await getHistory(chatId);
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(messagePart);
    
    // Save updated history back to Neon
    const newHistory = await chat.getHistory();
    const formattedHistory = newHistory.map(h => ({
        role: h.role,
        parts: h.parts
    }));
    await saveHistory(chatId, formattedHistory);
    
    return result.response.text();
}

function formatToTelegramHTML(text) {
    if (!text) return '';
    let html = text;
    
    // 1. Escape & first, but don't break existing HTML entities
    html = html.replace(/&(?!(amp|lt|gt|quot|apos);)/g, '&amp;');
    
    // 2. Convert markdown to HTML tags
    html = html.replace(/```(?:[a-zA-Z0-9-]+\n)?([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>');
    html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>');
    html = html.replace(/__([\s\S]+?)__/g, '<i>$1</i>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    
    // 3. Escape < that are NOT part of valid Telegram HTML tags
    html = html.replace(/<(?!\/?(b|strong|i|em|u|ins|s|strike|del|span|tg-spoiler|a|code|pre|blockquote)\b)/g, '&lt;');
    
    return html;
}

async function sendSafeMessage(ctx, text, withButtons = true) {
    const formattedText = formatToTelegramHTML(text);
    const chunkSize = 4000;
    for (let i = 0; i < formattedText.length; i += chunkSize) {
        let chunk = formattedText.substring(i, i + chunkSize);
        let isLastChunk = (i + chunkSize >= formattedText.length);
        let extraParams = { parse_mode: 'HTML' };
        
        if (isLastChunk && withButtons) {
            extraParams.reply_markup = {
                inline_keyboard: [
                    [
                        { text: '🔥 Roast Me', callback_data: 'roast_harder' },
                        { text: '📚 Deep Dive', callback_data: 'expand_academic' }
                    ]
                ]
            };
        }

        try {
            await ctx.reply(chunk, extraParams);
        } catch (e) {
            console.error("HTML Parse Error", e);
            delete extraParams.parse_mode;
            await ctx.reply(chunk, extraParams);
        }
    }
}

async function generateVoice(text) {
    if (!process.env.ELEVENLABS_API_KEY) return null;
    try {
        const VOICE_ID = "pNInz6obpgDQGcFmaJgB"; 
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;
        const cleanText = text.replace(/<[^>]*>?/gm, '');

        const response = await axios.post(url, {
            text: cleanText,
            model_id: "eleven_multilingual_v2",
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
        let errorMsg = error.response?.data || error.message;
        if (Buffer.isBuffer(errorMsg)) {
            errorMsg = errorMsg.toString('utf-8');
        }
        console.error("ElevenLabs Error:", errorMsg);
        return null;
    }
}

bot.start((ctx) => ctx.reply("System active. Comms secure. Neon Database Online. Speak, soldier."));

bot.on('text', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        try { await ctx.react('⚡'); } catch(e) {}
        await ctx.sendChatAction('typing');
        const responseText = await processMessage(chatId, ctx.message.text);
        await sendSafeMessage(ctx, responseText, true);
        
        const audioBuffer = await generateVoice(responseText);
        if (audioBuffer) {
            await ctx.replyWithVoice({ source: audioBuffer });
        }
    } catch (error) {
        console.error("Error processing text:", error);
        ctx.reply("System error. The comms are jammed.");
    }
});

bot.on('voice', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        try { await ctx.react('👀'); } catch(e) {}
        await ctx.sendChatAction('record_voice');
        const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        
        const audioPart = {
            inlineData: { data: Buffer.from(response.data).toString('base64'), mimeType: "audio/ogg" }
        };

        const responseText = await processMessage(chatId, [audioPart, { text: "Audio comms received. Analyze and reply." }]);
        await sendSafeMessage(ctx, responseText, true);
        
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
        try { await ctx.react('⚡'); } catch(e) {}
        await ctx.sendChatAction('typing');
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const fileLink = await ctx.telegram.getFileLink(photo.file_id);
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        
        const imagePart = {
            inlineData: { data: Buffer.from(response.data).toString('base64'), mimeType: "image/jpeg" }
        };

        const responseText = await processMessage(chatId, [imagePart, { text: "Visual intel received. Analyze this image." }]);
        await sendSafeMessage(ctx, responseText, true);
    } catch (error) {
        console.error("Error processing photo:", error);
        ctx.reply("Visual feed corrupted.");
    }
});

bot.action('roast_harder', async (ctx) => {
    try {
        await ctx.answerCbQuery("Initiating aggressive roast protocol...");
        const chatId = ctx.chat.id;
        await ctx.sendChatAction('typing');
        const responseText = await processMessage(chatId, "Roast me harder and more aggressively regarding our last topic.");
        await sendSafeMessage(ctx, responseText, true);
        const audioBuffer = await generateVoice(responseText);
        if (audioBuffer) await ctx.replyWithVoice({ source: audioBuffer });
    } catch (e) {
        console.error(e);
    }
});

bot.action('expand_academic', async (ctx) => {
    try {
        await ctx.answerCbQuery("Accessing academic database...");
        const chatId = ctx.chat.id;
        await ctx.sendChatAction('typing');
        const responseText = await processMessage(chatId, "Provide a deeper, highly academic, and meticulously detailed breakdown of our last topic.");
        await sendSafeMessage(ctx, responseText, true);
        const audioBuffer = await generateVoice(responseText);
        if (audioBuffer) await ctx.replyWithVoice({ source: audioBuffer });
    } catch (e) {
        console.error(e);
    }
});

bot.launch().then(() => console.log("BEAST MODE LOCAL is active and connected to Neon."));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
