// =============================================
//  独立脚本：用机器人向频道发一条「图片 + 文案 + 跳转按钮」的消息（单图版）
//
//  单图版改用 sendPhoto：caption 和 inline_keyboard 可同条携带，
//  整条消息合一发出，不需要再拆「图+按钮」两条。
//
//  用法：
//    node post-to-channel.js
//    node post-to-channel.js "自定义消息文本"
//    node post-to-channel.js "文案" ./3.jpg
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
//    IMAGE          图片路径，默认 ./3.jpg
//
//  前置条件：机器人需为频道管理员且有「发送消息」权限。
// =============================================

const fs = require("fs");
const path = require("path");
const https = require("https");
const FormData = require("form-data");

const BOT_TOKEN = process.env.BOT_TOKEN || "8976964648:AAFbQ1zFkiM8JzUnNAXUzHitwHvxVJW-hrk";
const CHANNEL_ID = process.env.CHANNEL_ID || "-1003845568377,";
const BOT_USERNAME = (process.env.BOT_USERNAME || "@ai_ym_lyf_bot").replace(/^@/, "");
const START_PARAM = process.env.START_PARAM || "";
const BUTTON_TEXT = process.env.BUTTON_TEXT || "🤖 进入机器人";
const DEFAULT_MESSAGE = process.env.MESSAGE_TEXT ||
  ` 新增 全能模式！ 你的暗恋对象、女老师、女领导、女同事，
    只要输入提示词，你可以让她们摆出各种骚样！
    点下方按钮直接私聊机器人
    🎁 新人立刻送 2 积分，今晚就能爽到了～
`;

const args = process.argv.slice(2);
const messageText = args[0] || DEFAULT_MESSAGE;
const image = args[1] || process.env.IMAGE || "./3.jpg";

function assertConfig() {
  const missing = [];
  if (!BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!CHANNEL_ID) missing.push("CHANNEL_ID");
  if (!BOT_USERNAME) missing.push("BOT_USERNAME");
  if (missing.length) {
    console.error("❌ 缺少环境变量：", missing.join(", "));
    process.exit(1);
  }
  if (!fs.existsSync(image)) {
    console.error(`❌ 找不到图片文件：${image}`);
    process.exit(1);
  }
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

function buildBotUrl() {
  const base = `https://t.me/${BOT_USERNAME}`;
  return START_PARAM ? `${base}?start=${encodeURIComponent(START_PARAM)}` : base;
}

async function sendPhotoWithCaptionAndButton(chatId, photoPath, caption, buttonText, url) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", fs.createReadStream(photoPath), {
    filename: path.basename(photoPath),
    contentType: "image/jpeg",
  });
  if (caption) form.append("caption", caption);
  form.append("reply_markup", JSON.stringify({
    inline_keyboard: [[{ text: buttonText, url }]],
  }));
  return tgRequestForm("sendPhoto", form);
}

async function main() {
  assertConfig();
  const url = buildBotUrl();
  const res = await sendPhotoWithCaptionAndButton(CHANNEL_ID, image, messageText, BUTTON_TEXT, url);
  if (!res.ok) {
    console.error("❌ 发送失败：", JSON.stringify(res));
    process.exit(1);
  }
  console.log(`✅ 已发送，message_id=${res.result.message_id}`);
  console.log(`   图片：${image}`);
  console.log(`   按钮链接：${url}`);
}

main().catch((e) => {
  console.error("❌ 出错：", e);
  process.exit(1);
});
