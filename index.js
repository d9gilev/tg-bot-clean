// index.js — стабильный webhook с секретом и надёжными логами
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// --- helpers ---
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function setWebHookSafe(bot, url, opts, label='setWebHook') {
  for (let i = 0; i < 4; i++) {
    try {
      const ok = await bot.setWebHook(url, opts);
      return ok;
    } catch (e) {
      const is429 = e?.code === 'ETELEGRAM' && e?.response?.statusCode === 429;
      const ra = e?.response?.body?.parameters?.retry_after ?? 1;
      if (is429) {
        console.warn(`[429] ${label}: retry in ${ra}s`);
        await wait((ra + 0.3) * 1000);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`[setWebHookSafe] failed after retries`);
}

// --- ВСТАВЬ ЭТУ функцию и ВЫЗЫВАЙ вместо своего кода настройки вебхука ---
async function ensureWebhook(bot) {
  const base = process.env.WEBHOOK_URL?.replace(/\/+$/, '') || '';
  const path = process.env.WH_PATH || '/tg/ab12cd34';
  const secret = process.env.WH_SECRET || 'secret';
  const url = `${base}${path}`;

  // 1) смотрим текущие настройки
  const info = await bot.getWebHookInfo(); // Bot API: getWebhookInfo
  // NB: в node-telegram-bot-api метод называется именно getWebHookInfo

  const needDrop = info.url !== url; // сбрасываем "хвост" только при смене URL
  const allowed = ['message', 'callback_query'];

  // если уже настроено — выходим
  const already =
    info.url === url &&
    Array.isArray(info.allowed_updates) &&
    allowed.every(x => info.allowed_updates.includes(x));

  if (already) {
    console.log('Webhook already OK:', info.url);
    return;
  }

  // 2) один-единственный setWebHook
  console.log('Setting webhook ->', url);
  await setWebHookSafe(bot, url, {
    secret_token: secret,
    allowed_updates: allowed,
    drop_pending_updates: needDrop
  }, 'setWebHook(init)');
  console.log('Webhook set.');
}
// Условный импорт OpenAI (только если есть API ключ)
let oa = null;
try {
  const OpenAI = require("openai");
  if (process.env.OPENAI_API_KEY) {
    oa = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
} catch (e) {
  console.log('OpenAI not available:', e.message);
}
const cron = require('node-cron');

// Подключаем модуль анкеты ОДИН раз
const onbMod = require('./src/onboarding-max');

// ===== Версия/диагностика, чтобы видеть свежий деплой =====
const BUILD = {
  sha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'local',
  startedAt: new Date().toISOString(),
  onb: 'ONB-2025-08-30'
};
console.log('BOOT:', BUILD);

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

// Регистрируем хендлеры анкеты 1 раз
if (!global.__ONB_REG__) {
  onbMod.registerOnboarding(bot);
  global.__ONB_REG__ = true;
  console.log('Onboarding: handlers registered (index.js)');
}

// Безопасная отправка — чтобы видеть ошибки API
const safeSend = (chatId, text, opts) =>
  bot.sendMessage(chatId, text, opts).catch(err => {
    console.error('sendMessage error:', err?.response?.body || err);
  });

// === A) Команды и главное меню ===

bot.setMyCommands([
  { command: 'version', description: 'Версия бота' },
  { command: 'start', description: 'Главное меню' },
  { command: 'menu', description: 'Показать меню' },
  { command: 'onboarding', description: 'Пройти анкету' },
  { command: 'onb_state', description: 'Диагностика анкеты' }
]).catch(console.error);

bot.onText(/^\/version$/, (msg) => {
  const short = BUILD.sha ? BUILD.sha.slice(0,7) : '—';
  bot.sendMessage(msg.chat.id, `Версия: ${BUILD.onb}\nCommit: ${short}\nStarted: ${BUILD.startedAt}`);
});



// Диагностика: показать состояние онбординга
bot.onText(/^\/onb_state$/, (msg) => {
  const u = onbMod.getUser(msg.chat.id);
  const state = u.onb ? { idx: u.onb.idx, waitingIntro: u.onb.waitingIntro, nextKey: (u.onb.idx !== undefined ? 'see logs' : null) } : 'none';
  console.log('ONB STATE', msg.chat.id, u.onb);
  bot.sendMessage(msg.chat.id, 'onb: ' + (u.onb ? JSON.stringify(u.onb, null, 2) : 'none'));
});

// Главное меню (ReplyKeyboard)
const mainKb = {
  keyboard: [
    [{ text: '🏠 Главная' }, { text: '📅 План' }],
    [{ text: '🍽️ Еда' }, { text: '📝 Отчёты' }],
    [{ text: '🧭 Анкета' }, { text: '⚙️ Настройки' }],
  ],
  resize_keyboard: true,
  one_time_keyboard: false,
};

// /start
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(
    chatId,
    'Привет, я Павел — твой персональный тренер! 💪\n\n' +
    'Готов собрать персональный план на 4 недели и вести тебя по нему. ' +
    'Нажми «🧭 Анкета», чтобы начать.',
    { reply_markup: mainKb, parse_mode: 'HTML' }
  );
});

// Явный запуск анкеты командой/кнопкой
bot.onText(/^\/onboarding$|^🧭 Анкета$/, async (msg) => {
  const chatId = msg.chat.id;
  // Старт новой анкеты (модуль сам ведёт состояние, наш код больше не лезет внутрь)
  await onbMod.startOnboarding(bot, chatId);
});

// 4) /menu — быстрый способ вернуть клавиатуру, если её сняли
bot.onText(/^\/menu$/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, 'Главное меню', { reply_markup: mainKb });
});







// === B) Анкета: модульная система ===

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

function setUser(chatId, patch) {
  const user = getUser(chatId);
  const updated = { ...user, ...patch };
  state.set(chatId, updated);
  return updated;
}

// Модуль onboarding самодостаточен - не требует инициализации



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

// Фильтр вежливости + лёгкая ирония на хамство
const BAD_RU = [
  /говн/i, /хер|хуй|поху/i, /пизд/i, /сука/i, /мраз/i, /долбо/i, /ублюд/i
];

function looksToxic(text='') {
  return BAD_RU.some(re => re.test(text));
}

const WITTY = [
  'Не думал, что у тебя ТАКИЕ изысканные вкусы 😅 Давай вернёмся к здоровой еде?',
  'Запишу как «эксперимент». Но нутрициолог внутри меня плачет. Возьмём яблоко? 🍎',
  'Хм… смелый выбор. Я бы заменил это на что-то, что не обидит твой ЖКТ 🙃',
];

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

// === PLAN GENERATION ===
// Подстраховка парсинга JSON
function parseJsonLoose(s) {
  try { return JSON.parse(s); } catch (e) {}
  // вырезать по первому/последнему фигурным скобкам
  const start = s.indexOf('{'); const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end+1)); } catch(e) {}
  }
  return null;
}

// Схема, по которой просим GPT вернуть план
const PLAN_SCHEMA = `
{
  "meta": { "version": "1.0", "model": "plan" },

  "user": {
    "name": "Иван",
    "name_variants": ["Иван", "Иванушка", "Ваня"], 
    "sex": "М|Ж",
    "age": 30,
    "height_cm": 180,
    "weight_kg": 82,
    "tz": "Europe/Moscow"
  },

  "goals": {
    "primary": "Похудение | Набор мышц | Здоровье-самочувствие | Производительность",
    "secondary": ["Сила","Выносливость"],
    "kpi_month": "−2 кг, 10k шагов/день",
    "target_weight_change_month_kg": -2.0
  },

  "screening": {
    "flags": {
      "medical_flags": "Да|Нет",
      "meds_affecting": "Да|Нет",
      "clotting_issue": "Да|Нет",
      "pregnancy_status": "Не актуально|Актуально",
      "cardio_symptoms_now": "Да|Нет"
    },
    "notes": "краткие ограничения и что учитывать в тренировках"
  },

  "training": {
    "days_per_week": 4,
    "session_length_min": 75,
    "rpe_guidance": "Рабочие подходы 6–8 RPE; 1–3 повтора в запасе",
    "equipment": ["Зал","Гантели","Штанга"],
    "avoid": ["Бег","Скручивания"],
    "schedule_week": [
      {
        "day": "Понедельник",
        "focus": ["Грудь","Трицепс","Плечи"],
        "exercises": [
          {"name":"Жим лёжа", "sets":4, "reps":"6–8", "rpe":"7–8", "rest_sec":120, "alt":["Жим гантелей","Отжимания на брусьях"]},
          {"name":"Жим гантелей сидя", "sets":3, "reps":"8–10", "rpe":"7", "rest_sec":90},
          {"name":"Разводка гантелей", "sets":3, "reps":"12–15", "rpe":"6–7", "rest_sec":60},
          {"name":"Трицепс на блоке", "sets":3, "reps":"10–12", "rpe":"7", "rest_sec":60}
        ],
        "cardio_z2_min": 20
      },
      { "day":"Среда", "focus":["Спина","Бицепс"], "exercises":[...], "cardio_z2_min":20 },
      { "day":"Пятница", "focus":["Ноги","Ягодицы","Кор"], "exercises":[...], "cardio_z2_min":20 },
      { "day":"Суббота", "focus":["День техники/кор"], "exercises":[...], "cardio_z2_min":0 }
    ],
    "notes": "Разминка 5–8 минут, заминка 5 минут"
  },

  "cardio": {
    "z2_definition": "Разговорный темп (RPE 3–4, ~65–75% HRmax; talk-test ниже VT1)",
    "weekly_total_min": 90
  },

  "nutrition": {
    "kcal_method": "Mifflin-St Jeor",
    "target_kcal": 2200,
    "protein_g_per_kg": 1.6,
    "protein_g": 130,
    "fat_min_g_per_kg": 0.8,
    "carb_g": 220,
    "meals_per_day": 4,
    "track_style": "Только калории|Только белок|Да|Нет",
    "diet_limits": ["Нет"],
    "water_ai_l": 2.5,
    "water_rationale": "EFSA: 2.5 л мужчины / 2.0 л женщины, корректировать под массу/жару/кардио"
  },

  "recovery": {
    "sleep_target_h": ">=7",
    "steps_goal": "8000–10000"
  },

  "reminders": {
    "morning": "08:30",
    "water": ["11:00","13:00","14:00","15:00","17:00"],
    "goodnight": "23:00"
  },

  "reporting": {
    "style": "Сразу после тренировки | Один раз вечером",
    "allow_rebuilds": true,
    "allow_micro_swaps": true
  },

  "limits": {
    "food_logs_per_day_limit": 4
  },

  "safety_notes": "что исключить/на что следить",
  "rich_text": {
    "intro_html": "<b>Привет, Ваня!</b> Ниже твой план на 4 недели...",
    "week_overview_html": "<b>Понедельник — грудь/трицепс/плечи</b> ... (список с упражнениями, подходами, отдыхом, Z2)"
  }
}
`;

// Системная инструкция для модели плана
function planSystemPromptRus() {
  return `
Ты — профессиональный тренер и нутрициолог. Генерируешь персональный МЕСЯЧНЫЙ план на основе анкеты.
Требования:
- Используй НОРМЫ: ВОЗ 2020 (150–300 мин/нед умеренная + силовые ≥2/нед), сон ≥7 ч (AASM/SRS), белок ~1.6 г/кг/сут (Morton 2018), креатин 3–5 г/д (ISSN), вода — EFSA (2.5 л муж., 2.0 л жен.), калории — Mifflin–St Jeor.
- ВСЕГДА учитывай предскрининг (PAR-Q+/ACSM): при красных флагах — снизить интенсивность/указать ограничения.
- Обращайся к пользователю по ИМЕНИ, варьируй обращения и уместно склоняй (например: "Павел", "Паш, смотри...", "Павла" — когда нужно по контексту). Не перегибай.
- План должен быть ЧЕЛОВЕЧЕСКИ оформлен: по дням недели с фокусом по мышечным группам, затем упражнения (название, подходы×повторы, RPE, отдых), плюс кардио Z2, если актуально.
- Вывод ТОЛЬКО в виде одного JSON строго по схеме ниже (поле rich_text содержит красиво оформленный HTML-текст для Telegram).
- Учитывай предпочтения/неприятные упражнения/инвентарь/время/приёмы пищи/воду/шаги/добавки/режим "пинков".
- Если цель похудение/набор и задана величина (кг/мес) — скорректируй калории соответственно.
СХЕМА:
${PLAN_SCHEMA}
Сгенерируй JSON по этой схеме без комментариев и лишнего текста.`;
}

// Генерация плана
async function generatePlanFromAnswersGPT(user) {
  const a = user.onb?.answers || user.onbAnswers || {};
  const payload = {
    user_input: {
      name: user.name || a.name || 'Друг',
      sex: a.sex || user.sex || 'М',
      age: a.age, height_cm: a.height_cm, weight_kg: a.weight_kg, tz: user.tz || a.tz,
      waist_cm: a.waist_cm
    },
    screening: {
      medical_flags: a.medical_flags, meds_affecting_ex: a.meds_affecting_ex,
      clotting_issue: a.clotting_issue, pregnancy_status: a.pregnancy_status,
      cardio_symptoms_now: a.cardio_symptoms, injury_notes: a.injury_notes
    },
    goals: {
      primary: a.goal, secondary: a.secondary_goals, kpi: a.goal_kpi,
      weight_loss_month_kg: a.weight_loss_month_kg,
      weight_gain_month_kg: a.weight_gain_month_kg
    },
    profile: {
      level: a.level, training_history: a.training_history, rpe_ready: a.rpe_ready
    },
    logistics: {
      days_per_week: a.days_per_week, preferred_slots: a.preferred_slots,
      session_length: a.session_length, equipment: a.equipment,
      equipment_limits: a.equipment_limits
    },
    preferences: { dislikes: a.dislikes, cardio_pref: a.cardio_pref },
    nutrition: {
      diet_limits: a.diet_limits, track_style: a.track_style, meals_per_day: a.meals_per_day,
      water_ready: a.water_ready
    },
    recovery_neat: {
      sleep_hours: a.sleep_hours, stress_level: a.stress_level, steps_level: a.steps_level
    },
    cardio_steps: {
      z2_after_lifts: a.z2_after_lifts, swim_ok: a.swim_ok, steps_goal_ok: a.steps_goal_ok
    },
    supps_reporting: {
      creatine_ok: a.creatine_ok, omega_vitd: a.omega_vitd, report_style: a.report_style,
      plan_rebuilds_ok: a.plan_rebuilds_ok, micro_swaps_ok: a.micro_swaps_ok,
      month_constraints: a.month_constraints, reminder_mode: a.reminder_mode
    }
  };

  const sys = planSystemPromptRus();
  const userMsg = `Анкета пользователя в JSON:\n${JSON.stringify(payload, null, 2)}\n\nВерни план ТОЛЬКО как один JSON по схеме.`;

  const resp = await oa.responses.create({
    model: process.env.OPENAI_MODEL_PLAN || 'gpt-4o',
    input: [
      { role: 'system', content: sys },
      { role: 'user', content: userMsg }
    ],
    temperature: 0.3
  });

  const out = resp.output_text || resp.content?.[0]?.text || resp.choices?.[0]?.message?.content || '';
  const plan = parseJsonLoose(out);
  if (!plan) throw new Error('Plan JSON parse failed');
  return plan;
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

// === МОДУЛЬНЫЙ ОНБОРДИНГ (src/onboarding-max.js) ===

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

function looksToxic(s) {
  // минимальный словарик, без фанатизма
  const bad = [
    /ху(й|и|я|е)/i,
    /пизд/i,
    /мраз/i,
    /гавно|говн/i,
    /идиот|дебил|туп/i
  ];
  return bad.some(rx => rx.test(s));
}

bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat?.id;
    const textRaw = (msg.text ?? '').toString();
    if (!chatId) return;

    // Если сейчас идёт анкета — даём рулить модулю анкеты и выходим
    if (onbMod.onbState?.has(chatId)) return;

    // Чистим пробелы и делаем нижний регистр для проверок
    const t = textRaw.trim();
    const tl = t.toLowerCase();

    // 1) Фильтр «токсика» (работает только для НЕ-команд)
    //    Команды вида /start, /onboarding и т.п. не трогаем.
    if (t && !t.startsWith('/') && looksToxic(tl)) {
      await bot.sendMessage(
        chatId,
        'Хм… необычный выбор слов 😏 Давай держать диалог конструктивно и вернёмся к плану тренировок.'
      );
      return;
    }

    // 2) Нормальная маршрутизация по основным кнопкам / командам
    if (t === '/start') {
      return sendWelcome(bot, chatId); // ваш текущий приветственный блок
    }

    if (t === '/onboarding' || t === '🧭 Анкета') {
      return onbMod.startOnboarding(bot, chatId);
    }

    if (t === '🏠 Главная' || t === '• 🏠 Главная') {
      return showHome(bot, chatId); // ваша функция отрисовки «Главная»
    }

    if (t === '📅 План') {
      return showPlan(bot, chatId); // ваша функция показа плана
    }

    if (t === '🍽️ Еда') {
      return enterFoodFlow(bot, chatId); // ваш блок учёта еды
    }

    if (t === '📝 Отчёты') {
      return enterReportFlow(bot, chatId); // ваш блок отчётов
    }

    if (t === '⚙️ Настройки') {
      return showSettings(bot, chatId); // ваша страница настроек
    }

    // Фолбэк: если ничего из выше — покажем подсказку
    await bot.sendMessage(chatId, 'Выбери действие на клавиатуре ниже или набери /onboarding для персонализации.');
  } catch (err) {
    console.error('Handler error:', err);
  }
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
    const chatId = q.message?.chat?.id;
    if (!chatId) return;

    // Кнопки еды
    if (data === 'food:cancel') {
      expectingFood.delete(chatId);
      await bot.answerCallbackQuery(q.id, { text: 'Отменено' });
      return;
    }
    if (data === 'food:more') {
      expectingFood.add(chatId);
      await bot.answerCallbackQuery(q.id, { text: 'Жду ещё один приём' });
      await bot.sendMessage(chatId, 'Еда: <что съел?>');
      return;
    }
    if (data === 'food:summary') {
      await bot.answerCallbackQuery(q.id);
      const u = getUser(chatId);
      const today = new Date().toISOString().slice(0,10);
      const meals = u.food?.[today] || [];
      
      if (meals.length === 0) {
        await bot.sendMessage(chatId, 'Сегодня приёмов еды нет. Начни с «🍽️ Еда».');
        return;
      }
      
      const lines = meals.map((m, i) => {
        const time = new Date(m.at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
        return `${i + 1}) ${time} — ${m.text}`;
      });
      
      const summary = [
        '📊 Итоги дня по еде:',
        ...lines,
        '',
        'Рекомендация: держи белок 20–40 г в каждом приёме, добавляй овощи.'
      ].join('\n');
      
      await bot.sendMessage(chatId, summary);
      return;
    }



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
  
  // Инициализируем вебхук
  (async () => {
    try {
      await ensureWebhook(bot);
    } catch (e) {
      console.error('Webhook setup error:', e);
    }
  })();
});

// ===== Мини-тест: проверяем инлайн-кнопки и снятие нижней клавиатуры =====
bot.onText(/^\/oktest$/, async (msg) => {
  const chatId = msg.chat.id;

  // 1) Уберём нижнюю реплай-клавиатуру (чтобы не мешала визуально)
  await bot.sendMessage(chatId, 'Убираю нижние кнопки...', {
    reply_markup: { remove_keyboard: true }
  });

  // 2) Пошлём СООБЩЕНИЕ С ИНЛАЙН-КЛАВИАТУРОЙ "ОК ✅"
  await bot.sendMessage(chatId, 'Это интро-блок. Готов продолжить?', {
    reply_markup: {
      inline_keyboard: [[{ text: 'ОК ✅', callback_data: 'oktest:ok' }]]
    }
  });
});

// Ловим клики по инлайн-кнопкам
bot.on('callback_query', async (q) => {
  // Для отладки видно в логах Railway:
  console.log('CQ:', q.data);

  if (q.data === 'oktest:ok') {
    await bot.answerCallbackQuery(q.id, { text: 'Поехали!' });
    await bot.sendMessage(q.message.chat.id, 'Клик пришёл. Инлайн-кнопки работают ✅');
  }
});
