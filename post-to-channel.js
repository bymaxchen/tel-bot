// =============================================
//  独立脚本：用机器人向频道发一条带按钮的消息
//  按钮点击后跳转到机器人聊天界面（可带 /start 参数）
//
//  用法：
//    node post-to-channel.js
//    node post-to-channel.js "自定义消息文本"
//
//  必需环境变量：
//    BOT_TOKEN      机器人 token（与主程序同一个）
//    CHANNEL_ID     频道标识：@your_channel 或 -100xxxxxxxxxx
//    BOT_USERNAME   机器人用户名（不带 @），用于拼跳转链接
//
//  可选环境变量：
//    START_PARAM    跳转后自动发送 /start <值>，用于追踪来源，留空则普通打开
//    BUTTON_TEXT    按钮文字，默认「🤖 进入机器人」
//    MESSAGE_TEXT   消息正文，命令行参数优先于此
//
//  前置条件：把机器人加为频道管理员，并允许「发送消息」权限。
// =============================================

const https = require("https");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, "");
const START_PARAM = process.env.START_PARAM || "";
const BUTTON_TEXT = process.env.BUTTON_TEXT || "🤖 进入机器人";
const DEFAULT_MESSAGE = process.env.MESSAGE_TEXT ||
  "👋 想试试 AI 换衣 / 脱衣？点下面按钮直接和机器人聊天，新人有 2 积分赠送～";

const messageText = process.argv[2] || DEFAULT_MESSAGE;

function assertConfig() {
  const missing = [];
  if (!BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!CHANNEL_ID) missing.push("CHANNEL_ID");
  if (!BOT_USERNAME) missing.push("BOT_USERNAME");
  if (missing.length) {
    console.error("❌ 缺少环境变量：", missing.join(", "));
    process.exit(1);
  }
}

function telegramRequest(method, params) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(params);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`响应非 JSON (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

function buildBotUrl() {
  const base = `https://t.me/${BOT_USERNAME}`;
  return START_PARAM ? `${base}?start=${encodeURIComponent(START_PARAM)}` : base;
}

async function main() {
  assertConfig();
  const url = buildBotUrl();
  const res = await telegramRequest("sendMessage", {
    chat_id: CHANNEL_ID,
    text: messageText,
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: BUTTON_TEXT, url }]],
    },
  });
  if (!res.ok) {
    console.error("❌ 发送失败：", JSON.stringify(res));
    process.exit(1);
  }
  console.log(`✅ 已发送到 ${CHANNEL_ID}，message_id=${res.result.message_id}`);
  console.log(`   按钮链接：${url}`);
}

main().catch((e) => {
  console.error("❌ 出错：", e);
  process.exit(1);
});
