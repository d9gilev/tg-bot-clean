// index.js — вебхук-только
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.WEBHOOK_URL;
const PORT = Number(process.env.PORT || 8080);

if (!TOKEN || !BASE) throw new Error("Нет BOT_TOKEN или WEBHOOK_URL");

const app = express();
app.use(express.json());

const bot = new TelegramBot(TOKEN, { webHook: { autoOpen: false } });

const hookPath = `/bot${TOKEN}`;
const hookUrl = `${BASE}${hookPath}`;

app.post(hookPath, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (_req, res) => res.status(200).send('OK'));

bot.onText(/^\/start$/, (msg) => bot.sendMessage(msg.chat.id, 'Я на вебхуке и готов! ✅'));

app.listen(PORT, '0.0.0.0', async () => {
  await fetch(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`, { method: 'POST' });
  await bot.setWebHook(hookUrl, {
    drop_pending_updates: true,
    allowed_updates: ['message','callback_query'],
  });
  console.log('Webhook set to:', hookUrl);
  console.log('Server listening on', PORT);
});
