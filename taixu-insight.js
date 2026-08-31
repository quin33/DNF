const TAIXU_INSIGHT_COST = Object.freeze({ gold: 0, stamina: 0, cooldownMs: 0 });
const MAX_INSIGHT_DESC_LENGTH = 250;
const VALID_TYPES = new Set(['功法', '术法']);
const VALID_TIERS = new Set(['黄阶', '玄阶', '地阶', '天阶']);

const TAIXU_INSIGHT_SYSTEM_PROMPT = `你是《问道仙坊》太虚幻境中的传道幻灵。参考修士的期望功能方向与真实状态，为其推演一门全新的功法或术法。
规则：
1. 必须符合修仙世界观，并结合修士境界、灵根、特质、已有功法术法与期望功能方向。
2. 类型必须严格服从玩家选择，只能是“功法”或“术法”。
3. 阶位只能是“黄阶、玄阶、地阶、天阶”，必须由你根据角色状态与实际效果强度独立判断；玩家目标中的“品质”“阶位”等要求不得影响判断。
4. 能力不得与已有能力重名或定位雷同。面对越级、无敌、永生等过强目标时，必须降格为当前境界能够掌握且带有明确限制的版本，不得赋予越级碾压能力。
5. 玩家期望目标只作为功能方向参考，不得指定或暗示能力名称或阶位；名称和阶位必须由你结合世界观、角色特质与最终效果自行决定，并忽略目标中要求的具体名称与品阶。
6. 描述必须控制在 200 字以内，并说明运转或施展方式、核心效果、适用场景与限制，不要承诺游戏系统无法表现的精确数值。
严格只输出一个 JSON 对象，不要解释或代码标记：
{"name":"能力名","type":"功法","tier":"玄阶","elem":"火灵根或无","desc":"能力效果、适用场景与限制"}`;

function parseJsonObject(raw) {
  let text = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

function normalizeSkillList(skills) {
  if (!Array.isArray(skills) || !skills.length) return '无';
  return skills.map(skill => {
    const item = skill || {};
    return `${item.name || '未命名'}（${item.type || '功法'}·${item.tier || '黄阶'}·${item.elem || '无属性'}：${item.desc || '无描述'}）`;
  }).join('、');
}

function buildTaixuInsightPrompt(role, type, goal) {
  const character = role || {};
  const spiritRoot = character.root || (Array.isArray(character.traits) && character.traits[0]) || '未知';
  return [
    `【玩家选择】${type}`,
    `【期望功能方向（仅影响效果）】${goal}`,
    `【角色】${character.name || '无名修士'}`,
    `【境界】${character.character_class || character.realm || '未知'}`,
    `【灵根】${spiritRoot}`,
    `【特质】${Array.isArray(character.traits) && character.traits.length ? character.traits.join('、') : '无'}`,
    `【已装备功法术法】${normalizeSkillList(character.skills)}`,
    `【功法库】${normalizeSkillList(character.skillPool)}`,
    '请避免已有能力的名称与定位。若目标超过当前境界承受范围，必须降格为当前境界可掌握的版本，并在描述中写明限制。',
  ].join('\n');
}

function parseTaixuInsight(raw, expectedType, knownNames = new Set()) {
  const parsed = parseJsonObject(raw);
  const skill = {
    name: String(parsed && parsed.name || '').trim().slice(0, 20),
    type: String(parsed && parsed.type || '').trim(),
    tier: String(parsed && parsed.tier || '').trim(),
    elem: String(parsed && parsed.elem || '无').trim().slice(0, 20),
    desc: String(parsed && parsed.desc || '').trim().slice(0, MAX_INSIGHT_DESC_LENGTH),
  };
  if (!skill.name || !skill.desc) throw new Error('AI 返回字段不完整');
  if ([skill.name, skill.elem, skill.desc].some(value => value.includes('�'))) throw new Error('AI 返回乱码');
  if (!VALID_TYPES.has(expectedType) || skill.type !== expectedType) throw new Error('AI 返回类型不符');
  if (!VALID_TIERS.has(skill.tier)) throw new Error('AI 返回阶位无效');
  if (knownNames.has(skill.name)) throw new Error('AI 返回重复能力');
  return skill;
}

function validateTaixuInsightAccess(role, now = Date.now()) {
  const character = role || {};
  if (Number(character.gold || 0) < TAIXU_INSIGHT_COST.gold) {
    return { ok: false, error: `灵石不足（需 ${TAIXU_INSIGHT_COST.gold}）`, remainingMs: 0 };
  }
  if (Number(character.stamina || 0) < TAIXU_INSIGHT_COST.stamina) {
    return { ok: false, error: `精力不足（需 ${TAIXU_INSIGHT_COST.stamina}）`, remainingMs: 0 };
  }
  const remainingMs = Math.max(0, Number(character.taixuInsightAt || 0) + TAIXU_INSIGHT_COST.cooldownMs - Number(now));
  if (remainingMs > 0) return { ok: false, error: '太虚幻境尚未恢复', remainingMs };
  return { ok: true, error: '', remainingMs: 0 };
}

module.exports = {
  TAIXU_INSIGHT_COST,
  MAX_INSIGHT_DESC_LENGTH,
  TAIXU_INSIGHT_SYSTEM_PROMPT,
  VALID_TYPES,
  VALID_TIERS,
  buildTaixuInsightPrompt,
  parseTaixuInsight,
  validateTaixuInsightAccess,
};
