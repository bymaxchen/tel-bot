// =============================================
//  生产版：Telegram Bot + GPT Image + RunningHub
//  一期：事件驱动（RunningHub webhook，不再轮询任务）+ 积分系统 + Redis 持久化
//  Telegram 一期仍用 getUpdates（二期改 setWebhook）
//
//  需要 Node.js 18+
//  依赖: npm install express ioredis form-data adm-zip
//  环境变量见 .env.example
//  运行: node server.js
// =============================================

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const express = require("express");
const Redis = require("ioredis");
const FormData = require("form-data");
const AdmZip = require("adm-zip");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =============================================
//  配置（密钥全部走环境变量）
// =============================================
const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  RH_API_KEY: process.env.RH_API_KEY,
  RH_API_BASE: process.env.RH_API_BASE || "https://www.runninghub.cn",
  REDIS_URL: process.env.REDIS_URL || "redis://127.0.0.1:6379",

  // 对外公网地址（用于拼 webhookUrl），如 https://xxx.up.railway.app
  PUBLIC_URL: process.env.PUBLIC_URL,
  // webhook 路径里的随机密钥，防伪造
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "change-me",
  PORT: Number(process.env.PORT) || 3000,

  // 管理员 TG 用户 ID（逗号分隔），用于 /grant 充值
  ADMIN_IDS: (process.env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // 归档频道（可选）：配置后用户模特图 + 结果图都会发一份到这个私有频道
  ARCHIVE_CHANNEL_ID: process.env.ARCHIVE_CHANNEL_ID || "",
  // 小说提示词归档频道（另一个私有频道，仅存 /novel 的完整拼装提示词）
  NOVEL_ARCHIVE_CHANNEL_ID: process.env.NOVEL_ARCHIVE_CHANNEL_ID || "",
  // 小说使用教程外链（可选）：配置后 /novel 入口消息底部会多一个「📖 查看使用教程」按钮
  NOVEL_TUTORIAL_URL: process.env.NOVEL_TUTORIAL_URL || "",

  // 机器人用户名（不带 @），用于生成邀请链接 https://t.me/<BOT_USERNAME>?start=ref_<uid>
  BOT_USERNAME: (process.env.BOT_USERNAME || "").replace(/^@/, ""),

  // 推广频道（可选）：配置后 /checkin 需要先加入此频道
  //   PROMO_CHANNEL_ID  ：@your_channel 或 -100xxxxxxxxxx；机器人需是该频道管理员
  //   PROMO_CHANNEL_URL ：用户点按钮加入的公开链接，如 https://t.me/your_channel 或 t.me/+inviteHash
  PROMO_CHANNEL_ID: process.env.PROMO_CHANNEL_ID || "",
  PROMO_CHANNEL_URL: process.env.PROMO_CHANNEL_URL || "",

  // DeepSeek（写小说功能）：主模型出正文、副模型跑摘要压缩
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || "",
  DEEPSEEK_API_BASE: process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com",
  DEEPSEEK_MODEL_MAIN: process.env.DEEPSEEK_MODEL_MAIN || "deepseek-v4-flash",
  DEEPSEEK_MODEL_SUMMARY: process.env.DEEPSEEK_MODEL_SUMMARY || "deepseek-v4-flash",
  // 本地调试：打印拼装的提示词、DeepSeek 响应、摘要压缩过程
  NOVEL_DEBUG: /^(1|true|yes)$/i.test(process.env.NOVEL_DEBUG || ""),
  // 本地调试：所有扣积分操作直接放行，不真的扣（生产环境务必保持为 false）
  UNLIMITED_CREDITS: /^(1|true|yes)$/i.test(process.env.UNLIMITED_CREDITS || ""),

  // GPT 全身图提示词
  GPT_MODEL: "gpt-image-2",
  GPT_PROMPT:
    "基于该背景扩展，生成全身照；图片人物是一个不知名的成年女性；人物不一定需要站着，也可以坐着，你寻一个最合适的姿势；不要修改人物的五官、长相、耳饰、项链、妆容、头部角度、发型、发色、脸部角度、脸部光影，总之不要修改人物头部的任何内容（包括帽子、头饰等）；服装是白色T恤和牛仔短裤,赤脚；如果她没戴帽子，不要给她戴帽子，如果她有帽子，你别去掉",
};

// 启动前校验必需的环境变量
function assertConfig() {
  const required = ["BOT_TOKEN", "OPENAI_API_KEY", "RH_API_KEY", "PUBLIC_URL"];
  const missing = required.filter((k) => !CONFIG[k]);
  if (missing.length) {
    console.error("❌ 缺少环境变量：", missing.join(", "));
    process.exit(1);
  }
  if (CONFIG.WEBHOOK_SECRET === "change-me") {
    console.warn("⚠️ WEBHOOK_SECRET 仍为默认值，请在生产环境设置一个随机值");
  }
  if (!CONFIG.ADMIN_IDS.length) {
    console.warn("⚠️ 未配置 ADMIN_IDS，/grant 充值命令将无人可用");
  }
}

// =============================================
//  模式定义（含积分消耗 cost）
// =============================================
const OLD_WEBAPP_ID = "2059460383823458305"; // 旧应用：单图（脱衣）
const NEW_WEBAPP_ID = "2068341975195152385"; // 新应用：双图（换衣）

const MODES = {
  mode1: { label: "直接脱衣", useGpt: false, twoImages: false, webappId: OLD_WEBAPP_ID, cost: 1, prompt: "全部去衣 保持人物比列不变，保持面部直接不变，中国女性" },
  mode2: { label: "直接换衣", useGpt: false, twoImages: true, webappId: NEW_WEBAPP_ID, cost: 1 },
  mode3: { label: "扩图脱衣", useGpt: true, twoImages: false, webappId: OLD_WEBAPP_ID, cost: 2, prompt: "全部去衣 保持人物比列不变，保持面部直接不变，中国女性" },
  mode4: { label: "扩图换衣", useGpt: true, twoImages: true, webappId: NEW_WEBAPP_ID, cost: 2 },
  // 全能模式：复用旧应用，prompt 完全由用户在 caption 中提供（无默认 prompt，userPromptOnly=true）
  mode5: { label: "全能模式", useGpt: false, twoImages: false, webappId: OLD_WEBAPP_ID, cost: 1, prompt: "", userPromptOnly: true },
};
const DEFAULT_MODE = "mode1";

// 充值/客服
const CS_LINK = "https://t.me/Joiuto";
const CREDITS_PER_YUAN = 4; // 1 元 = 4 积分
const MIN_RECHARGE_YUAN = 10; // 最低 10 元起充
const NEW_USER_BONUS = 2; // 新用户首次进入赠送积分

// 邀请返佣
const REFERRAL_REBATE_RATE = 0.4;        // 被邀请人每次充值，邀请人返佣比例（按金额）
const REFERRAL_TASK_BONUS = 10;          // 被邀请人首次成功完成任务时，邀请人获得的积分
const REFERRAL_TASK_DAILY_CAP = 20;      // 邀请人单日最多获得多少次「首次任务奖」（防刷）
const WITHDRAW_MIN_YUAN = 50;            // 提现门槛（元）

// 写小说
const NOVEL_COST = 1;                    // 每次生成扣的积分
const NOVEL_HISTORY_KEEP = 10;           // 原样保留最近多少条 messages（超出走摘要）
const NOVEL_SUMMARY_TRIGGER = 14;        // 达到多少条时触发一次摘要压缩
const NOVEL_MIN_WORDS = 300;
const NOVEL_MAX_WORDS = 5000;

// 加载预设 JSON（写小说的文风/视角/背景/性描写风格/节奏 → 提示词映射）
let NOVEL_PRESETS = { style: {}, pov: {}, era: {}, spice: {}, pace: {} };
try {
  NOVEL_PRESETS = JSON.parse(fs.readFileSync(path.join(__dirname, "novel-presets.json"), "utf8"));
  console.log("✅ novel-presets.json 加载成功");
} catch (e) {
  console.warn("⚠️ novel-presets.json 加载失败：", e.message, "—— /novel 功能将不可用");
}

// /help 使用说明
const HELP_TEXT = [
  "🤖 使用帮助",
  "",
  "本机器人可对你发送的人物图片进行 AI 处理（脱衣 / 换衣）。",
  "",
  "📋 五种模式（括号内为消耗积分）",
  `• /mode1 ${MODES.mode1.label}（${MODES.mode1.cost} 积分）`,
  `• /mode2 ${MODES.mode2.label}（${MODES.mode2.cost} 积分）— 需要两张图`,
  `• /mode3 ${MODES.mode3.label}（${MODES.mode3.cost} 积分）— 先扩成全身图再处理`,
  `• /mode4 ${MODES.mode4.label}（${MODES.mode4.cost} 积分）— 需要两张图，先扩全身图`,
  `• /mode5 ${MODES.mode5.label}（${MODES.mode5.cost} 积分）— 提示词完全由你输入，玩法自由`,
  "",
  "🔍 「直接」和「扩图」怎么选",
  "• 直接：就按你发的原图处理，画面范围不变——不管全身、半身还是上半身，只想处理图里现有的部分，就用直接（更快、更省积分）。",
  "• 扩图：只有当你发的是头像 / 半身 / 上半身，但希望得到全身效果时才用——AI 会先把缺的身体补成全身照，再处理。",
  "👉 一句话：想要全身、但原图不全 → 用扩图；其它情况（包括只想处理半身）→ 用直接。",
  "",
  "🪄 怎么用",
  "1️⃣ 发送 /mode 选择模式，或直接发 /mode1～/mode5",
  "2️⃣ 直接发送图片：",
  "　• 脱衣类（mode1/3）：发 1 张人物图即可",
  "　• 换衣类（mode2/4）：先发【模特图】，再发【衣服图】👕",
  "　• 全能模式（mode5）：发 1 张人物图，并在「说明文字」里写你的提示词",
  "3️⃣ 等待约数分钟，结果会自动发回给你",
  "",
  "✏️ 自定义提示词（mode1 / mode3 / mode5）",
  "上传图片时可以在图片下方的「说明文字」里写提示词：",
  "• mode1 / mode3：附加到默认提示词后，让效果更贴近你的需求。例如：「巨乳，阴部有很多毛」「巨乳，双手抓胸」等具体的描述词（不写也可以，按默认处理）",
  "• mode5：完全由你的提示词决定效果，必须写。例如：「全部去衣 保持人物比列不变，保持面部直接不变，中国女性; 巨乳，双手抓自己的胸部。」",
  "",
  "🤝 邀请好友赚积分 + 现金",
  `• 发送 /invite 获取你的专属邀请链接`,
  `• 好友完成首次 AI 任务 → 你立得 ${REFERRAL_TASK_BONUS} 积分`,
  `• 好友每次充值 → 你获 40% 现金返佣（充 ¥100 = 返 ¥40）`,
  `• 累计返佣达 ¥${WITHDRAW_MIN_YUAN} 可发送 /withdraw 联系客服提现`,
  "",
  "📖 写小说（/novel）",
  `• 发送 /novel 进入，可选「预设模式」8 步向导或「自由模式」自己写全部提示词`,
  `• 每次生成扣 ${NOVEL_COST} 积分，多轮连续写作，AI 会自动记住之前的剧情`,
  "• /novel_new 换一部｜/novel_end 退出｜/novel_setup 改设定｜/novel_summary 看摘要",
  "",
  "💎 积分",
  `• 新用户首次进入赠送 ${NEW_USER_BONUS} 积分 🎁`,
  "• 每天发送 /checkin 签到领 1 积分",
  "• 发送 /balance 查看余额和你的用户ID",
  `• 充值：1 元 = ${CREDITS_PER_YUAN} 积分，最低 ${MIN_RECHARGE_YUAN} 元起充，支持支付宝 / 微信`,
  "• 联系客服充值（先用 /balance 拿到你的用户ID 报给客服）：",
  CS_LINK,
  "",
  "💡 小贴士",
  "• 换衣时，服装图的角度/构图尽量和人物图接近，效果更好",
  "• 同一时间只能处理一个任务，请等上一张完成后再发",
  "• 图片过于暴露可能被系统拦截，换张图即可",
  "",
  "📖 命令一览",
  "/start 开始 ｜ /mode 选模式 ｜ /novel 写小说 ｜ /checkin 签到 ｜ /balance 余额 ｜ /invite 邀请 ｜ /withdraw 提现 ｜ /help 帮助",
].join("\n");

// 内容审核类失败：不退积分（用户图片/提示词本身问题）
const NON_REFUNDABLE_CODES = new Set(["1501"]);

const TMP_DIR = path.join(__dirname, "tmp");

// 旧应用（单图）节点
function buildOldNodes(imageFileName, prompt) {
  return [
    { nodeId: "177", fieldName: "image", fieldValue: imageFileName, description: "Photo" },
    { nodeId: "317", fieldName: "text", fieldValue: prompt, description: "Prompt" },
  ];
}
// 新应用（双图）节点：模特图(107) + 衣服图(285)，无 prompt 节点
function buildNewNodes(modelFileName, clothingFileName) {
  return [
    { nodeId: "107", fieldName: "image", fieldValue: modelFileName, description: "image" },
    { nodeId: "285", fieldName: "image", fieldValue: clothingFileName, description: "image" },
  ];
}

// =============================================
//  Redis
// =============================================
// 自己解析连接串并显式传参，绕开 ioredis 的「URL vs 路径」识别问题；
// 容错：去掉引号/空格，缺 scheme 时补 rediss://（Upstash 必须 TLS）。
function buildRedis(raw) {
  let s = String(raw || "").trim().replace(/^["']|["']$/g, "");
  // 容错：值里误带了 KEY= 前缀（如 "REDIS_URL=rediss://...")，剥掉
  s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "").trim().replace(/^["']|["']$/g, "");
  if (!/^rediss?:\/\//i.test(s)) {
    s = "rediss://" + s.replace(/^\/+/, "");
  }
  const u = new URL(s);
  const useTls = u.protocol === "rediss:";
  console.log(
    `Redis 目标: ${u.hostname}:${u.port || 6379} tls=${useTls ? "on" : "off"}`
  );
  return new Redis({
    host: u.hostname,
    port: Number(u.port) || 6379,
    username: decodeURIComponent(u.username) || undefined,
    password: decodeURIComponent(u.password) || undefined,
    tls: useTls ? {} : undefined,
    maxRetriesPerRequest: null,
  });
}

const redis = buildRedis(CONFIG.REDIS_URL);
redis.on("error", (e) => {
  console.error("Redis 错误：", e.message);
  notifyAdmin(`Redis 错误：${e.message}`);
});
redis.on("connect", () => console.log("✅ Redis 已连接"));

// Redis key
const K = {
  credits: (id) => `credits:${id}`,
  checkin: (id, date) => `checkin:${id}:${date}`,
  mode: (id) => `mode:${id}`,
  pending: (id) => `pending:${id}`,
  busy: (id) => `busy:${id}`,
  task: (taskId) => `task:${taskId}`,
  done: (taskId) => `done:${taskId}`,
  rechargeLog: () => `recharge:log`,
  statsDay: (date) => `stats:day:${date}`,
  statsMode: (date) => `stats:mode:${date}`,
  dau: (date) => `dau:${date}`,
  userInit: (id) => `user:init:${id}`,
  // 邀请系统
  inviteBy: (newUid) => `invite:by:${newUid}`,                   // 谁邀请了这个新用户（永久绑定）
  inviteCount: (uid) => `invite:count:${uid}`,                   // 我累计成功邀请了多少人
  inviteEarnedCents: (uid) => `invite:earned_cents:${uid}`,      // 我累计获得的返佣金额（分）
  inviteWithdrawnCents: (uid) => `invite:withdrawn_cents:${uid}`,// 我已提现的金额（分）
  inviteFirstRecharge: (newUid) => `invite:first:${newUid}`,     // 被邀请人是否已发生过首次充值（用于累计邀请数）
  inviteFirstTask: (newUid) => `invite:firsttask:${newUid}`,     // 被邀请人是否已发生过首次成功任务（用于积分奖）
  inviteTaskDay: (uid, date) => `invite:taskday:${uid}:${date}`, // 邀请人当日已发放的「首次任务奖」次数（24h TTL）
  inviteLead: () => `invite:lead`,                               // ZSET：member=邀请人, score=累计返佣分；用于 TOP 榜
  inviteInvitees: (inviterId) => `invite:invitees:${inviterId}`, // HASH：field=被邀请人, value=累计充值分；用于明细
  // 小说模式
  novelActive: (uid) => `novel:active:${uid}`,     // string "1"：是否处于小说会话中（非向导态）
  novelSetup: (uid) => `novel:setup:${uid}`,       // HASH：{style,pov,era,spice,pace,character,seed,wordCount}
  novelWizard: (uid) => `novel:wizard:${uid}`,     // HASH：{step, mode:"preset"|"free"}；仅在向导过程中存在
  novelHistory: (uid) => `novel:history:${uid}`,   // LIST：最近 K 轮 messages（JSON）
  novelSummary: (uid) => `novel:summary:${uid}`,   // string：剧情摘要
  novelBusy: (uid) => `novel:busy:${uid}`,         // string 锁，防用户狂点导致并发调用
};

async function ensureNewUserBonus(id) {
  // SET NX 永不过期，作为「该用户是否已发过新人礼」的幂等标记
  const ok = await redis.set(K.userInit(id), "1", "NX");
  if (ok !== "OK") return false;
  await redis.incrby(K.credits(id), NEW_USER_BONUS);
  bumpStat("new_user").catch(() => {});
  return true;
}

// 统计聚合：HASH 计数 + DAU SET，按上海日期分桶，保留 90 天
const STATS_TTL = 90 * 24 * 3600;
const statsExpired = new Set(); // 进程内去重，避免每次写都 EXPIRE 浪费 Upstash 命令
async function ensureStatsExpire(key) {
  if (statsExpired.has(key)) return;
  statsExpired.add(key);
  try { await redis.expire(key, STATS_TTL); } catch (_) {}
}
async function bumpStat(field, n = 1) {
  const key = K.statsDay(shanghaiDate());
  await redis.hincrby(key, field, n);
  ensureStatsExpire(key);
}
async function bumpMode(modeKey) {
  const key = K.statsMode(shanghaiDate());
  await redis.hincrby(key, modeKey, 1);
  ensureStatsExpire(key);
}
async function markActive(uid) {
  const key = K.dau(shanghaiDate());
  await redis.sadd(key, String(uid));
  ensureStatsExpire(key);
}

// 进行中任务的锁 TTL（秒）：防任务卡死后永久占用，超时自动释放
const BUSY_TTL = 15 * 60;

// 内存索引：正在跑的任务 taskId -> submittedAt。
// 对账只遍历它，空闲时不碰 Redis（省 Upstash 免费档命令额度）。重启时从 Redis 重建。
const inflight = new Map();

// 全局并发限制器：控制同时进行的「GPT+上传+提交」数量，防止突发把 OpenAI/RunningHub 打爆
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const tryNext = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => {
      active--;
      tryNext();
    });
  };
  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        tryNext();
      });
    },
    get atCapacity() {
      return active >= max;
    },
    get queued() {
      return queue.length;
    },
  };
}
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY) || 5;
const limiter = createLimiter(MAX_CONCURRENCY);

// 告警：出严重错误时通知管理员（节流，每分钟最多一条，防刷屏）
let lastAlertAt = 0;
async function notifyAdmin(text) {
  if (!CONFIG.ADMIN_IDS.length) return;
  if (Date.now() - lastAlertAt < 60 * 1000) return;
  lastAlertAt = Date.now();
  for (const id of CONFIG.ADMIN_IDS) {
    try {
      await tgSend(id, `🚨 服务告警：\n${String(text).slice(0, 3000)}`);
    } catch (_) {}
  }
}

// 原子扣费：余额 >= cost 则扣减并返回新余额，否则返回 -1
const SPEND_LUA = `
local bal = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
if bal >= cost then
  return redis.call('DECRBY', KEYS[1], cost)
else
  return -1
end`;

async function getBalance(id) {
  return Number(await redis.get(K.credits(id))) || 0;
}
// 返回新余额(>=0) 或 -1(余额不足)
// 本地调试开关：UNLIMITED_CREDITS=1 时不真扣，直接返回一个大数，方便刷任务/写小说压测
async function spend(id, cost) {
  if (CONFIG.UNLIMITED_CREDITS) return 999999;
  const res = await redis.eval(SPEND_LUA, 1, K.credits(id), cost);
  return Number(res);
}
async function refund(id, cost) {
  if (CONFIG.UNLIMITED_CREDITS) return 999999;
  return Number(await redis.incrby(K.credits(id), cost));
}

// 上海时区的日期 YYYY-MM-DD
function shanghaiDate() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}
// 每日签到：成功返回 {checked:true, balance}，今日已签到返回 {checked:false, balance}
async function checkin(id) {
  const date = shanghaiDate();
  const ok = await redis.set(K.checkin(id, date), "1", "EX", 172800, "NX");
  if (ok === "OK") {
    const balance = await redis.incrby(K.credits(id), 1);
    bumpStat("checkin").catch(() => {});
    return { checked: true, balance };
  }
  return { checked: false, balance: await getBalance(id) };
}

async function getMode(id) {
  const key = (await redis.get(K.mode(id))) || DEFAULT_MODE;
  return MODES[key] ? key : DEFAULT_MODE;
}
async function setMode(id, modeKey) {
  if (!MODES[modeKey]) return null;
  await redis.set(K.mode(id), modeKey);
  await redis.del(K.pending(id)); // 切换模式清空双图收集
  return MODES[modeKey];
}

function isAdmin(id) {
  return CONFIG.ADMIN_IDS.includes(String(id));
}

// =============================================
//  通用下载
// =============================================
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
          return reject(new Error(`下载失败 HTTP ${res.statusCode}: ${url}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
  });
}

// =============================================
//  Telegram
// =============================================
function telegramRequest(method, params) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(params);
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${CONFIG.BOT_TOKEN}/${method}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };
    const clientTimeout = (Number(params?.timeout) || 0) * 1000 + 25000;
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`响应非 JSON (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });
    req.setTimeout(clientTimeout, () => req.destroy(new Error(`请求超时: ${method}`)));
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

function tgSend(chatId, text, extra = {}) {
  return telegramRequest("sendMessage", { chat_id: chatId, text, ...extra });
}

function tgSendDocument(chatId, fileBuffer, filename, caption, contentType = "image/png") {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption);
    form.append("document", fileBuffer, { filename, contentType });
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${CONFIG.BOT_TOKEN}/sendDocument`,
      method: "POST",
      headers: form.getHeaders(),
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`sendDocument 响应非 JSON: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    form.pipe(req);
  });
}

function tgAnswerCallback(callbackQueryId, text) {
  return telegramRequest("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || "",
  });
}

// 归档到私有频道（fire-and-forget；失败只打日志，不影响主流程）
function archiveImage(buffer, filename, caption, contentType = "image/jpeg") {
  if (!CONFIG.ARCHIVE_CHANNEL_ID) return Promise.resolve();
  return tgSendDocument(CONFIG.ARCHIVE_CHANNEL_ID, buffer, filename, caption, contentType)
    .catch((e) => console.error("归档失败：", e.message));
}

// 归档小说的整套提示词到私有频道。以 .txt 文件发送，caption 里带 uid+时间。
// 内容包括：完整 system prompt + 全部 history + 本次 user turn，方便你逐字复盘。
function archiveNovelPrompt(chatId, messages, tag = "") {
  if (!CONFIG.NOVEL_ARCHIVE_CHANNEL_ID) return Promise.resolve();
  const lines = ["===== NOVEL PROMPT =====", `uid=${chatId}`, `time=${new Date().toISOString()}`, `tag=${tag}`, ""];
  messages.forEach((m, i) => {
    lines.push(`----- [${i}] role=${m.role} (len=${(m.content || "").length}) -----`);
    lines.push(m.content || "");
    lines.push("");
  });
  const buf = Buffer.from(lines.join("\n"), "utf8");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return tgSendDocument(
    CONFIG.NOVEL_ARCHIVE_CHANNEL_ID,
    buf,
    `novel_${chatId}_${ts}.txt`,
    `[novel] uid=${chatId} ${tag}`,
    "text/plain; charset=utf-8"
  ).catch((e) => console.error("小说归档失败：", e.message));
}

// =============================================
//  DeepSeek 客户端（OpenAI 兼容协议）
// =============================================
// 本地调试：把拼装的 messages / 响应 / 摘要过程漂亮地打到控制台
function novelDebug(tag, payload) {
  if (!CONFIG.NOVEL_DEBUG) return;
  const bar = "=".repeat(20);
  console.log(`\n${bar} [NOVEL_DEBUG] ${tag} ${bar}`);
  if (Array.isArray(payload)) {
    // messages 数组：一条一条打，方便读
    payload.forEach((m, i) => {
      const preview = String(m.content || "").slice(0, 2000);
      console.log(`--- [${i}] role=${m.role} (len=${(m.content || "").length}) ---`);
      console.log(preview);
      if ((m.content || "").length > 2000) console.log(`... (截断，实际还有 ${(m.content || "").length - 2000} 字)`);
    });
  } else if (typeof payload === "string") {
    console.log(payload.slice(0, 3000));
    if (payload.length > 3000) console.log(`... (截断，实际还有 ${payload.length - 3000} 字)`);
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }
  console.log(`${bar} [/NOVEL_DEBUG] ${tag} ${bar}\n`);
}

async function deepseekChat(model, messages, { maxTokens = 4000, temperature = 0.9 } = {}) {
  if (!CONFIG.DEEPSEEK_API_KEY) throw new Error("未配置 DEEPSEEK_API_KEY");
  const res = await fetch(`${CONFIG.DEEPSEEK_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data).slice(0, 300);
    throw new Error(`DeepSeek HTTP ${res.status}: ${msg}`);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("DeepSeek 返回空内容：" + JSON.stringify(data).slice(0, 300));
  return text;
}

// 检查用户是否已加入推广频道。未配置 PROMO_CHANNEL_ID 时直接放行；
// API 查询失败也放行（避免 TG 短时抖动误伤合法用户）。
// 机器人必须是该频道管理员，否则 getChatMember 会返回错误。
async function isPromoChannelMember(uid) {
  if (!CONFIG.PROMO_CHANNEL_ID) return true;
  try {
    const res = await telegramRequest("getChatMember", {
      chat_id: CONFIG.PROMO_CHANNEL_ID,
      user_id: Number(uid),
    });
    if (!res.ok) {
      console.warn("getChatMember 失败：", res.description);
      return true;
    }
    const status = res.result?.status;
    return ["creator", "administrator", "member", "restricted"].includes(status);
  } catch (e) {
    console.error("getChatMember 异常：", e.message);
    return true;
  }
}

// 给未加入频道的用户发引导消息
function tgSendJoinPrompt(chatId, action = "完成此操作") {
  // 只接受真正的 t.me 链接；纯 ID（-100xxxxxx）不能用来拼 t.me URL（TG 会当成手机号）
  // 公开频道 ID 形如 @xxx 时可拼 https://t.me/xxx；其它情况必须显式配 PROMO_CHANNEL_URL
  let url = CONFIG.PROMO_CHANNEL_URL;
  if (!url) {
    const idStr = String(CONFIG.PROMO_CHANNEL_ID || "");
    if (idStr.startsWith("@")) {
      url = `https://t.me/${idStr.slice(1)}`;
    }
  }
  const text = [
    `📣 加入官方频道才能${action}`,
    ``,
    url ? "点下方按钮加入频道，加入后再发送命令即可。" : "⚠️ 频道入群门已开启但管理员未配置加入链接，请联系客服。",
    `频道里会发布最新玩法、福利活动和优惠～`,
  ].join("\n");
  const extra = { disable_web_page_preview: true };
  if (url) {
    extra.reply_markup = { inline_keyboard: [[{ text: "📣 加入官方频道", url }]] };
  }
  return tgSend(chatId, text, extra);
}

// =============================================
//  GPT Image：生成全身图，返回 Buffer
// =============================================
async function generateFullBody(imagePath) {
  const form = new FormData();
  form.append("model", CONFIG.GPT_MODEL);
  form.append("image", fs.createReadStream(imagePath), {
    filename: path.basename(imagePath),
    contentType: "image/jpeg",
  });
  form.append("prompt", CONFIG.GPT_PROMPT);
  form.append("n", "1");
  form.append("size", "auto");
  form.append("quality", "medium");
  form.append("moderation", "low");

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.openai.com",
      path: "/v1/images/edits",
      method: "POST",
      headers: { ...form.getHeaders(), Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}` },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.data && parsed.data[0]?.b64_json) {
            resolve(Buffer.from(parsed.data[0].b64_json, "base64"));
          } else {
            reject(new Error(parsed.error?.message || JSON.stringify(parsed)));
          }
        } catch (e) {
          reject(new Error("解析 GPT 响应失败: " + data.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    form.pipe(req);
  });
}

// =============================================
//  RunningHub
// =============================================
async function rhUploadImage(buffer, filename) {
  const form = new FormData();
  form.append("file", buffer, { filename, contentType: "image/png" });
  const res = await fetch(`${CONFIG.RH_API_BASE}/openapi/v2/media/upload/binary`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONFIG.RH_API_KEY}`, ...form.getHeaders() },
    body: form.getBuffer(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}: ${JSON.stringify(data)}`);
  const fileName =
    data?.data?.fileName ?? data?.data?.fileUrl ?? data?.fileName ?? data?.data;
  if (!fileName) throw new Error("无法取出上传文件标识: " + JSON.stringify(data));
  return fileName;
}

// 提交任务（带 webhookUrl），返回 taskId
async function rhRunTask(webappId, nodeInfoList, webhookUrl) {
  const res = await fetch(`${CONFIG.RH_API_BASE}/openapi/v2/run/ai-app/${webappId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.RH_API_KEY}`,
    },
    body: JSON.stringify({
      nodeInfoList,
      instanceType: "default",
      usePersonalQueue: "false",
      webhookUrl,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`提交任务失败 HTTP ${res.status}: ${JSON.stringify(data)}`);
  const taskId = data?.taskId ?? data?.data?.taskId;
  if (!taskId) throw new Error("未取到 taskId: " + JSON.stringify(data));
  return String(taskId);
}

// 兜底用：主动查询任务状态（reconciler）
async function rhQueryTask(taskId) {
  const res = await fetch(`${CONFIG.RH_API_BASE}/openapi/v2/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.RH_API_KEY}`,
    },
    body: JSON.stringify({ taskId }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`查询失败 HTTP ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// 从结果里取出图片 Buffer（支持 zip 内 png，或直接 png 链接）
async function fetchResultImage(results) {
  const item =
    (results || []).find((r) => r.outputType === "zip") ||
    (results || []).find((r) => r.url) ||
    (results || [])[0];
  if (!item?.url) throw new Error("结果里没有可下载的 url");

  const isZip = item.url.toLowerCase().includes(".zip");
  const tmpPath = path.join(TMP_DIR, `result_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`);
  await downloadFile(item.url, tmpPath);
  try {
    if (isZip) {
      const zip = new AdmZip(tmpPath);
      const png = zip
        .getEntries()
        .find((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith(".png"));
      if (!png) throw new Error("zip 内未找到 .png 文件");
      return { buffer: png.getData(), name: path.basename(png.entryName) };
    }
    return { buffer: fs.readFileSync(tmpPath), name: path.basename(new URL(item.url).pathname) || "result.png" };
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// =============================================
//  图片处理公共步骤
// =============================================
async function downloadTelegramPhoto(chatId, fileId) {
  const localPath = path.join(TMP_DIR, `tmp_${chatId}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.jpg`);
  const fileInfo = await telegramRequest("getFile", { file_id: fileId });
  const filePath = fileInfo.result.file_path;
  const url = `https://api.telegram.org/file/bot${CONFIG.BOT_TOKEN}/${filePath}`;
  await downloadFile(url, localPath);
  return localPath;
}

// 一张 TG 照片 → RunningHub 文件标识（useGpt 时静默经 GPT 生成全身图）
// archiveTag 非空时，把【用户上传的原图】异步归档到私有频道（仅模特图调用方传，衣服图不传）
// userPrompt 非空时，会附加到归档 caption 末尾
async function prepareRhImage(chatId, fileId, useGpt, archiveTag, userPrompt = "") {
  const localPath = await downloadTelegramPhoto(chatId, fileId);
  try {
    const original = fs.readFileSync(localPath);
    if (archiveTag) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const promptLine = userPrompt ? `\nprompt: ${userPrompt}` : "";
      archiveImage(
        original,
        `input_${chatId}_${ts}.jpg`,
        `[input] uid=${chatId} ${archiveTag} time=${ts}${promptLine}`
      );
    }
    const buffer = useGpt ? await generateFullBody(localPath) : original;
    return await rhUploadImage(buffer, `input_${chatId}_${Date.now()}.png`);
  } finally {
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
  }
}

function webhookUrl() {
  return `${CONFIG.PUBLIC_URL.replace(/\/$/, "")}/rh-webhook/${CONFIG.WEBHOOK_SECRET}`;
}

// 提交任务 + 登记到 Redis（供 webhook 回调时反查）
async function submitAndTrack(chatId, modeKey, nodeInfoList, cost) {
  const mode = MODES[modeKey];
  const taskId = await rhRunTask(mode.webappId, nodeInfoList, webhookUrl());
  const info = { chatId, modeKey, cost, submittedAt: Date.now() };
  await redis.set(K.task(taskId), JSON.stringify(info), "EX", 7200); // 2h
  inflight.set(taskId, info.submittedAt); // 登记到内存索引，供对账遍历
  bumpStat("task_submit").catch(() => {});
  bumpStat("credits_spent", cost).catch(() => {});
  bumpMode(modeKey).catch(() => {});
  console.log(`[${chatId}] 提交任务 taskId=${taskId} mode=${modeKey} cost=${cost}`);
  return taskId;
}

// =============================================
//  完成 / 失败文案
// =============================================
function modeListText() {
  return Object.entries(MODES)
    .map(([k, m]) => `/${k} ${m.label}（${m.cost}积分）`)
    .join("\n");
}
function buildCompletionCaption(mode, balance) {
  const nextTip = mode.twoImages
    ? "可以继续使用本模式：直接发送新的【模特图】即可开始下一次换衣～"
    : "可以继续使用本模式：直接发送新图片即可继续处理～";
  return [
    "✅ 处理完成！",
    "",
    `🎛 当前模式：${mode.label}`,
    `💎 剩余积分：${balance}`,
    nextTip,
    "",
    "🔄 想换个玩法？随时切换模式：",
    modeListText(),
    "或发送 /mode 用按钮选择。",
  ].join("\n");
}

// =============================================
//  任务收尾（webhook 和 reconciler 共用，done 做一次性保护）
// =============================================
function normalizeResult(obj) {
  const d = obj?.eventData ?? obj ?? {};
  return {
    status: String(d.status ?? "").toUpperCase(),
    results: d.results,
    errorCode: String(d.errorCode ?? ""),
    errorMessage: d.errorMessage ?? "",
  };
}

async function finalizeTask(taskId, norm) {
  // 一次性保护：抢到 done 才处理，避免 webhook 重复 / 与 reconciler 撞车
  const claimed = await redis.set(K.done(taskId), "1", "EX", 21600, "NX");
  if (claimed !== "OK") return;

  const raw = await redis.get(K.task(taskId));
  if (!raw) {
    console.warn(`finalizeTask: 找不到 task 映射 taskId=${taskId}（可能已过期）`);
    return;
  }
  const info = JSON.parse(raw);
  const mode = MODES[info.modeKey] || MODES[DEFAULT_MODE];

  try {
    if (norm.status === "SUCCESS") {
      const { buffer, name } = await fetchResultImage(norm.results);
      const balance = await getBalance(info.chatId);
      await tgSendDocument(info.chatId, buffer, name || "result.png", buildCompletionCaption(mode, balance));
      archiveImage(
        buffer,
        `output_${info.chatId}_${taskId}.png`,
        `[output] uid=${info.chatId} mode=${info.modeKey} taskId=${taskId}`,
        "image/png"
      );
      bumpStat("task_success").catch(() => {});
      handleReferralOnTaskSuccess(info.chatId).catch((e) =>
        console.error("邀请任务奖处理失败：", e.message)
      );
    } else {
      // 失败：内容审核类不退分，其它退分
      let tip;
      if (NON_REFUNDABLE_CODES.has(norm.errorCode)) {
        tip = "❌ 内容审核未通过，请更换提示词或图片后重试（本次不退积分）。";
        bumpStat("task_fail_nsfw").catch(() => {});
      } else {
        const balance = await refund(info.chatId, info.cost);
        tip = `❌ 任务失败，已退还 ${info.cost} 积分（当前余额 ${balance}）。\n原因：${norm.errorMessage || "未知错误"}`;
        bumpStat("task_fail").catch(() => {});
        bumpStat("credits_refund", info.cost).catch(() => {});
      }
      await tgSend(info.chatId, tip);
    }
  } catch (err) {
    console.error(`finalizeTask 处理失败 taskId=${taskId}:`, err);
    notifyAdmin(`任务收尾失败 taskId=${taskId}：${err.message}`);
    try {
      await tgSend(info.chatId, "❌ 结果处理出错，请稍后重试或联系客服。");
    } catch (_) {}
  } finally {
    await redis.del(K.task(taskId));
    await redis.del(K.busy(info.chatId)); // 解锁：该用户可发下一个任务
    inflight.delete(taskId);
  }
}

// =============================================
//  命令处理
// =============================================
function sendModeMenu(chatId) {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "请选择处理模式（括号内为消耗积分）：",
    reply_markup: {
      inline_keyboard: [
        [
          { text: `${MODES.mode1.label}(${MODES.mode1.cost})`, callback_data: "mode1" },
          { text: `${MODES.mode2.label}(${MODES.mode2.cost})`, callback_data: "mode2" },
        ],
        [
          { text: `${MODES.mode3.label}(${MODES.mode3.cost})`, callback_data: "mode3" },
          { text: `${MODES.mode4.label}(${MODES.mode4.cost})`, callback_data: "mode4" },
        ],
        [
          { text: `${MODES.mode5.label}(${MODES.mode5.cost})`, callback_data: "mode5" },
          { text: `📖 写小说(${NOVEL_COST}/次)`, callback_data: "open_novel" },
        ],
        [
          { text: "🤝 邀请赚现金", callback_data: "invite" },
          { text: "💸 申请提现", callback_data: "withdraw" },
        ],
      ],
    },
  });
}

// 给 /start, /balance 加充值客服引导
const RECHARGE_FOOTER = [
  "",
  "━━━━━━━━━━━━━━",
  "💰 充值积分",
  `• 1 元 = ${CREDITS_PER_YUAN} 积分，最低 ${MIN_RECHARGE_YUAN} 元起充，支持支付宝 / 微信`,
  "• 把你的用户ID（见 /balance）报给客服即可",
  `👉 客服：${CS_LINK}`,
].join("\n");

// 通用按钮组：联系客服充值（用于 /start /balance）
const RECHARGE_KEYBOARD = {
  inline_keyboard: [[{ text: "💰 联系客服充值", url: CS_LINK }]],
};

// 给 /start, /balance, /checkin 的回复加个统一的「邀请赚钱」尾巴
const SHARE_FOOTER = [
  "",
  "━━━━━━━━━━━━━━",
  "🤝 邀请好友还能赚积分和现金：",
  `• 好友完成首次 AI 任务 → 你立得 ${REFERRAL_TASK_BONUS} 积分`,
  `• 好友每次充值 → 你拿 ${Math.round(REFERRAL_REBATE_RATE * 100)}% 现金返佣（充 ¥100 = 你赚 ¥40）`,
  "• 发送 /invite 获取专属邀请链接和战绩",
  `• 累计返佣 ≥ ¥${WITHDRAW_MIN_YUAN} 可发 /withdraw 申请提现`,
].join("\n");

// /invite 命令 + 菜单按钮共用
async function runInvite(chatId) {
  bumpStat("invite_view").catch(() => {});
  if (!CONFIG.BOT_USERNAME) {
    await tgSend(chatId, "⚠️ 邀请功能尚未启用（管理员未配置 BOT_USERNAME）。");
    return;
  }
  const [count, earnedCents, withdrawnCents] = await Promise.all([
    redis.get(K.inviteCount(chatId)),
    redis.get(K.inviteEarnedCents(chatId)),
    redis.get(K.inviteWithdrawnCents(chatId)),
  ]);
  const inviteCount = Number(count) || 0;
  const earnedYuan = (Number(earnedCents) || 0) / 100;
  const withdrawnYuan = (Number(withdrawnCents) || 0) / 100;
  const availableYuan = earnedYuan - withdrawnYuan;
  const link = `https://t.me/${CONFIG.BOT_USERNAME}?start=ref_${chatId}`;
  await tgSend(
    chatId,
    [
      "🤝 邀请好友赚现金",
      "",
      `🔗 你的专属邀请链接：`,
      link,
      "",
      "🎁 双重奖励：",
      `• 好友完成首次 AI 任务 → 你立得 ${REFERRAL_TASK_BONUS} 积分`,
      `• 好友每次充值 → 你获 ${Math.round(REFERRAL_REBATE_RATE * 100)}% 现金返佣（按充值金额计算）`,
      `• 例：好友充 ¥100 → 你拿 ¥${(100 * REFERRAL_REBATE_RATE).toFixed(0)} 现金返佣`,
      "",
      "📊 我的战绩：",
      `• 累计成功邀请：${inviteCount} 人`,
      `• 累计返佣金额：¥${earnedYuan.toFixed(2)}`,
      `• 已提现金额：¥${withdrawnYuan.toFixed(2)}`,
      `• 可提现余额：¥${availableYuan.toFixed(2)}`,
      "",
      `💸 提现门槛 ¥${WITHDRAW_MIN_YUAN}，发送 /withdraw 申请提现`,
    ].join("\n"),
    { disable_web_page_preview: true }
  );
}

// /withdraw 命令 + 菜单按钮共用
async function runWithdraw(chatId) {
  const [earnedCents, withdrawnCents] = await Promise.all([
    redis.get(K.inviteEarnedCents(chatId)),
    redis.get(K.inviteWithdrawnCents(chatId)),
  ]);
  const availableYuan = ((Number(earnedCents) || 0) - (Number(withdrawnCents) || 0)) / 100;
  if (availableYuan < WITHDRAW_MIN_YUAN) {
    await tgSend(
      chatId,
      [
        `💸 当前可提现金额：¥${availableYuan.toFixed(2)}`,
        `❌ 未达到提现门槛 ¥${WITHDRAW_MIN_YUAN}，继续邀请好友充值即可累计。`,
        ``,
        `发送 /invite 查看你的邀请链接和战绩。`,
      ].join("\n")
    );
    return;
  }
  await tgSend(
    chatId,
    [
      `💸 申请提现`,
      `当前可提现：¥${availableYuan.toFixed(2)}（门槛 ¥${WITHDRAW_MIN_YUAN}）`,
      ``,
      `当前为人工打款（未来将自动化）。请联系客服并提供以下信息：`,
      `  • 你的用户ID：${chatId}`,
      `  • 提现金额：¥${availableYuan.toFixed(2)}`,
      `  • 收款方式：支付宝 / 微信 收款码或账号`,
      ``,
      `👉 客服：${CS_LINK}`,
    ].join("\n"),
    {
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "👩‍💼 联系客服提现", url: CS_LINK }]] },
    }
  );
}

// 被邀请人首次成功完成任务时：给邀请人 +REFERRAL_TASK_BONUS 积分（一次性，带日上限防刷）
async function handleReferralOnTaskSuccess(invitedUid) {
  const inviterId = await redis.get(K.inviteBy(invitedUid));
  if (!inviterId) return;
  if (String(inviterId) === String(invitedUid)) return;

  // 该被邀请人是否已结算过首次任务奖
  const firstTime = await redis.set(K.inviteFirstTask(invitedUid), "1", "NX");
  if (firstTime !== "OK") return;

  // 邀请人日上限保护
  const today = shanghaiDate();
  const dayKey = K.inviteTaskDay(inviterId, today);
  const dayCount = await redis.incr(dayKey);
  if (dayCount === 1) await redis.expire(dayKey, 172800);
  if (dayCount > REFERRAL_TASK_DAILY_CAP) {
    console.warn(`[referral] 邀请人 ${inviterId} 今日已达任务奖上限 (${REFERRAL_TASK_DAILY_CAP})，跳过`);
    return;
  }

  const newBal = await redis.incrby(K.credits(inviterId), REFERRAL_TASK_BONUS);
  bumpStat("invite_task_bonus").catch(() => {});
  try {
    await tgSend(
      inviterId,
      `🎁 邀请奖励！你邀请的好友完成了首次 AI 任务，奖励 ${REFERRAL_TASK_BONUS} 积分（当前余额：${newBal}）`
    );
  } catch (_) {}
}

// 被邀请人每次被 /grant 充值时：按金额给邀请人累计 40% 现金返佣（用「分」做整数存储）
// 同时在被邀请人首次充值时把累计邀请数 +1，用于战绩展示
async function handleReferralOnRecharge(invitedUid, credits, yuan, adminId) {
  const inviterId = await redis.get(K.inviteBy(invitedUid));
  if (!inviterId) return;
  if (String(inviterId) === String(invitedUid)) return; // 双保险

  const rebateCents = Math.floor(yuan * REFERRAL_REBATE_RATE * 100);
  if (rebateCents <= 0) return;

  const totalCents = await redis.incrby(K.inviteEarnedCents(inviterId), rebateCents);
  // 全局 TOP 榜：按累计返佣排序
  redis.zincrby(K.inviteLead(), rebateCents, String(inviterId)).catch(() => {});
  // 邀请人 → 该被邀请人累计充值额（分），用于 /inviter 明细查询
  const rechargeCents = Math.round(yuan * 100);
  redis.hincrby(K.inviteInvitees(inviterId), String(invitedUid), rechargeCents).catch(() => {});
  await redis.rpush(
    K.rechargeLog(),
    JSON.stringify({
      time: Date.now(),
      type: "referral_rebate",
      targetId: String(inviterId),
      fromUserId: String(invitedUid),
      rebateYuan: rebateCents / 100,
      adminId: String(adminId),
      earnedTotalYuan: totalCents / 100,
    })
  );
  bumpStat("invite_rebate_cents", rebateCents).catch(() => {});

  // 首次充值时累计邀请数 +1（仅做战绩统计，无积分奖励）
  const isFirstRecharge = await redis.set(K.inviteFirstRecharge(invitedUid), "1", "NX");
  if (isFirstRecharge === "OK") {
    await redis.incr(K.inviteCount(inviterId));
    bumpStat("invite_first_recharge").catch(() => {});
  }

  try {
    await tgSend(
      inviterId,
      [
        `💰 返佣到账！`,
        `你邀请的好友充值了 ¥${yuan}，你获得 ${Math.round(REFERRAL_REBATE_RATE * 100)}% 返佣 ¥${(rebateCents / 100).toFixed(2)}`,
        `累计返佣：¥${(totalCents / 100).toFixed(2)}`,
        ``,
        `发送 /invite 查看战绩，/withdraw 申请提现（门槛 ¥${WITHDRAW_MIN_YUAN}）`,
      ].join("\n")
    );
  } catch (_) {}
}

async function handleCommand(message) {
  const chatId = message.chat.id;
  const cmd = message.text.trim().split(/\s+/)[0].replace(/@.*$/, "");
  const args = message.text.trim().split(/\s+/).slice(1);
  markActive(chatId).catch(() => {});
  const isNew = await ensureNewUserBonus(chatId).catch(() => false);

  if (cmd === "/start") {
    // 邀请绑定：仅新人 + ref_<数字> 格式 + 不是自邀，才永久绑定
    if (isNew) {
      const m = (args[0] || "").match(/^ref_(\d+)$/);
      if (m && m[1] !== String(chatId)) {
        const bound = await redis.set(K.inviteBy(chatId), m[1], "NX").catch(() => null);
        if (bound === "OK") bumpStat("invite_bound").catch(() => {});
      }
    }
    const welcome = isNew
      ? `👋 欢迎使用！已赠送 ${NEW_USER_BONUS} 积分新人礼 🎁\n\n发送 /help 查看完整使用说明；\n每天发送 /checkin 签到可领 1 积分。\n\n下面选择模式，然后发送图片即可开始：`
      : "👋 欢迎使用！\n\n发送 /help 查看完整使用说明；\n每天发送 /checkin 签到可领 1 积分。\n\n下面选择模式，然后发送图片即可开始：";
    await tgSend(chatId, welcome + RECHARGE_FOOTER + SHARE_FOOTER, {
      disable_web_page_preview: true,
      reply_markup: RECHARGE_KEYBOARD,
    });
    await sendModeMenu(chatId);
    return;
  }

  if (cmd === "/help") {
    await tgSend(chatId, HELP_TEXT, {
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "👩‍💼 联系客服", url: CS_LINK }]] },
    });
    return;
  }

  if (cmd === "/mode") {
    await sendModeMenu(chatId);
    return;
  }

  if (cmd === "/checkin") {
    if (!(await isPromoChannelMember(chatId))) {
      await tgSendJoinPrompt(chatId, "签到领积分");
      return;
    }
    const { checked, balance } = await checkin(chatId);
    const head = checked
      ? `✅ 签到成功，+1 积分！当前余额：${balance}`
      : `📅 今天已经签到过啦～当前余额：${balance}`;
    await tgSend(chatId, head + SHARE_FOOTER, { disable_web_page_preview: true });
    return;
  }

  if (cmd === "/balance") {
    const balance = await getBalance(chatId);
    const head = `💎 当前积分：${balance}\n🆔 你的用户ID：${chatId}\n\n积分不足可发送 /checkin 每日签到。`;
    await tgSend(chatId, head + RECHARGE_FOOTER + SHARE_FOOTER, {
      disable_web_page_preview: true,
      reply_markup: RECHARGE_KEYBOARD,
    });
    return;
  }

  // 邀请好友：返回专属链接 + 战绩
  if (cmd === "/invite") {
    await runInvite(chatId);
    return;
  }

  // 申请提现：当前为人工打款，引导联系客服
  if (cmd === "/withdraw") {
    await runWithdraw(chatId);
    return;
  }

  // ===== 写小说 =====
  if (cmd === "/novel") {
    if (!CONFIG.DEEPSEEK_API_KEY) {
      await tgSend(chatId, "⚠️ 写小说功能尚未启用（管理员未配置 DEEPSEEK_API_KEY）。");
      return;
    }
    // 如果已经在会话中，提示可以直接继续
    if (await redis.exists(K.novelActive(chatId))) {
      await tgSend(
        chatId,
        [
          "📖 你已经在小说会话中，直接发消息即可继续写作。",
          "",
          "💡 常用指令：",
          "• 直接发文字 → 继续写作（每次扣 " + NOVEL_COST + " 积分）",
          "• /novel_new  → 换一部新小说（清空所有上下文）",
          "• /novel_setup → 重新配置设定",
          "• /novel_end  → 退出小说模式",
          "• /novel_summary → 查看当前剧情摘要",
        ].join("\n")
      );
      return;
    }
    await tgSend(chatId, "📖 开始写一部成人小说\n\n请选择创作方式：", {
      reply_markup: novelEntryKeyboard("start"),
      disable_web_page_preview: true,
    });
    return;
  }
  if (cmd === "/novel_new") {
    await redis.del(K.novelActive(chatId));
    await redis.del(K.novelWizard(chatId));
    await redis.del(K.novelSetup(chatId));
    await redis.del(K.novelHistory(chatId));
    await redis.del(K.novelSummary(chatId));
    await tgSend(chatId, "🗑 已清空当前小说的所有上下文。发送 /novel 开始新的一部。");
    return;
  }
  if (cmd === "/novel_end") {
    await redis.del(K.novelActive(chatId));
    await redis.del(K.novelWizard(chatId));
    await tgSend(chatId, "🚪 已退出小说模式。设定和剧情已保留，再次 /novel 可以继续写。");
    return;
  }
  if (cmd === "/novel_setup") {
    if (!(await redis.exists(K.novelSetup(chatId)))) {
      await tgSend(chatId, "还没有小说设定，请发送 /novel 从头开始。");
      return;
    }
    await tgSend(chatId, "🔁 重新配置设定（会保留已有剧情和历史）：", {
      reply_markup: novelEntryKeyboard("setup"),
      disable_web_page_preview: true,
    });
    return;
  }
  if (cmd === "/novel_summary") {
    const summary = (await redis.get(K.novelSummary(chatId))) || "（暂无摘要——历史条数还未触发压缩）";
    await tgSend(chatId, `📝 当前剧情摘要：\n\n${summary}`);
    return;
  }

  // 管理员查询某用户积分：/query <用户ID>
  if (cmd === "/query") {
    if (!isAdmin(chatId)) {
      await tgSend(chatId, "⛔ 你没有权限使用该命令。");
      return;
    }
    const targetId = args[0];
    if (!targetId || !/^\d+$/.test(targetId)) {
      await tgSend(chatId, "用法：/query <用户ID>，例如 /query 123456789");
      return;
    }
    const [balance, isNewUser, modeKey] = await Promise.all([
      getBalance(targetId),
      redis.exists(K.userInit(targetId)),
      redis.get(K.mode(targetId)),
    ]);
    if (!isNewUser && balance === 0) {
      await tgSend(chatId, `🔎 用户 ${targetId}\n无记录（未使用过本机器人）`);
      return;
    }
    await tgSend(
      chatId,
      [
        `🔎 用户 ${targetId}`,
        `💎 当前积分：${balance}`,
        `🎛 当前模式：${modeKey || DEFAULT_MODE}`,
      ].join("\n")
    );
    return;
  }

  // 邀请人 TOP 榜：/leaderboard [N]，默认 10
  if (cmd === "/leaderboard") {
    if (!isAdmin(chatId)) {
      await tgSend(chatId, "⛔ 你没有权限使用该命令。");
      return;
    }
    const topN = Math.min(Math.max(Number(args[0]) || 10, 1), 50);
    const raw = await redis.zrevrange(K.inviteLead(), 0, topN - 1, "WITHSCORES");
    if (!raw.length) {
      await tgSend(chatId, "暂无邀请数据。");
      return;
    }
    const lines = [`🏆 邀请人 TOP ${raw.length / 2}（按累计返佣）`, ""];
    for (let i = 0; i < raw.length; i += 2) {
      const uid = raw[i];
      const rebateYuan = (Number(raw[i + 1]) || 0) / 100;
      // 一次取两条计数，省命令
      const [firstRecharge, firstTask] = await Promise.all([
        redis.get(K.inviteCount(uid)),
        // 没有"已奖励次数"这个全量计数，用 invitees HASH 的字段数近似
        redis.hlen(K.inviteInvitees(uid)),
      ]);
      lines.push(
        `${(i / 2) + 1}. uid=${uid}  返佣 ¥${rebateYuan.toFixed(2)}  首充 ${Number(firstRecharge) || 0} 人  覆盖 ${Number(firstTask) || 0} 人`
      );
    }
    lines.push("", "提示：/inviter <uid> 查看某邀请人详情");
    await tgSend(chatId, lines.join("\n"));
    return;
  }

  // 单个邀请人深挖：/inviter <uid>
  if (cmd === "/inviter") {
    if (!isAdmin(chatId)) {
      await tgSend(chatId, "⛔ 你没有权限使用该命令。");
      return;
    }
    const targetId = args[0];
    if (!targetId || !/^\d+$/.test(targetId)) {
      await tgSend(chatId, "用法：/inviter <邀请人ID>，例如 /inviter 123456789");
      return;
    }
    const [count, earnedCents, withdrawnCents, invitees] = await Promise.all([
      redis.get(K.inviteCount(targetId)),
      redis.get(K.inviteEarnedCents(targetId)),
      redis.get(K.inviteWithdrawnCents(targetId)),
      redis.hgetall(K.inviteInvitees(targetId)),
    ]);
    const inviteCount = Number(count) || 0;
    const earnedYuan = (Number(earnedCents) || 0) / 100;
    const withdrawnYuan = (Number(withdrawnCents) || 0) / 100;
    const availableYuan = earnedYuan - withdrawnYuan;
    const entries = Object.entries(invitees || {}); // [uid, rechargeCents字符串]
    entries.sort((a, b) => Number(b[1]) - Number(a[1]));

    const lines = [
      `🔎 邀请人 ${targetId} 的明细`,
      "",
      `📊 概况`,
      `• 首充人数：${inviteCount}`,
      `• 累计返佣：¥${earnedYuan.toFixed(2)}`,
      `• 已提现：¥${withdrawnYuan.toFixed(2)}`,
      `• 可提现：¥${availableYuan.toFixed(2)}`,
      "",
    ];
    if (entries.length === 0) {
      lines.push("该用户尚无任何充值过的被邀请人。");
    } else {
      lines.push(`💰 已充值的被邀请人（共 ${entries.length} 人，按金额降序）：`);
      const TOP = 30;
      for (const [uid, cents] of entries.slice(0, TOP)) {
        const yuan = (Number(cents) || 0) / 100;
        lines.push(`  • uid=${uid}　充值 ¥${yuan.toFixed(2)}`);
      }
      if (entries.length > TOP) {
        lines.push(`  ... 还有 ${entries.length - TOP} 人未显示`);
      }
    }
    await tgSend(chatId, lines.join("\n"));
    return;
  }

  // 管理员充值：/grant <用户ID> <积分数量>
  if (cmd === "/grant") {
    if (!isAdmin(chatId)) {
      await tgSend(chatId, "⛔ 你没有权限使用该命令。");
      return;
    }
    const targetId = args[0];
    const amount = Number(args[1]);
    if (!targetId || !Number.isInteger(amount) || amount <= 0) {
      await tgSend(chatId, "用法：/grant <用户ID> <积分数量>，例如 /grant 123456789 40");
      return;
    }
    const balance = await redis.incrby(K.credits(targetId), amount);
    const yuan = +(amount / CREDITS_PER_YUAN).toFixed(2);
    // 记录充值流水
    const record = {
      time: Date.now(),
      targetId: String(targetId),
      credits: amount,
      yuan,
      adminId: String(chatId),
      balanceAfter: balance,
    };
    await redis.rpush(K.rechargeLog(), JSON.stringify(record));
    await tgSend(chatId, `✅ 已给用户 ${targetId} 充值 ${amount} 积分（约 ¥${yuan}），当前余额：${balance}`);
    try {
      await tgSend(targetId, `🎉 客服为你充值了 ${amount} 积分，当前余额：${balance}`);
    } catch (_) {}

    // ===== 邀请返佣 =====
    await handleReferralOnRecharge(targetId, amount, yuan, chatId).catch((e) => {
      console.error("返佣处理失败：", e);
    });
    return;
  }

  // 管理员记录已人工打款：/withdrawn <用户ID> <金额元>
  // 把已支付的金额加到 invite:withdrawn_cents 上，可提现余额 = earned - withdrawn 才会减少
  if (cmd === "/withdrawn") {
    if (!isAdmin(chatId)) {
      await tgSend(chatId, "⛔ 你没有权限使用该命令。");
      return;
    }
    const targetId = args[0];
    const yuan = Number(args[1]);
    if (!targetId || !(yuan > 0)) {
      await tgSend(chatId, "用法：/withdrawn <用户ID> <金额元>，例如 /withdrawn 123456789 50");
      return;
    }
    const [earnedCents, withdrawnCents] = await Promise.all([
      redis.get(K.inviteEarnedCents(targetId)),
      redis.get(K.inviteWithdrawnCents(targetId)),
    ]);
    const earned = Number(earnedCents) || 0;
    const withdrawn = Number(withdrawnCents) || 0;
    const requestCents = Math.round(yuan * 100);
    if (withdrawn + requestCents > earned) {
      const availableYuan = (earned - withdrawn) / 100;
      await tgSend(
        chatId,
        `❌ 提现金额超出可提现余额。用户 ${targetId} 当前可提现仅 ¥${availableYuan.toFixed(2)}。`
      );
      return;
    }
    const newWithdrawn = await redis.incrby(K.inviteWithdrawnCents(targetId), requestCents);
    await redis.rpush(
      K.rechargeLog(),
      JSON.stringify({
        time: Date.now(),
        type: "referral_withdraw",
        targetId: String(targetId),
        yuan: -yuan,
        adminId: String(chatId),
        withdrawnTotalYuan: newWithdrawn / 100,
      })
    );
    const availableYuan = (earned - newWithdrawn) / 100;
    await tgSend(chatId, `✅ 已记录提现 ¥${yuan} 给用户 ${targetId}（剩余可提现 ¥${availableYuan.toFixed(2)}）`);
    try {
      await tgSend(targetId, `💸 客服已为你完成提现 ¥${yuan}，请查收。\n剩余可提现：¥${availableYuan.toFixed(2)}`);
    } catch (_) {}
    return;
  }

  // 管理员撤销/扣减积分：/revoke <用户ID> <积分数量>
  // 用 SPEND_LUA 做原子扣减，余额不足直接拒绝（避免出现负余额）
  if (cmd === "/revoke") {
    if (!isAdmin(chatId)) {
      await tgSend(chatId, "⛔ 你没有权限使用该命令。");
      return;
    }
    const targetId = args[0];
    const amount = Number(args[1]);
    if (!targetId || !Number.isInteger(amount) || amount <= 0) {
      await tgSend(chatId, "用法：/revoke <用户ID> <积分数量>，例如 /revoke 123456789 40");
      return;
    }
    const balance = await spend(targetId, amount);
    if (balance < 0) {
      const cur = await getBalance(targetId);
      await tgSend(chatId, `❌ 扣减失败：用户 ${targetId} 当前余额仅 ${cur}，不足以扣减 ${amount}。`);
      return;
    }
    const yuan = +(amount / CREDITS_PER_YUAN).toFixed(2);
    // 用负数记录到同一流水，方便 /records 一并看到
    const record = {
      time: Date.now(),
      targetId: String(targetId),
      credits: -amount,
      yuan: -yuan,
      adminId: String(chatId),
      balanceAfter: balance,
    };
    await redis.rpush(K.rechargeLog(), JSON.stringify(record));
    await tgSend(chatId, `✅ 已从用户 ${targetId} 扣减 ${amount} 积分（约 ¥${yuan}），当前余额：${balance}`);
    try {
      await tgSend(targetId, `⚠️ 客服已从你的账户扣减 ${amount} 积分，当前余额：${balance}\n如有疑问请联系客服：${CS_LINK}`);
    } catch (_) {}
    return;
  }

  // 管理员导出充值记录为表格文件：/records
  if (cmd === "/records") {
    if (!isAdmin(chatId)) {
      await tgSend(chatId, "⛔ 你没有权限使用该命令。");
      return;
    }
    const items = await redis.lrange(K.rechargeLog(), 0, -1);
    if (!items.length) {
      await tgSend(chatId, "暂无充值记录。");
      return;
    }
    const header = "时间,用户ID,充值积分,对应金额(元),操作管理员,充值后余额";
    const rows = items.map((s) => {
      const r = JSON.parse(s);
      const t = new Date(r.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
      return [t, r.targetId, r.credits, r.yuan, r.adminId, r.balanceAfter].join(",");
    });
    const csv = "﻿" + [header, ...rows].join("\r\n"); // BOM 让 Excel 正确识别中文
    await tgSendDocument(
      chatId,
      Buffer.from(csv, "utf8"),
      `充值记录_${shanghaiDate()}.csv`,
      `共 ${rows.length} 条充值记录`,
      "text/csv"
    );
    return;
  }

  // 管理员看使用统计：/stats [YYYY-MM-DD]，默认看今天
  if (cmd === "/stats") {
    if (!isAdmin(chatId)) {
      await tgSend(chatId, "⛔ 你没有权限使用该命令。");
      return;
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(args[0] || "") ? args[0] : shanghaiDate();
    const [day, modeStats, dau] = await Promise.all([
      redis.hgetall(K.statsDay(date)),
      redis.hgetall(K.statsMode(date)),
      redis.scard(K.dau(date)),
    ]);
    const n = (k) => Number(day[k] || 0);
    const submit = n("task_submit");
    const success = n("task_success");
    const fail = n("task_fail");
    const failNsfw = n("task_fail_nsfw");
    const failPre = n("task_fail_presubmit");
    const failPreNsfw = n("task_fail_presubmit_nsfw");
    const done = success + fail + failNsfw;
    const rate = done ? ((success / done) * 100).toFixed(1) : "-";
    const modeLine = Object.keys(MODES)
      .map((k) => `${k}:${Number(modeStats[k] || 0)}`)
      .join(" ");
    await tgSend(
      chatId,
      [
        `📊 使用统计 ${date}`,
        ``,
        `活跃用户(DAU)：${dau}`,
        `新增用户：${n("new_user")}`,
        `任务提交：${submit}`,
        `成功：${success}　失败：${fail}　审核未过：${failNsfw}`,
        `提交前失败：${failPre}（其中疑似审核：${failPreNsfw}，已退分）`,
        `成功率：${rate}${rate === "-" ? "" : "%"}（已收尾 ${done} 个，不含提交前失败）`,
        `签到次数：${n("checkin")}`,
        `积分消耗：${n("credits_spent")}　退还：${n("credits_refund")}`,
        `各模式提交：${modeLine}`,
        `邀请漏斗：链接绑定 ${n("invite_bound")} → 首单 ${n("invite_task_bonus")} → 首充 ${n("invite_first_recharge")} → 返佣 ¥${(n("invite_rebate_cents") / 100).toFixed(2)}`,
        `分享意愿：/invite 被点击 ${n("invite_view")} 次　积分奖发出 ${n("invite_task_bonus") * REFERRAL_TASK_BONUS}`,
        `小说：生成 ${n("novel_turn")} 次　失败 ${n("novel_fail")} 次`,
        ``,
        `提示：/stats 2026-06-23 可看历史，保留 90 天`,
      ].join("\n")
    );
    return;
  }

  // /mode1../mode4 切换
  const m = cmd.match(/^\/(mode[1-5])$/);
  if (m) {
    const mode = await setMode(chatId, m[1]);
    await tgSend(chatId, modeSelectedText(mode));
  }
}

// 选定模式后的提示文案：单图模式（mode1/3/5）额外提示可在 caption 写自定义提示词
function modeSelectedText(mode) {
  const base = `✅ 已选择 ${mode.label}（消耗 ${mode.cost} 积分），发送一张模特图片即可开始。`;
  if (mode.twoImages) return base;
  if (mode.userPromptOnly) {
    return (
      base +
      "\n\n📝 全能模式必须在图片下方的「说明文字」里写提示词（完全由你的提示词决定效果，无默认）。\n例如：「全部去衣 保持人物比列不变，保持面部直接不变，中国女性; 巨乳，双手抓自己的胸部。」"
    );
  }
  return (
    base +
    "\n\n✏️ 小技巧：上传图片时可在「说明文字」里写补充提示词，会附加到默认提示词后。\n例如：「巨乳，阴部有很多毛」「巨乳，双手抓胸」等具体的描述词（不写也可以，按默认处理，但是胸通常会比较正常）"
  );
}

// =============================================
//  写小说：向导 + 会话 + 摘要压缩
// =============================================
const NOVEL_WIZARD_STEPS = ["style", "pov", "era", "character", "spice", "seed", "wordCount"];
const NOVEL_STEP_LABEL = {
  style: "文风",
  pov: "视角",
  era: "背景时代",
  character: "人物设定",
  spice: "性描写风格",
  seed: "开场情境",
  wordCount: "每章字数",
};

// 小说入口菜单键盘（三处共用）：预设 / 自由 [+ 教程外链]
// mode = "start"（新开）| "setup"（改设定），只是按钮文字略不同
function novelEntryKeyboard(mode = "start") {
  const rows = mode === "setup"
    ? [
        [{ text: "📋 走预设向导", callback_data: "novel_preset" }],
        [{ text: "✍️ 走自由模式", callback_data: "novel_free" }],
      ]
    : [
        [{ text: "📋 预设模式（引导 7 步）", callback_data: "novel_preset" }],
        [{ text: "✍️ 自由模式（自己写全部提示词）", callback_data: "novel_free" }],
      ];
  if (CONFIG.NOVEL_TUTORIAL_URL) {
    rows.push([{ text: "📖 查看使用教程", url: CONFIG.NOVEL_TUTORIAL_URL }]);
  }
  return { inline_keyboard: rows };
}

function novelPresetButtons(field) {
  const opts = NOVEL_PRESETS[field] || {};
  const rows = [];
  const entries = Object.entries(opts);
  for (let i = 0; i < entries.length; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, entries.length); j++) {
      const [key, cfg] = entries[j];
      row.push({ text: cfg.label, callback_data: `nvp:${field}:${key}` });
    }
    rows.push(row);
  }
  rows.push([{ text: "✏️ 自定义（自己写）", callback_data: `nvp:${field}:__custom__` }]);
  return { inline_keyboard: rows };
}

// 步骤提示文案（含"自由输入"步骤的引导）
function novelStepPrompt(step) {
  if (step === "style") return "🖋 第 1/7 步：选择【文风】";
  if (step === "pov") return "👁 第 2/7 步：选择【视角】";
  if (step === "era") return "🏛 第 3/7 步：选择【背景时代】";
  if (step === "character") {
    return [
      "👥 第 4/7 步：【人物设定】（自由输入）",
      "",
      "请写下所有角色的详细设定，越具体效果越好：",
      "",
      "📌 建议包含：",
      "• 姓名 / 称呼 / 外号",
      "• 年龄、身高、身材、外貌（发型、脸型、五官、胸/腰/臀）",
      "• 常见穿着、气质",
      "• 性格特点（如：外冷内热、傲娇、爱撒娇）",
      "• 你（主角）和她的关系（如：直属上司、大学学妹、隔壁人妻）",
      "• 特殊设定（如：不能被别人发现、她有男朋友但暗恋主角）",
      "",
      "可同时写多个角色（女主 + 女二 + 男主…），一段文字全部写进来即可。",
      "",
      "现在，请直接回复一段文字：",
    ].join("\n");
  }
  if (step === "spice") return "🔥 第 5/7 步:选择【性描写风格】";
  if (step === "seed") {
    return [
      "🎬 第 6/7 步：【开场情境】（自由输入）",
      "",
      "故事从哪一刻开始？描述得越具体，AI 越好接着写：",
      "",
      "📌 想想这几点（不必全答）：",
      "• 地点：办公室下班后 / 她家客厅 / 出差同一酒店房间 / …",
      "• 时间：周五加班的深夜 / 大雨困住的下午 / …",
      "• 触发事件：她突然请你帮忙 / 停电 / 无意撞见 / …",
      "• 此刻的氛围与紧张点：她穿着什么、你在想什么、下一秒可能发生什么",
      "",
      "现在，请直接回复一段文字：",
    ].join("\n");
  }
  if (step === "wordCount") {
    return [
      "📏 第 7/7 步：【每章字数】",
      "",
      "💡 推荐范围：",
      "• 1500–2500 字：节奏紧凑，方便碎片时间读",
      "• 2500–4000 字：情节 + 描写都能舒展开",
      "• 4000–5000 字：一次读到爽",
      "",
      `请直接回复一个数字（${NOVEL_MIN_WORDS}–${NOVEL_MAX_WORDS}）：`,
    ].join("\n");
  }
  return "";
}

async function novelWizardStart(chatId, mode) {
  // mode: "preset" 走 8 步；"free" 跳过 style/pov/era/spice/pace，只走 character/seed/wordCount
  await redis.del(K.novelActive(chatId));
  await redis.hmset(K.novelWizard(chatId), { step: mode === "free" ? "character" : "style", mode });
  await redis.expire(K.novelWizard(chatId), 3600); // 1h 内完成，否则失效
  const step = mode === "free" ? "character" : "style";
  await novelAskStep(chatId, step);
}

async function novelAskStep(chatId, step) {
  const isFreeInput = ["character", "seed", "wordCount"].includes(step);
  if (isFreeInput) {
    await tgSend(chatId, novelStepPrompt(step));
  } else {
    await tgSend(chatId, novelStepPrompt(step), { reply_markup: novelPresetButtons(step) });
  }
}

// 用户点了预设按钮或选了「自定义」
async function novelHandleWizardCallback(cb, field, key) {
  const chatId = cb.message.chat.id;
  const wizard = await redis.hgetall(K.novelWizard(chatId));
  if (!wizard.step) {
    await tgAnswerCallback(cb.id, "向导已过期，请重新 /novel");
    return;
  }
  if (wizard.step !== field) {
    await tgAnswerCallback(cb.id, "步骤已切换，请看最新提示");
    return;
  }
  if (key === "__custom__") {
    await tgAnswerCallback(cb.id, "请自由输入");
    await redis.hset(K.novelWizard(chatId), "awaitingCustom", field);
    const promptTail = {
      style: "描述你想要的文风（例：像某某作家、口语化、诗意化…）：",
      pov: "描述你想要的视角（例：第一人称男主但偶尔切到女主内心）：",
      era: "描述背景时代与场景（例：赛博朋克夜市、80年代北方小城…）：",
      spice: "描述你想要的性描写风格（例：直白但不粗俗、重心理描写…）：",
    }[field] || "请自由输入：";
    await tgSend(chatId, `✏️ 自定义【${NOVEL_STEP_LABEL[field]}】\n\n${promptTail}`);
    return;
  }
  const preset = NOVEL_PRESETS[field]?.[key];
  if (!preset) {
    await tgAnswerCallback(cb.id, "未知选项");
    return;
  }
  await redis.hmset(K.novelSetup(chatId), field, `preset:${key}`);
  await tgAnswerCallback(cb.id, `已选：${preset.label}`);
  await novelAdvance(chatId);
}

// 用户在自由输入步骤发来文字（含"自定义"分支）
async function novelHandleWizardText(chatId, text) {
  const wizard = await redis.hgetall(K.novelWizard(chatId));
  if (!wizard.step) return false;
  const step = wizard.step;
  const awaiting = wizard.awaitingCustom;

  // 分支 A：预设步骤下的"自定义"输入
  if (awaiting && ["style", "pov", "era", "spice"].includes(awaiting)) {
    if (text.length < 4 || text.length > 500) {
      await tgSend(chatId, `请写得再详细/简短一点（4–500 字内）。`);
      return true;
    }
    await redis.hmset(K.novelSetup(chatId), awaiting, `custom:${text}`);
    await redis.hdel(K.novelWizard(chatId), "awaitingCustom");
    await novelAdvance(chatId);
    return true;
  }

  // 分支 B：自由输入步骤
  if (step === "character") {
    if (text.length < 15) {
      await tgSend(chatId, "人物设定太短了，至少写 15 字。要包含姓名/外貌/关系/性格才够 AI 用～");
      return true;
    }
    if (text.length > 3000) {
      await tgSend(chatId, "人物设定太长了（<3000 字），可以精简后重发。");
      return true;
    }
    await redis.hmset(K.novelSetup(chatId), "character", text);
    await novelAdvance(chatId);
    return true;
  }
  if (step === "seed") {
    if (text.length < 10) {
      await tgSend(chatId, "开场情境太短了，至少写 10 字。");
      return true;
    }
    if (text.length > 2000) {
      await tgSend(chatId, "开场情境太长了（<2000 字），可以精简后重发。");
      return true;
    }
    await redis.hmset(K.novelSetup(chatId), "seed", text);
    await novelAdvance(chatId);
    return true;
  }
  if (step === "wordCount") {
    const n = parseInt(text.trim(), 10);
    if (!Number.isFinite(n) || n < NOVEL_MIN_WORDS || n > NOVEL_MAX_WORDS) {
      await tgSend(chatId, `请输入 ${NOVEL_MIN_WORDS}–${NOVEL_MAX_WORDS} 之间的整数。`);
      return true;
    }
    await redis.hmset(K.novelSetup(chatId), "wordCount", String(n));
    await novelAdvance(chatId);
    return true;
  }
  return false;
}

// 进入下一步（或收尾）
async function novelAdvance(chatId) {
  const wizard = await redis.hgetall(K.novelWizard(chatId));
  const mode = wizard.mode || "preset";
  const orderPreset = ["style", "pov", "era", "character", "spice", "seed", "wordCount"];
  const orderFree = ["character", "seed", "wordCount"];
  const order = mode === "free" ? orderFree : orderPreset;
  const idx = order.indexOf(wizard.step);
  if (idx < 0 || idx >= order.length - 1) {
    // 已到最后一步，向导完成
    await redis.del(K.novelWizard(chatId));
    await redis.set(K.novelActive(chatId), "1");
    // 清空之前历史（切换设定不影响 wordCount 之类）
    await redis.del(K.novelHistory(chatId));
    await redis.del(K.novelSummary(chatId));
    await tgSend(
      chatId,
      [
        "✅ 设定完成！第一章按你给的开场情境自动展开，我这就开始写…",
        "",
        "💡 每一章之前，请描述你希望本章发生什么，比如：",
        "  • 「本章让他们在办公室加班到深夜，她主动送咖啡时踢掉了高跟鞋」",
        "  • 「本章推进到卧室，先来一段口舌撩拨，别急着最后一步」",
        "  • 「本章切到第二天早上，两人假装无事，但她的领口有痕迹」",
        "  • 「继续」← 没想法时这样简写，AI 会顺着上一章的钩子自然推进",
        "",
        `每次生成扣 ${NOVEL_COST} 积分。/novel_end 退出，/novel_new 换一部，/novel_summary 看剧情摘要。`,
      ].join("\n")
    );
    // 用一个"开始写第一章"的初始 user turn 触发首章生成
    await runNovelTurn(chatId, "请开始为我写这部小说的第一章。").catch((e) => {
      console.error("首章生成失败：", e);
    });
    return;
  }
  const next = order[idx + 1];
  await redis.hmset(K.novelWizard(chatId), "step", next);
  await novelAskStep(chatId, next);
}

// 从 setup 里取某字段的实际 prompt（preset:xxx / custom:xxx / 空）
function resolveSetupField(setup, field) {
  const raw = setup[field] || "";
  if (raw.startsWith("preset:")) {
    return NOVEL_PRESETS[field]?.[raw.slice(7)]?.prompt || "";
  }
  if (raw.startsWith("custom:")) return raw.slice(7);
  return raw; // 自由输入字段（character / seed）无前缀
}

async function novelBuildMessages(chatId, userText) {
  const [setup, summary, historyRaw] = await Promise.all([
    redis.hgetall(K.novelSetup(chatId)),
    redis.get(K.novelSummary(chatId)),
    redis.lrange(K.novelHistory(chatId), -NOVEL_HISTORY_KEEP * 2, -1),
  ]);
  const sysParts = [
    "你是一位擅长中文成人小说创作的作家。所有人物均为成年人，均为虚构。你的任务是按用户设定与指令持续创作一部小说。",
  ];
  const sections = [
    ["文风", resolveSetupField(setup, "style")],
    ["视角", resolveSetupField(setup, "pov")],
    ["背景时代", resolveSetupField(setup, "era")],
    ["性描写风格", resolveSetupField(setup, "spice")],
  ];
  for (const [name, val] of sections) if (val) sysParts.push(`【${name}】${val}`);
  if (setup.character) sysParts.push(`【人物设定】\n${setup.character}`);
  if (setup.seed) sysParts.push(`【开场情境】\n${setup.seed}`);
  const wc = Number(setup.wordCount) || 2000;
  sysParts.push(`【每章字数】每次输出约 ${wc} 字（±20% 内可接受）；一次写完一章，结尾留有钩子但不要询问是否继续。`);
  if (summary) sysParts.push(`【已发生的剧情摘要】\n${summary}`);
  sysParts.push([
    "【写作纪律】",
    "- 保持人物姓名、外貌、关系的一致性",
    "- 不打招呼、不寒暄、不出戏，直接开始正文",
    "- 除非用户要求，否则不使用小标题",
    "- 节奏由用户主导：用户会在每一章生成前给出本章希望发生的情节；请严格贴合用户的本章指令推进，不要自作主张跳过或提前展开用户没要求的关键场面",
    "- 若用户本章指令留白（比如只说「继续」），就顺着上一章的钩子自然接下去，控制推进幅度，把决定权留给下一次用户输入",
  ].join("\n"));

  const messages = [{ role: "system", content: sysParts.join("\n\n") }];
  for (const raw of historyRaw) {
    try {
      messages.push(JSON.parse(raw));
    } catch (_) {}
  }
  messages.push({ role: "user", content: userText });
  return messages;
}

// 一次写作：扣积分 → 调 API → 存历史 → 触发摘要
async function runNovelTurn(chatId, userText) {
  // 忙锁：防用户狂点
  if ((await redis.set(K.novelBusy(chatId), "1", "EX", 120, "NX")) !== "OK") {
    await tgSend(chatId, "⏳ 上一段还在生成中，稍等一下～");
    return;
  }
  try {
    // 扣积分
    const bal = await spend(chatId, NOVEL_COST);
    if (bal < 0) {
      const cur = await getBalance(chatId);
      await tgSend(chatId, `积分不足～本次写作需要 ${NOVEL_COST} 积分，当前余额 ${cur}。发送 /balance 联系客服充值。`);
      return;
    }
    await tgSend(chatId, "✍️ 正在写作中，请稍等…");
    let assistantText;
    let messagesForArchive;
    try {
      messagesForArchive = await novelBuildMessages(chatId, userText);
      novelDebug(`REQUEST uid=${chatId} model=${CONFIG.DEEPSEEK_MODEL_MAIN}`, messagesForArchive);
      // 每次生成前把完整提示词归档到私有频道（fire-and-forget，失败不影响正文）
      archiveNovelPrompt(chatId, messagesForArchive, "turn");
      assistantText = await deepseekChat(CONFIG.DEEPSEEK_MODEL_MAIN, messagesForArchive, {
        maxTokens: Math.min(8000, Math.round((Number((await redis.hget(K.novelSetup(chatId), "wordCount")) || 2000)) * 3)),
        temperature: 0.95,
      });
      novelDebug(`RESPONSE uid=${chatId} (chars=${assistantText.length})`, assistantText);
    } catch (e) {
      await refund(chatId, NOVEL_COST);
      console.error("DeepSeek 失败：", e);
      const m = String(e.message || "");
      const nsfwHit = /content|safety|policy|refuse|reject/i.test(m);
      bumpStat("novel_fail").catch(() => {});
      await tgSend(
        chatId,
        nsfwHit
          ? `❌ 内容被 DeepSeek 拒绝（换个说法或调整设定后重试），已退还 ${NOVEL_COST} 积分。`
          : `❌ 写作出错（已退还 ${NOVEL_COST} 积分）：${m.slice(0, 200)}`
      );
      return;
    }
    // 存历史
    await redis.rpush(
      K.novelHistory(chatId),
      JSON.stringify({ role: "user", content: userText }),
      JSON.stringify({ role: "assistant", content: assistantText })
    );
    bumpStat("novel_turn").catch(() => {});
    // 分段发送（TG 单条 4096 字符上限）
    for (const chunk of splitForTelegram(assistantText)) {
      await tgSend(chatId, chunk);
    }
    // 触发摘要
    const len = await redis.llen(K.novelHistory(chatId));
    if (len >= NOVEL_SUMMARY_TRIGGER * 2) {
      novelCompressHistory(chatId).catch((e) => console.error("摘要压缩失败：", e.message));
    }
  } finally {
    await redis.del(K.novelBusy(chatId));
  }
}

// Telegram 单条消息上限 4096；给自己留点余量走 3800。
// 切分策略：优先在语义边界（段落 > 换行 > 中文句末标点 > 中文停顿标点）切，最后才硬切；
// 除段间空白外不吃任何字符；末尾自检确保正文字符总数不丢。
function splitForTelegram(text, limit = 3800) {
  if (!text) return [];
  const findCut = (s) => {
    const candidates = ["\n\n", "\n", "。", "！", "？", "，", "、", "；"];
    for (const sep of candidates) {
      const idx = s.lastIndexOf(sep, limit);
      if (idx >= Math.floor(limit / 2)) return idx + sep.length; // 含标点/换行本身
    }
    return limit; // 硬切
  };
  const out = [];
  let s = text;
  while (s.length > limit) {
    const cut = findCut(s);
    out.push(s.slice(0, cut));
    // 只削掉段间的空白（不吃标点、不吃字），头部改用带空白去除的正则
    s = s.slice(cut).replace(/^[\s　]+/, "");
  }
  if (s) out.push(s);
  // 完整性自检：正文非空白字符总数应完全一致
  const stripBlank = (t) => t.replace(/[\s　]/g, "");
  const before = stripBlank(text).length;
  const after = out.reduce((n, p) => n + stripBlank(p).length, 0);
  if (before !== after) {
    console.error(`[splitForTelegram] ⚠️ 字符丢失！原文 ${before} → 切后 ${after}，请检查`);
  }
  // 给分片打标：多片时头/尾标（续）/（未完）
  if (out.length > 1) {
    return out.map((p, i) => {
      const head = i === 0 ? "" : "（续）\n";
      const tail = i === out.length - 1 ? "" : "\n（未完）";
      return head + p + tail;
    });
  }
  return out;
}

// 把 history 前半段 + 旧 summary 压缩成新 summary，然后砍掉被压缩的部分
async function novelCompressHistory(chatId) {
  const historyRaw = await redis.lrange(K.novelHistory(chatId), 0, -1);
  if (historyRaw.length < NOVEL_SUMMARY_TRIGGER * 2) return;
  const oldSummary = (await redis.get(K.novelSummary(chatId))) || "";
  const setup = await redis.hgetall(K.novelSetup(chatId));
  const keepFrom = historyRaw.length - NOVEL_HISTORY_KEEP * 2;
  const toCompress = historyRaw.slice(0, keepFrom);
  const parsed = toCompress.map((r) => {
    try {
      return JSON.parse(r);
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
  const chatSlice = parsed.map((m) => `【${m.role === "user" ? "用户" : "小说"}】\n${m.content}`).join("\n\n---\n\n");
  const sys = "你是一个小说编辑助手。给定既有摘要和一段新的小说正文/用户指令，输出一份**升级后的剧情摘要**，控制在 800 字以内，覆盖：主要人物关键状态、关系进展、已发生的重要情节、伏笔与悬念。用简洁的第三人称叙述，不要评论、不要列表。";
  const usr = [
    `【原有剧情摘要（可能为空）】\n${oldSummary || "（无）"}`,
    `【新增内容（用户与小说交替）】\n${chatSlice}`,
    `【人物设定（供你保持人物一致）】\n${setup.character || "（无）"}`,
    "请输出升级后的剧情摘要（800 字以内）：",
  ].join("\n\n");
  const summaryMessages = [
    { role: "system", content: sys },
    { role: "user", content: usr },
  ];
  novelDebug(`COMPRESS_REQUEST model=${CONFIG.DEEPSEEK_MODEL_SUMMARY}`, summaryMessages);
  const summary = await deepseekChat(CONFIG.DEEPSEEK_MODEL_SUMMARY, summaryMessages, { maxTokens: 2000, temperature: 0.3 });
  novelDebug(`COMPRESS_RESPONSE (chars=${summary.length})`, summary);
  // 保存新摘要 + 砍历史
  await redis.set(K.novelSummary(chatId), summary);
  await redis.ltrim(K.novelHistory(chatId), keepFrom, -1);
  bumpStat("novel_compress").catch(() => {});
}

async function handleCallbackQuery(cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data;

  // 写小说向导按钮：nvp:<field>:<key>
  if (data.startsWith("nvp:")) {
    const [, field, key] = data.split(":");
    await novelHandleWizardCallback(cb, field, key);
    return;
  }
  // 菜单里的「📖 写小说」按钮 —— 复用 /novel 的入口逻辑
  if (data === "open_novel") {
    await tgAnswerCallback(cb.id, "");
    if (!CONFIG.DEEPSEEK_API_KEY) {
      await tgSend(chatId, "⚠️ 写小说功能尚未启用（管理员未配置 DEEPSEEK_API_KEY）。");
      return;
    }
    if (await redis.exists(K.novelActive(chatId))) {
      await tgSend(chatId, "📖 你已在小说会话中，直接发消息即可继续写作。发送 /novel 查看命令帮助。");
      return;
    }
    await tgSend(chatId, "📖 开始写一部成人小说\n\n请选择创作方式：", {
      reply_markup: novelEntryKeyboard("start"),
      disable_web_page_preview: true,
    });
    return;
  }
  // /novel 入口按钮
  if (data === "novel_preset") {
    await tgAnswerCallback(cb.id, "");
    await novelWizardStart(chatId, "preset");
    return;
  }
  if (data === "novel_free") {
    await tgAnswerCallback(cb.id, "");
    await novelWizardStart(chatId, "free");
    return;
  }

  if (data === "invite") {
    await tgAnswerCallback(cb.id, "");
    await runInvite(chatId);
    return;
  }
  if (data === "withdraw") {
    await tgAnswerCallback(cb.id, "");
    await runWithdraw(chatId);
    return;
  }

  const mode = await setMode(chatId, data);
  if (!mode) {
    await tgAnswerCallback(cb.id, "未知操作");
    return;
  }
  await tgAnswerCallback(cb.id, `已选择 ${mode.label}`);
  await tgSend(chatId, modeSelectedText(mode));
}

// =============================================
//  图片处理（按模式分流，含积分扣减）
// =============================================
function insufficientText(cost, balance) {
  return `积分不足～本次需要 ${cost} 积分，当前余额 ${balance}。\n发送 /checkin 每日签到领 1 积分，或发送 /balance 拿到用户ID联系客服充值。`;
}

// 处理失败时给用户的友好提示（不暴露第三方/OpenAI 细节，完整错误只在控制台日志）
function failureText(err, cost) {
  const m = String(err?.message || "");
  if (/safety|sexual|nsfw|rejected by the safety/i.test(m)) {
    return `❌ 图片过于暴露，请换一张图片（已退还 ${cost} 积分）。`;
  }
  return `❌ 处理失败，已退还 ${cost} 积分，请稍后重试。`;
}

async function handlePhotoMessage(message) {
  const chatId = message.chat.id;
  const fileId = message.photo[message.photo.length - 1].file_id;
  const userCaption = String(message.caption || "").trim(); // 用户随图发送的提示词
  const modeKey = await getMode(chatId);
  const mode = MODES[modeKey];
  markActive(chatId).catch(() => {});
  if (await ensureNewUserBonus(chatId).catch(() => false)) {
    await tgSend(chatId, `🎁 新人礼：已赠送 ${NEW_USER_BONUS} 积分，可直接开始体验～`);
  }

  if (mode.twoImages) {
    await handleTwoImageMode(chatId, fileId, modeKey, mode);
  } else {
    await handleSingleImageMode(chatId, fileId, modeKey, mode, userCaption);
  }
}

// 排队提示（并发已满时）
async function maybeNotifyQueue(chatId) {
  if (limiter.atCapacity) {
    await tgSend(chatId, `🕐 当前任务较多，已排队（前面约 ${limiter.queued} 个），请稍候～`);
  }
}

async function handleSingleImageMode(chatId, fileId, modeKey, mode, userCaption = "") {
  // 全能模式必须有 caption（前置校验，不上锁、不扣分）
  const extra = userCaption.slice(0, 300).trim();
  if (mode.userPromptOnly && !extra) {
    await tgSend(
      chatId,
      "📝 全能模式需要你在图片下方的「说明文字」里写提示词哦～\n例如：「让她穿一条红色比基尼，背景换成沙滩」\n请重新发送图片并附上提示词。"
    );
    return;
  }
  // 原子上锁：同一用户同时仅一个进行中任务（避免排队期间重复下单/重复扣分）
  if ((await redis.set(K.busy(chatId), "1", "EX", BUSY_TTL, "NX")) !== "OK") {
    await tgSend(chatId, "⏳ 你有一个任务正在处理中，完成后再发下一张哦～");
    return;
  }
  // 原子扣费
  const balance = await spend(chatId, mode.cost);
  if (balance < 0) {
    await redis.del(K.busy(chatId));
    await tgSend(chatId, insufficientText(mode.cost, await getBalance(chatId)));
    return;
  }
  // 最终 prompt：全能模式直接用用户输入；其它模式 = 默认 + 用户附加（逗号分隔）
  const finalPrompt = mode.userPromptOnly
    ? extra
    : (extra ? `${mode.prompt}，${extra}` : mode.prompt);
  let submitted = false;
  try {
    let intro;
    if (mode.userPromptOnly) {
      intro = `⏳ 收到图片（${mode.label}），使用你的提示词：${extra}\n正在处理...`;
    } else if (extra) {
      intro = `⏳ 收到图片（${mode.label}），已附加你的提示词：${extra}\n正在处理...`;
    } else {
      intro = `⏳ 收到图片（${mode.label}），正在处理...`;
    }
    await tgSend(chatId, intro);
    await maybeNotifyQueue(chatId);
    await limiter.run(async () => {
      const imageFileName = await prepareRhImage(chatId, fileId, mode.useGpt, `mode=${modeKey}`, finalPrompt);
      await submitAndTrack(chatId, modeKey, buildOldNodes(imageFileName, finalPrompt), mode.cost);
      submitted = true;
    });
  } catch (err) {
    if (!submitted) {
      await refund(chatId, mode.cost);
      await redis.del(K.busy(chatId)); // 未提交则解锁
      logPresubmitFail(err, mode.cost);
    }
    console.error(`[${chatId}] 处理失败：`, err);
    await tgSend(chatId, failureText(err, mode.cost));
    return;
  }
  await tgSend(chatId, "正在跑任务（约需数分钟）...");
}

// 提交 RunningHub 之前就失败（多为 GPT 扩图被审核拦截），单独计入统计
function logPresubmitFail(err, cost) {
  bumpStat("task_fail_presubmit").catch(() => {});
  bumpStat("credits_refund", cost).catch(() => {});
  if (/safety|sexual|nsfw|rejected by the safety/i.test(String(err?.message || ""))) {
    bumpStat("task_fail_presubmit_nsfw").catch(() => {});
  }
}

async function handleTwoImageMode(chatId, fileId, modeKey, mode) {
  const pendingFileId = await redis.get(K.pending(chatId));

  if (!pendingFileId) {
    // 第一张模特图：若已有任务在跑则拒绝；否则查余额、只记 fileId、立刻让发衣服图
    if (await redis.exists(K.busy(chatId))) {
      await tgSend(chatId, "⏳ 你有一个任务正在处理中，完成后再发哦～");
      return;
    }
    const balance = await getBalance(chatId);
    if (balance < mode.cost) {
      await tgSend(chatId, insufficientText(mode.cost, balance));
      return;
    }
    await redis.set(K.pending(chatId), fileId, "EX", 3600);
    await tgSend(
      chatId,
      "✅ 模特图已收到，请再发送一张【衣服图】👕\n\n💡 小提示：服装图片的角度/构图最好和人物图保持接近，效果会更好～"
    );
    return;
  }

  // 第二张衣服图：原子上锁 + 扣费后处理
  if ((await redis.set(K.busy(chatId), "1", "EX", BUSY_TTL, "NX")) !== "OK") {
    await tgSend(chatId, "⏳ 你有一个任务正在处理中，完成后再发哦～");
    return;
  }
  const balance = await spend(chatId, mode.cost);
  if (balance < 0) {
    await redis.del(K.busy(chatId));
    await redis.del(K.pending(chatId));
    await tgSend(chatId, insufficientText(mode.cost, await getBalance(chatId)));
    return;
  }
  await redis.del(K.pending(chatId));
  let submitted = false;
  try {
    await tgSend(chatId, "✅ 衣服图已收到，开始处理...");
    await maybeNotifyQueue(chatId);
    await limiter.run(async () => {
      const modelFileName = await prepareRhImage(chatId, pendingFileId, mode.useGpt, `mode=${modeKey}`);
      const clothingFileName = await prepareRhImage(chatId, fileId, false); // 衣服图不归档

      await submitAndTrack(chatId, modeKey, buildNewNodes(modelFileName, clothingFileName), mode.cost);
      submitted = true;
    });
  } catch (err) {
    if (!submitted) {
      await refund(chatId, mode.cost);
      await redis.del(K.busy(chatId));
      logPresubmitFail(err, mode.cost);
    }
    console.error(`[${chatId}] 处理失败：`, err);
    await tgSend(chatId, failureText(err, mode.cost));
    return;
  }
  await tgSend(chatId, "正在跑任务（约需数分钟）...");
}

// =============================================
//  Telegram getUpdates 长轮询（一期）
// =============================================
let offset = 0;
// 非命令的普通文字消息：优先处理小说向导 / 小说会话
async function handleTextMessage(message) {
  const chatId = message.chat.id;
  const text = message.text || "";
  markActive(chatId).catch(() => {});

  // 向导中的自由输入 / 自定义
  if (await redis.exists(K.novelWizard(chatId))) {
    const handled = await novelHandleWizardText(chatId, text.trim());
    if (handled) return;
  }
  // 会话中的正常写作
  if (await redis.exists(K.novelActive(chatId))) {
    await runNovelTurn(chatId, text.trim());
    return;
  }
  // 其它：静默忽略（避免打扰用户），除非用户明确以 / 开头
}

async function pollUpdates() {
  try {
    const res = await telegramRequest("getUpdates", { offset, timeout: 30 });
    if (res.result?.length) {
      for (const update of res.result) {
        offset = update.update_id + 1;
        if (update.callback_query) {
          handleCallbackQuery(update.callback_query).catch((e) => console.error("按钮处理出错：", e));
          continue;
        }
        const message = update.message;
        if (message?.photo) {
          handlePhotoMessage(message).catch((e) => console.error("图片处理出错：", e));
        } else if (message?.text?.startsWith("/")) {
          handleCommand(message).catch((e) => console.error("命令处理出错：", e));
        } else if (message?.text) {
          handleTextMessage(message).catch((e) => console.error("文字消息处理出错：", e));
        }
      }
    }
  } catch (err) {
    console.error("轮询出错：", err.message);
  }
  setTimeout(pollUpdates, 1000);
}

// =============================================
//  兜底对账：扫描超时未回调的任务，主动查一次
// =============================================
const RECONCILE_AFTER_MS = 15 * 1000; // 提交超过 15 秒还没收尾就主动查（webhook 不通时的快速兜底）
const TASK_MAX_AGE_MS = 20 * 60 * 1000; // 超过 20 分钟仍未终态则放弃（停止查询，busy 锁已自动过期）

async function reconcile() {
  const now = Date.now();
  // 只遍历内存索引；为空时此函数不发起任何 Redis/网络请求
  for (const [taskId, submittedAt] of [...inflight.entries()]) {
    if (now - submittedAt < RECONCILE_AFTER_MS) continue;
    if (now - submittedAt > TASK_MAX_AGE_MS) {
      console.warn(`reconcile: 任务超时放弃查询 taskId=${taskId}`);
      inflight.delete(taskId);
      continue;
    }
    try {
      const norm = normalizeResult(await rhQueryTask(taskId)); // 查 RunningHub，不消耗 Upstash
      if (norm.status === "SUCCESS" || ["FAILED", "ERROR", "FAIL"].includes(norm.status)) {
        console.log(`reconcile: 补收尾 taskId=${taskId} status=${norm.status}`);
        await finalizeTask(taskId, norm);
      }
    } catch (e) {
      console.error(`reconcile 查询失败 taskId=${taskId}:`, e.message);
    }
  }
}

// 启动时从 Redis 重建内存索引（一次性 SCAN，应对重启后仍在跑的任务）
async function rebuildInflight() {
  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "task:*", "COUNT", 100);
      cursor = next;
      for (const key of keys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        inflight.set(key.slice("task:".length), JSON.parse(raw).submittedAt);
      }
    } while (cursor !== "0");
    console.log(`恢复在跑任务 ${inflight.size} 个`);
  } catch (e) {
    console.error("rebuildInflight 出错：", e.message);
  }
}

// =============================================
//  HTTP 服务（RunningHub webhook + 健康检查）
// =============================================
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/rh-webhook/:secret", async (req, res) => {
  console.log("📩 webhook 被访问 /rh-webhook，secret 匹配:", req.params.secret === CONFIG.WEBHOOK_SECRET);
  if (req.params.secret !== CONFIG.WEBHOOK_SECRET) {
    return res.status(403).json({ ok: false });
  }
  // 立刻回 200，避免 RunningHub 因处理耗时而重试
  res.json({ ok: true });

  try {
    const payload = req.body || {};
    const taskId = String(payload?.eventData?.taskId ?? payload?.taskId ?? "");
    if (!taskId) return console.warn("webhook 无 taskId：", JSON.stringify(payload).slice(0, 200));
    const norm = normalizeResult(payload);
    console.log(`webhook 收到 taskId=${taskId} status=${norm.status}`);
    await finalizeTask(taskId, norm);
  } catch (e) {
    console.error("webhook 处理出错：", e);
  }
});

// =============================================
//  启动
// =============================================
process.on("unhandledRejection", (e) => {
  console.error("未处理的 rejection：", e);
  notifyAdmin(`未处理的 rejection：${e?.message || e}`);
});
process.on("uncaughtException", (e) => {
  console.error("未捕获的异常：", e);
  notifyAdmin(`未捕获的异常：${e?.message || e}`);
});

async function main() {
  assertConfig();
  if (CONFIG.UNLIMITED_CREDITS) {
    console.warn("\n" + "!".repeat(60));
    console.warn("!!  UNLIMITED_CREDITS=1  所有扣分/退分操作已禁用");
    console.warn("!!  仅限本地调试；生产环境请务必移除此环境变量！");
    console.warn("!".repeat(60) + "\n");
  }
  if (CONFIG.NOVEL_DEBUG) console.log("🐞 NOVEL_DEBUG=1，将在控制台打印 /novel 请求/响应细节");
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

  app.listen(CONFIG.PORT, () => {
    console.log(`🌐 HTTP 服务已启动: 端口 ${CONFIG.PORT}`);
    console.log(`   RunningHub webhook: ${webhookUrl()}`);
  });

  await rebuildInflight(); // 重启后恢复在跑任务
  setInterval(reconcile, 10 * 1000); // 每 10 秒对账一次（空闲时不消耗 Upstash）
  console.log("🤖 Bot 启动，等待用户发图...");
  pollUpdates();
}

main();
