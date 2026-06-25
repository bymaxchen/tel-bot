# 部署到 Railway（一期）

## 0. 前置
- 入口文件：`server.js`（生产版）。本文件夹（tel-bot）即完整的部署目录，已不含旧的 `app.js`。
- 在本文件夹内执行 git 操作（仓库根 = tel-bot）。

## 1. 推送代码到 Git
```bash
# 在 tel-bot 文件夹内执行
git init
git add .
git commit -m "telegram rh bot - 生产版一期"
# 推到你的 GitHub 仓库
```
确认 `.env`、`keys.local.txt`、`node_modules/`、`tmp/` 没被提交（已在 .gitignore）。

## 2. Railway 建项目
1. railway.app → New Project → Deploy from GitHub repo，选你的仓库。
2. Railway 会自动识别 Node，用 `npm install` + `npm start` 启动。

## 3. 加 Redis
- 项目里 New → Database → Add Redis。
- Railway 会自动注入 `REDIS_URL` 到服务环境变量（server.js 已读取它）。

## 4. 配环境变量（Service → Variables）
照 `keys.local.txt` 填密钥，其余照下表：

| 变量 | 值 |
|------|----|
| BOT_TOKEN | 见 keys.local.txt |
| OPENAI_API_KEY | 见 keys.local.txt |
| RH_API_KEY | 见 keys.local.txt |
| RH_API_BASE | https://www.runninghub.cn |
| PUBLIC_URL | 见第 5 步拿到的域名 |
| WEBHOOK_SECRET | 自己生成一段随机串（如 `openssl rand -hex 16`） |
| ADMIN_IDS | 你的 Telegram 用户ID（多个逗号分隔） |

注：`REDIS_URL` 由 Redis 自动注入；`PORT` 由 Railway 自动注入，不用手填。

## 5. 拿公网域名
- Service → Settings → Networking → Generate Domain，得到形如 `https://xxx.up.railway.app`。
- 把它填回 `PUBLIC_URL` 变量，然后 Redeploy。
- RunningHub 回调地址会自动变成 `https://xxx.up.railway.app/rh-webhook/<WEBHOOK_SECRET>`（启动日志会打印）。

## 6. 设 Telegram 命令菜单（BotFather，可选）
对 BotFather 发 `/setcommands`，粘贴：
```
start - 开始使用
help - 使用帮助
mode - 选择处理模式
checkin - 每日签到领积分
balance - 查看积分余额
mode1 - 直接脱衣(1积分)
mode2 - 直接换衣(1积分)
mode3 - 扩图脱衣(2积分)
mode4 - 扩图换衣(2积分)
mode5 - 全能模式(1积分)
```

## 7. 验证
- 打开 `https://xxx.up.railway.app/health` 应返回 `{"ok":true}`。
- Telegram 给 bot 发 `/start` → `/checkin` → 选模式 → 发图，看是否正常。
- 看 Railway 日志确认 webhook 回调是否进来（"webhook 收到 taskId=..."）；若没有，兜底对账会在 ~6 分钟内补结果。

## 注意
- 自己先用 `/grant <自己的用户ID> 100` 加点积分测试。
- 本地想测 webhook：用 `ngrok http 3000`，把 PUBLIC_URL 临时指向 ngrok 域名。
