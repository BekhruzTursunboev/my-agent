require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function setup() {
    try {
        await sql`
            CREATE TABLE IF NOT EXISTS chats (
                chat_id BIGINT PRIMARY KEY,
                history JSONB DEFAULT '[]'::jsonb
            );
        `;
        console.log("Neon DB initialized. Table 'chats' is ready.");
    } catch (e) {
        console.error("Failed to setup DB:", e);
    }
}

setup();
