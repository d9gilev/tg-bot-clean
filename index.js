// index.js — стабильный webhook с секретом и надёжными логами
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require("openai");
const oa = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const cron = require('node-cron');

const TOKEN  = process.env.BOT_TOKEN;
const BASE   = process.env.WEBHOOK_URL;     // https://…up.railway.app
const PATH   = process.env.WH_PATH;         // напр. "/tg/ab12cd34"
const SECRET = process.env.WH_SECRET;       // напр. "s3cr3t_XYZ"
const PORT   = Number(process.env.PORT || 8080);
const ADMIN_ID = (process.env.ADMIN_ID || '').trim();

// === COMPAT for old food-flow ===
// УДАЛЕНО: expectingFood - теперь используется user.awaitingMeal в state Map

if (!TOKEN || !BASE || !PATH || !SECRET) {
  console.error('Missing ENV vars:');
  console.error('BOT_TOKEN:', TOKEN ? 'OK' : 'MISSING');
  console.error('WEBHOOK_URL:', BASE ? 'OK' : 'MISSING');
  console.error('WH_PATH:', PATH ? 'OK' : 'MISSING');
  console.error('WH_SECRET:', SECRET ? 'OK' : 'MISSING');
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

// ==== SETTINGS ====
const DAY_LIMIT_MEALS = 4; // базовый лимит на день (перекусов)
const TZ = process.env.TZ || 'Europe/Amsterdam'; // можно поменять на свой

// если план у юзера задаёт лимит — берём его, иначе дефолт
function limitMealsFor(user) {
  const planLimit = user?.plan?.meals_limit;
  return Number.isFinite(planLimit) && planLimit > 0 ? planLimit : DAY_LIMIT_MEALS;
}

// сегодня: объект с приёмами
function getMealsToday(user) {
  const key = dayKeyNow();
  if (!user.mealsByDate[key]) user.mealsByDate[key] = { list: [] };
  return user.mealsByDate[key];
}

// ==== RUNTIME STATE (in-memory MVP) ====
// В проде заменим на БД. Сейчас — простая Map в памяти.
const state = new Map(); // chatId -> { mealsByDate: { [dayKey]: { list: Meal[] } }, awaitingMeal: boolean, homeMsgId?: number }
function getUser(chatId) {
  if (!state.has(chatId)) {
    state.set(chatId, {
      chatId,                 // <<< ВАЖНО: сохраняем chatId
      mealsByDate: {},
      awaitingMeal: false,
      homeMsgId: null,
      tz: process.env.TZ || 'Europe/Amsterdam'
    });
  } else {
    // если объект уже есть, но chatId в нём отсутствует — допишем
    const u = state.get(chatId);
    if (!u.chatId) u.chatId = chatId;
  }
  return state.get(chatId);
}

// Дата-сутки по TZ: 'YYYY-MM-DD'
function dayKeyNow() {
  const now = new Date();
  const iso = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  const y = iso.getFullYear();
  const m = String(iso.getMonth() + 1).padStart(2, '0');
  const d = String(iso.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Мини-анализ еды (плейсхолдер; позже подключим GPT)
function mealFeedback(text) {
  const t = (text || '').toLowerCase();
  const tips = [];

  if (/(омлет|яйц)/.test(t)) tips.push('Отлично: есть белок.');
  if (/(кур|индей|рыб|творог|сыр|йогурт|говя)/.test(t)) tips.push('Белок ок — держим темп.');
  if (/(салат|овощ|зелень|буряк|шпинат|огурц|помидор)/.test(t)) tips.push('Овощи — супер для объёма и клетчатки.');
  if (/(жарен|фритюр|булк|слад|печен|кекс|торт|сода|кола|фаст)/.test(t)) tips.push('Много быстрых углей/жира — на следующем приёме сбалансируй белком/овощами.');
  if (/(пицц|суши|бургер|шаурм)/.test(t)) tips.push('Ок изредка; постарайся добавить белок и овощи.');
  if (!/(кур|рыб|творог|омлет|яйц|говя|индей|сыр|йогурт)/.test(t)) tips.push('В этом приёме мало явного белка — добавь 20–40 г в следующий.');

  // не больше 2–3 пунктов
  return 'Фидбэк: ' + tips.slice(0, 3).join(' ');
}

// Удалено - функция перенесена выше

// === Back-compat alias: старый код может звать ensureUser(...)
function ensureUser(chatId) { return getUser(chatId); }

// === Компактная совместимость с прежней логикой "ожидаем еду"
const expectingFood = new Set();

// === UI (экраны/хаб) ===
const getUI = (u) => { u.ui ??= {}; return u.ui; };

const navKb = (active = 'home') => {
  const b = (id, title) => ({ text: (active === id ? `• ${title}` : title), callback_data: `nav:${id}` });
  return {
    inline_keyboard: [
      [b('home','🏠 Главная'), b('plan','📅 План')],
      [b('food','🍽️ Еда'), b('reports','📝 Отчёты')],
      [b('settings','⚙️ Настройки')]
    ]
  };
};

const renderScreen = (u, screen = 'home') => {
  const p = u.plan || {};
  if (screen === 'plan') {
    const w = Array.isArray(p.workouts) ? p.workouts.join(' · ') : 'ещё нет';
    return {
      html:
`<b>📅 Твой план на 30 дней</b>
Цель: ${p.goal || '—'}
Силовые: ${p.days_per_week || '—'}×/нед (${p.session_length || '—'})
Схема: ${w}
Питание: ~${p.daily_kcal || '—'} ккал/день, белок ${p.protein_g_per_kg || '1.6'} г/кг
Вода: ~${p.water_goal_ml || 2200} мл, сон ⩾ ${p.sleep_goal_h || 7} ч`,
      kb: navKb('plan')
    };
  }
  if (screen === 'food') {
    return {
      html:
`<b>🍽️ Еда</b>
Лимит приёмов: ${(p.meals_limit ?? 4)}/день.
Пришли скрин/описание одним сообщением — я сохраню и учту в дневной сводке.`,
      kb: navKb('food')
    };
  }
  if (screen === 'reports') {
    return {
      html:
`<b>📝 Отчёты</b>
Нажми «📝 Отчёт» внизу и пришли текст/фото — я отвечу <i>одним, но ёмким</i> предложением (ИИ).`,
      kb: navKb('reports')
    };
  }
  if (screen === 'settings') {
    const creatine = p.creatine_ok === true ? 'Да' : (p.creatine_ok === false ? 'Нет' : 'Не выбрано');
    return {
      html:
`<b>⚙️ Настройки</b>
— Режим пинков: ${u.reminder_mode || 'Soft'}
— TZ: ${u.tz || 'Europe/Amsterdam'}
— Креатин: ${creatine}`,
      kb: navKb('settings')
    };
  }
  // home
  return {
    html:
`<b>🏠 Главная</b>
Здесь будут напоминания (вода/тренировка) и «споки».
Выбирай экран ниже: план, еда, отчёты, настройки.`,
    kb: navKb('home')
  };
};

async function ensureHubMessage(bot, chatId, screen = 'home') {
  const u  = getUser(chatId);
  const ui = u.ui ?? (u.ui = {});
  const { html, kb } = renderScreen(u, screen);

  if (ui.hubMessageId) {
    try {
      await bot.editMessageText(html, {
        chat_id: assertChatId(chatId),                 // <<< используем ПАРАМЕТР
        message_id: ui.hubMessageId,
        parse_mode: 'HTML',
        reply_markup: kb
      });
      ui.activeScreen = screen;
      return;
    } catch (e) {
      ui.hubMessageId = null; // переотправим ниже
    }
  }

  const sent = await bot.sendMessage(assertChatId(chatId), html, { parse_mode:'HTML', reply_markup: kb });
  ui.hubMessageId = sent.message_id;
  ui.activeScreen = screen;
  try { await bot.pinChatMessage(assertChatId(chatId), sent.message_id); } catch {}
}

// УДАЛЕНО: expectingFood - теперь используется user.awaitingMeal в state Map

// === FOOD HELPERS ===
// Заглушки для старого кода - используют новую систему state Map
function mealsCountToday(chatId, tz = "Europe/Amsterdam") {
  const user = getUser(chatId);
  const today = getMealsToday(user);
  return today.list.length;
}

function addFood(chatId, entry) {
  const user = getUser(chatId);
  const today = getMealsToday(user);
  const timestamp = new Date().toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  today.list.push({ 
    text: entry.text || (entry.photo_file_id ? '(Фото/скрин)' : '(без текста)'), 
    time: timestamp 
  });
}

function foodSummaryToday(chatId, tz="Europe/Amsterdam") {
  const user = getUser(chatId);
  const today = getMealsToday(user);
  if (!today.list.length) return "Сегодня записей по еде нет.";
  return today.list.map((m, i) => `${i + 1}) ${m.time} — ${m.text}`).join('\n');
}

// === AI FEEDBACK ===
async function coachFeedbackOneSentence({ name, goal, plan, report }) {
  try {
    const resp = await oa.responses.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      max_output_tokens: 120,
      input: [
        { role: "system", content: "Ты поддерживающий, но честный фитнес-тренер/нутриционист. Дай РОВНО одно предложение: похвали, укажи 1–2 корректировки к следующей сессии. Без мед. советов." },
        { role: "user", content: `Имя: ${name}\nЦель: ${goal}\nПлан: ккал ~${plan?.daily_kcal}, белок ${plan?.protein_g_per_kg} г/кг, тренировки ${plan?.days_per_week}×/нед.\nОтчёт: ${report}` }
      ]
    });
    return resp.output_text?.trim() || "Принял отчёт.";
  } catch (e) {
    console.error("GPT error:", e?.response?.data || e);
    return "Принял отчёт. Продолжай!";
  }
}

// === REMINDERS HELPERS ===
// равномерное распределение тренировок по неделе (очень грубо, MVP)
function trainingDaysFor(u){
  const d = u.plan?.days_per_week || 3;
  if (d === 2) return [1,4];           // Пн, Чт
  if (d === 3) return [1,3,5];         // Пн, Ср, Пт
  if (d === 4) return [1,2,4,6];       // Пн, Вт, Чт, Сб
  return [1,3,5]; // дефолт
}
function isTrainingDay(u, date){
  const dow = Number(new Intl.DateTimeFormat('ru-RU',{weekday:'short', timeZone:u.tz||'Europe/Amsterdam'})
    .formatToParts(date).find(p=>p.type==='weekday')?.value ? date.getDay() : date.getDay());
  // JS: 0=Вс..6=Сб; приведём к 1=Пн..7=Вс
  const norm = (date.getUTCDay()+6)%7 + 1;
  return trainingDaysFor(u).includes(norm);
}
function hhmm(date, tz){ return new Date(date).toLocaleTimeString('ru-RU',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false}); }
function todayStr(date, tz){ return new Date(date).toLocaleDateString('ru-RU',{timeZone:tz}); }

// УДАЛЕНО: sentFlags - больше не используется в новой архитектуре

// небольшой джиттер (±10 минут)
function jitter(baseMinutes = 0, span = 10){ return baseMinutes + Math.floor((Math.random()*2-1)*span); }

// === МИНИ-ОНБОРДИНГ ===
const ONB_QUESTIONS = [
  { key:"name",         type:"text",   q:"Как к тебе обращаться?" },
  { key:"sex",          type:"single", q:"Пол:", opts:["М","Ж"] },
  { key:"age",          type:"number", q:"Возраст (лет):", min:14, max:90 },
  { key:"height_cm",    type:"number", q:"Рост (см):",     min:130, max:220 },
  { key:"weight_kg",    type:"number", q:"Вес (кг):",      min:35,  max:250 },
  { key:"steps_level",  type:"single", q:"Средняя активность (шагов/день):", opts:["<5k","5–8k","8–11k",">11k"] },
  { key:"goal",         type:"single", q:"Главная цель:", opts:["Похудение","Набор мышечной массы","Поддержание здоровья и самочувствия","Увеличение производительности"] },
  { key:"days_per_week",type:"number", q:"Сколько тренировок в неделю?", min:1, max:6 },
  { key:"session_length",type:"single", q:"Длительность одной тренировки:", opts:["60 мин","75 мин","90 мин"] },
  { key:"equipment",    type:"text",   q:"Где/что доступно? Введи через запятую из списка:\nДом, Зал, Улица, Штанга, Гантели, Тренажёры, Турник, Эспандеры, Дорожка/вело, Бассейн" },
  { key:"dislikes",     type:"text",   q:"Что НЕ нравится/не подходит? (через запятую)" }
];

const onbState = {}; // per chat: {i, answers}

const askNext = (chatId) => {
  const st = onbState[chatId];
  const step = ONB_QUESTIONS[st.i];
  if (!step) return;
  if (step.type === "single") {
    bot.sendMessage(chatId, step.q, { 
      reply_markup: { 
        keyboard: [step.opts.map(o=>({text:o}))], 
        resize_keyboard:true, 
        one_time_keyboard:true 
      } 
    });
  } else {
    bot.sendMessage(chatId, step.q, { 
      reply_markup: { remove_keyboard: true } 
    });
  }
};

const validate = (step, text) => {
  if (step.type==="number"){
    const n = Number((text||"").replace(",","."));
    if (Number.isNaN(n)) return { ok:false, err:"Нужна цифра." };
    if (step.min && n < step.min) return { ok:false, err:`Минимум ${step.min}.` };
    if (step.max && n > step.max) return { ok:false, err:`Максимум ${step.max}.` };
    return { ok:true, val:n };
  }
  if (step.type==="single"){
    if (!step.opts.includes(text)) return { ok:false, err:"Выбери из кнопок ниже." };
    return { ok:true, val:text };
  }
  // text
  const v = (text||"").trim();
  if (!v) return { ok:false, err:"Напиши ответ текстом." };
  return { ok:true, val:v };
};

// === ГЕНЕРАТОР ПЛАНА ===
const mifflinStJeor = ({ sex, weight, height, age }) => {
  const s = (sex === "М" || sex === "M") ? 5 : -161;
  return Math.round(10 * weight + 6.25 * height - 5 * age + s); // RMR
};

const palFromSteps = (steps_level) => { 
  return {"<5k":1.3,"5–8k":1.45,"8–11k":1.6,">11k":1.75}[steps_level] || 1.4; 
};

const kcalByGoal = (tdee, goal) => { 
  if(goal==="Похудение") return Math.round(tdee*0.85); 
  if(goal==="Набор мышечной массы") return Math.round(tdee*1.10); 
  return Math.round(tdee); 
};

const defaultWorkouts = (days) => { 
  const map={2:["Full Body A","Full Body B"],3:["Upper","Lower","Full"],4:["Upper","Lower","Push","Pull"]}; 
  return map[days]||map[3]; 
};

const createPlanFromAnswers = (a) => {
  const rmr  = mifflinStJeor({ sex:a.sex, weight:+a.weight_kg||70, height:+a.height_cm||170, age:+a.age||30 });
  const tdee = Math.round(rmr * palFromSteps(a.steps_level));
  const daily_kcal = kcalByGoal(tdee, a.goal);

  const plan = {
    goal: a.goal,
    days_per_week: +a.days_per_week || 3,
    session_length: a.session_length || "60 мин",
    equipment: Array.isArray(a.equipment) ? a.equipment : String(a.equipment||"").split(",").map(s=>s.trim()).filter(Boolean),
    dislikes: Array.isArray(a.dislikes) ? a.dislikes : String(a.dislikes||"").split(",").map(s=>s.trim()).filter(Boolean),
    daily_kcal,
    protein_g_per_kg: 1.6,
    meals_limit: 4,
    water_goal_ml: 2200,
    sleep_goal_h: 7,
    workouts: defaultWorkouts(+a.days_per_week || 3), // типы сессий
    goodnight_window: "23:00±10m",
    creatine_ok: a.creatine_ok ?? null
  };

  const start = new Date(); const end = new Date(); end.setDate(start.getDate()+30);
  return { plan, plan_start: start.toISOString(), plan_end: end.toISOString(), plan_status:"active" };
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

// ==== KEYBOARDS ====
// Постоянное главное меню
const mainKb = {
  reply_markup: {
    keyboard: [
      [{ text: '📅 План' }, { text: '🍽️ Еда' }],
      [{ text: '📝 Отчёт' }, { text: '📊 Итоги дня' }],
      [{ text: '🧭 Анкета' }, { text: '🏠 Главная' }]
    ],
    resize_keyboard: true,
    is_persistent: true
  }
};

// Временная клавиатура-сигнал "готово/отмена" при вводе еды
const doneKb = {
  reply_markup: {
    keyboard: [[{ text: '✅ Готово' }], [{ text: '↩️ Отмена' }]],
    resize_keyboard: true,
    one_time_keyboard: true // спрячется после нажатия
  }
};

function homeText(user, profile = {}) {
  const mealsToday = getMealsToday(user).list.length;
  const limit = limitMealsFor(user);
  const left = Math.max(0, limit - mealsToday);

  const kcal  = profile.kcal  || '…';
  const prt   = profile.prt   || '…';
  const water = profile.water || '…';
  const days  = profile.days  || '…';

  const lines = [
    'Привет, я Павел — твой персональный тренер! 💪',
    '',
    `Я собираю план, считаю ${kcal}, даю чёткие задания и пинаю, когда надо.`,
    'Основа — ВОЗ/ACSM и лучшие практики. Ты тренируешься — я думаю за тебя.',
    '',
    'Что внутри:',
    `• Силовые ${days}×/нед + кардио Z2.`,
    `• Питание: ${kcal}, белок ${prt}.`,
    `• Вода: ~${water} мл, сон ⩾ 7 ч.`,
    '• Напоминания вовремя и честный фидбэк после каждой сессии.',
    ''
  ];

  if (left > 0) {
    lines.push(`🍽️ Осталось перекусов: ${left}`);
  } else {
    lines.push('🍏 Еда на сегодня закончилась — съешь яблочко!');
  }

  lines.push('', 'Поехали? Нажимай ниже 👇');
  return lines.join('\n');
}

// Отправить/обновить «дом»
async function sendOrUpdateHome(bot, chatId, profile) {
  const user = getUser(chatId);
  const text = homeText(user, profile);

  if (user.homeMsgId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: user.homeMsgId, ...mainKb });
      return;
    } catch (e) {
      // если старое сообщение нельзя отредактировать — пришлём новое
      user.homeMsgId = null;
    }
  }
  const msg = await bot.sendMessage(assertChatId(chatId), text, mainKb);
  user.homeMsgId = msg.message_id;
}

// Проверка chat_id
function assertChatId(x) {
  if (!x) throw new Error('chat_id is empty (guard)');
  return x;
}

// Удаляем служебные сообщения (чистим чат)
async function tryDelete(bot, chatId, msgIdToDelete, keepId) {
  try {
    if (msgIdToDelete && msgIdToDelete !== keepId) {
      await bot.deleteMessage(assertChatId(chatId), msgIdToDelete);
    }
  } catch (_) {}
}

// === ХЕНДЛЕРЫ ===
// Включает «режим ожидания отчёта»
const expectingReport = new Set();

bot.on('message', async (msg) => {
  try {
    if (!msg.text && !msg.photo) return;
    const t = msg.text || '';
    
    console.log('Handler saw message:', msg.message_id, t);
  
  const u = getUser(msg.chat.id);

  // завершение/отмена
  if (t === '✅ Готово') {
    u.awaitingMeal = false;
    await sendOrUpdateHome(bot, msg.chat.id);
    await bot.sendMessage(msg.chat.id, 'Готово! Возвращаю главное меню.', mainKb);
    return;
  }
  if (t === '↩️ Отмена') {
    u.awaitingMeal = false;
    await bot.sendMessage(msg.chat.id, 'Отменил ввод. Возвращаюсь в главное меню.', mainKb);
    return;
  }

  // если ждём еду — обрабатываем ввод
  if (u.awaitingMeal) {
    // соберём текст
    let mealText = '';
    if (msg.text) mealText = msg.text.trim();
    if (!mealText && msg.caption) mealText = msg.caption.trim();
    const hasPhoto = !!(msg.photo && msg.photo.length);

    if (!mealText && !hasPhoto) return;

    const today = getMealsToday(u);
    const limit = limitMealsFor(u);

    if (today.list.length >= limit) {
      u.awaitingMeal = false;
      await bot.sendMessage(msg.chat.id, '🍏 Еда на сегодня закончилась — съешь яблочко!', mainKb);
      await sendOrUpdateHome(bot, msg.chat.id);
      return;
    }

    // сохранить приём
    const time = new Date().toLocaleTimeString('ru-RU', { timeZone: u.tz || TZ, hour: '2-digit', minute: '2-digit' });
    today.list.push({ time, text: mealText || (hasPhoto ? '(Фото/скрин)' : '(без текста)') });

    // быстрый фидбэк
    await bot.sendMessage(msg.chat.id, mealFeedback(mealText));

    // обновим «дом»
    await sendOrUpdateHome(bot, msg.chat.id);

    // если достигли лимита — закрываем режим и предлагаем итоги
    if (today.list.length >= limit) {
      u.awaitingMeal = false;
      await bot.sendMessage(msg.chat.id, 'Ты заполнил(а) дневной лимит. Готов подвести «📊 Итоги дня»?', mainKb);
    }
    return;
  }
  
  // Кнопка "📅 План"
  if (t === "📅 План") {
    const u = ensureUser(msg.chat.id);
    if (!u.plan) {
      return bot.sendMessage(assertChatId(u.chatId), "Сначала пройди «🧭 Анкета» — соберу план за 2 минуты.");
    }

    const start = new Date(u.plan_start);
    const end   = new Date(u.plan_end);
    const days  = u.plan.days_per_week;
    const scheme = u.plan.workouts.join(" · ");

    bot.sendMessage(assertChatId(u.chatId),
      `Твой план (30 дней)\n` +
      `Период: ${start.toLocaleDateString()} — ${end.toLocaleDateString()}\n` +
      `Цель: ${u.plan.goal}\n` +
      `Силовые: ${days}×/нед (${u.plan.session_length}), схема: ${scheme}\n` +
      `Кардио: Z2 по 20–30 мин 2–3×/нед (после силовой)\n` +
      `Питание: ~${u.plan.daily_kcal} ккал/день, белок ${u.plan.protein_g_per_kg} г/кг\n` +
      `Вода: ~${u.plan.water_goal_ml} мл, сон ⩾ ${u.plan.sleep_goal_h} ч`
    );
    return;
  }

  // Кнопка "🍽️ Еда" → проверяем лимит
  if (t === "🍽️ Еда") {
    const u = getUser(msg.chat.id);
    const today = getMealsToday(u);
    const limit = limitMealsFor(u);
    const left  = Math.max(0, limit - today.list.length);

    if (left <= 0) {
      await bot.sendMessage(u.chatId || msg.chat.id, '🍏 Еда на сегодня закончилась — съешь яблочко!', mainKb);
      await sendOrUpdateHome(bot, msg.chat.id);
      return;
    }

    u.awaitingMeal = true;
    await bot.sendMessage(
      msg.chat.id,
      `Пришли еду текстом (например: «омлет с сыром») или фото с подписью.\nОсталось перекусов: ${left}\nПосле завершения нажми «✅ Готово».`,
      {
        reply_markup: {
          keyboard: [[{ text: '✅ Готово' }], [{ text: '↩️ Отмена' }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
    return;
  }



  // Кнопка/фраза «📊 Итоги дня»
  if (t === "📊 Итоги дня") {
    const u = getUser(msg.chat.id);
    const today = getMealsToday(u);
    if (today.list.length === 0) {
      await bot.sendMessage(msg.chat.id, 'Сегодня приёмов еды нет. Начни с «🍽️ Еда».', mainKb);
      return;
    }

    const lines = today.list.map((m, i) => `${i + 1}) ${m.time} — ${m.text}`);
    // простая оценка дня (как раньше)
    const joined = today.list.map(m => m.text).join(' ').toLowerCase();
    let grade = 'ОК';
    if (/(торт|кекс|фаст|бургер|слад|кока|пицц)/.test(joined)) grade = 'Ниже цели';
    if (/(салат|овощ|творог|кур|рыб|омлет|яйц|индей)/.test(joined)) grade = (grade === 'Ниже цели') ? 'Смешанно' : 'Отлично';

    const summary = [
      '📊 Итоги дня по еде:',
      ...lines,
      '',
      `Оценка дня: ${grade}`,
      'Рекомендация: держи белок 20–40 г в каждом приёме, добавляй овощи; сладкое — умеренно, лучше к тренировке.'
    ].join('\n');

    await bot.sendMessage(msg.chat.id, summary, mainKb);
    return;
  }

  // Кнопка "🏠 Главная"
  if (t === "🏠 Главная") {
    await sendOrUpdateHome(bot, msg.chat.id);
    return;
  }

  // Кнопка "🛠 Админ"
  if (t === '🛠 Админ') {
    if (String(msg.from.id) !== (process.env.ADMIN_ID || '').trim()) {
      return bot.sendMessage(msg.chat.id, 'Недостаточно прав.');
    }
    return bot.sendMessage(msg.chat.id, 'Админ-панель', {
      reply_markup: {
        inline_keyboard: [[
          { text: '♻️ Сброс МЕНЯ', callback_data: 'admin:reset_me' },
          { text: '🔥 Сброс ВСЁ',  callback_data: 'admin:reset_all' }
        ]]
      }
    });
  }

  // Любой свободный текст (если ждём отчёт) → отправляем в GPT
  if (expectingReport.has(msg.chat.id)) {
    // игнорируем нажатия по меню
    if (["📅 План","🍽️ Еда","💧 +250 мл","🧭 Анкета","🏠 Главная","👤 Профиль","❓ Помощь","/start","📊 Итоги дня"].includes(t)) {
      // не выходим из режима, просто игнор
    } else {
      expectingReport.delete(msg.chat.id);
      const u = ensureUser(msg.chat.id);
      const fb = await coachFeedbackOneSentence({
        name: u.name || msg.from.first_name,
        goal: u.plan?.goal || "Поддержание здоровья и самочувствия",
        plan: u.plan || {},
        report: t
      });
      await bot.sendMessage(assertChatId(u.chatId), fb);
      return;
    }
  }
  
  // Обработка ответов анкеты
  const st = onbState[msg.chat.id];
  if (st) {
    const step = ONB_QUESTIONS[st.i];
    if (!step) return;

    const { ok, err, val } = validate(step, msg.text);
    if (!ok) return bot.sendMessage(msg.chat.id, err);

    st.answers[step.key] = val;
    st.i += 1;

    if (st.i < ONB_QUESTIONS.length) {
      askNext(msg.chat.id);
    } else {
      // анкета готова → создаём план
      const built = createPlanFromAnswers(st.answers);
      const u = ensureUser(msg.chat.id);
      Object.assign(u, { ...built, name: st.answers.name || u.name || msg.from.first_name });

      delete onbState[msg.chat.id];
      bot.sendMessage(assertChatId(u.chatId),
        `План готов ✅\n\n` +
        `Цель: ${built.plan.goal}\n` +
        `Тренировок/нед: ${built.plan.days_per_week} (${built.plan.session_length})\n` +
        `Ккал/день: ~${built.plan.daily_kcal}\n` +
        `Белок: ${built.plan.protein_g_per_kg} г/кг\n` +
        `Вода: ~${built.plan.water_goal_ml} мл\n` +
        `Сон: ⩾${built.plan.sleep_goal_h} ч\n` +
        `Схема силовых: ${built.plan.workouts.join(" · ")}`,
        { reply_markup: mainKb }
      );
    }
    return;
  }
  
  } catch (e) {
    console.error('Handler error:', e); // чтобы процесс не падал
  }
});

bot.onText(/^\/start$/, async (msg) => {
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
    Object.assign(u, { ...built, name: u.name || msg.from.first_name });
  }
  const user = ensureUser(msg.chat.id);
  bot.sendMessage(assertChatId(msg.chat.id), welcomeText(user), { 
    parse_mode: 'HTML', 
    reply_markup: mainKb 
  });
  await ensureHubMessage(bot, msg.chat.id, 'home');
  // Можно сразу спросить про креатин:
  // askCreatine(msg.chat.id);
});

// Старт анкеты
bot.onText(/^🧭 Анкета$/, (msg) => {
  onbState[msg.chat.id] = { i:0, answers:{} };
  askNext(msg.chat.id);
});

bot.onText(/^📝 Отчёт$/, (msg)=>{
  expectingReport.add(msg.chat.id);
  bot.sendMessage(msg.chat.id, "Опиши тренировку одним сообщением (можно фото + подпись).");
});

// Узнать свой numeric id (временная утилита)
bot.onText(/^\/whoami$/, (msg) => {
  bot.sendMessage(msg.chat.id, `ID: ${msg.from.id}`);
});

// Полный сброс всего in-memory стейта (РАЗРАБОТЧИК)
bot.onText(/^\/admin_reset$/, async (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) return bot.sendMessage(msg.chat.id, 'Нет прав');
  state.clear();
  await bot.sendMessage(msg.chat.id, 'Админ: весь локальный стейт сброшен. Нажми /start.');
});

// Простейшая статистика
bot.onText(/^\/admin_stats$/, async (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) return bot.sendMessage(msg.chat.id, 'Нет прав');
  await bot.sendMessage(msg.chat.id, `Активных чатов в памяти: ${state.size}`);
});

bot.on('callback_query', async (q) => {
  try {
    console.log('CQ:', q.id, q.data); // ДОЛЖНО появляться в логах при клике
    const data = q.data || '';

    if (/^nav:(home|plan|food|reports|settings)$/.test(data)) {
      const screen = data.split(':')[1];
      const chatId = q.message?.chat?.id || q.from.id; // если inline
      await ensureHubMessage(bot, chatId, screen);
      return bot.answerCallbackQuery(q.id); // гасим "часики"
    }

    if (data === 'admin:reset_me') {
      if (String(q.from.id) !== ADMIN_ID) {
        return bot.answerCallbackQuery(q.id, { text: 'Нет прав' });
      }
      const chatId = q.message?.chat?.id || q.from.id; // на случай inline
      state.set(chatId, {
        chatId,                         // <<< НЕ теряем chatId
        mealsByDate: {},
        awaitingMeal: false,
        homeMsgId: null,
        tz: process.env.TZ || 'Europe/Amsterdam'
      });
      await bot.answerCallbackQuery(q.id, { text: 'Сброшено (только ты).' });
      return bot.sendMessage(assertChatId(chatId), 'Твои данные сброшены. Нажми /start.');
    }
    
    if (data === 'admin:reset_all') {
      if (String(q.from.id) !== ADMIN_ID) {
        return bot.answerCallbackQuery(q.id, { text: 'Нет прав' });
      }
      state.clear();
      await bot.answerCallbackQuery(q.id, { text: 'Полный сброс.' });
      return bot.sendMessage(q.message.chat.id, 'Глобальный сброс выполнен. Нажмите /start.');
    }

  } catch (e) {
    console.error('CQ error:', e);
  }
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
  console.log(`Server listening on ${PORT}`);
  console.log('Webhook URL:', hookUrl);
  console.log('SECRET length:', SECRET?.length || 0);
  
  // Проверяем SECRET токен
  if (SECRET.length < 1 || SECRET.length > 256) {
    console.error('SECRET token length must be 1-256 characters, got:', SECRET.length);
    return;
  }
  
  try {
    // на всякий случай сносим старую привязку
    console.log('Deleting old webhook...');
    await fetch(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`, { method: 'POST' });
    
    // ставим новую привязку с секретом и нужными типами апдейтов
    console.log('Setting new webhook...');
    const result = await bot.setWebHook(hookUrl, {
      secret_token: SECRET,  // Telegram пришлёт этот заголовок
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    });
    console.log('Webhook set result:', result);
  } catch (error) {
    console.error('Webhook setup error:', error);
    console.error('Error details:', error?.response?.body || error.message);
  }
});
