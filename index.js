// index.js — стабильный webhook с секретом и надёжными логами
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN  = process.env.BOT_TOKEN;
const BASE   = process.env.WEBHOOK_URL;     // https://…up.railway.app
const PATH   = process.env.WH_PATH;         // напр. "/tg/ab12cd34"
const SECRET = process.env.WH_SECRET;       // напр. "s3cr3t_XYZ"
const PORT   = Number(process.env.PORT || 8080);

if (!TOKEN || !BASE || !PATH || !SECRET) {
  throw new Error('ENV missing: BOT_TOKEN / WEBHOOK_URL / WH_PATH / WH_SECRET');
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// Один инстанс бота, только webhook
const bot = new TelegramBot(TOKEN, { webHook: { autoOpen: false } });
const hookUrl = `${BASE}${PATH}`;

// Безопасная отправка — чтобы видеть ошибки API
const safeSend = (chatId, text, opts) =>
  bot.sendMessage(chatId, text, opts).catch(err => {
    console.error('sendMessage error:', err?.response?.body || err);
  });

// === ХЕНДЛЕРЫ (регистрируем ДО запуска сервера) ===
bot.on('message', (msg) => {
  console.log('Handler saw message:', msg.message_id, msg.text);
  if (msg.text && !/^\/start$/.test(msg.text)) safeSend(msg.chat.id, `Эхо: ${msg.text}`);
});

bot.onText(/^\/start$/, (msg) => {
  safeSend(msg.chat.id, 'Привет! Вебхук с секретом работает ✅');
});

// === HTTP-маршруты ===
app.use((req, _res, next) => { console.log('HTTP', req.method, req.url); next(); });

app.post(PATH, (req, res) => {
  // проверяем, что запрос действительно от Telegram
  if (req.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    console.warn('Bad secret header'); return res.sendStatus(401);
  }
  console.log('Update:', req.body.update_id, req.body?.message?.text);
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (_req, res) => res.status(200).send('OK'));

// === Старт и привязка вебхука ===
app.listen(PORT, '0.0.0.0', async () => {
  // на всякий случай сносим старую привязку
  await fetch(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`, { method: 'POST' });
  // ставим новую привязку с секретом и нужными типами апдейтов
  await bot.setWebHook(hookUrl, {
    allowed_updates: ['message', 'callback_query'],
    secret_token:     SECRET,  // Telegram пришлёт этот заголовок
    drop_pending_updates: true
  });
  console.log('Webhook url:', hookUrl);
  console.log('Server listening on', PORT);
});
