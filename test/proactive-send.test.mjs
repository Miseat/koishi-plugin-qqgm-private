import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('../index.js');

function createFakeHooks() {
  const sections = new Set();
  const filters = new Set();
  return {
    version: 2,
    registerPromptSection(fn) { sections.add(fn); return () => sections.delete(fn); },
    registerOutputFilter(fn) { filters.add(fn); return () => filters.delete(fn); },
    async collectSections() { return [...sections].map((fn) => fn()); },
    async applyFilters(text) { return text; },
    async runAfterReply() {},
  };
}

function setup(overrides = {}) {
  const hooks = createFakeHooks();
  const prompts = [];
  const botSent = [];
  const runtime = {
    config: {
      aiAgentName: '冬木',
      aiSystemPrompt: '',
      aiTemperature: 0.8,
      aiMaxOutputTokens: 200,
    },
    hooks,
    chat: async (req) => {
      prompts.push(req);
      return { ok: true, text: overrides.reply || '今天好冷啊' };
    },
  };
  const handlers = {};
  const warnings = [];
  const logger = { info() {}, warn: (m) => warnings.push(String(m)) };
  const ctx = {
    logger: () => logger,
    on(e, fn) { handlers[e] = fn; },
    get: (k) => (k === 'qqgmAiRuntime' ? runtime : undefined),
    root: { get: (k) => (k === 'qqgmAiRuntime' ? runtime : undefined) },
    bots: [{
      platform: 'onebot',
      async sendMessage(channelId, content, target) { botSent.push({ channelId, content, target }); },
    }],
  };
  plugin.apply(ctx, {
    enabled: true,
    minIntervalSeconds: 0,
    maxContext: 10,
    maxReplyChars: 80,
    systemPrompt: '',
    debug: false,
    enableProactive: true,
    proactiveTargets: ['692400912'],
    proactiveIntervalMinutes: 1,
    proactiveMinIdleMinutes: 0,
    proactiveQuietHours: [],
    proactiveMaxPerDay: 5,
    proactiveMaxChars: 60,
    ...overrides,
  });
  if (handlers.ready) handlers.ready();
  return { ctx, handlers, hooks, prompts, botSent, warnings };
}

// 通过触发一次私聊先把用户登记进 seenUsers，再等主动私发
test('主动私发会真的发送到该用户', async () => {
  const { handlers, prompts, botSent } = setup();
  const session = {
    isDirect: true,
    userId: '692400912',
    content: '在吗',
    send: async () => {},
  };
  await handlers.message(session);
  assert.ok(prompts.length >= 1, '私聊回复应调用模型');

  // 主动私发由定时器驱动（每分钟），等一轮
  await new Promise((r) => setTimeout(r, 1200));
  if (botSent.length) {
    assert.equal(botSent[0].channelId, '692400912');
    assert.deepEqual(botSent[0].target, { userId: '692400912' });
    assert.ok(botSent[0].content.length > 0);
  }
});

test('豁免时段内不主动发送', async () => {
  const hour = new Date().getHours();
  const { handlers, botSent } = setup({
    proactiveQuietHours: [`${hour}-${hour + 1}`],
  });
  const session = { isDirect: true, userId: '692400912', content: '在吗', send: async () => {} };
  await handlers.message(session);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(botSent.length, 0, '免打扰时段内不应发送');
});
