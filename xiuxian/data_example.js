// 修仙版数据示例 —— 替换本目录 data.js 中对应字段即可
// 完整替换后：修士卡片、仙坊座位、灵墟地图、探险日志全部变为修仙主题
window.TAVERN_DATA = {
  user: { nickname: '青璃真人', username: 'player', id: 1, balance: 50000, balance_display: '5万灵石', is_admin: false },

  tavern: {
    title_kicker: 'XIANXIA FRONTIER · SEASON I',
    title: '问道仙坊',
    title_badge: 'S1',
    subtitle: '招募同道，组队探索灵墟；从每一次探险中带回机缘、伤势与新的故事。',
    beta_notice: '抢先体验 · 测试版本。灵墟剧情完全由 AI 实时生成，可能出现离谱展开甚至修士陨落。',
    level: 1,
    notice: '仙坊等级 Lv.1，灵墟传送阵已开启。',
  },

  seats: [
    { id: 1, zone: 'bar', label: '酒桌 1 号', adventurer: { id: 1, name: '白芷', is_mine: false }, drink: { icon: '🍵', name: '灵茶', price: 2, text: '灵气缭绕，涤荡尘埃。' } },
    { id: 2, zone: 'bar', label: '酒桌 2 号', adventurer: null },
    { id: 3, zone: 'table', table_label: '八仙桌 甲', adventurer: { id: 2, name: '铁心', is_mine: false }, drink: { icon: '🍶', name: '灵酿', price: 5, text: '一口入喉，气血翻涌。' } },
  ],

  adventurers: [
    { id: 1, name: '青璃真人', status: 'resting', is_mine: true, hp: 300, max_hp: 300, stamina: 80, max_stamina: 100,
      level: 14, strength: 30, agility: 40, intelligence: 70, luck: 55, gold: 1200,
      character_class: '金丹前期', personality: '重诺', traits: ['离火神幡掌控者', '丹道入门', '灵墟老手'],
      equipment: [{ name: '离火神幡', rarity: 'epic', icon: '🚩' }, { name: '聚气丹', rarity: 'common', icon: '💊' }],
      latest_score: 8.6, praise_count: 33, is_followed: false },
    { id: 2, name: '石敢当', status: 'resting', is_mine: false, hp: 400, max_hp: 400, stamina: 70, max_stamina: 100,
      level: 9, strength: 80, agility: 20, intelligence: 15, luck: 20, gold: 300,
      character_class: '练气九层·体修', personality: '莽撞', traits: ['玄武甲护体', '硬抗流'],
      equipment: [{ name: '玄武甲', rarity: 'rare', icon: '🛡️' }, { name: '遁地梭', rarity: 'rare', icon: '🪄' }],
      latest_score: 7.2, praise_count: 12, is_followed: false },
    { id: 3, name: '沈孤鸿', status: 'in_party', is_mine: false, hp: 260, max_hp: 260, stamina: 90, max_stamina: 100,
      level: 17, strength: 25, agility: 30, intelligence: 90, luck: 40, gold: 5000,
      character_class: '元婴前期', personality: '高傲', traits: ['太乙拂尘', '阵道宗师'],
      equipment: [{ name: '太乙拂尘', rarity: 'legendary', icon: '🧹' }, { name: '清心丹', rarity: 'common', icon: '💊' }],
      latest_score: 9.1, praise_count: 55, is_followed: true },
  ],

  matchmaking: { available_dungeons: { items: [
    { name: '枯骨林', level_desc: '炼气期', rank: 0 },
    { name: '迷雾泽', level_desc: '炼气–筑基', rank: 1 },
    { name: '赤炎谷', level_desc: '筑基期', rank: 2 },
    { name: '万剑冢', level_desc: '筑基–金丹', rank: 3 },
    { name: '幽冥渊', level_desc: '金丹期', rank: 4 },
    { name: '雷音山', level_desc: '金丹–元婴', rank: 5 },
    { name: '落仙台', level_desc: '元婴+', rank: 6 },
  ]}, queue_summary: { dungeon_member_counts: {}, queued_member_count: 2, queued_count: 1, random_member_count: 1 } },

  // AI 生成的探险日志（后端接口返回，见 ai_log_prompt.md）
  logs: [
    { id: 1, party_name: '寻仙小队', dungeon_name: '幽冥渊', status: 'completed',
      result_summary: '青璃祭出离火神幡逼退鬼潮，沈孤鸿以太乙拂尘净化阴煞，石敢当凭玄武甲硬抗幽冥鬼爪。三人于渊底拾得幽冥寒铁三块，安然回返。',
      created_at: '2026-08-15T10:00:00Z', is_favorited: false, special_event_theme: '', items_used: ['离火神幡', '太乙拂尘', '玄武甲', '幽冥寒铁'] },
    { id: 2, party_name: '寻仙小队', dungeon_name: '万剑冢', status: 'completed',
      result_summary: '沈孤鸿以剑灵碎片叩开剑冢试炼，万千残剑共鸣认主。青璃吞服清心丹抵御剑意侵蚀，石敢当遁地梭截断退路，最终携「残月古剑」而归，代价是三人神识俱损。',
      created_at: '2026-08-15T09:30:00Z', is_favorited: true, special_event_theme: '剑灵认主', items_used: ['剑灵碎片', '清心丹', '遁地梭', '残月古剑'] },
  ],

  npcs: { tavern: { name: '白芷', breed: '药童', intro: '药童白芷在柜台后打盹，怀里抱着半本《百草经》。' } },
};
