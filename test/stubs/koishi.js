// 仅供本地单元测试使用的最小 koishi 替身（不随包发布）。
// 只实现插件代码实际用到的 Schema 链式 API 与消息元素构造器 h。
function chain(kind, inner) {
  const node = {
    kind,
    inner,
    meta: {},
    default(value) {
      node.meta.default = value;
      return node;
    },
    description(value) {
      node.meta.description = value;
      return node;
    },
    role(value) {
      node.meta.role = value;
      return node;
    },
    min() {
      return node;
    },
    max() {
      return node;
    },
    step() {
      return node;
    },
    required() {
      node.meta.required = true;
      return node;
    },
    hidden() {
      return node;
    },
    toString() {
      return kind;
    },
  };
  return node;
}

const Schema = {
  string: () => chain('string'),
  boolean: () => chain('boolean'),
  number: () => chain('number'),
  natural: () => chain('natural'),
  percent: () => chain('percent'),
  array: (inner) => chain('array', inner),
  object: (dict) => {
    const node = chain('object');
    node.dict = dict;
    return node;
  },
  intersect: (list) => chain('intersect', list),
  union: (list) => chain('union', list),
  const: (value) => chain('const', value),
  dict: (inner) => chain('dict', inner),
};

// 与 satorijs 的 h 保持同样的最小形状：{ type, attrs, children }
function element(type, attrs = {}, children = []) {
  const node = { type, attrs, children };
  node.toString = () => `<${type}>`;
  return node;
}

const h = (type, attrs, children) => element(type, attrs, children);
// satorijs 的元素类型名是 img/audio/video/file，而不是 image；
// h.image 只是“构造图片”的方法名，产出的 type 仍然是 img。
const TYPE_OF = { image: 'img', audio: 'audio', video: 'video', file: 'file' };
for (const name of ['text', 'image', 'at', 'quote', 'face', 'audio', 'video', 'file', 'br']) {
  const elementType = TYPE_OF[name] || name;
  h[name] = (value, attrs) => {
    if (name === 'text') return element('text', { content: String(value ?? '') });
    if (typeof value === 'string' && (!attrs || Object.keys(attrs).length === 0)) {
      return element(elementType, { src: value });
    }
    return element(
      elementType,
      { ...(attrs || {}), ...(value && typeof value === 'object' ? value : {}) },
    );
  };
}
h.parse = (raw) => [{ type: 'text', attrs: { content: String(raw) }, children: [] }];

module.exports = { Schema, h };
