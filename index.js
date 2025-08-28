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
  food: [], 
  workouts: [] 
};

const ensureUser = (chatId) => {
  if (!db.users[chatId]) {
    db.users[chatId] = { 
      chatId, 
      name: null, 
      tz: "Europe/Amsterdam", 
      plan: null, 
      reminder_mode: "Soft" 
    };
  }
  return db.users[chatId];
};

const setUser = (chatId, patch) => {
  db.users[chatId] = { ...(db.users[chatId] || {}), ...patch };
  return db.users[chatId];
};

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

const ensureHubMessage = async (bot, u, screen = 'home') => {
  const ui = getUI(u);
  const { html, kb } = renderScreen(u, screen);

  if (ui.hubMessageId) {
    try {
      await bot.editMessageText(html, {
        chat_id: u.chatId,
        message_id: ui.hubMessageId,
        parse_mode: 'HTML',
        reply_markup: kb
      });
      ui.activeScreen = screen;
      return;
    } catch (e) {
      console.warn('editMessageText failed, resend hub:', e?.response?.body || e.message);
      ui.hubMessageId = null; // переотправим ниже
    }
  }

  const sent = await bot.sendMessage(u.chatId, html, { parse_mode: 'HTML', reply_markup: kb });
  ui.hubMessageId = sent.message_id;
  ui.activeScreen = screen;
  try { await bot.pinChatMessage(u.chatId, sent.message_id); } catch (e) {
    console.log('pinChatMessage skipped:', e?.response?.body || e.message);
  }
};

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
  if (!msg.text) return;
  
  const t = msg.text;
  
  // Кнопка "📅 План"
  if (t === "📅 План") {
    const u = ensureUser(msg.chat.id);
    if (!u.plan) {
      return bot.sendMessage(u.chatId, "Сначала пройди «🧭 Анкета» — соберу план за 2 минуты.");
    }

    const start = new Date(u.plan_start);
    const end   = new Date(u.plan_end);
    const days  = u.plan.days_per_week;
    const scheme = u.plan.workouts.join(" · ");

    bot.sendMessage(u.chatId,
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
      setUser(u.chatId, { ...built, name: st.answers.name || u.name || msg.from.first_name });

      delete onbState[msg.chat.id];
      bot.sendMessage(u.chatId,
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
    setUser(u.chatId, { ...built, name: u.name || msg.from.first_name });
  }
  const user = ensureUser(msg.chat.id);
  bot.sendMessage(msg.chat.id, welcomeText(user), { 
    parse_mode: 'HTML', 
    reply_markup: mainKb 
  });
  await ensureHubMessage(bot, ensureUser(msg.chat.id), 'home');
  // Можно сразу спросить про креатин:
  // askCreatine(msg.chat.id);
});

// Старт анкеты
bot.onText(/^🧭 Анкета$/, (msg) => {
  onbState[msg.chat.id] = { i:0, answers:{} };
  askNext(msg.chat.id);
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
