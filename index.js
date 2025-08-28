require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN  = process.env.BOT_TOKEN;
const BASE   = process.env.WEBHOOK_URL;        // https://<твой>.up.railway.app
const PORT   = Number(process.env.PORT || 8080);
const PATH   = process.env.WH_PATH;            // например "/tg/ab12cd34"
const SECRET = process.env.WH_SECRET;          // "s3cr3t_XYZ"

if (!TOKEN || !BASE || !PATH || !SECRET) throw new Error('Нет переменных окружения');

const app = express();
app.use(express.json());

const bot = new TelegramBot(TOKEN, { webHook: { autoOpen: false } });
const hookUrl = `${BASE}${PATH}`;

// Логируем без токена:
console.log('Webhook url:', hookUrl);

app.post(PATH, (req, res) => {
  if (req.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) return res.sendStatus(401);
  console.log('Update:', req.body.update_id, req.body?.message?.text);
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (_req, res) => res.status(200).send('OK'));

app.listen(PORT, '0.0.0.0', async () => {
  await fetch(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`, { method: 'POST' });
  await bot.setWebHook(hookUrl, {
    allowed_updates: ['message','callback_query'],
    secret_token: SECRET,
    drop_pending_updates: true,
  });
  console.log('Server listening on', PORT);
});
