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

  // GPT 全身图提示词
  GPT_MODEL: "gpt-image-2",
  GPT_PROMPT:
    "基于该背景扩展，生成全身照；图片人物是一个不知名的成年女性；人物不一定需要站着，也可以坐着，你寻一个最合适的姿势；不要修改人物的五官、长相、妆容、头部角度、脸部角度、脸部光影；服装是白色T恤和牛仔短裤,赤脚；如果她没戴帽子，不要给她戴帽子",
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
};
const DEFAULT_MODE = "mode1";

// 充值/客服
const CS_LINK = "https://t.me/Joiuto";
const CREDITS_PER_YUAN = 4; // 1 元 = 4 积分
const MIN_RECHARGE_YUAN = 10; // 最低 10 元起充
const NEW_USER_BONUS = 2; // 新用户首次进入赠送积分

// /help 使用说明
const HELP_TEXT = [
  "🤖 使用帮助",
  "",
  "本机器人可对你发送的人物图片进行 AI 处理（脱衣 / 换衣）。",
  "",
  "📋 四种模式（括号内为消耗积分）",
  `• /mode1 ${MODES.mode1.label}（${MODES.mode1.cost} 积分）`,
  `• /mode2 ${MODES.mode2.label}（${MODES.mode2.cost} 积分）— 需要两张图`,
  `• /mode3 ${MODES.mode3.label}（${MODES.mode3.cost} 积分）— 先扩成全身图再处理`,
  `• /mode4 ${MODES.mode4.label}（${MODES.mode4.cost} 积分）— 需要两张图，先扩全身图`,
  "",
  "🔍 「直接」和「扩图」怎么选",
  "• 直接：就按你发的原图处理，画面范围不变——不管全身、半身还是上半身，只想处理图里现有的部分，就用直接（更快、更省积分）。",
  "• 扩图：只有当你发的是头像 / 半身 / 上半身，但希望得到全身效果时才用——AI 会先把缺的身体补成全身照，再处理。",
  "👉 一句话：想要全身、但原图不全 → 用扩图；其它情况（包括只想处理半身）→ 用直接。",
  "",
  "🪄 怎么用",
  "1️⃣ 发送 /mode 选择模式，或直接发 /mode1～/mode4",
  "2️⃣ 直接发送图片：",
  "　• 脱衣类（mode1/3）：发 1 张人物图即可",
  "　• 换衣类（mode2/4）：先发【模特图】，再发【衣服图】👕",
  "3️⃣ 等待约数分钟，结果会自动发回给你",
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
  "/start 开始 ｜ /mode 选模式 ｜ /checkin 签到 ｜ /balance 余额 ｜ /help 帮助",
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
async function spend(id, cost) {
  const res = await redis.eval(SPEND_LUA, 1, K.credits(id), cost);
  return Number(res);
}
async function refund(id, cost) {
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
async function prepareRhImage(chatId, fileId, useGpt, archiveTag) {
  const localPath = await downloadTelegramPhoto(chatId, fileId);
  try {
    const original = fs.readFileSync(localPath);
    if (archiveTag) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      archiveImage(
        original,
        `input_${chatId}_${ts}.jpg`,
        `[input] uid=${chatId} ${archiveTag} time=${ts}`
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
      ],
    },
  });
}

async function handleCommand(message) {
  const chatId = message.chat.id;
  const cmd = message.text.trim().split(/\s+/)[0].replace(/@.*$/, "");
  const args = message.text.trim().split(/\s+/).slice(1);
  markActive(chatId).catch(() => {});
  const isNew = await ensureNewUserBonus(chatId).catch(() => false);

  if (cmd === "/start") {
    const welcome = isNew
      ? `👋 欢迎使用！已赠送 ${NEW_USER_BONUS} 积分新人礼 🎁\n\n发送 /help 查看完整使用说明；\n每天发送 /checkin 签到可领 1 积分。\n\n下面选择模式，然后发送图片即可开始：`
      : "👋 欢迎使用！\n\n发送 /help 查看完整使用说明；\n每天发送 /checkin 签到可领 1 积分。\n\n下面选择模式，然后发送图片即可开始：";
    await tgSend(chatId, welcome);
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
    const { checked, balance } = await checkin(chatId);
    await tgSend(
      chatId,
      checked
        ? `✅ 签到成功，+1 积分！当前余额：${balance}`
        : `📅 今天已经签到过啦～当前余额：${balance}`
    );
    return;
  }

  if (cmd === "/balance") {
    const balance = await getBalance(chatId);
    await tgSend(
      chatId,
      `💎 当前积分：${balance}\n🆔 你的用户ID：${chatId}\n\n积分不足可发送 /checkin 每日签到，或把上面的用户ID发给客服充值。`
    );
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
        ``,
        `提示：/stats 2026-06-23 可看历史，保留 90 天`,
      ].join("\n")
    );
    return;
  }

  // /mode1../mode4 切换
  const m = cmd.match(/^\/(mode[1-4])$/);
  if (m) {
    const mode = await setMode(chatId, m[1]);
    await tgSend(chatId, `✅ 已选择 ${mode.label}（消耗 ${mode.cost} 积分），发送一张模特图片即可开始。`);
  }
}

async function handleCallbackQuery(cb) {
  const chatId = cb.message.chat.id;
  const mode = await setMode(chatId, cb.data);
  if (!mode) {
    await tgAnswerCallback(cb.id, "未知模式");
    return;
  }
  await tgAnswerCallback(cb.id, `已选择 ${mode.label}`);
  await tgSend(chatId, `✅ 已选择 ${mode.label}（消耗 ${mode.cost} 积分），发送一张模特图片即可开始。`);
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
  const modeKey = await getMode(chatId);
  const mode = MODES[modeKey];
  markActive(chatId).catch(() => {});
  if (await ensureNewUserBonus(chatId).catch(() => false)) {
    await tgSend(chatId, `🎁 新人礼：已赠送 ${NEW_USER_BONUS} 积分，可直接开始体验～`);
  }

  if (mode.twoImages) {
    await handleTwoImageMode(chatId, fileId, modeKey, mode);
  } else {
    await handleSingleImageMode(chatId, fileId, modeKey, mode);
  }
}

// 排队提示（并发已满时）
async function maybeNotifyQueue(chatId) {
  if (limiter.atCapacity) {
    await tgSend(chatId, `🕐 当前任务较多，已排队（前面约 ${limiter.queued} 个），请稍候～`);
  }
}

async function handleSingleImageMode(chatId, fileId, modeKey, mode) {
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
  let submitted = false;
  try {
    await tgSend(chatId, `⏳ 收到图片（${mode.label}），正在处理...`);
    await maybeNotifyQueue(chatId);
    await limiter.run(async () => {
      const imageFileName = await prepareRhImage(chatId, fileId, mode.useGpt, `mode=${modeKey}`);
      await submitAndTrack(chatId, modeKey, buildOldNodes(imageFileName, mode.prompt), mode.cost);
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
