// =============================================
//  独立脚本：用机器人向频道发一条「两张图 + 文案 + 跳转按钮」的消息
//
//  Telegram 限制：媒体组（sendMediaGroup）不支持 inline_keyboard，
//  所以拆成两条相邻消息：① 两张图 + 文案；② 一条独立的「进入机器人」按钮。
//  视觉上仍然是连续的一块内容，按钮就在最底部。
//
//  用法：
//    node post-to-channel.js
//    node post-to-channel.js "自定义消息文本"
//    node post-to-channel.js "文案" ./a.jpg ./b.jpg
//
//  必需环境变量：
//    BOT_TOKEN      机器人 token
//    CHANNEL_ID     @your_channel 或 -100xxxxxxxxxx
//    BOT_USERNAME   机器人用户名（不带 @），用于拼跳转链接
//
//  可选环境变量：
//    START_PARAM    跳转后自动发送 /start <值>
//    BUTTON_TEXT    按钮文字，默认「🤖 进入机器人」
//    MESSAGE_TEXT   消息文案（命令行参数优先）
//    IMAGE_1        第一张图路径，默认 ./1.jpg
//    IMAGE_2        第二张图路径，默认 ./2.jpg
//    BUTTON_HINT    按钮上方的提示文字，默认「👇 点下方按钮立即体验」
//
//  前置条件：机器人需为频道管理员且有「发送消息」权限。
// =============================================

const fs = require("fs");
const path = require("path");
const https = require("https");
const FormData = require("form-data");

const BOT_TOKEN = process.env.BOT_TOKEN || "8976964648:AAF70Jh_dL6R67yzIvX7YsJ8HEdfiAXlQeg";
const CHANNEL_ID = process.env.CHANNEL_ID || "-1003845568377,";
const BOT_USERNAME = (process.env.BOT_USERNAME || "@ai_ym_lyf_bot").replace(/^@/, "");
const START_PARAM = process.env.START_PARAM || "";
const BUTTON_TEXT = process.env.BUTTON_TEXT || "🤖 进入机器人";
const BUTTON_HINT = process.env.BUTTON_HINT || "👇 点下方按钮立即体验";
const DEFAULT_MESSAGE = process.env.MESSAGE_TEXT ||
  ` 想把你意淫的学姐/女上司/女同事脱光吗？
    上传她的照片，AI 瞬间帮你换上最骚的尺度～
    从清纯校服、情趣内衣到赤身裸体，随你玩！
    点下方按钮直接私聊机器人
    🎁 新人立刻送 2 积分，今晚就能爽到了～
`;

const args = process.argv.slice(2);
const messageText = args[0] || DEFAULT_MESSAGE;
const image1 = args[1] || process.env.IMAGE_1 || "./1.jpg";
const image2 = args[2] || process.env.IMAGE_2 || "./2.jpg";

function assertConfig() {
  const missing = [];
  if (!BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!CHANNEL_ID) missing.push("CHANNEL_ID");
  if (!BOT_USERNAME) missing.push("BOT_USERNAME");
  if (missing.length) {
    console.error("❌ 缺少环境变量：", missing.join(", "));
    process.exit(1);
  }
  for (const p of [image1, image2]) {
    if (!fs.existsSync(p)) {
      console.error(`❌ 找不到图片文件：${p}`);
      process.exit(1);
    }
  }
}

function tgRequestJson(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`响应非 JSON (HTTP ${res.statusCode}): ${data.slice(0, 200)}`)); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function tgRequestForm(method, form) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/${method}`,
        method: "POST",
        headers: form.getHeaders(),
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`响应非 JSON (HTTP ${res.statusCode}): ${data.slice(0, 200)}`)); }
        });
      }
    );
    req.on("error", reject);
    form.pipe(req);
  });
}

async function sendMediaGroupWithCaption(chatId, photoPaths, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  const media = photoPaths.map((p, i) => {
    const item = { type: "photo", media: `attach://photo${i}` };
    if (i === 0 && caption) item.caption = caption;
    return item;
  });
  form.append("media", JSON.stringify(media));
  photoPaths.forEach((p, i) => {
    form.append(`photo${i}`, fs.createReadStream(p), {
      filename: path.basename(p),
      contentType: "image/jpeg",
    });
  });
  return tgRequestForm("sendMediaGroup", form);
}

function buildBotUrl() {
  const base = `https://t.me/${BOT_USERNAME}`;
  return START_PARAM ? `${base}?start=${encodeURIComponent(START_PARAM)}` : base;
}

async function main() {
  assertConfig();

  // ① 两张图 + 文案
  const mgRes = await sendMediaGroupWithCaption(CHANNEL_ID, [image1, image2], messageText);
  if (!mgRes.ok) {
    console.error("❌ 媒体组发送失败：", JSON.stringify(mgRes));
    process.exit(1);
  }
  const firstId = mgRes.result?.[0]?.message_id;
  console.log(`✅ 媒体组已发送，首条 message_id=${firstId}`);

  // ② 紧跟一条带按钮的消息
  const url = buildBotUrl();
  const btnRes = await tgRequestJson("sendMessage", {
    chat_id: CHANNEL_ID,
    text: BUTTON_HINT,
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: BUTTON_TEXT, url }]],
    },
  });
  if (!btnRes.ok) {
    console.error("❌ 按钮消息发送失败：", JSON.stringify(btnRes));
    process.exit(1);
  }
  console.log(`✅ 按钮消息已发送，message_id=${btnRes.result.message_id}`);
  console.log(`   按钮链接：${url}`);
}

main().catch((e) => {
  console.error("❌ 出错：", e);
  process.exit(1);
});
