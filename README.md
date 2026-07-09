# BananaBot

BananaBot 是一个基于 Wechaty + 百炼/OpenAI 兼容接口的微信智能机器人。

当前版本重点能力：

- 私聊默认直接回复，不需要唤醒词。
- 群聊支持安静、智能、活跃、超级活跃、话唠五种模式。
- 历史消息、长期记忆、提醒、token 用量按会话隔离保存。
- 支持自然语言触发工具，不需要用户记住固定命令。
- 支持图片理解、语音转写尝试、视频抽帧理解尝试、链接预读取。
- 微信回复前会剥离 Markdown，并按微信消息长度智能分段。

## 目录

- [架构概览](#架构概览)
- [隐私和记忆隔离](#隐私和记忆隔离)
- [服务器部署](#服务器部署)
- [配置说明](#配置说明)
- [运行和维护](#运行和维护)
- [使用方式](#使用方式)
- [多模态能力](#多模态能力)
- [工具能力](#工具能力)
- [数据文件](#数据文件)
- [常见问题](#常见问题)
- [开发说明](#开发说明)

## 架构概览

```text
微信消息
  ↓
Wechaty / wechaty-puppet-wechat4u
  ↓
消息过滤和会话隔离
  ↓
文本 / 图片 / 语音 / 视频 / 链接适配
  ↓
记忆、提醒、token 用量存储
  ↓
聊天模型 / 工具路由 / 多模态模型
  ↓
Markdown 清洗和智能分段
  ↓
微信回复
```

主要代码：

- `src/main.ts`：Wechaty 登录、扫码、消息入口。
- `src/companion.ts`：机器人主逻辑、工具路由、多模态处理、回复格式化。
- `src/store.ts`：本地数据存储，负责消息、记忆、提醒、token 记录。
- `src/config.ts`：读取 `config.yaml` 或环境变量。

## 隐私和记忆隔离

隔离是强制要求，也是默认行为。

当前隔离边界是 `chatId`：

- 私聊：每个联系人有独立 `chatId`。
- 群聊：每个群有独立 `room.id`。
- 私聊 A 的历史和记忆不会被私聊 B 读取。
- 群 A 的历史和记忆不会被群 B 读取。
- 群里的记忆不会进入私聊。
- 私聊里的记忆不会进入群聊。

`store.searchMemories()` 只检索当前 `chatId` 下的记忆。默认不读取全局记忆。

token 用量查询默认也只返回当前会话的用量。若确实需要私聊中查看全局用量，可以在配置中开启：

```yaml
allowGlobalUsageReport: true
```

不建议在群聊中开放全局用量，避免泄漏其他会话信息。

## 服务器部署

以下以阿里云 ECS / Ubuntu 或 Debian 系服务器为例。

### 1. 安装 Node.js

推荐 Node.js 16。当前项目已经在 Node `16.20.2` 下验证可用。

```bash
cd /opt
wget https://nodejs.org/dist/v16.20.2/node-v16.20.2-linux-x64.tar.xz
tar -xf node-v16.20.2-linux-x64.tar.xz
```

检查：

```bash
/opt/node-v16.20.2-linux-x64/bin/node -v
/opt/node-v16.20.2-linux-x64/bin/npm -v
```

### 2. 克隆代码

```bash
cd /opt
git clone git@github.com:Meloding/BananaBot.git my-wechat-bot
cd /opt/my-wechat-bot
```

### 3. 安装依赖

```bash
/opt/node-v16.20.2-linux-x64/bin/npm install
```

### 4. 安装 Chromium 运行依赖

Wechaty Web 协议需要 Puppeteer/Chromium。Ubuntu/Debian 常见依赖：

```bash
apt-get update
apt-get install -y \
  ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
  libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 xdg-utils
```

### 5. 写入配置

```bash
cp config.yaml.example config.yaml
nano config.yaml
```

`config.yaml` 包含真实 API Key，已经被 `.gitignore` 忽略，不要提交到 Git。

### 6. 编译检查

```bash
/opt/node-v16.20.2-linux-x64/bin/npm run build
```

### 7. systemd 服务

创建 `/etc/systemd/system/my-wechat-bot.service`：

```ini
[Unit]
Description=Companion on WeChat
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/my-wechat-bot
Environment=NODE_ENV=production
Environment=WECHATY_PUPPET=wechaty-puppet-wechat4u
Environment=PATH=/opt/node-v16.20.2-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/opt/node-v16.20.2-linux-x64/bin/npm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启动：

```bash
systemctl daemon-reload
systemctl enable my-wechat-bot.service
systemctl start my-wechat-bot.service
```

扫码登录：

```bash
journalctl -u my-wechat-bot.service -f
```

日志里会出现二维码链接。用机器人微信号扫码确认即可。

如果终端二维码不好扫，可以复制日志里的二维码链接到浏览器打开：

```text
https://wechaty.js.org/qrcode/...
```

浏览器里显示完整二维码后，再用微信扫码登录。

## 配置说明

示例：

```yaml
openaiApiKey: ""
openaiBasePath: "https://dashscope.aliyuncs.com/compatible-mode/v1"
openaiModel: "qwen3.6-flash"
agentModel: "qwen3.6-flash"
legacyTriggerKeyword: "Hi bot:"

privateAutoReply: true
defaultGroupMode: "smart"

botDataPath: "./data/bot-store.json"
historyMessageLimit: 12
agentRouterEnabled: true
rootAuthToken: ""
ignoreOfficialAccounts: true
activeGroupCooldownSeconds: 30
superActiveGroupCooldownSeconds: 15
talkativeGroupCooldownSeconds: 5
reminderFollowupIntervalMinutes: 5
debugMessageTypes: true

multimodalEnabled: true
visionModel: "qwen3.7-plus"
audioModel: "qwen3-omni-flash"
maxMediaBytes: 10485760
maxVideoBytes: 83886080
videoInlineMaxBytes: 6291456
videoInputFps: 2
videoFrameCount: 3

replyMaxLength: 500
replyMaxSegments: 8
stripMarkdown: true

allowGlobalUsageReport: false
generatedFilesPath: "./data/generated"
statusPageEnabled: false
statusHost: "127.0.0.1"
statusPort: 8791
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `openaiApiKey` | 百炼 / DashScope API Key |
| `openaiBasePath` | OpenAI 兼容模式地址 |
| `openaiModel` | 普通聊天模型，建议 `qwen3.6-flash` |
| `agentModel` | 工具路由和复杂任务模型，建议 `qwen3.6-flash` |
| `legacyTriggerKeyword` | 兼容旧触发词；私聊默认不需要 |
| `privateAutoReply` | 私聊是否自动回复所有文本 |
| `defaultGroupMode` | 群聊默认模式：`quiet` / `smart` / `active` / `super_active` / `talkative` |
| `botDataPath` | 本地数据文件 |
| `historyMessageLimit` | 每次对话带入的最近消息条数 |
| `agentRouterEnabled` | 是否启用 LLM 工具路由 |
| `rootAuthToken` | root 授权长串，留空则关闭 root 自助授权 |
| `ignoreOfficialAccounts` | 是否默认忽略公众号消息 |
| `activeGroupCooldownSeconds` | 群聊活跃模式冷却秒数 |
| `superActiveGroupCooldownSeconds` | 群聊超级活跃模式冷却秒数 |
| `talkativeGroupCooldownSeconds` | 群聊话唠模式冷却秒数 |
| `reminderFollowupIntervalMinutes` | 连续提醒多次时的间隔分钟数 |
| `debugMessageTypes` | 是否在日志输出微信消息类型 |
| `multimodalEnabled` | 是否启用多模态 |
| `visionModel` | 图片、表情包、视频理解模型 |
| `audioModel` | 语音转写模型 |
| `maxMediaBytes` | 图片、语音、表情等普通媒体最大字节数 |
| `maxVideoBytes` | 微信视频下载到服务器的最大字节数，默认 80MB |
| `videoInlineMaxBytes` | 送入 Qwen-VL 前的视频目标大小，默认 6MB |
| `videoInputFps` | Qwen-VL 读取视频时的采样 fps |
| `videoFrameCount` | 原生视频理解失败时，抽帧兜底的最多帧数 |
| `replyMaxLength` | 单条微信消息最大长度 |
| `replyMaxSegments` | 一次回复最多拆分几条 |
| `stripMarkdown` | 发送微信前是否移除 Markdown 标记 |
| `allowGlobalUsageReport` | 私聊中是否允许查看全局 token 用量 |
| `generatedFilesPath` | agent 生成文件的保存目录 |
| `statusPageEnabled` | 是否启用状态控制台 |
| `statusHost` | 状态页监听地址，公网部署建议绑定 `127.0.0.1` 后由 Nginx 反代 |
| `statusPort` | 状态页监听端口 |

### 状态控制台

BananaBot 内置一个轻量状态控制台，适合部署到 `http://你的域名/wechat-status/` 查看运行状态和管理会话。控制台复用 `rootAuthToken` 登录；没有配置 `rootAuthToken` 时，控制台登录会被禁用。

最小配置：

```yaml
rootAuthToken: "你的 root 长串"
statusPageEnabled: true
statusHost: "127.0.0.1"
statusPort: 8791
```

建议让状态服务只监听 `127.0.0.1`，再由 Nginx 反代到公网域名：

```nginx
location /wechat-status/ {
    proxy_pass http://127.0.0.1:8791/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

修改 Nginx 后检查并重载：

```bash
nginx -t
systemctl reload nginx
```

可用地址：

| 地址 | 说明 |
| --- | --- |
| `/wechat-status/` | Web 控制台，使用 `rootAuthToken` 登录 |
| `/wechat-status/healthz` | 健康检查接口，不需要登录 |
| `/wechat-status/status.json` | 运行状态 JSON，需要登录 |
| `/wechat-status/api/overview` | 总览数据，需要登录 |
| `/wechat-status/api/chats` | 会话列表，需要登录 |
| `/wechat-status/api/chat?id=...` | 单个会话详情，需要登录 |
| `/wechat-status/api/usage` | token 用量统计，需要登录 |
| `/wechat-status/api/reminders` | 提醒列表，需要登录 |
| `/wechat-status/api/memories` | 记忆列表，需要登录 |
| `/wechat-status/api/recent` | 最近消息和模型调用事件，需要登录 |

控制台目前可以查看登录状态、运行时长、模型配置、消息/API 计数、最近错误、群聊/私聊会话、token 用量、提醒、记忆和最近事件，也可以调整群聊模式、会话允许/禁用状态、私聊视频权限和取消提醒。

安全建议：务必把 `rootAuthToken` 当成管理员密码保管，不要发到群里、截图或写进公开仓库。公网访问建议配 HTTPS；如果只给自己使用，也可以额外加一层服务器防火墙或 Nginx basic auth。

## 运行和维护

查看状态：

```bash
systemctl status my-wechat-bot.service
```

实时日志：

```bash
journalctl -u my-wechat-bot.service -f
```

重启：

```bash
systemctl restart my-wechat-bot.service
```

停止：

```bash
systemctl stop my-wechat-bot.service
```

更新代码：

```bash
cd /opt/my-wechat-bot
git pull
/opt/node-v16.20.2-linux-x64/bin/npm install
/opt/node-v16.20.2-linux-x64/bin/npm run build
systemctl restart my-wechat-bot.service
```

## 使用方式

### 私聊

私聊默认不用触发词：

```text
你好，帮我解释一下操作系统里的虚拟内存是什么
```

保存记忆：

```text
帮我记住：我的高数考试是7月10日上午
```

查询记忆：

```text
我之前让你记住的考试安排是什么？
```

设置提醒：

```text
明天上午9点提醒我交作业
每天中午十一点半提醒我点外卖
明天早上8点帮我写一段暖心慰问
我有哪些提醒？
```

查看 token：

```text
今天 token 消耗怎么样？
```

### 群聊

群聊模式：

- `quiet`：安静模式，只在被 @ 或触发词出现时回复。
- `smart`：智能模式，被明显问到或需要工具时回复。
- `active`：活跃模式，会更积极参与，默认 30 秒冷却。
- `super_active`：超级活跃模式，更积极接话，默认 15 秒冷却。
- `talkative`：话唠模式，高频参与聊天，默认 5 秒冷却。

推荐切换方式：

```text
/模式
/安静
/智能
/活跃
/超活跃
/话唠
```

`/模式` 会回复菜单：

```text
/1 安静
/2 智能
/3 活跃
/4 超级活跃
/5 话唠
```

你可以直接回复 `/1` / `/2` / `/3` / `/4` / `/5` 切换。

也支持自然语言，例如：

```text
你先安静一点
这个群里活跃一点
恢复正常回复
```

群聊里也可以 @：

```text
@布拿拿 帮我总结今天这个群聊了什么
```

### 群聊里询问图片、语音、视频

如果你在群里发了一张图片，然后想让机器人看，可以在图片下面继续发：

```text
@布拿拿 这张图在说什么？
@布拿拿 帮我看一下这张截图
@布拿拿 图里的报错怎么解决？
```

也可以先发视频或语音，再继续问：

```text
@布拿拿 总结一下这个视频
@布拿拿 把刚才那条语音转成文字
```

不同模式下的行为：

- 安静模式：群里随机发图不会处理；只有 @ 或触发词问它时才会理解最近媒体。
- 智能模式：群里随机发图不会处理；明显问到机器人时才会理解最近媒体。
- 活跃模式：文本聊天会更积极参与，但随机裸发图片、语音、视频仍不会主动调用多模态模型。
- 超级活跃模式：会主动理解图片和表情包。
- 话唠模式：会主动理解图片、语音、表情包和视频。

也就是说，单纯乱发图片不会消耗 `visionModel`。机器人只会在当前群缓存最近几条媒体一小段时间，等有人明确问“这张图/刚才的视频/这条语音”时再调用模型。

群里有人先发图、表情包、语音或视频，另一个人再 @ 机器人追问，也会使用当前群最近缓存的媒体，不要求必须同一个人连续提问。

## 多模态能力

### 图片

收到图片后，机器人不会无条件调用视觉模型。

私聊默认会直接理解图片并回复。群聊中，机器人会先按当前群模式判断是否需要处理：

- 被 @ 并询问图片时处理。
- 使用触发词询问图片时处理。
- 后续文本明显引用最近图片时处理。
- 随机裸发图片时只缓存，不调用模型。

需要处理时，机器人会尝试：

1. 从 Wechaty 读取图片文件。
2. 转成 data URL。
3. 调用 `visionModel` 做图片理解。
4. 将理解结果保存到当前会话历史。
5. 根据当前会话模式决定是否回复。

适合场景：

- 截图 OCR
- 图片内容解释
- 图表初步解读
- 聊天截图总结

### 语音

微信 Web 协议不能稳定调用微信客户端自带的“语音转文字”结果。

当前策略：

1. 使用 `message.toFileBox()` 获取微信语音文件。
2. 尝试调用 `audioModel` 转写。
3. 将转写结果交给普通对话和工具路由理解。

注意：`wechaty-puppet-wechat4u` 拉到的微信语音通常是 `.sil` 文件。若音频模型不支持该格式，需要后续增加 silk/ffmpeg 转码。

### 视频

视频处理优先使用 Qwen-VL 原生视频理解：

1. 保存视频到临时目录。
2. 如果视频超过 `videoInlineMaxBytes` 或不是 MP4，会用 `ffmpeg` 压缩/转码成小 MP4。
3. 将 `data:video/mp4;base64,...` 通过 `video_url` 交给 `visionModel`。
4. 如果原生视频理解失败，再按 `videoFrameCount` 抽帧兜底。

私聊中，root 用户默认允许自动理解视频；普通好友需要 root 用 `/视频允许 编号` 授权。群聊中，话唠模式会主动理解视频，其他模式需要 @ 机器人或后续明确追问。

安装 `ffmpeg`：

```bash
apt-get install -y ffmpeg
```

### 链接

文本里出现 `http://` 或 `https://` 链接时，机器人会尝试：

1. 预读取网页标题和正文片段。
2. 过滤 localhost、内网 IP 等不安全地址。
3. 将摘录作为上下文交给模型总结。

## 工具能力

工具不是靠固定命令触发。提醒、查提醒、群模式切换这类基础能力会先走代码里的确定性解析；更模糊的意图再交给 LLM 路由判断。

普通聊天继续使用 `openaiModel`。复杂任务和工具路由默认使用更便宜的 `agentModel`，避免每条消息都消耗聊天主模型。

支持的动作：

- `chat`：普通聊天
- `remember`：保存长期记忆
- `recall`：查询当前会话记忆
- `reminder`：设置提醒
- `list_reminders`：查询当前会话提醒记录
- `agent_task`：复杂任务，包括日程文档、文件生成、代码执行确认
- `summarize_today`：总结当天当前会话
- `usage_report`：查询当前会话 token 用量
- `ignore`：判断不需要回复

例如以下自然语言都可以：

```text
帮我记住我周五下午要交开题报告
我之前说的 DDL 有哪些？
明天早上8点提醒我查房前看一下这个病人的检验
每天中午十一点半提醒我点外卖
明天早上8点帮我给她写一个暖心慰问
我昨天让你提醒我点外卖，你忘了吗？
帮我把这周的考试和作业整理成日程表
帮我生成一份 Markdown 复习计划文件
帮我运行这段 Python 代码
总结一下今天群里讨论的重点
今天这个群消耗了多少 token？
```

### Agent 能力

当前版本是内置轻量 agent 层，不会让所有消息都进入 agent：

- 普通聊天：直接用 `openaiModel` 回复。
- 快速工具：提醒、查提醒、记忆、群模式、token 查询由代码直接处理。
- 复杂任务：使用 `agentModel` 规划和生成结果。

已支持的复杂任务：

- 日程表：`帮我把这周考试和作业整理成日程表`
- 文件生成：`帮我生成一份 Markdown 复习计划文件`
- 代码执行：`帮我运行这段 Python 代码`
- 任务规划：`帮我把这个需求拆成步骤`

文件会保存到 `generatedFilesPath`，并通过微信发回当前私聊或群聊。代码执行属于高风险任务，机器人会先要求确认：

```text
/确认执行
/取消
```

代码运行只支持临时 Python / JavaScript 文件，使用超时和输出截断，不通过 shell 执行。

### 提醒能力

提醒支持私聊和群聊，都会按当前会话隔离保存：

- 私聊设置的提醒只发回对应私聊。
- 群聊设置的提醒会发回对应群。
- 查提醒时只查看当前私聊或当前群，不会串到其他会话。

目前支持：

- 一次性提醒：`明天上午9点提醒我交作业`
- 每日重复提醒：`每天中午十一点半提醒我点外卖`
- 连续多次提醒：`明天傍晚五点半连续提醒我两次写作业`
- 到点生成内容：`明天早上8点帮我写一段暖心慰问`
- 查询提醒：`我有哪些提醒？`、`我昨天让你提醒我点外卖，你忘了吗？`

简单提醒到点会直接发送 `提醒：...`。如果提醒内容明显是“写文案、生成慰问、起草回复、总结”等任务，到点时会先调用模型生成正文，再发到对应会话。

### Root 和白名单

在 `config.yaml` 里设置一个足够长的 `rootAuthToken` 后，任意私聊或群聊里发送这个长串，即可把发送者加入 root：

```text
your-long-root-token
```

root 支持：

```text
/root帮助
/好友列表
/群列表
/会话列表
/白名单
/允许 3
/禁止 3
/视频允许 3
/视频禁止 3
/视频白名单
/总结 3
```

默认好友和群都允许聊天；root 可以用 `/禁止 编号` 关闭某个好友或群的回复，用 `/允许 编号` 恢复。编号来自最近一次 `/好友列表`、`/群列表` 或 `/会话列表`。

公众号消息默认不回复，避免订阅号推送消耗 token。

## 数据文件

默认数据文件：

```bash
/opt/my-wechat-bot/data/bot-store.json
```

包含：

- `messages`：消息历史
- `memories`：长期记忆
- `reminders`：提醒
- `usageRecords`：token 用量
- `groupSettings`：群聊模式
- `rootUsers`：root 用户
- `chatAccess`：白名单/黑名单规则
- `privateVideoAccess`：普通好友私聊视频自动回复权限
- `knownChats`：已见过的私聊和群聊索引

`data/` 已加入 `.gitignore`，不会提交到仓库。

媒体文件默认不长期保存：图片、语音、视频只在处理时存在于内存或临时目录，处理结束后会删除。表情包调试文件、失败样本等只会在调试逻辑触发时写入 `data/debug-media/`；agent 生成的文件写入 `data/generated/`。

消息记录按会话持续保留，不会因为超过 `historyMessageLimit` 自动删除。`historyMessageLimit` 只控制每次对话带入模型的最近消息条数，用来避免聊天记录越积越多后每次请求都变贵。

建议定期备份：

```bash
tar -czf /root/mywechatbot-data-$(date +%F).tar.gz /opt/my-wechat-bot/data
```

## 常见问题

### 微信回复里为什么没有 Markdown 加粗？

微信普通文本不渲染 Markdown。直接发送 Markdown 会出现 `**加粗**` 这类星号。

本项目默认启用：

```yaml
stripMarkdown: true
```

机器人发送前会移除常见 Markdown 标记，并把 Markdown 链接转成普通文本。

### 回复太长怎么办？

微信单条消息有长度和可读性限制。

本项目会按以下优先级分段：

1. 空行
2. 换行
3. 句号、问号、感叹号
4. 分号、逗号
5. 硬切分

配置：

```yaml
replyMaxLength: 500
replyMaxSegments: 8
```

超过最大段数后会截断，并提示内容较长。

### 为什么语音转写失败？

常见原因：

- 微信语音是 `.sil` 格式，当前 ASR 模型不支持。
- 文件超过 `maxMediaBytes`。
- `audioModel` 配置不正确。
- 百炼账号没有对应模型权限。

后续可以加入 silk 转 wav/mp3 的转码流程。

### 为什么群里没有回复？

查看群模式：

- 安静模式：必须 @ 或触发词。
- 智能模式：只有明显问到机器人或需要工具时回复。
- 活跃模式：更积极，但有 30 秒冷却。
- 超级活跃模式：更积极接话，默认 15 秒冷却。
- 话唠模式：高频聊天，默认 5 秒冷却。

可以在群里说：

```text
/模式
/活跃
```

### 如何确认 API 是否正常？

重启服务后日志里应有：

```text
Companion starts success, ready to handle message!
```

也可以私聊发送：

```text
请只回复 API 测试成功
```

## 开发说明

本地开发：

```bash
npm install
cp config.yaml.example config.yaml
npm run build
npm start
```

提交前检查：

```bash
npm run build
git status --short --ignored
```

确认以下文件不要提交：

- `config.yaml`
- `data/`
- `node_modules/`
- `dist/`

当前 GitHub 仓库：

```text
git@github.com:Meloding/BananaBot.git
```
