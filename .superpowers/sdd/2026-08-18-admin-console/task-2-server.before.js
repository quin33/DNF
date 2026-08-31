/* ============================================================
   问道仙坊 · AI 探险日志服务（联机版：HTTP + WebSocket + SQLite）
   ------------------------------------------------------------
   启动：  node server.js
   访问：  http://localhost:8787        → 首页（首次弹登录，登录后联机游玩）
   配置：  编辑 ai.config.json（AI 提供商 baseURL / apiKey / model）
   依赖：  ws（WebSocket） + node:sqlite（内置）
   说明：  页面每次探险的每一步会调用 /api/ai/story，AI 生成该步叙事。
           登录后角色存服务器，单人匹配与副本由服务端权威推进。
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const DB = require('./db.js');
const GC = require('./game-create.js');
const GE = require('./game-engine.js');

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;

const CONFIG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'ai.config.json'), 'utf8'));
  } catch {
    return { baseURL: '', apiKey: '', model: '' };
  }
})();
const isConfigured = !!(CONFIG.baseURL && CONFIG.apiKey && CONFIG.model && !String(CONFIG.apiKey).includes('在这里填入') && !String(CONFIG.apiKey).startsWith('sk-在这里'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.md': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

/* ============================================================
   账号鉴权：scrypt 密码哈希 + 会话 token
   ============================================================ */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}
function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
function newToken() { return crypto.randomBytes(24).toString('hex'); }
/* 从 Authorization: Bearer xxx 取 token */
function bearerToken(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
function authUser(req) {
  const uid = DB.sessionUserId(bearerToken(req));
  return uid ? DB.findUserById(uid) : null;
}

/* ============================================================
   AI 提示词（整合世界观 / 结构 / 叙事 / 装备 / 技能 / 判定）
   ============================================================ */
const SYSTEM_PROMPT = `你是《问道仙坊》的探险日志作家，一名修仙志怪小说作者。游戏世界观：天地灵气枯竭后，修仙者聚居在洞天福地，经「灵墟」（上古战场破碎空间）探险求道；境界为练气一层~十层、筑基/金丹/元婴各分前中后期；角色四维为体魄/身法/神识/气运；货币为灵石。**修士皆隶属宗门，灵墟探险多为宗门派发的任务——每次进入副本都是受宗门差遣，任务完成须回宗门复命并领取报酬。**

叙事规则：
1. 输出修仙志怪小说笔法的叙事段落，环境、心理、动作交织，有沉浸感，人物对话自然贴切。
2. 混合叙事：**个人高光段**（约三成步骤——【本步主角】后没有"（与 XX 配合）"标注的即个人段：不写队友出场，聚焦该角色独自一人时的抉择与表现，用功法/术法/装备/性格撑起独当一面的高光时刻）与**多人配合段**（2~6 名角色协同，如"一攻一守""替他挡下致命一击"）自然交错；不存在主角，聚焦角色按队伍顺序轮转，人人都有戏份。
3. 角色融入：每名角色的性格（重诺/好奇/莽撞/明哲/高傲/仗义/孤僻/狡诈）、灵根、特质、境界体现在言行与战斗方式中。**代词严格按角色性别**：男用「他/他的」，女用「她/她的」，绝不错用（队伍信息中每名成员都标注了性别）。**称呼规则：角色名是一个完整的代号，一体不可拆分——凡称呼角色（含道友/师兄/姑娘/兄台等任何称谓或直接提及）必须使用其完整全名，禁止任何形式的省略、缩写、截取部分字符或昵称化（例如"魔法少女早苗酱"不得写作"早苗酱"或"酱"，"唐三"不得写作"唐"），每次提及都必须写全名；不得依据角色名推断性别、身份、来历或性格等任何信息，这些一律以【队伍】标注为准。**
9. **特质即经历与能力依据**：每名角色的特质是过往经历凝成的能力，**生成剧情时必须在合适时机让特质因果性地发挥作用**——不是偶然提一句，而是"因有某特质→事件随之发生"：如「辨别灵草（初级）」的修士在探索中更容易发现灵草药草、能识别毒草（找到灵草的机会增加）；「灵觉敏锐/听风辨位」者先察觉危险与伏击；「断后英杰」者在队伍遇险时挺身断后；「寻宝直觉/气运缠身」者更易发现暗格秘藏；「百毒不侵」者出入瘴毒之地更有底气。特质未直接相关的场景不必强用，但特质相关的机会要明显增多。
4. 装备独立使用：每件装备都是独立个体，只引用单件装备（绝不整串列举），装备没有属性数值，效果完全依据其描述文字合理演绎；装备判定失败时如实写"未能奏效/时机不对"。**道具只在自然合适时使用**：如避瘴珠对瘴气、罗盘对迷路、引灵灯对暗穴——没有非常合适的道具时不要强行围绕某件道具推进剧情（尤其探索阶段），应结合角色的功法/术法与四维属性（体魄/身法/神识/气运）来安排剧情；道具判定失败后一笔带过即可，不要反复围绕同一件道具展开。
5. 技能优先：角色的功法/术法是叙事最高优先级——只要本步判定选定了技能（见【本步技能】），就必须围绕它的施展来写：**严格按照技能描述（desc）演绎其效果**（不得发明描述之外的机制），功法偏修炼蓄势、术法偏攻防应变；判定成功则写得势如破竹、灵光迸发，判定失败则如实写施法受挫、灵光未聚。未选中技能时，也可在合适时机自然带出角色的功法术法。
6. 结合副本背景：敌人、场景、战利品必须与副本背景设定一致，敌人与首领的**修为（【此间生灵】/【深处首领】中已标注，如练气三层、筑基初期）要在战斗描写中自然体现**——修为高的敌人出手更沉、威压更强。**战利品类型不限**：武器、防具、丹药、符箓、材料、杂物、功法术法卷轴等皆可，只要与副本故事设定自洽即可（例如古战场可出残兵锈甲与军功之物，药镇废墟可出药炉丹方），不要凭空出现与副本无关的物品。**战利品全程自然分配**：战斗获胜可缴获、探索途中可发现、搜刮时可拾取，各阶段按剧情合理出现，不要集中堆在某一阶段；获得灵石时在正文写明具体数量（如"得了三十块灵石"），数量合理（几十到几百）。**凡本步获得道具，必须在段落最后另起一行输出标记：**【获得：道具名1、道具名2】（只写本步获得的，一次最多两三件；本步没有获得道具就不要输出该标记）。道具名可自由创造（简洁 2~8 字）。
7. 检定体现：关键节点自然体现 D20 检定的成败（成功则势如破竹，失败则险象环生），不要机械播报数字。
8. **宗门任务设定**：本次探险是宗门派发的任务——第一步（入谷）必须交代任务：由宗门长辈/执事差遣，结合副本背景说明任务目的（如调查异动、寻回失物、清剿妖兽、取回传承等），队伍受命出发；最后一步（归途）必须描写**回到宗门复命、领取任务报酬**（写明报酬灵石数量），收束故事。
9. **遇险可逃（由 AI 依据剧情判断）**：队伍遇到危险时（战斗失利、敌人过强、首领凶威、身负重伤、灵光将尽等），**由剧情自然决定是否逃跑**——玩家不干预。**当局面已无胜算（判定大失败、多人重伤昏迷、修为被敌人碾压等）时，应写队伍逃跑/撤退的剧情**，逃跑不一定成功——成功则队伍仓皇脱身保住性命但**任务失败**（归途如实写向宗门复命请罪、无报酬或仅少量抚恤）；失败则被追上付出代价（负伤、损失道具、死战到底）。**凡描写逃跑，必须明确写出逃跑的成与败，不得含糊**；逃跑后任务即告失败，最终成败以【深处首领】与归途剧情走向为准。若局面尚有转机，也可选择死战翻盘——成败由最终剧情判定。
10. **突破试炼（练气十层 → 筑基前期）**：当【当前进度】为「突破」阶段（见【突破试炼】标注），说明队伍中有角色修为已至练气十层满（灵机盈满），正面临突破筑基的关隘。**本阶段必须围绕该角色（主角）安排一场突破试炼**：可召唤天劫淬体、心魔问心、道基重铸、斩我明道等（贴合其灵根与修行路数），凶险与机缘并存——**试炼成败由本步判定结果决定**：判定成功则突破成功（灵台清明、道基稳固、踏入筑基）；失败则功亏一篑（气血翻涌、受创，修为仍停留练气十层，待下次再寻机缘）。叙事要写出「临界、冲关、成败」的过程。

整体副本日志由多步构成（入谷→探索→战斗→首领→搜刮→归途），步数随故事节奏自然浮动（总步数以【当前进度】为准，10~40 步），允许一行一段；**每步不超过 250 字，不设最低字数**——短促有力的句子、寥寥数语的转折同样自然，长度完全随叙事节奏起伏，切忌每段都凑成齐整的长段。你现在只负责其中一步。`;

function buildUserMessage(b) {
  const lines = [];
  lines.push(`【副本】${b.dungeon}${b.isHidden ? '（隐藏副本，原名 ' + b.baseDungeon + '）' : ''}`);
  if (b.specialEvent) lines.push('【特殊事件】本局触发异象：副本整体凶险更甚（敌人修为更高、机关更险），但机缘亦更丰厚——剧情中应烘托出异象骤生、凶机并现的氛围，战利品与报酬可以更丰。');
  if (b.lore) lines.push(`【背景】${b.lore}`);
  if (b.enemies && b.enemies.length) lines.push(`【此间生灵】${b.enemies.map(e => e.name + '（' + (e.realm || '修为不明') + '）：' + e.desc).join('；')}`);
  if (b.bosses && b.bosses.length) lines.push(`【深处首领】${b.bosses.map(x => x.name + '（' + (x.realm || '修为不明') + '）：' + x.desc).join('；')}`);
  lines.push('【队伍】');
  (b.party || []).forEach(m => {
    const sk = (m.skills || []).map(s => `${s.name}（${s.tier || '黄阶'}·${s.type || '功法'}：${s.desc || '无描述'}）`).join('、') || '无';
    const items = (m.items || []).map(i => `${i.name}（${i.kind || '杂物'}：${i.desc || '无描述'}）`).join('，') || '无';
    lines.push(`· ${m.name}（${m.gender || '男'}·${m.realm}·${m.root}·性格${m.personality}）｜特质：${(m.traits || []).join('、')}｜功法术法：${sk}｜携带：${items}`);
  });
  lines.push(`【当前进度】第 ${b.stepNo} 步 / 共 ${b.totalSteps} 步 · 阶段：${b.stageLabel || b.stage}`);
  if (b.stage === 'breakthrough' || b.stageLabel === '突破') lines.push('【突破试炼】本步为突破试炼（练气十层 → 筑基前期）：围绕主角安排突破关隘（天劫/心魔/道基重铸等），成败按本步判定（success 见【检定】）自然收束。');
  if (b.actor) lines.push(`【本步主角】${b.actor}${b.support ? '（与 ' + b.support + ' 配合）' : ''}${b.attr ? '，以' + b.attr + '检定 D20 ' + b.roll + (b.mod >= 0 ? '+' + b.mod : b.mod) + ' = ' + b.total : ''}`);
  if (b.enemy) lines.push(`【当前敌人】${b.enemy.name}：${b.enemy.desc || ''}`);
  if (b.skillUse) {
    const em = b.skillUse.elemMod || 0;
    const emTxt = em > 0 ? '此技能与施法者灵根同属，施展得心应手、威力增益' : '';
    lines.push(`【本步技能】${b.skillUse.name}（${b.skillUse.type}）D20 ${b.skillUse.roll} + ${b.skillUse.total - b.skillUse.roll} = ${b.skillUse.total} → ${b.skillUse.success ? '判定成功' : '判定失败'}${emTxt ? '（' + emTxt + '）' : ''}。技能描述：${b.skillUse.desc || '无'}。本步必须围绕施展此技能展开，严格按描述演绎其效果。`);
  }
  if (b.itemUse) {
    lines.push(`【装备判定】${b.itemUse.name}（${b.itemUse.kind}）D20 ${b.itemUse.roll}${b.itemUse.total ? ' = ' + b.itemUse.total : ''} → ${b.itemUse.success ? '判定成功，此物发挥作用' : '判定失败，未能奏效'}`);
  }
  if (b.context) lines.push(`【前文衔接】\n${b.context}`);
  if (b.stepNo === 1) lines.push('【开局】这是本次探险的第一步（入谷）：请交代这是宗门派发的任务——由宗门长辈/执事差遣，结合副本背景说明任务目的（调查异动/寻回失物/清剿妖兽等），描写队伍受命出发，营造任务感。');
  if (b.stepNo >= b.totalSteps) lines.push('【收尾】这是本次探险的最后一步（归途）：请描写队伍**回到宗门复命、领取任务报酬**（写明报酬灵石数量），回顾得失，收束故事，留有余韵。');
  lines.push('\n请生成这一步的叙事段落（不超过 250 字，不设最低字数，长短随节奏自然，可短促可铺陈），允许一行一段，衔接前文，只输出正文，不要标题。');
  return lines.join('\n');
}

/* ============================================================
   调用 LLM（OpenAI 兼容 /chat/completions）
   ============================================================ */
async function callLLM(userMsg, systemPrompt = SYSTEM_PROMPT) {
  if (!isConfigured) {
    throw new Error('AI 未配置：请编辑 ai.config.json 填写 baseURL / apiKey / model');
  }
  const url = CONFIG.baseURL.replace(/\/+$/, '') + '/chat/completions';
  let lastErr = null;
  // 失败自动重试：空内容错误（推理模型思考过长截断）最多试 4 次，其他错误最多试 2 次
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    try {
      const r = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + CONFIG.apiKey,
        },
        body: JSON.stringify({
          model: CONFIG.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMsg },
          ],
          temperature: CONFIG.temperature ?? 0.85,
          max_tokens: CONFIG.maxTokens ?? 5000,
          stream: false,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (j.error && (j.error.message || j.error)) || `HTTP ${r.status}`;
        throw new Error(String(msg).slice(0, 300));
      }
      const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
      if (!text) throw new Error('AI 返回空内容（思考过长被截断，重试中）');
      // 字数控制：单步截断至 250 字（保留完整句子）
      if (text.length > 250) {
        const cut = text.slice(0, 250);
        const lastDot = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('…'));
        return lastDot > 100 ? cut.slice(0, lastDot + 1) : cut;
      }
      return text;
    } catch (e) {
      lastErr = e;
      const isEmpty = /空内容/.test(String(e.message || e));
      if (!isEmpty && attempt >= 1) break;  // 非空内容错误最多试 2 次
      console.warn(`[ai] 第 ${attempt + 1} 次调用失败：${e.name === 'AbortError' ? '超时(120s)' : String(e.message || e).slice(0, 160)}`);
      await new Promise(r => setTimeout(r, 800));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/* ============================================================
   HTTP 服务
   ============================================================ */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function serveStatic(res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/online' || p === '/login' || p === '/login.html') p = '/index.html';
  const file = path.join(ROOT, p);
  // 防目录穿越
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function handleAuthAPI(req, res, urlPath) {
  // 返回 true 表示已处理（外层据此停止后续路由），false 表示未命中
  // ---------- 注册 ----------
  if (req.method === 'POST' && urlPath === '/api/auth/register') {
    const body = JSON.parse(await readBody(req));
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (username.length < 2 || username.length > 20) { sendJSON(res, 400, { error: '用户名需 2~20 字符' }); return true; }
    if (password.length < 4 || password.length > 64) { sendJSON(res, 400, { error: '密码需 4~64 字符' }); return true; }
    if (/[^\u4e00-\u9fa5A-Za-z0-9_]/.test(username)) { sendJSON(res, 400, { error: '用户名仅限中文/字母/数字/下划线' }); return true; }
    if (DB.findUserByUsername(username)) { sendJSON(res, 409, { error: '用户名已存在' }); return true; }
    const salt = makeSalt();
    const uid = DB.createUser(username, hashPassword(password, salt), salt);
    const token = DB.createSession(uid, newToken());
    sendJSON(res, 200, { token, user: { id: uid, username } });
    return true;
  }
  // ---------- 登录 ----------
  if (req.method === 'POST' && urlPath === '/api/auth/login') {
    const body = JSON.parse(await readBody(req));
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const u = DB.findUserByUsername(username);
    if (!u || hashPassword(password, u.salt) !== u.pass_hash) { sendJSON(res, 401, { error: '用户名或密码错误' }); return true; }
    const token = DB.createSession(u.id, newToken());
    sendJSON(res, 200, { token, user: { id: u.id, username: u.username } });
    return true;
  }
  // ---------- 登出 ----------
  if (req.method === 'POST' && urlPath === '/api/auth/logout') {
    DB.deleteSession(bearerToken(req));
    sendJSON(res, 200, { ok: true });
    return true;
  }
  // ---------- 当前用户 ----------
  if (req.method === 'GET' && urlPath === '/api/me') {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const chars = DB.getCharacters(u.id).map(c => ({ id: c.id, name: c.name, updated_at: c.updated_at }));
    sendJSON(res, 200, { user: { id: u.id, username: u.username }, characters: chars });
    return true;
  }
  // ---------- 房间列表（HTTP） ----------
  if (req.method === 'GET' && urlPath === '/api/rooms') {
    const list = Array.from(ROOMS.values()).map(roomStatePublic).filter(r => r.status === 'waiting');
    sendJSON(res, 200, { rooms: list });
    return true;
  }
  // ---------- 创建表单数据 ----------
  if (req.method === 'GET' && urlPath === '/api/creation') {
    sendJSON(res, 200, { data: GC.creationData() });
    return true;
  }
  // ---------- 角色：按表单服务端生成创建 ----------
  if (req.method === 'POST' && urlPath === '/api/character/create') {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const body = JSON.parse(await readBody(req));
    const name = String(body.name || '').trim();
    if (name.length < 1 || name.length > 12) { sendJSON(res, 400, { error: '角色名需 1~12 字' }); return true; }
    if (DB.getCharacters(u.id).length >= 6) { sendJSON(res, 400, { error: '角色数量已达上限（6）' }); return true; }
    const char = GC.createCharacterObject({
      name, rootKey: body.root, gender: body.gender, pers: body.pers,
      itemKeys: Array.isArray(body.items) ? body.items : [],
    });
    const id = DB.createCharacter(u.id, char.name, char);
    sendJSON(res, 200, { id, character: char });
    return true;
  }
  // ---------- 通用角色：创建/读取/保存 ----------
  if (req.method === 'POST' && urlPath === '/api/character') {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const body = JSON.parse(await readBody(req));
    const data = body.character || null;
    if (!data || !data.name) { sendJSON(res, 400, { error: '缺少角色数据' }); return true; }
    if (DB.getCharacters(u.id).length >= 6) { sendJSON(res, 400, { error: '角色数量已达上限（6）' }); return true; }
    const id = DB.createCharacter(u.id, data.name, data);
    sendJSON(res, 200, { id, character: data });
    return true;
  }
  const charMatch = urlPath.match(/^\/api\/character\/(\d+)$/);
  if (charMatch) {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const charId = Number(charMatch[1]);
    if (req.method === 'GET') {
      const c = DB.getCharacter(u.id, charId);
      if (!c) { sendJSON(res, 404, { error: '角色不存在' }); return true; }
      sendJSON(res, 200, { id: c.id, character: c.data });
      return true;
    }
    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const data = body.character || null;
      if (!data) { sendJSON(res, 400, { error: '缺少角色数据' }); return true; }
      DB.saveCharacter(u.id, charId, data, data.name);
      sendJSON(res, 200, { ok: true, character: data });
      return true;
    }
    sendJSON(res, 405, { error: 'Method Not Allowed' });
    return true;
  }
  // ---------- 日志：添加/列表 ----------
  if (req.method === 'POST' && urlPath === '/api/log') {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const body = JSON.parse(await readBody(req));
    if (!body.log) { sendJSON(res, 400, { error: '缺少日志' }); return true; }
    DB.addLog(u.id, body.log);
    sendJSON(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'GET' && urlPath === '/api/logs') {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    sendJSON(res, 200, { logs: DB.getLogs(u.id) });
    return true;
  }
  return false;  // 非账号 API，交给后续路由
}

/* 道具描述生成：为每件新获得的战利品编写修仙风格描述（严格 JSON 输出） */
const LOOT_PROMPT = `你是《问道仙坊》的宝物文案作者。为给定列表中的每件道具编写一段 15~40 字的修仙风格描述：点明材质、来历或用途，语言凝练有古意，贴合道具名。严格只输出一个 JSON 数组，不要任何解释或标记，格式：[{"name":"道具名","desc":"描述"}]，数组必须包含输入的全部道具名，顺序不限。`;

/* 探险总结生成：为整篇探险日志写一段 ≤200 字的总结 */
const SUMMARY_PROMPT = `你是《问道仙坊》的日志编者。请为下面这篇探险日志写一段总结，不超过 150 字：概括队伍所历、关键战斗与得失，语言凝练，带仙侠韵味，像一篇话本的回末评点。只输出总结正文，不要标题，不要任何解释。`;

/* 探险成败判定：AI 通读整篇日志后，依据最终剧情走向判定本次探险是成功还是失败 */
const OUTCOME_PROMPT = `你是《问道仙坊》的执事长老。阅读这篇探险日志的完整剧情，判断这次探险的最终结果：
1. **成功**：队伍达成了任务目标或至少全身而退（即使中途有波折、受伤、损失道具，只要最终完成任务或顺利撤离）；
2. **失败**：剧情明确以任务失败、队伍溃败/团灭、被逐出副本、核心目标未达成且付出惨重代价告终；**队伍在途中逃跑/撤退脱身同样视为失败**（未完成任务，哪怕保住了性命）。
注意：仅凭单次受挫、一次大失败、或某段描写凶险，不构成失败；必须以全文的最终结局为准。
严格只输出一个 JSON 对象，不要任何解释或标记：
{"ok":true,"reason":"简短理由"}
或
{"ok":false,"reason":"简短理由"}`;

/* 功法/术法卷轴生成：10% 概率的稀有战利品（严格 JSON 输出） */
const SCROLL_PROMPT = `你是《问道仙坊》的藏经阁执事。创作一部{type}卷轴——不是功法本体，而是记载修炼之法的卷轴（拓本/残卷/秘录皆可）。要求：
1. 起一个简洁贴切的名字（2~12 字，如"《青木养气诀》残卷""御风术·拓本""庚金炼体要旨"）；
2. 写一段 15~40 字的描述：来历、内容、价值；
3. 卷轴名与描述都要有修仙韵味，风格与《问道仙坊》一致。
严格只输出一个 JSON 对象，不要任何解释或标记：{"name":"卷轴名","desc":"描述"}`;

/* 炼器：AI 器道宗师判断材料组合合理性并生成法器（严格 JSON 输出） */
const FORGE_PROMPT = `你是《问道仙坊》的器道宗师，执掌炼器坊，精研器道与修仙世界观。修士投入两件材料请你炼器，请判断并处置：
1. **合理性判断**（符合修仙世界观与炼器常理）：材料带有品质（普通/精良/稀有/珍贵/传说），高品质材料（稀有及以上）炼成的法器应相应更珍奇，可在描述中体现品质带来的不凡之处；
   - 合理的组合：金属/矿石/兽骨/妖皮/灵木/灵植/符箓/法宝残片等炼器材料之间相互熔炼组合（如"铁剑+灵骨碎片"→骨铁兵刃、"兽皮+骨笛"→皮骨法器）；
   - 不合理的组合：丹药/食物/货币/活物等不宜入炉之物，或风马牛不相及的材料拼凑（如"聚气丹+罗盘"），判为不合理并说明理由。
2. **若合理**：生成一件契合两件材料特性的法器——起名（2~10 字，如"寒铁骨笛""青焰兽骨刀"），写 15~45 字描述（点明材质、工艺、用途），kind 为"武器/防具/法宝/工具"之一。
3. **若不合理**：reason 用一句话说明为何不能炼（符合世界观）。
严格只输出一个 JSON 对象，不要任何解释或标记：
{"ok":true,"item":{"name":"法器名","desc":"描述","kind":"武器"} }
或
{"ok":false,"reason":"理由"}`;

/* 战利品提取：从探险日志全文中语义提取角色们获得的道具（AI 理解剧情，能区分"获得"与"提及"），并为每件写描述 */
const EXTRACT_LOOT_PROMPT = `你是《问道仙坊》的结算师。阅读探险日志全文，找出角色们在本局探险中**明确获得**的道具（战利品），判断标准：剧情里出现"获得/捞到/捡到/摸出/拾起/拾得/搜刮到/缴获/寻得/翻出/收下/取走/到手/得"等获得动作的对象。注意排除：
1. 只是被提及/使用/携带的装备与工具（如"催动避瘴珠""摸了摸兽皮囊""提着灵锄"——这不是获得）；
2. 消耗掉的使用物（丹药、符箓等）；
3. 灵石等货币。
**必须穷尽列举**：只要出现获得动作指向的物品，即使一句话带过、即使只有一枚/半张，也要列出，宁可多列不可遗漏（例："拾起一枚幽绿磷骨珠""弯腰捡起半张兽皮"都要列入）。为每件道具写一段 15~40 字的修仙风格描述（材质/来历/用途），贴合副本背景。**道具名用简洁名词（2~6 字，如"骨笛""灵骨碎片""磷骨珠"），不要带"幽蓝""泛光""半张"等修饰语。**严格只输出一个 JSON 数组，不要任何解释或标记；**每个对象单独占一行**，格式：
[{"name":"道具名","desc":"描述"},
{"name":"道具名2","desc":"描述2"}]
没有获得任何道具时输出 []。`;

/* 特质颁发：AI 结合剧情为成员颁发新特质（名字 + 描述） */
const TRAIT_PROMPT = `你是《问道仙坊》的宗门藏经阁执事。修士「{member}」刚完成一次灵墟探险，请根据他/她在剧情中的实际表现（英勇断后、临危不乱、中毒负伤、寻宝发现、击杀强敌、辨识药草等）为其颁发一个新特质：
1. 特质名 2~8 字，可带熟练度后缀（初级/中级/高级），如"辨别灵草（初级）""断后英杰""百毒不侵""临危不乱""猎宝直觉"，要贴合剧情行为，不要与已有特质重复（已有：{existing}）；
2. 写一句 10~30 字的描述：因何经历获得、体现何种能力，未来探险中该特质会如何发挥作用（如"辨别灵草（初级）：多次采药辨草，已能认出常见灵草与毒草，探索中更容易发现药草"）。
严格只输出一个 JSON 对象，不要任何解释或标记：{"name":"特质名","desc":"描述"}`;

/* 容错解析 AI 的道具 JSON：AI 输出可能被截断（推理模型 token 占用）——
   先整段解析；失败则逐行正则提取 {"name":...,"desc":...} 片段，保住已生成的道具 */
function parseLootJsonLoose(raw) {
  let s = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  // 1) 整段解析
  const st = s.indexOf('['), en = s.lastIndexOf(']');
  if (st >= 0 && en > st) {
    try {
      const arr = JSON.parse(s.slice(st, en + 1));
      if (Array.isArray(arr)) return arr;
    } catch (e) { /* 截断，走逐行提取 */ }
  }
  // 2) 逐行/片段正则提取（容错：即使字符串被截断，已完成的条目也能保住）
  const out = [];
  const re = /\{"name"\s*:\s*"([^"]+)",\s*"desc"\s*:\s*"([^"]*)"\}/g;
  let m;
  while ((m = re.exec(s))) {
    const name = (m[1] || '').trim();
    if (name && name.length <= 12 && !out.some(x => x.name === name)) {
      out.push({ name, desc: (m[2] || '').trim() });
    }
  }
  return out.length ? out : null;
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url || '/';
  // 账号 / 角色 / 日志 / 房间 API（联机版）
  if (urlPath.startsWith('/api/auth') || urlPath.startsWith('/api/me') || urlPath.startsWith('/api/character') || urlPath.startsWith('/api/log') || urlPath === '/api/creation' || urlPath === '/api/rooms') {
    try {
      const handled = await handleAuthAPI(req, res, urlPath);
      if (handled === true) return;
      sendJSON(res, 404, { error: '未知 API 路径' });
      return;
    } catch (e) {
      console.error('[api]', String(e.message || e).slice(0, 200));
      sendJSON(res, 500, { error: String(e.message || e) });
      return;
    }
  }
  if (req.method === 'POST' && urlPath === '/api/ai/story') {
    try {
      const body = JSON.parse(await readBody(req));
      const text = await callLLM(buildUserMessage(body));
      sendJSON(res, 200, { text });
    } catch (e) {
      console.error('[ai/story]', String(e.message || e).slice(0, 300));
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/loot') {
    try {
      const body = JSON.parse(await readBody(req));
      const items = Array.isArray(body.items) ? body.items.map(String).filter(Boolean) : [];
      if (!items.length) { sendJSON(res, 400, { error: 'items 为空' }); return; }
      const raw = await callLLM('道具列表：' + items.join('、'), LOOT_PROMPT);
      // 容错解析：去 ```json 包裹，截取首个 [ ... ] 段
      let jsonStr = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const start = jsonStr.indexOf('['), end = jsonStr.lastIndexOf(']');
      if (start >= 0 && end > start) jsonStr = jsonStr.slice(start, end + 1);
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) throw new Error('AI 返回非数组');
      const out = [];
      const seen = new Set();
      parsed.forEach(x => {
        if (x && x.name && x.desc && !seen.has(x.name)) { seen.add(x.name); out.push({ name: String(x.name), desc: String(x.desc) }); }
      });
      sendJSON(res, 200, { items: out });
    } catch (e) {
      console.error('[ai/loot]', e.message);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/summary') {
    try {
      const body = JSON.parse(await readBody(req));
      const logText = String(body.log || '').slice(0, 8000);
      const dungeon = String(body.dungeon || '灵墟');
      const raw = await callLLM(`副本：${dungeon}\n\n探险日志全文：\n${logText}`, SUMMARY_PROMPT);
      // 150 字以内截断（保留完整句子）
      let text = raw.trim();
      if (text.length > 150) {
        const cut = text.slice(0, 150);
        const lastDot = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('…'));
        text = lastDot > 60 ? cut.slice(0, lastDot + 1) : cut;
      }
      sendJSON(res, 200, { text });
    } catch (e) {
      console.error('[ai/summary]', e.message);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/outcome') {
    try {
      const body = JSON.parse(await readBody(req));
      const logText = String(body.log || '').slice(0, 12000);
      const raw = await callLLM('探险日志全文：\n' + logText, OUTCOME_PROMPT);
      let jsonStr = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const st = jsonStr.indexOf('{'), en = jsonStr.lastIndexOf('}');
      if (st >= 0 && en > st) jsonStr = jsonStr.slice(st, en + 1);
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed.ok !== 'boolean') throw new Error('AI 未返回可用的判定');
      sendJSON(res, 200, { ok: parsed.ok, reason: String(parsed.reason || '').slice(0, 120) });
    } catch (e) {
      console.error('[ai/outcome]', e.message);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/extract_loot') {
    try {
      const body = JSON.parse(await readBody(req));
      const logText = String(body.log || '').slice(0, 12000);
      const raw = await callLLM('探险日志全文：\n' + logText, EXTRACT_LOOT_PROMPT);
      const parsed = parseLootJsonLoose(raw);
      if (!Array.isArray(parsed) || !parsed.length) throw new Error('AI 未返回可解析的道具列表');
      const out = [];
      const seen = new Set();
      parsed.forEach(x => {
        // 排除货币类（灵石/金银铜钱等）——剧情中写明的灵石数量由结算单独入账，不生成道具
        const nm = String(x.name || '');
        if (/灵石|钱|金锭|银锭|铜板/.test(nm)) return;
        if (!seen.has(nm)) {
          seen.add(nm);
          out.push({ name: nm, desc: String(x.desc || '来历不明的宝物') });
        }
      });
      sendJSON(res, 200, { items: out.slice(0, 8) });
    } catch (e) {
      console.error('[ai/extract_loot]', e.message);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/trait') {
    try {
      const body = JSON.parse(await readBody(req));
      const member = String(body.member || '修士').slice(0, 20);
      const logText = String(body.log || '').slice(0, 12000);
      const existing = Array.isArray(body.existing) ? body.existing.map(String).join('、') : '';
      const raw = await callLLM('探险日志全文：\n' + logText, TRAIT_PROMPT.replace('{member}', member).replace('{existing}', existing || '无'));
      let jsonStr = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const st = jsonStr.indexOf('{'), en = jsonStr.lastIndexOf('}');
      if (st >= 0 && en > st) jsonStr = jsonStr.slice(st, en + 1);
      const parsed = JSON.parse(jsonStr);
      if (!parsed || !parsed.name) throw new Error('AI 未返回可用的特质');
      sendJSON(res, 200, { name: String(parsed.name).slice(0, 12), desc: String(parsed.desc || '').slice(0, 60) });
    } catch (e) {
      console.error('[ai/trait]', e.message);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/scroll') {
    try {
      const body = JSON.parse(await readBody(req));
      const type = body.type === '术法' ? '术法' : '功法';
      const raw = await callLLM('请创作一部' + type + '卷轴。', SCROLL_PROMPT.replace('{type}', type));
      // 容错解析：去 ```json 包裹，截取首个 { ... } 段
      let jsonStr = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const st = jsonStr.indexOf('{'), en = jsonStr.lastIndexOf('}');
      if (st >= 0 && en > st) jsonStr = jsonStr.slice(st, en + 1);
      const parsed = JSON.parse(jsonStr);
      if (!parsed || !parsed.name) throw new Error('AI 未返回可用的卷轴');
      sendJSON(res, 200, { name: String(parsed.name).slice(0, 16), desc: String(parsed.desc || '来历不明的修炼卷轴').slice(0, 80) });
    } catch (e) {
      console.error('[ai/scroll]', e.message);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/forge') {
    try {
      const body = JSON.parse(await readBody(req));
      const mats = (body.materials || []).slice(0, 3).map(m => `${m.name}（${m.kind || '杂物'}·品质${({ common: '普通', uncommon: '精良', rare: '稀有', epic: '珍贵', legendary: '传说' })[m.rarity] || m.rarity || '普通'}：${m.desc || '无描述'}）`).join('、');
      if (!mats) { sendJSON(res, 400, { error: '材料为空' }); return; }
      const raw = await callLLM('投入材料：' + mats + '\n请判断合理性并炼器。', FORGE_PROMPT);
      // 容错解析：去 ```json 包裹，截取首个 { ... } 段
      let jsonStr = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const st = jsonStr.indexOf('{'), en = jsonStr.lastIndexOf('}');
      if (st >= 0 && en > st) jsonStr = jsonStr.slice(st, en + 1);
      const parsed = JSON.parse(jsonStr);
      if (!parsed || typeof parsed.ok !== 'boolean') throw new Error('AI 未返回可用的判定');
      if (parsed.ok) {
        const it = parsed.item || {};
        if (!it.name) throw new Error('AI 返回法器缺少名称');
        sendJSON(res, 200, { ok: true, item: { name: String(it.name).slice(0, 12), desc: String(it.desc || '新炼成的法器').slice(0, 100), kind: ['武器', '防具', '法宝', '工具'].includes(it.kind) ? it.kind : '法宝' } });
      } else {
        sendJSON(res, 200, { ok: false, reason: String(parsed.reason || '此组合不合炼器之道').slice(0, 80) });
      }
    } catch (e) {
      console.error('[ai/forge]', e.message);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/health') {
    sendJSON(res, 200, { ok: true, configured: isConfigured, model: CONFIG.model || null });
    return;
  }
  if (req.method === 'GET') { serveStatic(res, urlPath); return; }
  res.writeHead(405); res.end('Method Not Allowed');
});

/* ============================================================
   WebSocket + 房间/匹配 · 联机副本（服务端权威推进）
   ============================================================ */
const ROOMS = new Map();
let roomSeq = 1;

function roomStatePublic(room) {
  return {
    id: room.id,
    name: room.name || '房间' + room.id,
    status: room.status || 'waiting',
    dungeon: room.dg ? room.dg.dungeon.name : null,
    host: room.host,
    party: (room.party || []).map(m => m ? {
      uid: m.uid || null, name: m.name, charId: m.charId || null, isNpc: !!m.isNpc,
      realm: m.character_class || m.realm || '', online: !m.isNpc ? !!m.ws : true,
    } : null).filter(Boolean),
  };
}
function broadcast(room, msg, except) {
  const s = JSON.stringify(msg);
  (room.party || []).forEach(m => { if (m && m.ws && m.ws.readyState === 1 && m.ws !== except) m.ws.send(s); });
}
function addMember(room, m) { room.party.push(m); }
function toPublic(uid) {
  const u = DB.findUserById(uid);
  return { uid, username: u ? u.username : '?' };
}

/* ---------- 服务端权威副本推进 ---------- */
const TICK_MS = process.env.ROOM_FAST === '1' ? 600 : 3500;
function fillNpcs(room) { const target = 4; while ((room.party || []).length < target) { const npc = GE.genNpc(); npc.ws = null; npc.isNpc = true; addMember(room, npc); } }
function startRoomRun(room, hostChar) {
  const dg = GE.createDg(hostChar);
  dg.party = room.party.map(m => m.isNpc
    ? { ...GE.genNpc(), id: m.name, name: m.name, isNpc: true, is_mine: false, ws: null }
    : { ...(GC.ROOT_SKILLS ? hostChar : {}), ...(m.char ? m.char : {}), id: m.uid, name: m.name, is_mine: true, ws: m.ws, uid: m.uid, charId: m.charId, isNpc: false });
  dg.party.forEach(m => { const id = m.uid || m.id; dg.memberGains[id] = { acts: 0, rolls: [], damage: 0, loot: [], traits: [], crits: 0, fumbles: 0 }; });
  dg.status = 'running'; room.status = 'running'; room.dg = dg;
  broadcast(room, { type: 'dungeon_started', snapshot: { dungeon: dg.dungeon, planLabels: dg.plan.map(p => ({ key: p.key, label: p.label })), party: roomStatePublic(room).party, dgParty: dg.party.map(m => ({ name: m.name, hp: m.hp, max_hp: m.max_hp || 100, isNpc: !!m.isNpc, isMine: !m.isNpc })) } });
  scheduleTick(room);
}
function scheduleTick(room) {
  if (room.status !== 'running' || !room.dg) return;
  if (room._timer) return;
  room._timer = setTimeout(async () => {
    room._timer = null;
    if (room.status !== 'running' || !room.dg) return;
    try { await dungeonStep(room); } catch (e) { console.error('[run] 步骤失败:', e.message); broadcast(room, { type: 'run_error', error: String(e.message || e) }); room.status = 'error'; }
  }, TICK_MS);
}
async function dungeonStep(room) {
  const dg = room.dg;
  const plan = dg.plan[dg.planIdx];
  if (!plan) { await settleRoom(room); return; }
  const stageKey = plan.key;
  const actor = dg.party[dg.totalStep % dg.party.length];
  const isOpening = stageKey === 'opening';
  const isSolo = !isOpening && Math.random() < 0.35;
  const others = dg.party.filter(m => m !== actor);
  const shuf = [...others].sort(() => Math.random() - 0.5);
  const support = isSolo ? null : shuf[0] || null;
  const support2 = isSolo ? null : shuf[1] || null;
  if (stageKey === 'battle') dg._curEnemy = dg.dungeon.enemies[Math.floor(Math.random() * dg.dungeon.enemies.length)];
  else if (stageKey === 'boss') dg._curEnemy = dg.dungeon.bosses[dg.stepIdx] || dg.dungeon.bosses[0];
  else dg._curEnemy = null;
  let roll = 0, mod = 0, total = 0, attrKey = '', realmB = 0;
  if (plan.check) {
    const attrKeys = GE.STAGE_ATTR[stageKey];
    attrKey = attrKeys[Math.floor(Math.random() * attrKeys.length)];
    const attr = actor[attrKey] || 10;
    realmB = GE.realmBonus(actor);
    const realmDiff = (stageKey === 'battle' || stageKey === 'boss') ? GE.realmDiffMod(actor, dg._curEnemy) : 0;
    mod = Math.floor((attr - 10) / 2) + GE.itemBonus(dg, stageKey) + GE.traitBonus(actor) + realmB + realmDiff;
    roll = GE.rollD20();
    total = roll + mod;
  }
  const itemUse = plan.check ? GE.itemUseCheck(dg, stageKey) : null;
  const skillUse = plan.check ? GE.skillUseCheck(dg, stageKey, actor) : null;
  if (itemUse && itemUse.success && (itemUse.item.kind === 'pill' || itemUse.item.kind === 'talisman')) { if (!dg.consumed) dg.consumed = []; dg.consumed.push({ name: itemUse.item.name, ownerId: actor.uid || null }); }
  let text;
  try {
    const payload = GE.aiStoryPayload(dg, stageKey, actor, support, support2, attrKey, roll, mod, total, itemUse, skillUse);
    const j = await callAIStory(payload);
    text = j && j.text ? String(j.text) : localFallbackText(stageKey, actor, dg._curEnemy, total);
  } catch (e) { text = localFallbackText(stageKey, actor, dg._curEnemy, total); }
  const lootNames = GE.parseLootMarkers(text);
  if (lootNames.length) { if (!dg.gainedLoot) dg.gainedLoot = []; lootNames.forEach(n => { if (!dg.gainedLoot.some(x => x.name === n)) dg.gainedLoot.push(n); }); }
  const cleanText = String(text).replace(/【获得：[^】]*】/g, '').trim();
  const goodBar = dg.dungeon.specialEvent ? 14 : 12;
  const outcome = plan.check ? (total >= 18 || roll === 20 ? 'crit' : total >= goodBar ? 'good' : total >= 7 ? 'mid' : total >= 2 ? 'bad' : 'fumble') : 'good';
  GE.applyStageEffects(dg, stageKey, actor, total, outcome);
  const stepRec = {
    stage: stageKey, actor: actor.name, attr: attrKey, roll, mod, total, outcome, text: cleanText,
    stepNo: dg.totalStep + 1, enemy: dg._curEnemy ? dg._curEnemy.name : '', realmB, src: 'ai',
    itemUse: itemUse ? { name: itemUse.item.name, success: itemUse.success } : null,
    skillUse: skillUse ? { name: skillUse.name, type: skillUse.type, tier: skillUse.tier, elemMod: skillUse.elemMod || 0, success: skillUse.success } : null,
  };
  dg.steps.push(stepRec);
  const g = dg.memberGains[actor.uid || actor.id];
  if (g) { g.acts++; if (plan.check) { g.rolls.push(total); if (outcome === 'crit') g.crits++; if (outcome === 'fumble') g.fumbles++; } }
  if (support && cleanText.includes(support.name)) { const sg = dg.memberGains[support.uid || support.id]; if (sg) sg.acts++; }
  if (support2 && cleanText.includes(support2.name)) { const sg2 = dg.memberGains[support2.uid || support2.id]; if (sg2) sg2.acts++; }
  dg.totalStep++;
  dg.stepIdx++;
  if (dg.stepIdx >= plan.steps) { dg.stepIdx = 0; dg.planIdx++; }
  broadcast(room, {
    type: 'step',
    step: {
      no: stepRec.stepNo, stage: stepRec.stage, stageLabel: plan.label, actor: stepRec.actor, text: stepRec.text,
      roll, mod, total, success: outcome !== 'bad' && outcome !== 'fumble',
      itemUse: stepRec.itemUse, skillUse: stepRec.skillUse, enemy: stepRec.enemy,
      partyHp: dg.party.map(m => ({ name: m.name, hp: m.hp || 0, max_hp: m.max_hp || 100 })),
    },
  });
  if (!dg.plan[dg.planIdx]) { await settleRoom(room); return; }
  scheduleTick(room);
}
async function callAIStory(payload) {
  if (process.env.ROOM_FAST === '1') throw new Error('FAST_MODE');
  if (!isConfigured) throw new Error('AI 未配置');
  const url = CONFIG.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.apiKey },
    body: JSON.stringify({ model: CONFIG.model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildUserMessage(payload) }], temperature: CONFIG.temperature ?? 0.85, max_tokens: CONFIG.maxTokens ?? 5000, stream: false }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || ('HTTP ' + r.status));
  const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
  if (!text) throw new Error('AI 返回空内容');
  return { text };
}
function localFallbackText(stageKey, actor, enemy, total) {
  const names = { opening: '入谷', explore: '探索', battle: '战斗', boss: '首领', loot: '搜刮', closing: '归途', breakthrough: '突破' };
  const ok = total >= 12 || !total;
  const base = `${actor.name}在${names[stageKey] || stageKey}中${ok ? '谨慎前行，一切尚算顺利' : '遭遇变故，险些受创'}${enemy ? '，与「' + enemy.name + '」周旋片刻' : ''}。`;
  return base;
}
async function settleRoom(room) {
  const dg = room.dg;
  room.status = 'settling';
  const storyText = dg.steps.map(s => s.text || '').join('');
  // 并行的 AI 结算（对齐单机版 Promise.all）：总结 + 成败判定 + 战利品提取
  const [summaryRaw, outcomeRaw, lootRaw] = await Promise.all([
    callLLM('副本：' + dg.dungeon.name + '\n\n探险日志全文：\n' + storyText.slice(0, 8000), SUMMARY_PROMPT).catch(() => ''),
    callLLM('探险日志全文：\n' + storyText.slice(0, 12000), OUTCOME_PROMPT).catch(() => ''),
    callLLM('探险日志全文：\n' + storyText.slice(0, 12000), EXTRACT_LOOT_PROMPT).catch(() => ''),
  ]);
  // 探险总结：150 字以内截断，并保留完整句子（避免切到句中导致不完整）
  let summaryText = String(summaryRaw || '').trim();
  if (summaryText.length > 150) {
    const cut = summaryText.slice(0, 150);
    const lastDot = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('…'));
    summaryText = lastDot > 60 ? cut.slice(0, lastDot + 1) : cut;
  }
  let aiOk = null;
  try {
    let jsonStr = String(outcomeRaw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const st = jsonStr.indexOf('{'), en = jsonStr.lastIndexOf('}');
    if (st >= 0 && en > st) jsonStr = jsonStr.slice(st, en + 1);
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed.ok === 'boolean') aiOk = parsed.ok;
  } catch (e) { aiOk = null; }
  const hasFumble = dg.steps.some(s => s.outcome === 'fumble');
  const ok = aiOk !== null ? aiOk : !hasFumble;
  // AI 语义提取战利品（区分"获得"与"提及"，写描述）；失败回退剧情标记
  let lootAssign = [];
  try {
    const parsed = parseLootJsonLoose(lootRaw);
    if (Array.isArray(parsed) && parsed.length) lootAssign = parsed.map(x => ({ name: String(x.name).slice(0, 8), desc: String(x.desc || '').slice(0, 60), qty: 1, rarity: 'common' }));
  } catch (e) { lootAssign = []; }
  if (!lootAssign.length) {
    (dg.gainedLoot || []).forEach(n => lootAssign.push({ name: n.name, desc: n.desc || '剧情中获得的宝物', qty: 1, rarity: 'common' }));
    dg.bossDrops.forEach(b => lootAssign.push({ name: b.name, desc: b.desc || '', qty: 1, rarity: 'rare' }));
  } else {
    dg.bossDrops.forEach(b => { if (!lootAssign.some(x => x.name === b.name)) lootAssign.push({ name: b.name, desc: b.desc || '', qty: 1, rarity: 'rare' }); });
  }
  // 战利品按稀有度着色（普通/精良/稀有/珍贵/传说）
  const RARITY_POOL = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  lootAssign = lootAssign.filter((it, i) => lootAssign.findIndex(x => x.name === it.name) === i).map((it, i) => ({ ...it, rarity: it.rarity && RARITY_POOL.includes(it.rarity) ? it.rarity : RARITY_POOL[Math.min(i, RARITY_POOL.length - 1)] }));
  const expBase = 15 + dg.steps.length * 8 + lootAssign.length * 12 + (dg.breakthrough && dg.breachSuccess ? 60 : 0);
  const exp = dg.dungeon.specialEvent ? Math.round(expBase * 1.5) : expBase;
  const results = [];
  for (const m of dg.party) {
    const g = dg.memberGains[m.uid || m.id] || { damage: 0, crits: 0, fumbles: 0 };
    const hpNow = m.hp || 0;
    const memberRes = {
      name: m.name, isNpc: !!m.isNpc, isMine: !m.isNpc, loot: [], lootItems: [], exp: 0, hpFinal: hpNow,
      fate: hpNow <= 0 ? '濒死' : (hpNow <= (m.max_hp || 100) * 0.35 ? '受伤' : '健康'),
      score: 5, damage: g.damage || 0, gold: 0, newTraits: [], praise: 0,
    };
    if (m.isNpc) { results.push(memberRes); continue; }
    const char = DB.getCharacter(m.uid, m.charId);
    if (!char) { results.push(memberRes); continue; }
    const role = char.data;
    role.exp = (role.exp || 0) + exp;
    if (dg.breakthrough && dg.breachSuccess && role.level === 10) { role.level = 11; role.exp = 0; role.character_class = '筑基前期'; role.max_hp = (role.max_hp || 100) + 10; }
    while (role.level < 10 && role.exp >= (role.level || 1) * 100) { role.exp -= role.level * 100; role.level++; role.max_hp = (role.max_hp || 100) + 10; role.character_class = ['练气二','练气三','练气四','练气五','练气六','练气七','练气八','练气九','练气十'][role.level - 2] + '层'; }
    if (role.level >= 10 && role.exp > 1000) role.exp = 1000;
    const myLoot = ok ? lootAssign : lootAssign.filter(x => x.rarity === 'rare');
    myLoot.forEach(it => { const existing = (role.bag || []).find(b => b.name === it.name); if (existing) existing.qty = (existing.qty || 1) + 1; else role.bag.push({ name: it.name, desc: it.desc || '', qty: 1, rarity: it.rarity }); });
    const goldGain = ok ? 20 + exp : 5;
    role.gold = (role.gold || 0) + goldGain;
    memberRes.loot = myLoot.map(x => x.name);
    memberRes.lootItems = myLoot.map(x => ({ name: x.name, desc: x.desc || '', qty: 1, rarity: x.rarity || 'common' }));
    memberRes.exp = exp;
    memberRes.gold = goldGain;
    memberRes.score = Math.max(5, Math.min(9.5, +(5 + (g.rolls && g.rolls.length ? g.rolls.reduce((a,b)=>a+b,0)/g.rolls.length * 0.16 : 0) + (g.crits||0) * 0.3 - (g.fumbles||0) * 0.5).toFixed(1)));
    // 重伤判定（单机版需求）：结算时气血 <= 10% 视为重伤，带 3 小时现实倒计时
    if (hpNow <= Math.floor((m.max_hp || 100) * 0.1)) {
      if (hpNow <= 0) m.hp = 1;
      role.injury = { name: (['重伤未愈', '惊吓过度', '中了尸毒', '心有余悸'][Math.floor(Math.random() * 4)]), expiresAt: Date.now() + 3 * 3600 * 1000 };
      if (!role.traits) role.traits = [];
      if (!role.traits.includes(role.injury.name)) role.traits.push(role.injury.name);
    }
    // 结算完成：状态恢复为休息，精力回复 +30（封顶上限），气血/精力时间戳复位（与单机版一致）
    role.status = 'resting';
    role.stamina = Math.min(role.max_stamina || 100, (role.stamina || 0) + 30);
    role.staminaTs = Date.now();
    role.hpTs = Date.now();
    // 结算后气血并入真实结算值（服务端权威，m.hp 为冒险中扣血后的值）
    role.max_hp = m.max_hp || role.max_hp || 100;
    role.hp = Math.min(m.hp > 0 ? m.hp : 1, role.max_hp);
    DB.saveCharacter(m.uid, m.charId, role, role.name);
    const log = {
      id: DB.nextLogSeq(m.uid), party_name: '匹配小队' + room.id, dungeon_name: dg.dungeon.name,
      status: ok ? 'completed' : 'failed', result_summary: storyText, created_at: new Date().toISOString(),
      is_favorited: false, summary_text: summaryText || '',
      special_event_theme: dg.dungeon.specialEvent ? '特殊事件' : '',
      dg_snapshot: { icon: dg.dungeon.icon, name: dg.dungeon.name, baseName: dg.dungeon.baseName, isHidden: !!dg.dungeon.isHidden, specialEvent: !!dg.dungeon.specialEvent, steps: dg.steps, party: dg.party.map(x => ({ name: x.name, is_mine: !x.isNpc })) },
      settlement: { exp: memberRes.exp, gold: goldGain, items: memberRes.lootItems, damage: g.damage, members: results.map(r => ({ name: r.name, is_mine: r.isMine, score: r.score, gold: r.gold, fate: r.fate, damage: r.damage, loot: r.lootItems, newTraits: r.newTraits, praise: 0 })), consumed: [] },
    };
    DB.addLog(m.uid, log);
    memberRes.logId = log.id;
    results.push(memberRes);
  }
  room.status = 'finished';
  broadcast(room, { type: 'settled', ok, summary: summaryText || '', exp, dungeon: dg.dungeon.name, results, verdict: dg.breakthrough ? (dg.breachSuccess ? 'breakthrough_ok' : 'breakthrough_fail') : (ok ? 'completed' : 'failed') });
}
function leaveRoomCleanup(ws, room) {
  if (!room) return;
  const idx = (room.party || []).findIndex(m => m.ws === ws);
  if (idx >= 0) room.party.splice(idx, 1);
  ws._roomId = null;
  if (room.status === 'waiting') {
    if (!room.party.length) ROOMS.delete(room.id);
    else broadcast(room, { type: 'member_left', party: roomStatePublic(room).party });
  }
}

/* ---------- 匹配队列：单人匹配 → 攒真人/等 2 分钟 AI 补位开本 ---------- */
const MATCH_QUEUE = [];
const MATCH_TARGET = 4;
const MATCH_MIN_REAL = 2;
const MATCH_TIMEOUT_MS = 2 * 60 * 1000;
let matchSeq = 1;
function matchPublic(m) {
  return { uid: m.uid, name: m.char ? m.char.name : '?', realm: m.char ? (m.char.character_class || '练气一层') : '', charId: m.charId, joinedAt: m.joinedAt, isAI: false };
}
function broadcastMatches() {
  const payload = { type: 'match_state', queued: MATCH_QUEUE.length, members: MATCH_QUEUE.map(matchPublic) };
  MATCH_QUEUE.forEach(w => { if (w.ws.readyState === 1) w.ws.send(JSON.stringify(payload)); });
}
function tryStartMatch() {
  if (!MATCH_QUEUE.length) return;
  const now = Date.now();
  const real = MATCH_QUEUE.filter(m => !m._isAI);
  const waited = now - (real[0] ? real[0].joinedAt : now);
  const forceAfterTimeout = MATCH_QUEUE.length === 1 && waited >= MATCH_TIMEOUT_MS;
  const shouldStart = MATCH_QUEUE.length >= MATCH_MIN_REAL || forceAfterTimeout;
  if (!shouldStart) return;
  const room = { id: 'M' + (matchSeq++), name: '匹配小队_' + matchSeq, host: real[0] ? real[0].uid : null, party: [], status: 'waiting', createdAt: Date.now(), dg: null };
  MATCH_QUEUE.forEach(m => {
    room.party.push({ uid: m.uid, name: m.char.name, charId: m.charId, char: m.char, ws: m.ws, isNpc: false, character_class: m.char.character_class, matched: true });
    if (m.ws) m.ws._roomId = room.id;
  });
  while (room.party.length < MATCH_TARGET) {
    const npc = GE.genNpc();
    room.party.push({ uid: null, name: npc.name, char: npc, ws: null, isNpc: true, character_class: npc.character_class, matched: true });
  }
  MATCH_QUEUE.length = 0;
  const hostChar = room.party.find(p => p.uid === room.host) || room.party[0];
  startRoomRun(room, hostChar ? hostChar.char : null);
}
setInterval(() => { tryStartMatch(); if (MATCH_QUEUE.length) broadcastMatches(); }, 1000);

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  ws._roomId = null;
  ws._uid = null;
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    handleWS(ws, req, msg);
  });
  ws.on('close', () => {
    const mi = MATCH_QUEUE.findIndex(m => m.ws === ws);
    if (mi >= 0) { MATCH_QUEUE.splice(mi, 1); broadcastMatches(); }
    const room = ROOMS.get(ws._roomId);
    if (!room) return;
    if (room.status === 'running') {
      const idx = (room.party || []).findIndex(m => m.ws === ws);
      if (idx >= 0) { room.party[idx].ws = null; room.party[idx].online = false; }
      broadcast(room, { type: 'member_left', party: roomStatePublic(room).party });
    } else {
      leaveRoomCleanup(ws, room);
    }
  });
});

async function handleWS(ws, req, msg) {
  const send = d => { if (ws.readyState === 1) ws.send(JSON.stringify(d)); };
  switch (msg.type) {
    case 'auth': {
      const u = msg.token ? (DB.sessionUserId(msg.token) ? DB.findUserById(DB.sessionUserId(msg.token)) : null) : null;
      ws._uid = u ? u.id : 'guest-' + Math.random().toString(36).slice(2, 8);
      send({ type: 'authed', uid: ws._uid, username: u ? u.username : '游客' });
      return;
    }
    case 'match_start': {
      const u = msg.token ? (DB.sessionUserId(msg.token) ? DB.findUserById(DB.sessionUserId(msg.token)) : null) : null;
      if (!u || !msg.charId) { send({ type: 'error', error: '请先登录并选择角色' }); return; }
      const c = DB.getCharacter(u.id, Number(msg.charId));
      if (!c) { send({ type: 'error', error: '角色不存在' }); return; }
      if (MATCH_QUEUE.some(m => m.uid === u.id)) { send({ type: 'error', error: '已在匹配队列中' }); return; }
      ws._uid = u.id;
      if (ws._roomId) { const old = ROOMS.get(ws._roomId); if (old) leaveRoomCleanup(ws, old); }
      MATCH_QUEUE.push({ ws, token: msg.token, uid: u.id, charId: Number(c.id), char: c.data, choice: msg.choice || null, joinedAt: Date.now() });
      broadcastMatches();
      send({ type: 'match_enqueued', position: MATCH_QUEUE.length });
      return;
    }
    case 'match_cancel': {
      const idx = MATCH_QUEUE.findIndex(m => m.ws === ws);
      if (idx >= 0) MATCH_QUEUE.splice(idx, 1);
      send({ type: 'match_cancelled' });
      broadcastMatches();
      return;
    }
    case 'match_state': {
      send({ type: 'match_state', queued: MATCH_QUEUE.length, members: MATCH_QUEUE.map(matchPublic) });
      return;
    }
    case 'rooms': {
      const list = Array.from(ROOMS.values()).map(roomStatePublic).filter(r => r.status === 'waiting');
      send({ type: 'rooms', rooms: list });
      return;
    }
    default:
      send({ type: 'error', error: '未知消息类型' });
  }
}

server.listen(PORT, () => {
  console.log('==========================================');
  console.log('  问道仙坊 · AI 探险日志服务已启动（联机版）');
  console.log('  页面：  http://localhost:' + PORT);
  console.log('  AI 配置：' + (isConfigured ? CONFIG.model + ' @ ' + CONFIG.baseURL : '未配置（将使用本地叙事引擎）'));
  console.log('==========================================');
});
