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

// === БАЗА ДАННЫХ (в памяти для MVP) ===
const db = {
  users: {},
  foods: {},
  workouts: {}
};

const ensureUser = (chatId) => {
  if (!db.users[chatId]) {
    db.users[chatId] = {
      chatId,
      name: null,
      plan: null,
      sex: null,
      age: null,
      weight_kg: null,
      height_cm: null,
      steps_level: null,
      goal: null,
      days_per_week: null,
      session_length: null,
      equipment: [],
      dislikes: []
    };
  }
  return db.users[chatId];
};

const setUser = (chatId, data) => {
  db.users[chatId] = { ...db.users[chatId], ...data };
};

// === ФУНКЦИИ ДЛЯ ПЛАНОВ ===
const mifflinStJeor = (sex, age, weight, height) => {
  const bmr = sex === 'М' ? 
    10 * weight + 6.25 * height - 5 * age + 5 :
    10 * weight + 6.25 * height - 5 * age - 161;
  return Math.round(bmr);
};

const palFromSteps = (steps) => {
  const stepMap = {
    'менее 5k': 1.2,
    '5–8k': 1.375,
    '8–10k': 1.55,
    '10k+': 1.725
  };
  return stepMap[steps] || 1.375;
};

const kcalByGoal = (tdee, goal) => {
  const goalMap = {
    'Похудение': 0.85,
    'Поддержание здоровья и самочувствия': 1.0,
    'Набор мышечной массы': 1.15
  };
  return Math.round(tdee * (goalMap[goal] || 1.0));
};

const defaultWorkouts = (days, equipment) => {
  const workouts = [];
  const hasWeights = equipment.includes('гантели') || equipment.includes('штанга');
  
  for (let i = 1; i <= days; i++) {
    workouts.push({
      day: i,
      type: i % 2 === 0 ? 'кардио' : 'силовая',
      exercises: hasWeights ? 
        ['Приседания', 'Жим лежа', 'Становая тяга'] :
        ['Отжимания', 'Приседания', 'Планка'],
      duration: '45-60 мин'
    });
  }
  return workouts;
};

const createPlanFromAnswers = (answers) => {
  const bmr = mifflinStJeor(answers.sex, answers.age, answers.weight_kg, answers.height_cm);
  const pal = palFromSteps(answers.steps_level);
  const tdee = Math.round(bmr * pal);
  const daily_kcal = kcalByGoal(tdee, answers.goal);
  const protein_g_per_kg = answers.goal === 'Набор мышечной массы' ? 2.0 : 1.6;
  
  return {
    plan: {
      daily_kcal,
      protein_g_per_kg,
      workouts: defaultWorkouts(answers.days_per_week, answers.equipment),
      goal: answers.goal,
      days_per_week: answers.days_per_week
    }
  };
};

// === ПРОДАЮЩЕЕ ПРИВЕТСТВИЕ ===
const welcomeText = (u) => {
  const kcal  = u?.plan?.daily_kcal ? `~${u.plan.daily_kcal} ккал/день` : `дневную норму ккал`;
  const prt   = u?.plan?.protein_g_per_kg ? `${u.plan.protein_g_per_kg} г/кг` : `≈1.6 г/кг`;
  const days  = u?.plan?.days_per_week   || 3;
  const water = u?.plan?.water_goal_ml   || 2200;

  return (
`👋 Привет, я Павел - твой персональный тренер!

Я анализирую твои пожелания после чего собираю для тебя персональный план работы, считаю твои колории, даю четкие задания и пинаю, когда надо.
Основа — методики ВОЗ/ACSM и лучшие практики тренинга и питания. Ты тренируешься — я думаю за тебя.

<b>Что внутри:</b>
• 🏋️ Силовые ${days}×/нед + кардио Z2.
• 🍽️ Питание: ${kcal}, белок ${prt}.
• 💧 Вода: ~${water} мл, 😴 сон ⩾ 7 ч.
• ⏰ Напоминания вовремя и честный фидбэк после каждой сессии.

<b>🚀 Поехали?</b> Жми кнопку ниже:
— 📅 <b>План</b> — старт и расписание недели.
— 🍽️ <b>Еда</b> — фиксируй приёмы пищи (до 4/день).
— 📝 <b>Отчёт</b> — напиши о тренировке, я дам фидбэк.`
  );
};

// === КЛАВИАТУРА ГЛАВНОГО МЕНЮ ===
const mainKb = {
  keyboard: [
    [{ text: "📅 План" }, { text: "📝 Отчёт" }],
    [{ text: "🍽️ Еда" }, { text: "💧 +250 мл" }],
    [{ text: "🧭 Анкета" }, { text: "👤 Профиль" }],
    [{ text: "❓ Помощь" }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

// === ХЕНДЛЕРЫ ===
bot.on('message', (msg) => {
  console.log('Handler saw message:', msg.message_id, msg.text);
  // Убрал эхо - не засоряем чат
});

bot.onText(/^\/start$/, (msg) => {
  const u = ensureUser(msg.chat.id);
  if (!u.plan) {
    const answers = {
      sex: u.sex || "М", 
      age: u.age || 30, 
      weight_kg: u.weight_kg || 75, 
      height_cm: u.height_cm || 175,
      steps_level: u.steps_level || "5–8k",
      goal: u.goal || "Поддержание здоровья и самочувствия",
      days_per_week: u.days_per_week || 3, 
      session_length: u.session_length || "60 мин",
      equipment: u.equipment || [], 
      dislikes: u.dislikes || []
    };
    const built = createPlanFromAnswers(answers);
    setUser(u.chatId, { ...built, name: u.name || msg.from.first_name });
  }
  const user = ensureUser(msg.chat.id);
  bot.sendMessage(msg.chat.id, welcomeText(user), { 
    parse_mode: 'HTML', 
    reply_markup: mainKb 
  });
  // Можно сразу спросить про креатин:
  // askCreatine(msg.chat.id);
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
