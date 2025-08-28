// index.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const TOKEN = process.env.BOT_TOKEN;
console.log('TOKEN:', TOKEN ? 'Есть' : 'Нет');
const bot = new TelegramBot(TOKEN, { polling: true });
bot.onText(/^\/start$/, (msg) => bot.sendMessage(msg.chat.id, 'Привет! Я живу локально (polling).'));
console.log('🤖 Бот запущен локально (polling). Нажми /start в Telegram.');
