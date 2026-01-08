const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN. Set it in .env or your environment and restart.');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const QUESTIONS_PATH = path.join(DATA_DIR, 'database_test_questions.json');
const STATS_PATH = path.join(DATA_DIR, 'stats.json');
const QUIZ_SIZE = 20;
const QUIZ_DURATION_MS = 60 * 60 * 1000; // 1 час на весь тест
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 3;
const PASSING_SCORE = 50;
const DIFFICULTY_SETTINGS = {
  1: { label: 'Легкий', points: 2, count: 8 },
  2: { label: 'Средний', points: 3, count: 6 },
  3: { label: 'Сложный', points: 4, count: 6 }
};

function loadQuestions() {
  const raw = fs.readFileSync(QUESTIONS_PATH, 'utf8');
  return JSON.parse(raw);
}

function loadStats() {
  try {
    const raw = fs.readFileSync(STATS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

function saveStats(stats) {
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2));
}

function shuffleArray(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function groupByDifficulty(questions) {
  const map = new Map();
  questions.forEach((q) => {
    const level = Number(q.difficulty_level);
    if (!map.has(level)) {
      map.set(level, []);
    }
    map.get(level).push(q);
  });
  return map;
}

function getDifficultySettings(level) {
  return DIFFICULTY_SETTINGS[level] || { label: 'Неизвестно', points: 0, count: 0 };
}

function getDifficultyPoints(level) {
  return getDifficultySettings(level).points;
}

function buildQuizQuestions(questions) {
  const byDifficulty = groupByDifficulty(questions);
  const usedIds = new Set();
  const selected = [];

  for (let level = MIN_DIFFICULTY; level <= MAX_DIFFICULTY; level += 1) {
    const pool = byDifficulty.get(level) || [];
    const targetCount = getDifficultySettings(level).count;
    if (targetCount <= 0) {
      continue;
    }
    const choices = shuffleArray(pool).filter((q) => !usedIds.has(q.id)).slice(0, targetCount);
    choices.forEach((q) => {
      usedIds.add(q.id);
      selected.push({
        ...q,
        options: shuffleArray(q.options)
      });
    });
  }

  if (selected.length < QUIZ_SIZE) {
    const remaining = shuffleArray(questions).filter((q) => !usedIds.has(q.id));
    remaining.slice(0, QUIZ_SIZE - selected.length).forEach((q) => {
      selected.push({
        ...q,
        options: shuffleArray(q.options)
      });
    });
  }

  return shuffleArray(selected).slice(0, QUIZ_SIZE);
}

function createEmptyPerDifficulty() {
  const perDifficulty = {};
  for (let level = MIN_DIFFICULTY; level <= MAX_DIFFICULTY; level += 1) {
    perDifficulty[level] = {
      asked: 0,
      correct: 0,
      points: 0,
      pointsPossible: 0
    };
  }
  return perDifficulty;
}

function ensureUserStats(stats, userId) {
  if (!stats[userId]) {
    stats[userId] = {
      totalQuizzes: 0,
      totalQuestions: 0,
      correctAnswers: 0,
      incorrectAnswers: 0,
      totalPoints: 0,
      totalPointsPossible: 0,
      perDifficulty: createEmptyPerDifficulty(),
      lastQuiz: null
    };
  }
  if (typeof stats[userId].totalPoints !== 'number') {
    stats[userId].totalPoints = 0;
  }
  if (typeof stats[userId].totalPointsPossible !== 'number') {
    stats[userId].totalPointsPossible = 0;
  }
  if (!stats[userId].perDifficulty) {
    stats[userId].perDifficulty = createEmptyPerDifficulty();
  }
  for (let level = MIN_DIFFICULTY; level <= MAX_DIFFICULTY; level += 1) {
    if (!stats[userId].perDifficulty[level]) {
      stats[userId].perDifficulty[level] = {
        asked: 0,
        correct: 0,
        points: 0,
        pointsPossible: 0
      };
    }
    if (typeof stats[userId].perDifficulty[level].points !== 'number') {
      stats[userId].perDifficulty[level].points = 0;
    }
    if (typeof stats[userId].perDifficulty[level].pointsPossible !== 'number') {
      stats[userId].perDifficulty[level].pointsPossible = 0;
    }
  }
}

function updateStats(stats, userId, question, isCorrect) {
  ensureUserStats(stats, userId);
  const entry = stats[userId];
  const level = Number(question.difficulty_level);
  const points = getDifficultyPoints(level);

  entry.totalQuestions += 1;
  entry.totalPointsPossible += points;
  if (isCorrect) {
    entry.correctAnswers += 1;
    entry.totalPoints += points;
  } else {
    entry.incorrectAnswers += 1;
  }

  if (!entry.perDifficulty[level]) {
    entry.perDifficulty[level] = {
      asked: 0,
      correct: 0,
      points: 0,
      pointsPossible: 0
    };
  }

  entry.perDifficulty[level].asked += 1;
  entry.perDifficulty[level].pointsPossible += points;
  if (isCorrect) {
    entry.perDifficulty[level].correct += 1;
    entry.perDifficulty[level].points += points;
  }
}

function formatStats(entry) {
  if (!entry) {
    return 'Статистика пока пустая. Запустите тест командой /quiz.';
  }

  const total = entry.totalQuestions;
  const accuracy = total > 0 ? Math.round((entry.correctAnswers / total) * 100) : 0;
  const lines = [
    `Тестов пройдено: ${entry.totalQuizzes}`,
    `Вопросов всего: ${entry.totalQuestions}`,
    `Правильных: ${entry.correctAnswers}`,
    `Неправильных: ${entry.incorrectAnswers}`,
    `Баллы: ${entry.totalPoints}/${entry.totalPointsPossible}`,
    `Точность: ${accuracy}%`
  ];

  if (entry.lastQuiz) {
    const verdict = entry.lastQuiz.passed ? 'сдан' : 'не сдан';
    lines.push(
      `Последний тест: ${entry.lastQuiz.correct}/${entry.lastQuiz.total}, ` +
      `баллы ${entry.lastQuiz.score}/${entry.lastQuiz.maxScore} (${verdict})`
    );
  }

  const perLevel = [];
  for (let level = MIN_DIFFICULTY; level <= MAX_DIFFICULTY; level += 1) {
    const stat = entry.perDifficulty[level];
    if (stat && stat.asked > 0) {
      const levelAccuracy = Math.round((stat.correct / stat.asked) * 100);
      const pointsLine = `${stat.points}/${stat.pointsPossible}`;
      perLevel.push(`Уровень ${level}: ${stat.correct}/${stat.asked} (${levelAccuracy}%), баллы ${pointsLine}`);
    }
  }

  if (perLevel.length > 0) {
    lines.push('', 'По уровням сложности:', ...perLevel);
  }

  return lines.join('\n');
}

const questions = loadQuestions();
const stats = loadStats();
const bot = new Telegraf(BOT_TOKEN);
const activeQuizzes = new Map();
const userLang = new Map(); // userId -> 'ru' | 'en' | 'both'
const DEFAULT_LANG = 'both';

function getUserLang(userId) {
  return userLang.get(userId) || DEFAULT_LANG;
}

function safeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pickTextByLang({ ru, en, mode }) {
  const ruT = safeText(ru);
  const enT = safeText(en);

  if (mode === 'ru') return ruT;
  if (mode === 'en') return enT || ruT; // fallback на RU, если EN пустой
  // both
  if (enT) return `${ruT}\n\nEN: ${enT}`;
  return ruT;
}


async function sendQuestion(ctx, quizState) {
  const question = quizState.questions[quizState.currentIndex];
  if (!question) return;

  const userId = ctx.from.id;
  const langMode = getUserLang(userId);

  const settings = getDifficultySettings(Number(question.difficulty_level));
  const timeLeft = formatMs(quizState.deadline - Date.now());

  const header =
    `Вопрос ${quizState.currentIndex + 1}/${quizState.questions.length} ` +
    `(уровень ${question.difficulty_level} — ${settings.label})`;

  const qBody = pickTextByLang({
    ru: question.question_ru,
    en: question.question_en,
    mode: langMode
  });

  // 1) Вопрос отдельным сообщением (без кнопок)
  await ctx.reply(
    `${header}\n` +
    `Баллы за вопрос: ${settings.points}\n` +
    `Осталось времени: ${timeLeft}\n\n` +
    qBody
  );

  // 2) Варианты отдельным сообщением снизу + кнопки A/B/C/D
  const letters = ['A', 'B', 'C', 'D'];
  const opts = Array.isArray(question.options) ? question.options : [];

  const lines = opts.map((opt, i) => {
    const letter = letters[i] || String(i + 1);

    const optBody = pickTextByLang({
      ru: opt.option_ru,
      en: opt.option_en,
      mode: langMode
    });

    // В режиме both optBody уже включает "EN: ..."
    // чтобы выглядело аккуратно, делаем отступ, если есть переносы
    const formatted = optBody.replace(/\n/g, '\n   ');
    return `${letter}. ${formatted}`;
  });

  const optionsText = `Выберите вариант:\n\n${lines.join('\n')}`;

  const buttons = opts.map((_, index) =>
    Markup.button.callback(letters[index] || String(index + 1), `a|${quizState.currentIndex}|${index}`)
  );

  return ctx.reply(optionsText, Markup.inlineKeyboard(buttons, { columns: 4 }));
}



function safeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}


function formatMs(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function finishQuiz(ctx, userId, quizState, reason) {
  if (quizState.timerId) clearTimeout(quizState.timerId);
  ensureUserStats(stats, userId);
  const passed = quizState.score >= PASSING_SCORE;

  stats[userId].totalQuizzes += 1;
  stats[userId].lastQuiz = {
    total: quizState.questions.length,
    correct: quizState.correctCount,
    score: quizState.score,
    maxScore: quizState.maxScore,
    passed,
    finishedAt: new Date().toISOString(),
    reason
  };
  saveStats(stats);

  if (quizState.timerId) clearTimeout(quizState.timerId);
  activeQuizzes.delete(userId);

  const message =
    `Тест завершен (${reason}).\n` +
    `Результат: ${quizState.correctCount}/${quizState.questions.length}\n` +
    `Баллы: ${quizState.score}/${quizState.maxScore}\n` +
    `${passed ? 'Сдан' : 'Не сдан'} (нужно ${PASSING_SCORE}).`;

  return ctx.reply(message);
}


async function startQuiz(ctx) {
  const userId = ctx.from.id;

  // Если уже есть активный тест — перезапустим (и очистим старый таймер)
  const existing = activeQuizzes.get(userId);
  if (existing && existing.timerId) {
    clearTimeout(existing.timerId);
  }

  const quizQuestions = buildQuizQuestions(questions);
  const maxScore = quizQuestions.reduce(
    (sum, question) => sum + getDifficultyPoints(Number(question.difficulty_level)),
    0
  );

  const startedAt = Date.now();
  const deadline = startedAt + QUIZ_DURATION_MS;

  const quizState = {
    questions: quizQuestions,
    currentIndex: 0,
    correctCount: 0,
    score: 0,
    maxScore,
    startedAt,
    deadline,
    timerId: null
  };

  // Таймер на 1 час
  quizState.timerId = setTimeout(() => {
    // завершаем тест по времени, если ещё активен
    const stillActive = activeQuizzes.get(userId);
    if (!stillActive) return;
    // ctx в таймере всё ещё рабочий для reply (Telegraf обычно ок)
    finishQuiz(ctx, userId, stillActive, 'время вышло');
  }, QUIZ_DURATION_MS);

  activeQuizzes.set(userId, quizState);

  await ctx.reply(
    'Старт теста.\n\n' +
    `• Вопросов: ${QUIZ_SIZE}\n` +
    `• Проходной балл: ${PASSING_SCORE}\n` +
    `• Время: 60 минут\n` +
    `• Язык: ${getUserLang(userId)} (сменить: /lang ru | /lang en | /lang both)\n`
  );


  return sendQuestion(ctx, quizState);
}


bot.start(async (ctx) => {
  const text =
    'Добро пожаловать в SQL Quiz Bot.\n\n' +
    'Что умею:\n' +
    '• /quiz — начать тест (20 вопросов)\n' +
    '• /stats — статистика\n' +
    '• /resetstats — сброс статистики\n\n' +
    `Правила:\n` +
    `• Нужно набрать ${PASSING_SCORE} баллов\n` +
    `• Легкий: 2 балла, Средний: 3 балла, Сложный: 4 балла\n\n` +
    'Нажмите /quiz чтобы начать.';

  await ctx.reply(
    'Старт теста.\n\n' +
    `• Вопросов: ${QUIZ_SIZE}\n` +
    `• Проходной балл: ${PASSING_SCORE}\n` +
    `• Начинаем сейчас.\n`
  );

  return startQuiz(ctx);
});


bot.command('quiz', (ctx) => startQuiz(ctx));

bot.command('stats', (ctx) => {
  const userId = ctx.from.id;
  ensureUserStats(stats, userId);
  saveStats(stats);
  const entry = stats[userId];
  return ctx.reply(formatStats(entry));
});

bot.command('resetstats', (ctx) => {
  const userId = ctx.from.id;
  delete stats[userId];
  saveStats(stats);
  return ctx.reply('Статистика сброшена.');
});
bot.command('lang', async (ctx) => {
  const userId = ctx.from.id;
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  const mode = (parts[1] || '').toLowerCase();

  if (!['ru', 'en', 'both'].includes(mode)) {
    return ctx.reply('Использование: /lang ru | /lang en | /lang both');
  }

  userLang.set(userId, mode);
  return ctx.reply(`Язык установлен: ${mode}`);
});


bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data || '';
  if (!data.startsWith('a|')) {
    return ctx.answerCbQuery();
  }

  const parts = data.split('|');
  const questionIndex = Number(parts[1]);
  const optionIndex = Number(parts[2]);
  const userId = ctx.from.id;
  const quizState = activeQuizzes.get(userId);

  if (!quizState) {
    return ctx.answerCbQuery('Нет активного теста');
  }

  if (questionIndex !== quizState.currentIndex) {
    return ctx.answerCbQuery('Этот вопрос уже отвечен');
  }

  const question = quizState.questions[quizState.currentIndex];
  const selected = question.options[optionIndex];

  if (!selected) {
    return ctx.answerCbQuery('Некорректный ответ');
  }

  const isCorrect = selected.is_correct === true;
  const points = getDifficultyPoints(Number(question.difficulty_level));
  if (isCorrect) {
    quizState.correctCount += 1;
    quizState.score += points;
  }

  updateStats(stats, userId, question, isCorrect);
  saveStats(stats);

  const correctOption = question.options.find((option) => option.is_correct);
  const feedback = isCorrect
    ? `Верно! +${points} балл(ов).`
    : `Неверно. Правильный ответ: ${correctOption ? correctOption.option_ru : 'не найден'}`;

  await ctx.answerCbQuery(isCorrect ? `Верно! +${points}` : 'Неверно');
  await ctx.reply(feedback);

  quizState.currentIndex += 1;

  if (quizState.currentIndex < quizState.questions.length) {
    return sendQuestion(ctx, quizState);
  }

  ensureUserStats(stats, userId);
  const passed = 30 >= PASSING_SCORE;
  stats[userId].totalQuizzes += 1;
  stats[userId].lastQuiz = {
    total: quizState.questions.length,
    correct: quizState.correctCount,
    score: quizState.score,
    maxScore: quizState.maxScore,
    passed,
    finishedAt: new Date().toISOString()
  };
  saveStats(stats);

  activeQuizzes.delete(userId);
  return ctx.reply(
    `Тест завершен! Результат: ${quizState.correctCount}/${quizState.questions.length}. ` +
    `Баллы: ${quizState.score}/${quizState.maxScore}. ` +
    `${passed ? 'Сдан' : 'Не сдан'} (нужно ${PASSING_SCORE}).`
  );
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));


