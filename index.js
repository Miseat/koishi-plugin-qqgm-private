/**
 * qqgm-private：依附于 @nestim/koishi-plugin-qq-group-manager 的私聊插件。
 *
 * 两件事：
 *   1. 私聊消息自动回复（复用主插件的 qqgmAiRuntime：同一模型、同一套 style/meme 钩子）
 *   2. 定时主动私发：每隔一段时间主动给用户发一条消息
 *
 * 不注册群管指令，不碰群聊逻辑，失败不影响主插件。
 */
const { Schema, h } = require('koishi');

const name = 'qqgm-private';
/**
 * 不写 inject。
 *
 * qqgmAiRuntime 是主插件用 ctx.root.set() 挂的普通对象，不是 Koishi Service，
 * 写了 inject 反而会让 Koishi 一直等一个不会出现的服务，配置页就会显示「必需服务：qqgmAiRuntime（未加载）」。
 * 这里改为运行时探测 + ready 重试。
 */
const inject = [];

function readService(ctx, key) {
  try {
    if (ctx.root && typeof ctx.root.get === 'function') {
      const value = ctx.root.get(key);
      if (value) return value;
    }
  } catch { /* ignore */ }
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(key);
      if (value) return value;
    }
  } catch { /* ignore */ }
  return null;
}

const Config = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('是否启用私聊回复。'),

  // ---------------------------------------------------------------- 回复
  allowedUsers: Schema.array(String).role('table').default([])
    .description('只回复这些 QQ 号；留空 = 所有人。'),
  blockedUsers: Schema.array(String).role('table').default([])
    .description('不回复这些 QQ 号。'),
  minIntervalSeconds: Schema.natural().min(0).max(3600).default(2)
    .description('同一个用户两条回复之间的最小间隔（秒）。'),
  maxContext: Schema.natural().min(1).max(100).default(20)
    .description('带入提示词的历史消息条数（用户+机器人）。'),
  maxReplyChars: Schema.natural().min(10).max(1000).default(120)
    .description('单条私聊回复最大字符数。'),
  systemPrompt: Schema.string().role('textarea').default('')
    .description('额外的私聊人设/规则；留空则只用主插件的人设。'),

  // ---------------------------------------------------------------- 主动私发
  enableProactive: Schema.boolean().default(false)
    .description('定时主动私发：每隔一段时间，主动给私聊过的人发一条消息。'),
  proactiveTargets: Schema.array(String).role('table').default([])
    .description('主动私发给哪些 QQ 号；留空 = 只发给「主动私聊过机器人的人」。'),
  proactiveIntervalMinutes: Schema.natural().min(1).max(10080).default(180)
    .description('两次主动私发之间的间隔（分钟）。默认 180 = 3 小时。'),
  proactiveMinIdleMinutes: Schema.natural().min(0).max(10080).default(60)
    .description('距该用户上次说话至少多久才发（分钟），避免人家正聊着又插一句。0 = 不判断。'),
  proactiveQuietHours: Schema.array(String).role('table').default(['0-8'])
    .description('免打扰时段，格式「起-止」，如 0-8 表示 0 点到 8 点不发。可多条。'),
  proactiveMaxPerDay: Schema.natural().min(1).max(50).default(3)
    .description('每个用户每天最多主动发几条。'),
  proactivePrompt: Schema.string().role('textarea').default('')
    .description('主动私发的提示词；留空用内置默认（主动找个话题，简短自然，不要客套）。'),
  proactiveMaxChars: Schema.natural().min(10).max(500).default(60)
    .description('主动私发的字数上限。'),

  debug: Schema.boolean().default(false)
    .description('日志里打印提示词。'),
});

function clipReply(text, maxChars) {
  const value = String(text || '')
    .replace(/^["'“”‘’「」『』\s]+|["'“”‘’「」『』\s]+$/g, '')
    .trim();
  if (value.length <= maxChars) return value;
  const slice = value.slice(0, maxChars);
  let boundary = -1;
  for (const char of ['。', '！', '？', '；', '，']) {
    boundary = Math.max(boundary, slice.lastIndexOf(char));
  }
  return boundary >= Math.floor(maxChars * 0.5)
    ? slice.slice(0, boundary + 1).trim()
    : slice.trim();
}

function extractText(session) {
  return String(session?.content || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[CQ:[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 判断当前小时是否落在免打扰时段（支持跨零点，如 23-7） */
function inQuietHours(ranges, hour) {
  if (!Array.isArray(ranges) || !ranges.length) return false;
  for (const item of ranges) {
    const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(String(item || ''));
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start <= end) {
      if (hour >= start && hour < end) return true;
    } else if (hour >= start || hour < end) {
      return true;
    }
  }
  return false;
}

/**
 * 发送私聊消息。OneBot 下 bot.sendMessage(userId, text, {userId}) 会被路由成
 * send_group_msg（retcode 1200），所以优先走底层 send_private_msg，再逐级回退。
 */
async function sendPrivate(bot, userId, text) {
  const uid = Number(userId) || userId;

  // 1) 底层 OneBot API
  try {
    const internal = bot.internal || {};
    if (typeof internal._request === 'function') {
      const res = await internal._request('send_private_msg', {
        user_id: uid,
        message: [{ type: 'text', data: { text } }],
      });
      if (res && (res.message_id || res.retcode === 0)) return true;
    }
  } catch (error) {
    // 继续尝试其它方式
  }

  // 2) 适配器公开方法
  try {
    if (typeof bot.sendPrivateMessage === 'function') {
      await bot.sendPrivateMessage(uid, text);
      return true;
    }
  } catch (error) {
    // 继续
  }

  // 3) 通用 sendMessage，channelId 用私聊会话 id 形式
  try {
    await bot.sendMessage(`private:${uid}`, text, { userId: uid });
    return true;
  } catch (error) {
    // 最后一种：YouTube 式 userId 直传
    await bot.sendMessage(uid, text, { userId: uid, isDirect: true, channelId: `private:${uid}` });
    return true;
  }
}

const DEFAULT_PROACTIVE_PROMPT = [
  '你要主动给一个私聊过的朋友发一条消息，找个话题聊起来。',
  '要求：',
  '- 只输出要发的那一句话，不要解释、不要列点、不要加引号；',
  '- 像日常闲聊，可以分享一件小事、问个近况、提一句之前聊过的内容；',
  '- 不要客套，不要说「在吗」「打扰了」「好久不见」这类开场白；',
  '- 不要重复最近已经说过的话；',
  '- 如果实在没话可说，只输出一个词：NONE',
].join('\n');

function apply(ctx, config) {
  if (config.enabled === false) return;

  const logger = ctx.logger('qqgm-private');
  const histories = new Map();
  const lastReplyAt = new Map();
  const inFlight = new Set();

  /** 见过的人：userId → 最后一次说话时间 */
  const seenUsers = new Map();
  /** 主动私发记录：userId → { lastAt, dayKey, count } */
  const proactiveState = new Map();

  let runtime = null;
  let mounted = false;
  let timer = null;

  const allowed = (config.allowedUsers || []).map(String);
  const blocked = (config.blockedUsers || []).map(String);

  const canTalkTo = (userId) => {
    if (!userId) return false;
    if (blocked.includes(userId)) return false;
    if (allowed.length && !allowed.includes(userId)) return false;
    return true;
  };

  const findRuntime = () => {
    const value = readService(ctx, 'qqgmAiRuntime');
    if (!value) return null;
    if (typeof value.chat !== 'function' || !value.hooks) return null;
    return value;
  };

  // ---------------------------------------------------------------- 回复

  async function handle(session) {
    if (!runtime) return;
    const isDirect = session?.isDirect === true || !session?.guildId;
    if (!isDirect) return;

    const userId = String(session.userId || '');
    if (!canTalkTo(userId)) return;

    seenUsers.set(userId, Date.now());

    const text = extractText(session);
    if (!text) return;
    // 不抢主插件的命令
    if (/^\s*\[bot\]/i.test(text) || /^\s*[/!！]/.test(text)) return;

    if (inFlight.has(userId)) return;
    const now = Date.now();
    const last = lastReplyAt.get(userId) || 0;
    if (now - last < Math.max(0, Number(config.minIntervalSeconds ?? 2)) * 1000) return;

    inFlight.add(userId);
    try {
      const base = runtime.config || {};
      const hooks = runtime.hooks;
      const history = histories.get(userId) || [];
      history.push({ role: 'user', text, at: now });
      const limit = Math.max(1, Number(config.maxContext ?? 20));
      if (history.length > limit * 2) history.splice(0, history.length - limit * 2);
      histories.set(userId, history);

      const prior = history.slice(0, -1);
      const selfName = String(base.aiAgentName || 'bot');
      const persona = String(base.aiSystemPrompt || '').trim();
      const extra = String(config.systemPrompt || '').trim();
      const groupId = `private:${userId}`;
      const sections = await hooks.collectSections({ session, groupId, mode: 'reply' });

      const system = [
        `你是「${selfName}」，正在和用户私聊。`,
        persona,
        extra,
        '只回应当前消息；不要提群聊、群友、群里；不要自我介绍。',
        `控制在 ${Math.max(10, Number(config.maxReplyChars ?? 120))} 字以内。`,
        ...sections,
      ].filter(Boolean).join('\n');

      const userLines = ['【最近私聊】（按时间顺序）'];
      if (prior.length) {
        for (const item of prior) {
          userLines.push(`${item.role === 'self' ? '你' : '用户'}: ${item.text}`);
        }
      } else {
        userLines.push('（没有更早的消息）');
      }
      userLines.push('', '【当前消息】', text, '', '只输出一条回复正文。');
      const user = userLines.join('\n');

      if (config.debug) logger.info(`[private] system=${system}\n[private] user=${user}`);

      const result = await runtime.chat({
        system,
        user,
        temperature: Number(base.aiTemperature ?? 0.8),
        maxTokens: Number(base.aiMaxOutputTokens ?? 600),
      });
      if (!result || !result.ok) {
        logger.warn(`[private] 模型调用失败 user=${userId} error=${result?.error || 'unknown'}`);
        return;
      }

      const raw = String(result.text || '').trim();
      if (!raw || /^\s*<(?:pass\s*\/?|不回复)>/i.test(raw)) return;

      const hookCtx = { session, groupId, mode: 'reply' };
      const filtered = await hooks.applyFilters(raw, hookCtx);
      if (filtered == null) {
        lastReplyAt.set(userId, Date.now());
        return;
      }

      const finalText = clipReply(filtered, Math.max(10, Number(config.maxReplyChars ?? 120)));
      if (!finalText) {
        lastReplyAt.set(userId, Date.now());
        return;
      }

      await session.send(h.text(finalText));
      lastReplyAt.set(userId, Date.now());
      history.push({ role: 'self', text: finalText, at: Date.now() });
      histories.set(userId, history);
      logger.info(`[private] reply user=${userId} chars=${finalText.length}`);

      await hooks.runAfterReply({ ...hookCtx, text: finalText });
    } catch (error) {
      logger.warn(`[private] 处理失败 user=${userId}: ${String(error)}`);
    } finally {
      inFlight.delete(userId);
    }
  }

  // ---------------------------------------------------------------- 主动私发

  function dayStamp() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function pickTargets() {
    const explicit = (config.proactiveTargets || []).map(String).filter(Boolean);
    if (explicit.length) return explicit;
    // 留空：只发给主动私聊过机器人的人
    return [...seenUsers.keys()];
  }

  async function proactiveTo(userId) {
    if (!runtime) return false;
    if (!canTalkTo(userId)) return false;

    const now = Date.now();
    const intervalMs = Math.max(1, Number(config.proactiveIntervalMinutes) || 180) * 60 * 1000;
    const state = proactiveState.get(userId) || { lastAt: 0, dayKey: '', count: 0 };

    if (now - state.lastAt < intervalMs) return false;

    const idleMin = Math.max(0, Number(config.proactiveMinIdleMinutes) || 0);
    const lastUserAt = seenUsers.get(userId) || 0;
    if (idleMin > 0 && lastUserAt && now - lastUserAt < idleMin * 60 * 1000) return false;

    const today = dayStamp();
    const count = state.dayKey === today ? state.count : 0;
    if (count >= Math.max(1, Number(config.proactiveMaxPerDay) || 3)) return false;

    const hour = new Date().getHours();
    if (inQuietHours(config.proactiveQuietHours, hour)) return false;

    const base = runtime.config || {};
    const hooks = runtime.hooks;
    const groupId = `private:${userId}`;
    const history = histories.get(userId) || [];
    const recent = history.slice(-6).map((item) => `${item.role === 'self' ? '你' : '对方'}: ${item.text}`).join('\n');

    const selfName = String(base.aiAgentName || 'bot');
    const persona = String(base.aiSystemPrompt || '').trim();
    const extra = String(config.systemPrompt || '').trim();
    const sections = await hooks.collectSections({ session: null, groupId, mode: 'reply' });

    const system = [
      `你是「${selfName}」，现在要主动私聊一个人。`,
      persona,
      extra,
      config.proactivePrompt || DEFAULT_PROACTIVE_PROMPT,
      `控制在 ${Math.max(10, Number(config.proactiveMaxChars) || 60)} 字以内。`,
      ...sections,
    ].filter(Boolean).join('\n');

    const user = [
      recent ? `【最近的私聊】\n${recent}` : '【最近的私聊】（还没有聊过）',
      '',
      '现在输出你要主动发的那一句话，或 NONE。',
    ].join('\n');

    if (config.debug) logger.info(`[private][proactive] system=${system}\n[private][proactive] user=${user}`);

    let raw = '';
    try {
      const result = await runtime.chat({
        system,
        user,
        temperature: Number(base.aiTemperature ?? 0.8),
        maxTokens: 400,
      });
      if (!result || !result.ok) {
        logger.warn(`[private][proactive] 模型失败 user=${userId}`);
        return false;
      }
      raw = String(result.text || '').trim();
    } catch (error) {
      logger.warn(`[private][proactive] 异常 user=${userId}: ${String(error)}`);
      return false;
    }

    if (!raw || /^(?:none|无)$/i.test(raw)) return false;

    let finalText = clipReply(raw.replace(/^\s*<(?:pass\s*\/?|不回复)>/i, ''), Math.max(10, Number(config.proactiveMaxChars) || 60));
    if (!finalText) return false;

    try {
      const filtered = await hooks.applyFilters(finalText, { session: null, groupId, mode: 'reply' });
      if (filtered == null) return false;
      finalText = clipReply(filtered, Math.max(10, Number(config.proactiveMaxChars) || 60));
      if (!finalText) return false;
    } catch { /* 过滤失败就用原文 */ }

    try {
      const bot = (ctx.bots || []).find((item) => item.platform === 'onebot');
      if (!bot) {
        logger.warn('[private][proactive] 没有可用的 onebot bot');
        return false;
      }
      // 私聊必须走私聊通道。直接 bot.sendMessage(userId,...) 在 OneBot 下会被
      // 当成 group_id 发出去（retcode 1200），所以先试底层 API。
      const sent = await sendPrivate(bot, userId, finalText);
      if (!sent) return false;
    } catch (error) {
      logger.warn(`[private][proactive] 发送失败 user=${userId}: ${String(error)}`);
      return false;
    }

    history.push({ role: 'self', text: finalText, at: Date.now() });
    histories.set(userId, history);
    proactiveState.set(userId, { lastAt: now, dayKey: today, count: count + 1 });
    logger.info(`[private][proactive] 已发送 user=${userId} chars=${finalText.length}`);
    return true;
  }

  async function proactiveTick() {
    if (!runtime) return;
    if (config.enableProactive === false) return;
    const targets = pickTargets();
    for (const userId of targets) {
      try {
        await proactiveTo(userId);
      } catch (error) {
        logger.warn(`[private][proactive] ${userId}: ${String(error)}`);
      }
    }
  }

  // ---------------------------------------------------------------- 挂载

  function install() {
    if (mounted) return true;
    const value = findRuntime();
    if (!value) return false;
    runtime = value;
    mounted = true;

    if (config.enableProactive !== false) {
      const intervalMs = 60 * 1000; // 每分钟检查一次，是否该发由每用户的间隔决定
      timer = setInterval(() => {
        void proactiveTick();
      }, intervalMs);
      if (timer.unref) timer.unref();
    }

    const base = runtime.config || {};
    logger.info(
      `私聊已启用 | 间隔=${config.minIntervalSeconds}s | 上下文=${config.maxContext} | 字数=${config.maxReplyChars}`
      + ` | 主动私发=${config.enableProactive !== false ? `${config.proactiveIntervalMinutes}min` : '关'}`,
    );
    if (config.debug) logger.info(`[debug] 人设=${base.aiAgentName || 'bot'} 主动目标=${pickTargets().join(',') || '（私聊过的人）'}`);
    return true;
  }

  if (!install()) {
    ctx.on('ready', () => {
      if (mounted) return;
      if (!install()) {
        logger.warn(
          '未找到 qqgmAiRuntime：请确认已启用 @nestim/koishi-plugin-qq-group-manager（>= 1.2.5），私聊插件不启用',
        );
      }
    });
  }

  ctx.on('message', (session) => handle(session).catch((error) => logger.warn(`[private] ${String(error)}`)));

  ctx.on('dispose', () => {
    if (timer) clearInterval(timer);
    timer = null;
    histories.clear();
    seenUsers.clear();
    proactiveState.clear();
    mounted = false;
    runtime = null;
  });
}

module.exports = { name, inject, Config, apply, clipReply, inQuietHours };
