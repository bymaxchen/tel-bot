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
  `TG机器人小说模式上线！把女神变成你的专属女人正文：你的TG机器人全新小说模式来了！  想让杨幂、迪丽热巴、杨颖、网红、以及你的任意女神彻底属于你吗？
输入名字 + 剧情需求，就能生成完整小说。  支持多种风格：  甜宠、霸总  
纯爱、NTR  
母猪调教（极致堕落）  
其他任意玩法

从温柔占有到彻底把她调教成发情母猪，随你选择。
让现实中的女神，在你的故事里跪下、臣服、变成只属于你的性奴。  快来试试吧，输入任意女神名字开启你的专属小说～
示例：
杨幂跪在地上，肥美的屁股高高拱起，骚穴正被你狠狠撞击。
「主人♡ 幂奴是您的骚母猪♡」她翻着白眼，口水直流，哭着扭腰猛摇，「求求您……把幂奴的子宫操坏吧♡ 让幂奴彻底变成只会喷水的肉便器母猪啊啊啊♡♡♡！」
    🎁 新人立刻送 2 积分，今晚就能爽到了～
`;

const args = process.argv.slice(2);
const messageText = args[0] || DEFAULT_MESSAGE;
const image = args[1] || process.env.IMAGE || "./3.png";

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
