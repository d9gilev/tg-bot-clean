// === ONBOARDING v2025-08-30 ===

// OpenAI (для генерации плана). Можно отключить — будет фоллбэк.
const OpenAI = require('openai');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// ==== Flood control & retries (429) ==========================================================
const wait = (ms) => new Promise(r => setTimeout(r, ms));

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
    await wait(1100); // пауза с запасом
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

// ==== User store ============================================================================
const __users = global.__users || (global.__users = new Map());
function ensureUser(chatId) {
  if (!__users.has(chatId)) {
    __users.set(chatId, { chatId, tz: process.env.TZ_DEFAULT || 'Europe/Moscow' });
  }
  return __users.get(chatId);
}
const getUser = ensureUser;

// ==== Helpers ===============================================================================
function norm(s){ return (s||'').toString().trim().toLowerCase().replace(/ё/g,'е'); }
function chunk(arr, n){ const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; }

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
  { key:'name', block:'IDENTITY', type:'text',   prompt:'Как к тебе обращаться?' },
  { key:'sex',  block:'IDENTITY', type:'single', prompt:'Пол:', opts:['М','Ж'] },
  { key:'tz',   block:'IDENTITY', type:'single', prompt:'Часовой пояс (для напоминаний):', 
    opts:['Europe/Moscow','Europe/Amsterdam','Asia/Almaty','Asia/Dubai','America/New_York','Другое…'] },
  { key:'age',       block:'IDENTITY', type:'number', prompt:'Возраст (лет):',    min:14, max:90 },
  { key:'height_cm', block:'IDENTITY', type:'number', prompt:'Рост (см):',        min:130, max:220 },
  { key:'weight_kg', block:'IDENTITY', type:'number', prompt:'Вес (кг):',         min:35,  max:250 },
  { key:'waist_cm',  block:'IDENTITY', type:'number', prompt:'Талия (см) — по желанию:', min:50, max:200, optional:true },

  // === 2) SCREENING ===
  { key:'medical_flags',   block:'SCREENING', type:'single', prompt:'Есть диагностированные проблемы сердца/сосудов/обмена/почек или симптомы при нагрузке?', opts:['Нет','Да'] },
  { key:'meds_affecting',  block:'SCREENING', type:'single', prompt:'Принимаешь лекарства, влияющие на пульс/давление (β-блокаторы и т.п.)?', opts:['Нет','Да'] },
  { key:'meds_list',       block:'SCREENING', type:'text',   prompt:'Укажи названия препаратов (коротко):', showIf:{ field:'meds_affecting', equals:'Да' } },
  { key:'clotting_issue',  block:'SCREENING', type:'single', prompt:'Нарушения свёртываемости крови или антикоагулянты?', opts:['Нет','Да'] },
  { key:'pregnancy_status',block:'SCREENING', type:'single', prompt:'Беременность/послеродовый период?', opts:['Не актуально','Актуально'], showIf:{ field:'sex', equals:'Ж' } },
  { key:'cardio_symptoms', block:'SCREENING', type:'single', prompt:'Есть тревожные симптомы сейчас (боль/давление в груди, необъяснимая одышка, обмороки)?', opts:['Нет','Да'] },
  { key:'injury_notes',    block:'SCREENING', type:'text',   prompt:'Травмы/операции за 12 мес? Движения/упражнения, которые вызывают боль? (коротко)', optional:true },

  // === 3) GOALS ===
  { key:'goal',                 block:'GOALS', type:'single', prompt:'Главная цель на месяц:', opts:['Похудение','Набор мышечной массы','Поддержание здоровья и самочувствия','Увеличение производительности'] },
  { key:'weight_loss_month_kg', block:'GOALS', type:'number', prompt:'На сколько КГ за месяц хочешь похудеть?', min:0.1, max:6, showIf:{ field:'goal', equals:'Похудение' } },
  { key:'weight_gain_month_kg', block:'GOALS', type:'number', prompt:'На сколько КГ за месяц хочешь набрать?',  min:0.1, max:6, showIf:{ field:'goal', equals:'Набор мышечной массы' } },
  { key:'secondary_goals',      block:'GOALS', type:'text',   prompt:'Вторичные цели (до 3, через запятую):', optional:true },
  { key:'goal_kpi',             block:'GOALS', type:'text',   prompt:'Как поймём, что месяц прошёл удачно? (KPI: −2 кг, +2 подтягивания, 10k шагов/день)', optional:true },

  // === 4) PROFILE ===
  { key:'level',        block:'PROFILE', type:'single', prompt:'Уровень в силовых:', opts:['Новичок','Средний','Продвинутый'] },
  { key:'training_hist',block:'PROFILE', type:'text',   prompt:'Стаж/перерывы (коротко):', optional:true },
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
  { key:'report_style',     block:'REPORTING', type:'single', prompt:'Как удобнее отчитываться?', opts:['Сразу после тренировки','Один раз вечером'] },
  { key:'plan_rebuilds_ok', block:'REPORTING', type:'single', prompt:'Пересборка плана до 2–3 раз/мес — ок?', opts:['Да','Нет'] },
  { key:'micro_swaps_ok',   block:'REPORTING', type:'single', prompt:'Точечные замены (1–2 упр.) — ок?', opts:['Да','Нет'] },
  { key:'month_constraints',block:'REPORTING', type:'text',   prompt:'Жёсткие дедлайны/поездки в этом месяце? (коротко)', optional:true },
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
  await sendMsg(bot, chatId,
    `<b>${blockName(block)}</b>\n${intro}\n\n<b>Источник:</b> PAR-Q+/ACSM, ВОЗ-2020, AASM/SRS (сон), Morton-2018 (белок), ISSN (креатин).`,
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

async function _sendQuestion(bot, chatId){
  const st = onbState.get(chatId);
  if (!st) return;

  // интро перед входом в новый блок
  const blk = currentBlock(st);
  const u = getUser(chatId);
  u.onb = u.onb || { introShown:{} };
  if (!u.onb.introShown[blk]) {
    u.onb.waitingIntro = blk;
    await sendIntro(bot, chatId, blk);
    return;
  }

  // найти следующий показываемый вопрос
  while (st.idx < ONB.length && !needShow(ONB[st.idx], st.answers)) st.idx++;
  if (st.idx >= ONB.length) return finishOnboarding(bot, chatId);

  const q = ONB[st.idx];

  if (q.type === 'single') {
    // inline buttons
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
async function finishOnboarding(bot, chatId){
  const st = onbState.get(chatId);
  if (!st) return;

  const u = getUser(chatId);
  u.onbAnswers = st.answers;
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

function fallbackPlan(ans){
  const rmr  = mifflinStJeor({ sex:ans.sex, weight:+ans.weight_kg||70, height:+ans.height_cm||170, age:+ans.age||30 });
  const tdee = Math.round(rmr * palFromSteps(ans.steps_level));
  const kcal = kcalByGoal(tdee, ans.goal);
  const days = +ans.days_per_week || 3;
  const sessions = {2:['Full A','Full B'],3:['Upper','Lower','Full'],4:['Upper','Lower','Push','Pull']}[days] || ['Upper','Lower','Full'];
  return {
    kcal, protein_g_per_kg:1.6, water_ml: (ans.sex==='М'?2500:2000), sleep_h:7,
    days, sessions
  };
}

async function generatePlanFromAnswersGPT(ans){
  if (!openai) return null;
  const name = ans.name || 'клиент';
  const sys = `Ты — профессиональный тренер и нутрициолог. Составь план на 4 недели.
Выводи кратко, но структурно, в HTML для Telegram. Используй имя в разных формах по-русски.`;
  const user = {
    name, sex:ans.sex, age:ans.age, height_cm:ans.height_cm, weight_kg:ans.weight_kg, tz:ans.tz,
    goal:ans.goal, weight_loss_month_kg:ans.weight_loss_month_kg, weight_gain_month_kg:ans.weight_gain_month_kg,
    level:ans.level, rpe_ready:ans.rpe_ready, days_per_week:ans.days_per_week, session_length:ans.session_length,
    equipment:ans.equipment, dislikes:ans.dislikes, cardio_pref:ans.cardio_pref,
    diet_limits:ans.diet_limits, track_style:ans.track_style, meals_per_day:ans.meals_per_day, water_ready:ans.water_ready,
    sleep_hours:ans.sleep_hours, stress_level:ans.stress_level, steps_level:ans.steps_level,
    z2_after_lifts:ans.z2_after_lifts, swim_ok:ans.swim_ok, steps_goal_ok:ans.steps_goal_ok,
    creatine_ok:ans.creatine_ok, omega_vitd:ans.omega_vitd, reminder_mode:ans.reminder_mode
  };

  const content = JSON.stringify(user);
  const model = process.env.OPENAI_MODEL_PLAN || 'gpt-4o-mini';

  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role:'system', content: sys },
      { role:'user',   content: `Собери план на месяц по данным:\n${content}\nТребования к формату: 
1) Заголовок, затем блоки: Расписание (дни недели → мышцы/упр./подходы/повторы/RPE/отдых), Кардио Z2 (объём/частота), Питание (ккал, белок г/кг, приёмы пищи), Вода (мл/день), Сон (цель), Напоминания (окна), Отчётность (что присылать), Ограничения.\n2) Пиши читабельно, списками / подзаголовками, без «воды».` }
    ],
    temperature: 0.4
  });
  return resp.choices?.[0]?.message?.content || null;
}

// ==== Registration ==========================================================================
function registerOnboarding(bot){

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

  // ответы текстом
  bot.on('message', async (msg) => {
    const chatId = msg.chat?.id;
    if (!chatId || !msg.text) return;

    const u = getUser(chatId);
    if (!u?.onb) return; // вне анкеты — игнор

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
  });

  // клики по inline-кнопкам
  bot.on('callback_query', async (q) => {
    const chatId = q.message?.chat?.id;
    if (!chatId) return;

    const u = getUser(chatId);
    const data = q.data || '';

    // интро "ОК ✅"
    if (data.startsWith('onb:ok:')) {
      const blk = data.split(':')[2];
      u.onb = u.onb || { introShown:{} };
      u.onb.introShown[blk] = true;
      u.onb.waitingIntro = null;
      await answerCb(bot, q.id, chatId, { text:'Ок' });
      await _sendQuestion(bot, chatId);
      return;
    }

    // выбор single
    if (data.startsWith('onb:pick:')) {
      const [, , key, idxStr] = data.split(':'); // onb:pick:key:idx
      const st = onbState.get(chatId);
      if (!st) return answerCb(bot, q.id, chatId, { text:'Анкета завершена' });
      // промотать до актуального вопроса
      while (st.idx < ONB.length && !needShow(ONB[st.idx], st.answers)) st.idx++;
      const qdef = ONB[st.idx];
      if (!qdef || qdef.key !== key) return answerCb(bot, q.id, chatId, { text:'Проскочили вопрос' });
      const opt = qdef.opts[Number(idxStr)];
      st.answers[key] = opt;
      st.idx++;
      await answerCb(bot, q.id, chatId, { text:'✔' });
      await wait(120);
      return _sendQuestion(bot, chatId);
    }

    // построить план
    if (data === 'plan:build') {
      await answerCb(bot, q.id, chatId, { text:'Собираю план…' });
      const ans = getUser(chatId)?.onbAnswers || {};
      let planHtml = null;
      try {
        planHtml = await generatePlanFromAnswersGPT(ans);
      } catch(e) {
        console.error('GPT plan error', e);
      }
      if (!planHtml) {
        const fb = fallbackPlan(ans);
        planHtml =
`<b>План на 4 недели</b>
<b>Питание:</b> ~${fb.kcal} ккал/день, белок ~${fb.protein_g_per_kg} г/кг.
<b>Вода:</b> ~${fb.water_ml} мл, <b>сон:</b> ⩾${fb.sleep_h} ч.
<b>Силовые ${fb.days}×/нед:</b> ${fb.sessions.join(' · ')}.
<b>Кардио Z2:</b> 20–30 мин по согласованию.`;
      }
      await sendMsg(bot, chatId, planHtml, { parse_mode:'HTML' });

      // закрепим основные переменные в профиле пользователя
      const u = getUser(chatId);
      u.plan = { builtAt: new Date().toISOString(), html: planHtml };
      await sendMsg(bot, chatId, 'Готово! Возвращаюсь в меню.', {
        reply_markup: {
          keyboard: [
            [{ text:'🏠 Главная' }, { text:'📅 План' }],
            [{ text:'🍽️ Еда' },   { text:'📝 Отчёты' }],
            [{ text:'🧭 Анкета' }, { text:'⚙️ Настройки' }]
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
  startOnboarding
};
