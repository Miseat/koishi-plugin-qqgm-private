import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('../index.js');

test('inject 为空，不声明 Koishi 服务', () => {
  assert.deepEqual(plugin.inject, [], 'inject 必须为空，否则配置页会显示“必需服务未加载”');
});

test('免打扰时段：普通区间', () => {
  assert.equal(plugin.inQuietHours(['0-8'], 0), true);
  assert.equal(plugin.inQuietHours(['0-8'], 7), true);
  assert.equal(plugin.inQuietHours(['0-8'], 8), false);
  assert.equal(plugin.inQuietHours(['0-8'], 12), false);
});

test('免打扰时段：跨零点', () => {
  assert.equal(plugin.inQuietHours(['23-7'], 23), true);
  assert.equal(plugin.inQuietHours(['23-7'], 2), true);
  assert.equal(plugin.inQuietHours(['23-7'], 6), true);
  assert.equal(plugin.inQuietHours(['23-7'], 7), false);
  assert.equal(plugin.inQuietHours(['23-7'], 12), false);
});

test('免打扰时段：多条与非法输入', () => {
  assert.equal(plugin.inQuietHours(['0-8', '13-14'], 13), true);
  assert.equal(plugin.inQuietHours(['bad'], 3), false);
  assert.equal(plugin.inQuietHours([], 3), false);
  assert.equal(plugin.inQuietHours(null, 3), false);
});

test('clipReply 截断在标点', () => {
  const long = '这是一句很长的话，'.repeat(10);
  const out = plugin.clipReply(long, 20);
  assert.ok(out.length <= 21, `实际 ${out.length}`);
});

test('clipReply 去引号', () => {
  assert.equal(plugin.clipReply('「你好」', 50), '你好');
});
