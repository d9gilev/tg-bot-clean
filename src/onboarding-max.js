// === ONBOARDING v2025-08-30 ===

// OpenAI (для генерации плана). Можно отключить — будет фоллбэк.
const OpenAI = require('openai');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// ==== Flood control & retries (429) ==========================================================
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Игнорируем повторный тот же callback в течение 800 мс
const __lastCb = new Map();
function isDupeCb(chatId, data) {
  const key = chatId + ':' + data;
  const now = Date.now();
  const prev = __lastCb.get(key) || 0;
  __lastCb.set(key, now);
  return (now - prev) < 800;
}

async function sendSafe(bot, method, args, label = method) {
  for (let i = 0; i < 3; i++) {
    try {
      return await bot[method](...args);
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
  throw new Error(`[sendSafe] ${label} failed after retries`);
}

// ≤1 сообщение/сек на чат
const __q = global.__perChatQueue || (global.__perChatQueue = new Map());
function enqueue(chatId, task) {
  let chain = __q.get(chatId) || Promise.resolve();
  chain = chain.then(async () => {
    const res = await task();
    await wait(1300); // пауза с запасом (увеличено для надёжности)
    return res;
  }).catch(err => console.error('queue task err', err));
  __q.set(chatId, chain);
  return chain;
}

// Шорткаты (в анкете используем только их!)
const sendMsg    = (bot, chatId, text, opts={})        => enqueue(chatId, () => sendSafe(bot, 'sendMessage', [chatId, text, opts], 'sendMessage'));
const editText   = (bot, chatId, msgId, text, opts={}) => enqueue(chatId, () => sendSafe(bot, 'editMessageText', [{ chat_id: chatId, message_id: msgId, text, ...opts }], 'editMessageText'));
const editMarkup = (bot, chatId, msgId, markup)        => enqueue(chatId, () => sendSafe(bot, 'editMessageReplyMarkup', [markup, { chat_id: chatId, message_id: msgId }], 'editMessageReplyMarkup'));
const answerCb   = (bot, qid, chatId, opts={})         => enqueue(chatId, () => sendSafe(bot, 'answerCallbackQuery', [qid, opts], 'answerCallbackQuery'));

// БЫСТРЫЙ ответ на callback: без очереди и без задержки!
const answerCbNow = (bot, qid, opts = {}) =>
  sendSafe(bot, 'answerCallbackQuery', [qid, opts], 'answerCallbackQuery');

// ==== User store ============================================================================
const __users = global.__users || (global.__users = new Map());
function ensureUser(chatId) {
  if (!__users.has(chatId)) {
    __users.set(chatId, { 
      chatId, 
      tz: process.env.TZ_DEFAULT || 'Europe/Moscow',
      dailyReports: { count: 0, date: new Date().toDateString() },
      awaitingReport: false
    });
  }
  return __users.get(chatId);
}
const getUser = ensureUser;

// ==== Daily limits ==========================================================================
function resetDailyCounters(user) {
  const today = new Date().toDateString();
  if (user.dailyReports.date !== today) {
    user.dailyReports = { count: 0, date: today };
  }
}

function canSendReport(user) {
  resetDailyCounters(user);
  return user.dailyReports.count < 10;
}

function incrementReportCount(user) {
  resetDailyCounters(user);
  user.dailyReports.count++;
}

// ==== Helpers ===============================================================================
function norm(s){ return (s||'').toString().trim().toLowerCase().replace(/ё/g,'е'); }
function chunk(arr, n){ const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; }

// Генерация случайных данных для тестовой анкеты
function generateRandomAnswers() {
  const names = ['Алексей', 'Мария', 'Дмитрий', 'Анна', 'Сергей', 'Елена', 'Андрей', 'Ольга', 'Максим', 'Татьяна'];
  const goals = ['Похудение', 'Набор мышечной массы', 'Поддержание здоровья и самочувствия', 'Увеличение производительности'];
  const levels = ['Новичок', 'Средний', 'Продвинутый'];
  const reminderModes = ['Мягкий', 'Жёсткий', 'Выключено'];
  const sleepHours = ['<6', '6–7', '7–8', '8+'];
  const stressLevels = ['Нет', 'Иногда', 'Часто'];
  const stepsLevels = ['<5k', '5–8k', '8–11k', '>11k'];
  const trackStyles = ['Да', 'Нет', 'Только калории', 'Только белок'];
  const mealsPerDay = ['2', '3', '4', '5+'];
  const omegaVitd = ['Нет', 'Да, омега-3', 'Да, вит.D', 'Да, оба'];
  
  const sex = Math.random() > 0.5 ? 'М' : 'Ж';
  const age = Math.floor(Math.random() * 40) + 18; // 18-58 лет
  const height = sex === 'М' ? Math.floor(Math.random() * 30) + 165 : Math.floor(Math.random() * 25) + 155; // М: 165-195, Ж: 155-180
  const weight = sex === 'М' ? Math.floor(Math.random() * 40) + 65 : Math.floor(Math.random() * 35) + 50; // М: 65-105, Ж: 50-85
  
  return {
    name: names[Math.floor(Math.random() * names.length)],
    sex: sex,
    tz: 'Europe/Moscow',
    age: age,
    height_cm: height,
    weight_kg: weight,
    medical_flags: Math.random() > 0.8 ? 'Да' : 'Нет',
    medical_details: Math.random() > 0.8 ? 'Гипертония 1 степени' : undefined,
    meds_affecting: Math.random() > 0.9 ? 'Да' : 'Нет',
    meds_list: Math.random() > 0.9 ? 'Эналаприл' : undefined,
    clotting_issue: Math.random() > 0.95 ? 'Да' : 'Нет',
    clotting_details: Math.random() > 0.95 ? 'Принимаю варфарин' : undefined,
    pregnancy_status: sex === 'Ж' ? (Math.random() > 0.9 ? 'Актуально' : 'Не актуально') : undefined,
    pregnancy_details: sex === 'Ж' && Math.random() > 0.9 ? '2 триместр' : undefined,
    cardio_symptoms: Math.random() > 0.9 ? 'Да' : 'Нет',
    cardio_details: Math.random() > 0.9 ? 'Иногда одышка при нагрузке' : undefined,
    injury_notes: Math.random() > 0.7 ? 'Старая травма колена' : undefined,
    goal: goals[Math.floor(Math.random() * goals.length)],
    weight_loss_month_kg: Math.random() > 0.5 ? Math.floor(Math.random() * 3) + 1 : undefined,
    weight_gain_month_kg: Math.random() > 0.5 ? Math.floor(Math.random() * 2) + 1 : undefined,
    secondary_goals: Math.random() > 0.5 ? 'Улучшить выносливость, укрепить спину' : undefined,
    goal_kpi: Math.random() > 0.5 ? 'Сбросить 3 кг, подтянуться 5 раз' : undefined,
    level: levels[Math.floor(Math.random() * levels.length)],
    training_hist: Math.random() > 0.3 ? 'Занимаюсь 2 года, был перерыв 6 месяцев' : undefined,
    rpe_ready: Math.random() > 0.3 ? 'Да' : 'Нет',
    days_per_week: Math.floor(Math.random() * 4) + 2, // 2-5 дней
    session_length: ['60 мин', '75 мин', '90 мин'][Math.floor(Math.random() * 3)],
    preferred_slots: Math.random() > 0.5 ? 'Пн/Ср/Пт утром, Вт/Чт вечером' : undefined,
    equipment: 'Дом, Гантели, Турник, Эспандеры',
    equip_limits_f: Math.random() > 0.8 ? 'Есть ограничения' : 'Ограничений нет',
    equipment_limits: Math.random() > 0.8 ? 'Нет штанги, только гантели до 20кг' : undefined,
    dislikes: Math.random() > 0.6 ? 'Бег, приседания со штангой' : undefined,
    cardio_pref: ['Ходьба в горку', 'Вело', 'Эллипс', 'Гребля', 'Плавание'][Math.floor(Math.random() * 5)],
    diet_limits: Math.random() > 0.7 ? 'Лактоза, глютен' : undefined,
    track_style: trackStyles[Math.floor(Math.random() * trackStyles.length)],
    meals_per_day: mealsPerDay[Math.floor(Math.random() * mealsPerDay.length)],
    water_ready: Math.random() > 0.2 ? 'Да' : 'Нет',
    sleep_hours: sleepHours[Math.floor(Math.random() * sleepHours.length)],
    stress_level: stressLevels[Math.floor(Math.random() * stressLevels.length)],
    steps_level: stepsLevels[Math.floor(Math.random() * stepsLevels.length)],
    z2_after_lifts: Math.random() > 0.3 ? 'Да' : 'Нет',
    swim_ok: Math.random() > 0.7 ? 'Да' : 'Нет',
    steps_goal_ok: Math.random() > 0.2 ? 'Да' : 'Нет',
    creatine_ok: Math.random() > 0.3 ? 'Да' : 'Нет',
    omega_vitd: omegaVitd[Math.floor(Math.random() * omegaVitd.length)],
    month_constraints: Math.random() > 0.6 ? 'Командировка в середине месяца' : undefined,
    reminder_mode: reminderModes[Math.floor(Math.random() * reminderModes.length)]
  };
}

// ==== Анкета: вопросы + интро-блоки =========================================================
const INTRO = {
  IDENTITY: `Перед началом — уточним базовые данные (имя, пол, возраст, рост/вес, часовой пояс). Это нужно для персонализации плана.`,
  SCREENING: `Блок безопасности основан на PAR-Q+ / алгоритме предскрининга ACSM. Отвечай честно — это про твою безопасность.`,
  GOALS: `Теперь цели. Это основа: что хочешь получить за ближайший месяц и как поймём, что всё идёт по плану.`,
  PROFILE: `Пара слов об опыте и RPE (шкала усилий 1–10). Если не знаком — кратко подскажу по ходу.`,
  LOGISTICS: `Логистика: сколько раз тренируемся, длительность, инвентарь, ограничения. Это влияет на структуру плана.`,
  PREFERENCES: `Предпочтения и «не люблю». Так мы избежим ненужной боли и повысим приверженность.`,
  NUTRITION: `Питание: ограничения, способ отслеживания, число приёмов пищи и готовность держать норму воды.`,
  RECOVERY: `Сон/стресс/NEAT — без этого прогресс буксует. Оценим текущий режим.`,
  CARDIO: `Кардио (Z2), плавание и шаги — согласуем базовые объёмы.`,
  REPORTING: `Финал: добавки, отчётность и режим «пинков».`
};

const ONB = [
  // === 1) IDENTITY ===
  { key:'name', block:'IDENTITY', type:'text',   prompt:'Как тебя зовут?' },
  { key:'sex',  block:'IDENTITY', type:'single', prompt:'Пол:', opts:['М','Ж'] },
  { key:'tz',   block:'IDENTITY', type:'single', prompt:'Часовой пояс (для напоминаний):', 
    opts:['Europe/Moscow','Europe/Amsterdam','Asia/Almaty','Asia/Dubai','America/New_York','Другое…'] },
  { key:'age',       block:'IDENTITY', type:'number', prompt:'Возраст (лет):',    min:14, max:90 },
  { key:'height_cm', block:'IDENTITY', type:'number', prompt:'Рост (см):',        min:130, max:220 },
  { key:'weight_kg', block:'IDENTITY', type:'number', prompt:'Вес (кг):',         min:35,  max:250 },

  // === 2) SCREENING ===
  { key:'medical_flags',   block:'SCREENING', type:'single', prompt:'Есть диагностированные проблемы сердца/сосудов/обмена/почек или симптомы при нагрузке?', opts:['Нет','Да'] },
  { key:'medical_details', block:'SCREENING', type:'text',   prompt:'Опиши подробнее:', showIf:{ field:'medical_flags', equals:'Да' } },
  { key:'meds_affecting',  block:'SCREENING', type:'single', prompt:'Принимаешь лекарства, влияющие на пульс/давление (β-блокаторы и т.п.)?', opts:['Нет','Да'] },
  { key:'meds_list',       block:'SCREENING', type:'text',   prompt:'Укажи названия препаратов (коротко):', showIf:{ field:'meds_affecting', equals:'Да' } },
  { key:'clotting_issue',  block:'SCREENING', type:'single', prompt:'Нарушения свёртываемости крови или антикоагулянты?', opts:['Нет','Да'] },
  { key:'clotting_details',block:'SCREENING', type:'text',   prompt:'Опиши подробнее:', showIf:{ field:'clotting_issue', equals:'Да' } },
  { key:'pregnancy_status',block:'SCREENING', type:'single', prompt:'Беременность/послеродовый период?', opts:['Не актуально','Актуально'], showIf:{ field:'sex', equals:'Ж' } },
  { key:'pregnancy_details',block:'SCREENING', type:'text',  prompt:'Опиши подробнее:', showIf:{ field:'pregnancy_status', equals:'Актуально' } },
  { key:'cardio_symptoms', block:'SCREENING', type:'single', prompt:'Есть тревожные симптомы сейчас (боль/давление в груди, необъяснимая одышка, обмороки)?', opts:['Нет','Да'] },
  { key:'cardio_details',  block:'SCREENING', type:'text',   prompt:'Опиши подробнее:', showIf:{ field:'cardio_symptoms', equals:'Да' } },
  { key:'injury_notes',    block:'SCREENING', type:'text',   prompt:'Травмы/операции за 12 мес? Движения/упражнения, которые вызывают боль? (коротко)', optional:true },

  // === 3) GOALS ===
  { key:'goal',                 block:'GOALS', type:'single', prompt:'Главная цель на месяц:', opts:['Похудение','Набор мышечной массы','Поддержание здоровья и самочувствия','Увеличение производительности'] },
  { key:'weight_loss_month_kg', block:'GOALS', type:'number', prompt:'На сколько КГ за месяц хочешь похудеть?', min:0.1, max:6, showIf:{ field:'goal', equals:'Похудение' } },
  { key:'weight_gain_month_kg', block:'GOALS', type:'number', prompt:'На сколько КГ за месяц хочешь набрать?',  min:0.1, max:6, showIf:{ field:'goal', equals:'Набор мышечной массы' } },
  { key:'secondary_goals',      block:'GOALS', type:'text',   prompt:'Вторичные цели (до 3, через запятую):', optional:true },
  { key:'goal_kpi',             block:'GOALS', type:'text',   prompt:'Как поймём, что месяц прошёл удачно? (KPI: −2 кг, +2 подтягивания, 10k шагов/день)', optional:true },

  // === 4) PROFILE ===
  { key:'level',        block:'PROFILE', type:'single', prompt:'Уровень в силовых:', opts:['Новичок','Средний','Продвинутый'] },
  { key:'training_hist',block:'PROFILE', type:'text',   prompt:'Стаж занятий (опыт):', optional:true },
  { key:'rpe_ready',    block:'PROFILE', type:'single', prompt:'Знаешь шкалу усилий RPE (0–10) и готов(а) ею пользоваться?', opts:['Да','Нет'] },

  // === 5) LOGISTICS ===
  { key:'days_per_week',   block:'LOGISTICS', type:'number', prompt:'Сколько дней в неделю реально хочешь тренироваться?', min:1, max:6 },
  { key:'session_length',  block:'LOGISTICS', type:'single', prompt:'Длительность одной тренировки:', opts:['60 мин','75 мин','90 мин'] },
  { key:'preferred_slots', block:'LOGISTICS', type:'text',   prompt:'Предпочтительные дни/время (до 5): Пн/Вт/Ср/Чт/Пт/Сб/Вс + Утро/День/Вечер', optional:true },
  { key:'equipment',       block:'LOGISTICS', type:'text',   prompt:'Где тренируешься и что доступно? (Дом, Зал, Улица, Штанга, Гантели, Тренажёры, Турник, Эспандеры, Дорожка/вело, Бассейн)' },
  { key:'equip_limits_f',  block:'LOGISTICS', type:'single', prompt:'Есть ли ограничения по инвентарю/движениям?', opts:['Ограничений нет','Есть ограничения'] },
  { key:'equipment_limits',block:'LOGISTICS', type:'text',   prompt:'Опиши ограничения (коротко)', showIf:{ field:'equip_limits_f', equals:'Есть ограничения' } },

  // === 6) PREFERENCES ===
  { key:'dislikes',    block:'PREFERENCES', type:'text',   prompt:'Что НЕ нравится/вызывает дискомфорт? (до 5, через запятую)', optional:true },
  { key:'cardio_pref', block:'PREFERENCES', type:'single', prompt:'Что нравится из кардио?', opts:['Ходьба в горку','Вело','Эллипс','Гребля','Плавание'] },

  // === 7) NUTRITION ===
  { key:'diet_limits',   block:'NUTRITION', type:'text',   prompt:'Пищевые ограничения (до 3, через запятую):', optional:true },
  { key:'track_style',   block:'NUTRITION', type:'single', prompt:'Готов(а) считать БЖУ/ккал?', opts:['Да','Нет','Только калории','Только белок'] },
  { key:'meals_per_day', block:'NUTRITION', type:'single', prompt:'Сколько приёмов пищи удобно?', opts:['2','3','4','5+'] },
  { key:'water_ready',   block:'NUTRITION', type:'single', prompt:'Готов(а) соблюдать норму воды по плану (буду напоминать)?', opts:['Да','Нет'] },

  // === 8) RECOVERY ===
  { key:'sleep_hours',  block:'RECOVERY', type:'single', prompt:'Сон (ср. часов/ночь)', opts:['<6','6–7','7–8','8+'] },
  { key:'stress_level', block:'RECOVERY', type:'single', prompt:'Стресс/смены/ночные?', opts:['Нет','Иногда','Часто'] },
  { key:'steps_level',  block:'RECOVERY', type:'single', prompt:'Средняя дневная активность (шаги)', opts:['<5k','5–8k','8–11k','>11k'] },

  // === 9) CARDIO ===
  { key:'z2_after_lifts', block:'CARDIO', type:'single', prompt:'Ок ли Z2-кардио 20–30 мин после силовой?', opts:['Да','Нет'] },
  { key:'swim_ok',        block:'CARDIO', type:'single', prompt:'Плавание доступно 1–2×/нед по 20–30 мин?', opts:['Да','Нет'] },
  { key:'steps_goal_ok',  block:'CARDIO', type:'single', prompt:'Цель по шагам 8–10k/день — ок?', opts:['Да','Нет'] },

  // === 10) REPORTING ===
  { key:'creatine_ok',      block:'REPORTING', type:'single', prompt:'Креатин 3–5 г/д — ок?', opts:['Да','Нет'] },
  { key:'omega_vitd',       block:'REPORTING', type:'single', prompt:'Омега-3/витамин D уже принимаешь?', opts:['Нет','Да, омега-3','Да, вит.D','Да, оба'] },
  { key:'month_constraints',block:'REPORTING', type:'text',   prompt:'Что может отвлечь от плана занятий в этом месяце? (поездки, дедлайны, события)', optional:true },
  { key:'reminder_mode',    block:'REPORTING', type:'single', prompt:'Режим напоминаний/«пинков»:', opts:['Мягкий','Жёсткий','Выключено'] },
];

const onbState = new Map();

// ==== UI builders ===========================================================================
function kbInlineSingle(key, opts){
  const rows = chunk(opts.map((o,i)=>({ text:o, data:`onb:pick:${key}:${i}` })), 2)
                 .map(row => row.map(b => ({ text:b.text, callback_data:b.data })));
  return { inline_keyboard: rows };
}

function needShow(q, ans){
  if (!q.showIf) return true;
  return ans[q.showIf.field] === q.showIf.equals;
}

function currentBlock(state){ const q = ONB[state.idx]; return q?.block; }

// ==== Flow ==================================================================================
async function sendIntro(bot, chatId, block){
  const intro = INTRO[block];
  if (!intro) return;
  
  // Источники только в первом блоке
  const sources = block === 'IDENTITY' ? '\n\n<b>Источник:</b> PAR-Q+/ACSM, ВОЗ-2020, AASM/SRS (сон), Morton-2018 (белок), ISSN (креатин).' : '';
  
  await sendMsg(bot, chatId,
    `<b>${blockName(block)}</b>\n${intro}${sources}`,
    { parse_mode:'HTML', reply_markup:{ inline_keyboard: [[{ text:'ОК ✅', callback_data:`onb:ok:${block}` }]] } }
  );
}

function blockName(code){
  return {
    IDENTITY:'Идентификация',
    SCREENING:'Предскрининг безопасности',
    GOALS:'Цели',
    PROFILE:'Профиль/опыт',
    LOGISTICS:'Логистика и инвентарь',
    PREFERENCES:'Предпочтения',
    NUTRITION:'Питание',
    RECOVERY:'Сон/стресс/NEAT',
    CARDIO:'Кардио и шаги',
    REPORTING:'Добавки, отчёты и «пинки»'
  }[code] || code;
}

async function _sendQuestion(bot, chatId) {
  const st = onbState.get(chatId);
  if (!st) return;

  // 1) СНАЧАЛА проматываем скрытые вопросы
  while (st.idx < ONB.length && !needShow(ONB[st.idx], st.answers)) st.idx++;

  // 2) Если вопросов больше нет — ЗАВЕРШАЕМ анкету
  if (st.idx >= ONB.length) {
    return finishOnboarding(bot, chatId);
  }

  // 3) Интро-блок — только если реально есть следующий вопрос/блок
  const blk = currentBlock(st);
  const u = getUser(chatId);
  u.onb = u.onb || { introShown:{} };
  if (!u.onb.introShown[blk]) {
    u.onb.waitingIntro = blk;
    await sendIntro(bot, chatId, blk); // sendIntro сам ничего не шлёт для неизвестного блока
    return;
  }

  // 4) Задаём вопрос
  const q = ONB[st.idx];
  console.log('ONB step', st.idx, '→', q?.key);

  if (q.type === 'single') {
    await sendMsg(bot, chatId, q.prompt, { reply_markup: kbInlineSingle(q.key, q.opts) });
  } else {
    await sendMsg(bot, chatId, q.prompt, { reply_markup: { remove_keyboard:true } });
  }
}

function validateNumber(q, text){
  const num = Number((text||'').toString().replace(',', '.'));
  if (Number.isNaN(num)) return { ok:false, err:'Нужна цифра.' };
  if (q.min!=null && num < q.min) return { ok:false, err:`Минимум ${q.min}.` };
  if (q.max!=null && num > q.max) return { ok:false, err:`Максимум ${q.max}.` };
  return { ok:true, val:num };
}

function singleFromText(q, text){
  const t = norm(text);
  const hit = (q.opts||[]).find(o => norm(o) === t)
        || (q.key==='reminder_mode' && (
              (['жесткий','hard','крепкий'].includes(t) && 'Жёсткий') ||
              (['мягкий','soft','лайт'].includes(t)    && 'Мягкий') ||
              (['выкл','off','выключено','нет'].includes(t) && 'Выключено')
           ));
  return hit || null;
}

// ==== Finish & Plan =========================================================================
// В конце анкеты — сохраним выбранный режим «пинков»
async function finishOnboarding(bot, chatId){
  const st = onbState.get(chatId);
  if (!st) return;

  const u = getUser(chatId);
  u.onbAnswers = st.answers;
  // <<< добавлено: прокинем режим напоминаний в профиль пользователя
  if (st.answers?.reminder_mode) {
    u.reminder_mode = st.answers.reminder_mode;
  }

  u.onb = null; // анкета завершена
  onbState.delete(chatId);

  await sendMsg(bot, chatId,
    'Супер! Анкета заполнена. Теперь соберу персональный план на месяц (силовые, кардио Z2, питание, вода, сон, напоминания).\n' +
    'Нажми кнопку — и я всё сгенерирую.',
    { reply_markup:{ inline_keyboard: [[{ text:'Сформировать план ▶️', callback_data:'plan:build' }]] } }
  );
}

function mifflinStJeor({ sex, weight, height, age }) {
  const s = (sex === 'М' || sex === 'M') ? 5 : -161;
  return Math.round(10*weight + 6.25*height - 5*age + s);
}
function palFromSteps(steps){ return ({'<5k':1.3,'5–8k':1.45,'8–11k':1.6,'>11k':1.75}[steps] || 1.4); }
function kcalByGoal(tdee, goal){
  if (goal === 'Похудение') return Math.round(tdee*0.85);
  if (goal === 'Набор мышечной массы') return Math.round(tdee*1.10);
  return Math.round(tdee);
}

// Удален fallbackPlan - теперь только GPT

function parseJsonLoose(s) {
  try { return JSON.parse(s); } catch (_) {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a>=0 && b>a) { try { return JSON.parse(s.slice(a, b+1)); } catch (_) {} }
  return null;
}

function planSystemPromptRus() {
  return `
Ты — ЭКСПЕРТНЫЙ тренер и нутриционист с 15+ лет опыта. Создаёшь МАКСИМАЛЬНО РАБОЧИЙ персональный план как настоящий профессионал.

КРИТИЧЕСКИ ВАЖНО:
- План должен быть ЖИВЫМ, ДЕТАЛЬНЫМ и МОТИВИРУЮЩИМ
- Начинай с персонального обращения: "[ИМЯ], я посмотрел твою анкету и подготовил для тебя вот такой план:"
- Учитывай ВСЕ ограничения и предпочтения из анкеты
- ВОЗ 2020 (150–300 мин/нед умеренная + силовые ≥2/нед), сон ≥7 ч (AASM/SRS), белок ~1.6 г/кг/сут (Morton 2018), креатин 3–5 г/д (ISSN), вода — EFSA (2.5 л муж., 2.0 л жен.), калории — Mifflin–St Jeor
- PAR-Q+/ACSM: при рисках снижай интенсивность, добавляй пометки
- Каждое упражнение: название, подходы, повторы, RPE, отдых, прогрессия
- Добавляй мотивационные элементы и человечные рекомендации

СТРУКТУРА ПЛАНА:
1. Персональное приветствие с именем
2. Детальное расписание по дням недели с конкретными упражнениями
3. Питание с точными цифрами и рекомендациями
4. Добавки и восстановление
5. Мотивационные элементы и советы

ВЫВОД: ТОЛЬКО один JSON по схеме, без комментариев. В rich_text положи HTML для Telegram.

{
  "user": { "name":"...", "tz":"..." },
  "goals": { "primary":"...", "secondary":[...], "kpi_month":"...", "target_weight_change_month_kg": -1.5 },
  "training": { 
    "days_per_week":3, 
    "session_length_min":75, 
    "schedule_week":[
      { 
        "day":"Понедельник", 
        "focus":["Грудь","Трицепс"], 
        "exercises":[
          {"name":"Жим лёжа","sets":4,"reps":"6–8","rpe":"7–8","rest_sec":120,"notes":"Прогрессия: +2.5кг каждую неделю"},
          {"name":"Отжимания на брусьях","sets":3,"reps":"8–12","rpe":"7","rest_sec":90,"notes":"С отягощением если легко"},
          {"name":"Разводка гантелей","sets":3,"reps":"12–15","rpe":"6–7","rest_sec":60,"notes":"Контролируй негативную фазу"}
        ], 
        "cardio_z2_min":20,
        "notes":"Разминка 10 мин, заминка 5 мин"
      }
    ] 
  },
  "nutrition": { 
    "kcal_method":"Mifflin-St Jeor", 
    "target_kcal": 2200, 
    "protein_g_per_kg":1.6, 
    "meals_per_day":4, 
    "water_ai_l":2.5,
    "meal_timing":"Завтрак 7:00, обед 13:00, ужин 19:00, перекус 16:00",
    "supplements":["Креатин 5г/день", "Омега-3 2г/день", "Витамин D 2000МЕ"],
    "tips":["Пей воду до еды", "Белок в каждый приём пищи", "Не пропускай завтрак"]
  },
  "recovery": { 
    "sleep_target_h": ">=7",
    "stress_management":"Медитация 10 мин/день",
    "active_recovery":"Прогулка 30 мин в выходные",
    "tips":["Ложись спать в одно время", "За час до сна - никаких экранов"]
  },
  "cardio": { 
    "z2_definition":"Разговорный темп, RPE 3-4, 65-75% от максимального пульса", 
    "weekly_total_min":90,
    "schedule":"После силовых 20 мин, в выходные 30 мин"
  },
  "reporting": { 
    "style":"Сразу после тренировки",
    "tracking":["Вес", "Самочувствие", "Выполненные упражнения"],
    "feedback_prompts":["Как прошла тренировка?", "Что было сложно?", "Что понравилось?"]
  },
  "limits": { "food_logs_per_day_limit":4 },
  "rich_text": { 
    "intro_html":"<b>[ИМЯ], я посмотрел твою анкету и подготовил для тебя вот такой план:</b>\\n\\n<b>🎯 Твоя цель:</b> [ЦЕЛЬ]\\n<b>📊 KPI месяца:</b> [KPI]\\n\\n<b>💪 Что тебя ждёт:</b>\\n• Силовые тренировки [ДНИ]×/нед по [ВРЕМЯ] мин\\n• Кардио Z2 [МИНУТЫ] мин/нед\\n• Питание [КАЛОРИИ] ккал/день, белок [БЕЛОК] г/кг\\n• Вода [ВОДА] л/день, сон ⩾[СОН] ч\\n\\n<b>🔥 Расписание недели:</b>",
    "week_overview_html":"<b>Твой персональный план тренировок</b>\\n\\n[Здесь будет детальное расписание с конкретными упражнениями, подходами, повторами, RPE, отдыхом и прогрессией, адаптированное под твои цели, уровень, оборудование и ограничения]\\n\\n<b>🍽️ Питание:</b>\\n• [КАЛОРИИ] ккал/день, белок [БЕЛОК] г/кг\\n• [ПРИЕМЫ] приёма пищи\\n• Вода: [ВОДА] л/день\\n\\n<b>💊 Добавки:</b>\\n• Креатин 5г/день\\n• Омега-3 2г/день\\n• Витамин D 2000МЕ\\n\\n<b>😴 Восстановление:</b>\\n• Сон ⩾[СОН] ч/ночь\\n• Стресс-менеджмент\\n• Активное восстановление\\n\\n<b>📈 Прогрессия:</b>\\n• Силовые: +2.5кг каждую неделю\\n• Кардио: увеличивай время на 5 мин каждые 2 недели\\n• Отслеживай вес и самочувствие\\n\\n<b>🎯 Помни:</b> Ты можешь больше, чем думаешь! Каждая тренировка приближает к цели. Не сдавайся! 💪"
  }
}
`;
}

// Функция для анализа отчётов и генерации фидбэка
async function generateReportFeedback(report, userPlan, openai) {
  if (!openai) return null;

  const payload = {
    user_plan: userPlan,
    report: {
      type: report.type,
      text: report.text || '',
      caption: report.caption || '',
      timestamp: report.timestamp
    }
  };

  const sysPrompt = `
Ты — опытный персональный тренер, который анализирует отчёты клиентов и даёт развёрнутый фидбэк.

ЗАДАЧА:
- Проанализируй отчёт клиента в контексте его персонального плана
- Дай развёрнутый, мотивирующий фидбэк как настоящий тренер
- Отметь прогресс и достижения относительно плана
- Дай конкретные советы по улучшению техники/прогрессии
- Будь человечным, поддерживающим и мотивирующим
- Учитывай все ограничения и предпочтения из плана

СТРУКТУРА ФИДБЭКА:
1. Позитивная оценка (что сделано хорошо)
2. Анализ прогресса относительно плана тренировок
3. Конкретные рекомендации по технике/прогрессии
4. Мотивация на продолжение и следующие шаги

ВЫВОД: Только текст фидбэка, без дополнительных комментариев. Пиши как настоящий тренер.
`;

  try {
    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL_PLAN || 'gpt-4o',
      temperature: 0.7,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: 'Проанализируй отчёт и дай фидбэк:\n' + JSON.stringify(payload, null, 2) }
      ]
    });

    return resp.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error('GPT feedback error', e);
    return null;
  }
}

async function generatePlanFromAnswersGPT_JSON(ans, openai) {
  if (!openai) return null;

  // сгладим разные имена полей
  const meds_affecting = ans.meds_affecting_ex ?? ans.meds_affecting;

  const payload = {
    user: {
      name: ans.name || 'клиент',
      sex: ans.sex, age: ans.age, height_cm: ans.height_cm, weight_kg: ans.weight_kg,
      tz: ans.tz
    },
    goals: {
      primary: ans.goal,
      secondary: (ans.secondary_goals || '').split(',').map(s=>s.trim()).filter(Boolean),
      kpi_month: ans.goal_kpi || null,
      target_weight_change_month_kg: ans.weight_loss_month_kg ? -Math.abs(ans.weight_loss_month_kg) :
                                     ans.weight_gain_month_kg ?  Math.abs(ans.weight_gain_month_kg) : 0
    },
    screening: {
      medical_flags: ans.medical_flags,
      medical_details: ans.medical_details,
      meds_affecting, meds_list: ans.meds_list,
      clotting_issue: ans.clotting_issue,
      clotting_details: ans.clotting_details,
      pregnancy_status: ans.pregnancy_status,
      pregnancy_details: ans.pregnancy_details,
      cardio_symptoms_now: ans.cardio_symptoms,
      cardio_details: ans.cardio_details,
      injury_notes: ans.injury_notes
    },
    training: {
      days_per_week: Number(ans.days_per_week) || 3,
      session_length: ans.session_length,
      equipment: (ans.equipment||'').split(',').map(s=>s.trim()).filter(Boolean),
      avoid: (ans.dislikes||'').split(',').map(s=>s.trim()).filter(Boolean),
      rpe_ready: ans.rpe_ready
    },
    cardio: { z2_after_lifts: ans.z2_after_lifts, swim_ok: ans.swim_ok, steps_goal_ok: ans.steps_goal_ok },
    nutrition: {
      track_style: ans.track_style,
      meals_per_day: ans.meals_per_day,
      diet_limits: (ans.diet_limits||'').split(',').map(s=>s.trim()).filter(Boolean),
      water_ready: ans.water_ready
    },
    recovery: { sleep_hours: ans.sleep_hours, stress_level: ans.stress_level, steps_level: ans.steps_level },
    reporting: {
      creatine_ok: ans.creatine_ok, omega_vitd: ans.omega_vitd,
      reminder_mode: ans.reminder_mode, month_constraints: ans.month_constraints
    }
  };

  const sys = planSystemPromptRus();
  const model = process.env.OPENAI_MODEL_PLAN || 'gpt-4o';

  const resp = await openai.chat.completions.create({
    model,
    temperature: 0.3,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: 'Сгенерируй план по анкете (выведи ТОЛЬКО один JSON):\n' + JSON.stringify(payload, null, 2) }
    ]
  });

  const text = resp.choices?.[0]?.message?.content || '';
  return parseJsonLoose(text);
}

// ==== Registration ==========================================================================
function registerOnboarding(bot){

  // стартовая команда
  bot.onText(/^(?:\/start|старт)$/i, async (msg) => {
    const chatId = msg.chat.id;
    await sendMsg(bot, chatId, 
      '👋 Привет! Я помогу составить персональный план тренировок.\n\n' +
      'Нажми "Анкета" чтобы начать, или "Отчёт" если уже есть план.',
      {
        reply_markup: {
          keyboard: [
            [{ text:'🧭 Анкета' }, { text:'📝 Отчёт' }],
            [{ text:'🧪 Тестовая анкета' }]
          ],
          resize_keyboard:true
        }
      }
    );
  });

  // запуск по команде/кнопке
  bot.onText(/^(?:\/onboarding|\/anketa|анкета|🧭\s*анкета)$/i, async (msg) => {
    const chatId = msg.chat.id;
    const u = getUser(chatId);
    if (u.onb) {
      await sendMsg(bot, chatId, 'Анкета уже идёт. Напиши /cancel чтобы отменить.');
      return;
    }
    startOnboarding(bot, chatId);
  });

  // тестовая анкета с случайными данными
  bot.onText(/^(?:🧪\s*тестовая\s*анкета|тестовая\s*анкета|тест)$/i, async (msg) => {
    const chatId = msg.chat.id;
    const u = getUser(chatId);
    
    if (u.onb) {
      await sendMsg(bot, chatId, 'Анкета уже идёт. Напиши /cancel чтобы отменить.');
      return;
    }

    await sendMsg(bot, chatId, '🧪 Заполняю тестовую анкету случайными данными...');
    
    // Генерируем случайные ответы
    const randomAnswers = generateRandomAnswers();
    
    // Создаем состояние анкеты
    u.onb = { introShown: {}, waitingIntro: null };
    onbState.set(chatId, { idx: 0, answers: randomAnswers });
    
    // Пропускаем все интро и вопросы, сразу завершаем
    await sendMsg(bot, chatId, 
      '✅ Тестовая анкета заполнена!\n\n' +
      `Имя: ${randomAnswers.name}\n` +
      `Пол: ${randomAnswers.sex}\n` +
      `Возраст: ${randomAnswers.age}\n` +
      `Цель: ${randomAnswers.goal}\n` +
      `Уровень: ${randomAnswers.level}\n` +
      `Дней в неделю: ${randomAnswers.days_per_week}\n\n` +
      'Теперь соберу персональный план на месяц (силовые, кардио Z2, питание, вода, сон, напоминания).\n' +
      'Нажми кнопку — и я всё сгенерирую.',
      { reply_markup:{ inline_keyboard: [[{ text:'Сформировать план ▶️', callback_data:'plan:build' }]] } }
    );
  });

  // кнопка "Отчёт"
  bot.onText(/^(?:📝\s*отчёт|отчёт|отчет)$/i, async (msg) => {
    const chatId = msg.chat.id;
    const u = getUser(chatId);
    
    if (!u.plan) {
      await sendMsg(bot, chatId, 'Сначала пройди анкету, чтобы получить план тренировок.');
      return;
    }

    if (!canSendReport(u)) {
      await sendMsg(bot, chatId, `Лимит отчётов на сегодня исчерпан (10/10). Попробуй завтра.`);
      return;
    }

    // Устанавливаем флаг ожидания отчёта
    u.awaitingReport = true;

    await sendMsg(bot, chatId, 
      `📝 <b>Отчёт о тренировке</b>\n\n` +
      `Опиши как прошла тренировка:\n` +
      `• Что делал(а)?\n` +
      `• Как самочувствие?\n` +
      `• Что понравилось/не понравилось?\n` +
      `• Есть вопросы?\n\n` +
      `Или пришли скриншоты активности (Apple Health, Google Fit, Strava и т.д.)\n\n` +
      `Осталось отчётов сегодня: ${10 - u.dailyReports.count}/10`,
      { parse_mode: 'HTML' }
    );
  });

  // кнопка "План"
  bot.onText(/^(?:📅\s*план|план)$/i, async (msg) => {
    const chatId = msg.chat.id;
    const u = getUser(chatId);
    
    if (!u.plan) {
      await sendMsg(bot, chatId, 'Сначала пройди анкету, чтобы получить план тренировок.');
      return;
    }

    // Показываем GPT план, если есть
    if (u.gptPlan && u.gptPlan.rich_text) {
      const html = u.gptPlan.rich_text.week_overview_html || u.gptPlan.rich_text.intro_html;
      if (html) {
        const cleanHtml = html.replace(/<br\s*\/?>/gi, '\n');
        await sendMsg(bot, chatId, cleanHtml, { 
          parse_mode: 'HTML',
          reply_markup: {
            keyboard: [
              [{ text:'📅 План' }, { text:'📝 Отчёт' }],
              [{ text:'🏠 Главное меню' }]
            ],
            resize_keyboard:true
          }
        });
        return;
      }
    }

    // Если нет GPT плана - ошибка
    await sendMsg(bot, chatId, '❌ План не найден. Пройди анкету заново для генерации нового плана.');
  });

  // кнопка "Главное меню"
  bot.onText(/^(?:🏠\s*главное\s*меню|главное\s*меню|меню)$/i, async (msg) => {
    const chatId = msg.chat.id;
    const u = getUser(chatId);
    
    if (!u.plan) {
      await sendMsg(bot, chatId, 
        '👋 Привет! Я помогу составить персональный план тренировок.\n\n' +
        'Нажми "Анкета" чтобы начать, или "Отчёт" если уже есть план.',
        {
          reply_markup: {
            keyboard: [
              [{ text:'🧭 Анкета' }, { text:'📝 Отчёт' }]
            ],
            resize_keyboard:true
          }
        }
      );
    } else {
      await sendMsg(bot, chatId, 
        '🏠 <b>Главное меню</b>\n\n' +
        'Выбери действие:',
        {
          parse_mode: 'HTML',
          reply_markup: {
            keyboard: [
              [{ text:'📅 План' }, { text:'📝 Отчёт' }],
              [{ text:'🏠 Главное меню' }, { text:'🧪 Тестовая анкета' }]
            ],
            resize_keyboard:true
          }
        }
      );
    }
  });

  // отмена
  bot.onText(/^\/cancel$/i, async (msg) => {
    const chatId = msg.chat.id;
    const u = getUser(chatId);
    if (u.onb || onbState.has(chatId)) {
      u.onb = null; onbState.delete(chatId);
      await sendMsg(bot, chatId, 'Ок, остановил анкету. Набери /onboarding, чтобы начать заново.');
    } else {
      await sendMsg(bot, chatId, 'Сейчас анкета не идёт.');
    }
  });

  // обработка фото/документов для отчётов
  bot.on('message', async (msg) => {
    const chatId = msg.chat?.id;
    if (!chatId) return;

    const u = getUser(chatId);
    
    // если есть план и отправлено фото/документ — это отчёт
    if (u?.plan && (msg.photo || msg.document)) {
      if (!u.awaitingReport) {
        await sendMsg(bot, chatId, 'Сначала нажми кнопку "📝 Отчёт", чтобы отправить отчёт о тренировке.');
        return;
      }

      if (!canSendReport(u)) {
        await sendMsg(bot, chatId, `Лимит отчётов на сегодня исчерпан (10/10). Попробуй завтра.`);
        return;
      }

      incrementReportCount(u);
      
      const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
      const caption = msg.caption || '';
      
      // сохраняем отчёт
      u.reports = u.reports || [];
      u.reports.push({
        timestamp: new Date().toISOString(),
        fileId,
        caption,
        type: msg.photo ? 'photo' : 'document'
      });

      // Сбрасываем флаг ожидания отчёта
      u.awaitingReport = false;

      await sendMsg(bot, chatId, 
        `✅ Отчёт принят! (${u.dailyReports.count}/10 сегодня)\n\n` +
        `Анализирую твою тренировку...`
      );

      // Генерируем фидбэк через GPT
      try {
        const feedback = await generateReportFeedback(u.reports[u.reports.length - 1], u.gptPlan, openai);
        if (feedback) {
          await sendMsg(bot, chatId, `🏋️ <b>Анализ твоей тренировки:</b>\n\n${feedback}`, { parse_mode: 'HTML' });
        } else {
          await sendMsg(bot, chatId, `Скриншот сохранён. Продолжай тренировки по плану! 💪`);
        }
      } catch (e) {
        console.error('Feedback generation error', e);
        await sendMsg(bot, chatId, `Скриншот сохранён. Продолжай тренировки по плану! 💪`);
      }
      return;
    }

    // если нет текста — игнорируем
    if (!msg.text) return;

    // ПРИОРИТЕТ 1: Если есть план и ожидаем отчёт — обрабатываем как отчёт
    if (u?.plan && u?.awaitingReport) {
      if (!canSendReport(u)) {
        await sendMsg(bot, chatId, `Лимит отчётов на сегодня исчерпан (10/10). Попробуй завтра.`);
        return;
      }

      incrementReportCount(u);
      
      // сохраняем текстовый отчёт
      u.reports = u.reports || [];
      u.reports.push({
        timestamp: new Date().toISOString(),
        text: msg.text,
        type: 'text'
      });

      // Сбрасываем флаг ожидания отчёта
      u.awaitingReport = false;

      await sendMsg(bot, chatId, 
        `✅ Отчёт принят! (${u.dailyReports.count}/10 сегодня)\n\n` +
        `Анализирую твою тренировку...`
      );

      // Генерируем фидбэк через GPT
      try {
        const feedback = await generateReportFeedback(u.reports[u.reports.length - 1], u.gptPlan, openai);
        if (feedback) {
          await sendMsg(bot, chatId, `🏋️ <b>Анализ твоей тренировки:</b>\n\n${feedback}`, { parse_mode: 'HTML' });
        } else {
          await sendMsg(bot, chatId, `Отчёт сохранён. Продолжай тренировки по плану! 💪`);
        }
      } catch (e) {
        console.error('Feedback generation error', e);
        await sendMsg(bot, chatId, `Отчёт сохранён. Продолжай тренировки по плану! 💪`);
      }
      return;
    }

    // ПРИОРИТЕТ 2: Если есть план, но не ожидаем отчёт — игнорируем
    if (u?.plan && !u?.awaitingReport) {
      await sendMsg(bot, chatId, 'Используй кнопки меню для навигации. Нажми "📝 Отчёт" для отправки отчёта о тренировке.');
      return;
    }

    // ПРИОРИТЕТ 3: Если идёт анкета — обрабатываем как раньше
    if (u?.onb) {
      const st = onbState.get(chatId);
      if (!st) return;

      // если ждём интро «ОК ✅» — игнорируем текст
      if (u.onb?.waitingIntro) return;

      // промотать до показываемого вопроса
      while (st.idx < ONB.length && !needShow(ONB[st.idx], st.answers)) st.idx++;
      if (st.idx >= ONB.length) return finishOnboarding(bot, chatId);

      const q = ONB[st.idx];

      if (q.type === 'single') {
        // фоллбэк: ввёл текст вместо клика
        const hit = singleFromText(q, msg.text);
        if (hit) {
          st.answers[q.key] = hit;
          st.idx++;
          await wait(120);
          return _sendQuestion(bot, chatId);
        }
        // попросим нажать кнопку
        await sendMsg(bot, chatId, 'Выбери вариант кнопкой ниже 👇', { reply_markup: kbInlineSingle(q.key, q.opts) });
        return;
      }

      if (q.type === 'number') {
        const v = validateNumber(q, msg.text);
        if (!v.ok) { await sendMsg(bot, chatId, v.err); return; }
        st.answers[q.key] = v.val;
        st.idx++;
        await wait(120);
        return _sendQuestion(bot, chatId);
      }

      // text
      const val = (msg.text||'').trim();
      if (!val && !q.optional) { await sendMsg(bot, chatId, 'Напиши ответ текстом.'); return; }
      st.answers[q.key] = val || null;
      st.idx++;
      await wait(120);
      return _sendQuestion(bot, chatId);
    }
  });

  // клики по inline-кнопкам
  bot.on('callback_query', async (q) => {
    const chatId = q.message?.chat?.id;
    if (!chatId) return;

    if (isDupeCb(chatId, q.data || '')) {
      // Быстрый ACK и выходим
      await answerCbNow(bot, q.id);
      return;
    }

    const u = getUser(chatId);
    const data = q.data || '';

    // интро "ОК ✅"
    if (data.startsWith('onb:ok:')) {
      const blk = data.split(':')[2];
      u.onb = u.onb || { introShown:{} };
      u.onb.introShown[blk] = true;
      u.onb.waitingIntro = null;
      await answerCbNow(bot, q.id, { text:'Ок' });
      await _sendQuestion(bot, chatId);
      return;
    }

    // выбор single
    if (data.startsWith('onb:pick:')) {
      const [, , key, idxStr] = data.split(':'); // onb:pick:key:idx
      const st = onbState.get(chatId);
      if (!st) return answerCbNow(bot, q.id, { text:'Анкета завершена' });
      // промотать до актуального вопроса
      while (st.idx < ONB.length && !needShow(ONB[st.idx], st.answers)) st.idx++;
      const qdef = ONB[st.idx];
      if (!qdef || qdef.key !== key) return answerCbNow(bot, q.id, { text:'Проскочили вопрос' });
      const opt = qdef.opts[Number(idxStr)];
      st.answers[key] = opt;
      st.idx++;
      await answerCbNow(bot, q.id, { text:'✔' });
      await wait(120);
      return _sendQuestion(bot, chatId);
    }

    // построить план
    if (data === 'plan:build') {
      await answerCbNow(bot, q.id, { text:'Собираю план…' });

      const ans = getUser(chatId)?.onbAnswers || {};
      let planJson = null;

      try {
        console.log('Calling GPT with answers:', Object.keys(ans));
        planJson = await generatePlanFromAnswersGPT_JSON(ans, openai);
        console.log('GPT response:', planJson ? 'Success' : 'Failed');
      } catch (e) {
        console.error('GPT plan error', e);
      }

      // Если GPT не сработал - ошибка
      if (!planJson) {
        await sendMsg(bot, chatId, '❌ Ошибка генерации плана. Попробуй ещё раз или обратись к администратору.');
        return;
      }

      // Раскладка JSON в u.plan
      const u = getUser(chatId);
      const start = new Date(); const end = new Date(); end.setDate(start.getDate()+30);

      u.name = planJson.user?.name || ans.name || u.name || 'Друг';
      u.tz   = planJson.user?.tz   || ans.tz   || u.tz   || 'Europe/Moscow';

      const days = planJson.training?.days_per_week || Number(ans.days_per_week)||3;
      const sessMin = planJson.training?.session_length_min;
      const meals = Number(planJson.nutrition?.meals_per_day) || (ans.meals_per_day ? Number(ans.meals_per_day) : 4);

      u.plan = {
        goal: planJson.goals?.primary || ans.goal,
        days_per_week: days,
        session_length: sessMin ? `${sessMin} мин` : (ans.session_length || '60 мин'),
        daily_kcal: planJson.nutrition?.target_kcal || undefined,
        protein_g_per_kg: planJson.nutrition?.protein_g_per_kg || 1.6,
        meals_limit: meals,
        water_goal_ml: Math.round((planJson.nutrition?.water_ai_l || (ans.sex==='М'?2.5:2.0)) * 1000),
        sleep_goal_h: Number(String(planJson.recovery?.sleep_target_h || '7').replace(/[^\d]/g,'')) || 7,
        workouts: (planJson.training?.schedule_week || []).map(d => d.day).filter(Boolean),
        creatine_ok: (ans.creatine_ok === 'Да') || (planJson.reporting?.creatine_ok === true),
        plan_start: start.toISOString(),
        plan_end: end.toISOString(),
        plan_status: 'active'
      };

      // Сохраним GPT план в профиле пользователя
      u.gptPlan = planJson;

      // Сохраним красивый HTML, если вернулся
      const html = planJson.rich_text?.week_overview_html || planJson.rich_text?.intro_html;
      if (html) {
        // Заменяем <br> на \n для Telegram
        const cleanHtml = html.replace(/<br\s*\/?>/gi, '\n');
        await sendMsg(bot, chatId, cleanHtml, { parse_mode:'HTML' });
      } else {
        await sendMsg(bot, chatId, '<b>План готов.</b> Открой «📅 План», чтобы посмотреть детали.', { parse_mode:'HTML' });
      }

      await sendMsg(bot, chatId, 'Готово! Теперь можешь отправлять отчёты о тренировках.', {
        reply_markup: {
          keyboard: [
            [{ text:'📅 План' }, { text:'📝 Отчёт' }],
            [{ text:'🏠 Главное меню' }]
          ],
          resize_keyboard:true
        }
      });
      return;
    }
  });

  console.log('Onboarding: handlers registered');
}

// ==== Public API ============================================================================
function startOnboarding(bot, chatId){
  const u = getUser(chatId);
  if (u.onb) return; // уже идёт
  u.onb = { introShown:{}, waitingIntro:null };
  onbState.set(chatId, { idx:0, answers:{} });
  return sendMsg(bot, chatId, 'Начинаем персонализацию: отвечай коротко и по делу.')
    .then(() => _sendQuestion(bot, chatId));
}

module.exports = {
  getUser,
  registerOnboarding,
  startOnboarding,
  canSendReport,
  incrementReportCount,
  generateReportFeedback
};
