// === ПОЛНЫЙ БЛОК АНКЕТЫ ===

// Импорт OpenAI SDK
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Конфигурация вопросов анкеты
const ONB_QUESTIONS = [
  // БЛОК: ИДЕНТИЧНОСТЬ
  { key: "name", block: "IDENTITY", type: "text", prompt: "Как к тебе обращаться?" },
  { key: "sex", block: "IDENTITY", type: "single", prompt: "Пол:", opts: ["М", "Ж"] },
  { key: "age", block: "IDENTITY", type: "number", prompt: "Возраст (лет):", min: 14, max: 90 },
  { key: "height_cm", block: "IDENTITY", type: "number", prompt: "Рост (см):", min: 130, max: 220 },
  { key: "weight_kg", block: "IDENTITY", type: "number", prompt: "Вес (кг):", min: 35, max: 250 },
  { key: "waist_cm", block: "IDENTITY", type: "number", prompt: "Обхват талии (см):", min: 50, max: 200, optional: true },

  // БЛОК: СКРИНИНГ
  { key: "medical_flags", block: "SCREENING", type: "single", prompt: "Есть ли медицинские противопоказания к физ. нагрузкам?", opts: ["Нет", "Да"] },
  { key: "meds_affecting_ex", block: "SCREENING", type: "single", prompt: "Принимаешь ли лекарства, влияющие на тренировки?", opts: ["Нет", "Да"] },
  { key: "clotting_issue", block: "SCREENING", type: "single", prompt: "Есть ли проблемы со свёртываемостью крови?", opts: ["Нет", "Да"] },
  { key: "pregnancy_status", block: "SCREENING", type: "single", prompt: "Беременность (актуально для женщин):", opts: ["Не актуально", "Актуально"] },
  { key: "cardio_symptoms", block: "SCREENING", type: "single", prompt: "Есть ли сейчас симптомы сердечно-сосудистых проблем?", opts: ["Нет", "Да"] },
  { key: "injury_notes", block: "SCREENING", type: "text", prompt: "Травмы/ограничения (через запятую, если есть):", optional: true },

  // БЛОК: ЦЕЛИ
  { key: "goal", block: "GOALS", type: "single", prompt: "Главная цель:", opts: ["Похудение", "Набор мышечной массы", "Поддержание здоровья и самочувствия", "Увеличение производительности"] },
  { key: "weight_loss_month_kg", block: "GOALS", type: "number", prompt: "На сколько КГ за месяц хочешь похудеть?", min: 0.1, max: 6, showIf: { field: "goal", equals: "Похудение" } },
  { key: "weight_gain_month_kg", block: "GOALS", type: "number", prompt: "На сколько КГ за месяц хочешь набрать?", min: 0.1, max: 6, showIf: { field: "goal", equals: "Набор мышечной массы" } },
  { key: "secondary_goals", block: "GOALS", type: "text", prompt: "Дополнительные цели (через запятую):", optional: true },
  { key: "goal_kpi", block: "GOALS", type: "text", prompt: "Как измеришь успех? (например: -5 кг, 10 подтягиваний):", optional: true },

  // БЛОК: ПРОФИЛЬ
  { key: "level", block: "PROFILE", type: "single", prompt: "Уровень подготовки:", opts: ["Новичок", "Средний", "Продвинутый"] },
  { key: "training_history", block: "PROFILE", type: "text", prompt: "Опыт тренировок (месяцев):", optional: true },
  { key: "rpe_ready", block: "PROFILE", type: "single", prompt: "Знаешь ли шкалу RPE (нагрузка 1-10)?", opts: ["Нет", "Да"] },

  // БЛОК: ЛОГИСТИКА
  { key: "days_per_week", block: "LOGISTICS", type: "number", prompt: "Сколько тренировок в неделю?", min: 1, max: 6 },
  { key: "session_length", block: "LOGISTICS", type: "single", prompt: "Длительность одной тренировки:", opts: ["45 мин", "60 мин", "75 мин", "90 мин"] },
  { key: "preferred_slots", block: "LOGISTICS", type: "text", prompt: "Предпочитаемое время (утро/день/вечер):", optional: true },
  { key: "equipment", block: "LOGISTICS", type: "text", prompt: "Где/что доступно? Введи через запятую из списка:\nДом, Зал, Улица, Штанга, Гантели, Тренажёры, Турник, Эспандеры, Дорожка/вело, Бассейн" },
  { key: "equipment_limits", block: "LOGISTICS", type: "text", prompt: "Ограничения по инвентарю:", optional: true },

  // БЛОК: ПРЕДПОЧТЕНИЯ
  { key: "dislikes", block: "PREFERENCES", type: "text", prompt: "Что НЕ нравится/не подходит? (через запятую):", optional: true },
  { key: "cardio_pref", block: "PREFERENCES", type: "single", prompt: "Предпочтения по кардио:", opts: ["Любое", "Только ходьба", "Без бега", "Плавание"] },

  // БЛОК: ПИТАНИЕ
  { key: "diet_limits", block: "NUTRITION", type: "text", prompt: "Диетические ограничения (через запятую):", optional: true },
  { key: "track_style", block: "NUTRITION", type: "single", prompt: "Как будешь отслеживать питание?", opts: ["Только калории", "Только белок", "Да", "Нет"] },
  { key: "meals_per_day", block: "NUTRITION", type: "number", prompt: "Сколько приёмов пищи в день?", min: 1, max: 6 },
  { key: "water_ready", block: "NUTRITION", type: "single", prompt: "Готов ли отслеживать воду?", opts: ["Нет", "Да"] },

  // БЛОК: ВОССТАНОВЛЕНИЕ
  { key: "sleep_hours", block: "RECOVERY", type: "number", prompt: "Сколько часов спишь в среднем?", min: 4, max: 12 },
  { key: "stress_level", block: "RECOVERY", type: "single", prompt: "Уровень стресса:", opts: ["Низкий", "Средний", "Высокий"] },
  { key: "steps_level", block: "RECOVERY", type: "single", prompt: "Средняя активность (шагов/день):", opts: ["<5k", "5–8k", "8–11k", ">11k"] },

  // БЛОК: КАРДИО И ШАГИ
  { key: "z2_after_lifts", block: "CARDIO", type: "single", prompt: "Готов ли делать кардио Z2 после силовых?", opts: ["Нет", "Да"] },
  { key: "swim_ok", block: "CARDIO", type: "single", prompt: "Плавание доступно?", opts: ["Нет", "Да"] },
  { key: "steps_goal_ok", block: "CARDIO", type: "single", prompt: "Готов ли ставить цели по шагам?", opts: ["Нет", "Да"] },

  // БЛОК: ДОБАВКИ И ОТЧЁТЫ
  { key: "creatine_ok", block: "SUPPS", type: "single", prompt: "Ок с креатином 3–5 г/день?", opts: ["Нет", "Да"] },
  { key: "omega_vitd", block: "SUPPS", type: "single", prompt: "Принимаешь ли Омега-3/Витамин D?", opts: ["Нет", "Да"] },
  { key: "report_style", block: "REPORTING", type: "single", prompt: "Как будешь отчитываться?", opts: ["Сразу после тренировки", "Один раз вечером"] },
  { key: "plan_rebuilds_ok", block: "REPORTING", type: "single", prompt: "Разрешаешь корректировать план?", opts: ["Нет", "Да"] },
  { key: "micro_swaps_ok", block: "REPORTING", type: "single", prompt: "Разрешаешь замены упражнений?", opts: ["Нет", "Да"] },
  { key: "month_constraints", block: "REPORTING", type: "text", prompt: "Ограничения на месяц (командировки, отпуск):", optional: true },
  { key: "reminder_mode", block: "REPORTING", type: "single", prompt: "Режим напоминаний:", opts: ["Мягкий", "Средний", "Жёсткий"] }
];

// Состояние анкеты по чатам
const onbState = new Map();

// Функция проверки условий показа вопроса
function shouldShowQuestion(question, answers) {
  if (!question.showIf) return true;
  
  const { field, equals } = question.showIf;
  return answers[field] === equals;
}

// Функция получения следующего вопроса
function getNextQuestion(chatId) {
  const state = onbState.get(chatId);
  if (!state) return null;
  
  let currentIndex = state.idx;
  
  // Ищем следующий подходящий вопрос
  while (currentIndex < ONB_QUESTIONS.length) {
    const question = ONB_QUESTIONS[currentIndex];
    if (shouldShowQuestion(question, state.answers)) {
      return { question, index: currentIndex };
    }
    currentIndex++;
  }
  
  return null; // Анкета завершена
}

// Функция валидации ответа
function validateAnswer(question, text) {
  if (question.optional && (!text || text.trim() === '')) {
    return { ok: true, val: null };
  }
  
  switch (question.type) {
    case 'number':
      const num = Number((text || "").replace(",", "."));
      if (Number.isNaN(num)) return { ok: false, err: "Нужна цифра." };
      if (question.min && num < question.min) return { ok: false, err: `Минимум ${question.min}.` };
      if (question.max && num > question.max) return { ok: false, err: `Максимум ${question.max}.` };
      return { ok: true, val: num };
      
    case 'single':
      if (!question.opts.includes(text)) return { ok: false, err: "Выбери из кнопок ниже." };
      return { ok: true, val: text };
      
    case 'text':
      const val = (text || "").trim();
      if (!val && !question.optional) return { ok: false, err: "Напиши ответ текстом." };
      return { ok: true, val: val || null };
      
    default:
      return { ok: true, val: text };
  }
}

// Функция отправки вопроса
async function _sendQuestion(bot, chatId) {
  const next = getNextQuestion(chatId);
  if (!next) {
    // Анкета завершена
    await finishOnboarding(bot, chatId);
    return;
  }
  
  const { question, index } = next;
  const state = onbState.get(chatId);
  state.idx = index;
  
  if (question.type === "single") {
    const keyboard = {
      keyboard: [question.opts.map(opt => ({ text: opt }))],
      resize_keyboard: true,
      one_time_keyboard: true
    };
    await bot.sendMessage(chatId, question.prompt, { reply_markup: keyboard });
  } else {
    const keyboard = { remove_keyboard: true };
    await bot.sendMessage(chatId, question.prompt, { reply_markup: keyboard });
  }
}

// Функция завершения анкеты
async function finishOnboarding(bot, chatId) {
  const state = onbState.get(chatId);
  if (!state) return;
  
  // Создаём план из ответов
  const built = createPlanFromAnswers(state.answers);
  
  // Получаем пользователя и сохраняем план
  const u = getUser(chatId);
  
  setUser(chatId, { 
    ...built, 
    name: state.answers.name || u.name || 'Друг',
    onbAnswers: state.answers // сохраняем ответы анкеты
  });
  
  // Очищаем состояние
  onbState.delete(chatId);
  
  // Показываем результат
  const summary = `План готов ✅\n\n` +
    `• Цель: ${built.plan.goal}\n` +
    `• Тренировок/нед: ${built.plan.days_per_week} (${built.plan.session_length})\n` +
    `• Ккал/день: ~${built.plan.daily_kcal}\n` +
    `• Белок: ${built.plan.protein_g_per_kg} г/кг\n` +
    `• Вода: ~${built.plan.water_goal_ml} мл\n` +
    `• Сон: ⩾${built.plan.sleep_goal_h} ч\n` +
    `• Схема силовых: ${built.plan.workouts.join(" · ")}`;
  
  // Используем клавиатуру из основного файла
  const keyboard = {
    keyboard: [
      [{ text: '• 🏠 Главная' }, { text: '📅 План' }],
      [{ text: '🍽️ Еда' }, { text: '📝 Отчёты' }],
      [{ text: '🧭 Анкета' }, { text: '⚙️ Настройки' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
  await bot.sendMessage(chatId, summary, { reply_markup: keyboard });
}

// Функция создания плана из ответов (базовая версия)
function createPlanFromAnswers(answers) {
  const rmr = mifflinStJeor({ 
    sex: answers.sex, 
    weight: +answers.weight_kg || 70, 
    height: +answers.height_cm || 170, 
    age: +answers.age || 30 
  });
  
  const tdee = Math.round(rmr * palFromSteps(answers.steps_level));
  const daily_kcal = kcalByGoal(tdee, answers.goal);
  
  const plan = {
    goal: answers.goal,
    days_per_week: +answers.days_per_week || 3,
    session_length: answers.session_length || "60 мин",
    equipment: Array.isArray(answers.equipment) ? answers.equipment : 
               String(answers.equipment || "").split(",").map(s => s.trim()).filter(Boolean),
    dislikes: Array.isArray(answers.dislikes) ? answers.dislikes : 
              String(answers.dislikes || "").split(",").map(s => s.trim()).filter(Boolean),
    daily_kcal,
    protein_g_per_kg: 1.6,
    meals_limit: 4,
    water_goal_ml: 2200,
    sleep_goal_h: 7,
    workouts: defaultWorkouts(+answers.days_per_week || 3),
    goodnight_window: "23:00±10m",
    creatine_ok: answers.creatine_ok ?? null
  };
  
  const start = new Date();
  const end = new Date();
  end.setDate(start.getDate() + 30);
  
  return {
    plan,
    plan_start: start.toISOString(),
    plan_end: end.toISOString(),
    plan_status: "active"
  };
}

// Вспомогательные функции (если не определены в основном файле)
function mifflinStJeor({ sex, weight, height, age }) {
  const s = (sex === "М" || sex === "M") ? 5 : -161;
  return Math.round(10 * weight + 6.25 * height - 5 * age + s);
}

function palFromSteps(steps_level) {
  return { "<5k": 1.3, "5–8k": 1.45, "8–11k": 1.6, ">11k": 1.75 }[steps_level] || 1.4;
}

function kcalByGoal(tdee, goal) {
  if (goal === "Похудение") return Math.round(tdee * 0.85);
  if (goal === "Набор мышечной массы") return Math.round(tdee * 1.10);
  return Math.round(tdee);
}

function defaultWorkouts(days) {
  const map = { 2: ["Full Body A", "Full Body B"], 3: ["Upper", "Lower", "Full"], 4: ["Upper", "Lower", "Push", "Pull"] };
  return map[days] || map[3];
}

// Функции будут переданы из основного файла
let getUser = null;
let setUser = null;

// Функция для инициализации с переданными функциями
function initOnboarding(getUserFn, setUserFn) {
  getUser = getUserFn;
  setUser = setUserFn;
}

// Главная клавиатура (соответствует основному файлу)
const mainKb = {
  keyboard: [
    [{ text: '🏠 Главная' }, { text: '📅 План' }],
    [{ text: '🍽️ Еда' }, { text: '📝 Отчёты' }],
    [{ text: '🧭 Анкета' }, { text: '⚙️ Настройки' }]
  ],
  resize_keyboard: true,
  one_time_keyboard: false
};

// Регистрация обработчиков анкеты
function registerOnboarding(bot) {
  // Обработчик ответов на вопросы анкеты будет добавлен в основной файл
  // Здесь только инициализация состояния
  console.log('Onboarding module loaded');
}

// Функция запуска анкеты
function startOnboarding(bot, chatId) {
  const u = getUser(chatId);
  u.onb = { idx: 0, answers: {}, currentBlock: 'IDENTITY', introShown: {} };
  
  // Инициализируем состояние анкеты
  onbState.set(chatId, { idx: 0, answers: {} });
  
  return bot.sendMessage(chatId, 'Начинаем персонализацию: отвечай коротко и по делу.')
    .then(() => _sendQuestion(bot, chatId));
}

module.exports = { 
  initOnboarding,
  registerOnboarding, 
  startOnboarding, 
  onbState,
  getNextQuestion,
  validateAnswer,
  _sendQuestion
};
