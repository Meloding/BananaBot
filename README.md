# MyWechatBot

一个基于 Wechaty + Qwen/百炼 OpenAI 兼容接口的微信智能机器人。

当前版本重点能力：

- 私聊默认直接回复，不需要唤醒词。
- 群聊支持安静、智能、活跃三种模式。
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
Qwen 模型 / 工具路由 / 多模态模型
  ↓
Markdown 清洗和智能分段
  ↓
微信回复
```

主要代码：

- `src/main.ts`：Wechaty 登录、扫码、消息入口。
- `src/chatgpt.ts`：机器人主逻辑、工具路由、多模态处理、回复格式化。
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
git clone git@github.com:Meloding/MyWechatBot.git chatgpt-on-wechat
cd /opt/chatgpt-on-wechat
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

创建 `/etc/systemd/system/chatgpt-on-wechat.service`：

```ini
[Unit]
Description=ChatGPT on WeChat
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/chatgpt-on-wechat
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
systemctl enable chatgpt-on-wechat.service
systemctl start chatgpt-on-wechat.service
```

扫码登录：

```bash
journalctl -u chatgpt-on-wechat.service -f
```

日志里会出现二维码链接。用机器人微信号扫码确认即可。

## 配置说明

示例：

```yaml
openaiApiKey: ""
openaiOrganizationID: ""
openaiBasePath: "https://dashscope.aliyuncs.com/compatible-mode/v1"
openaiModel: "qwen-plus"
chatgptTriggerKeyword: "Hi bot:"

privateAutoReply: true
defaultGroupMode: "smart"

botDataPath: "./data/bot-store.json"
historyMessageLimit: 12
agentRouterEnabled: true

multimodalEnabled: true
visionModel: "qwen-vl-plus"
audioModel: "qwen-audio-turbo-latest"
maxMediaBytes: 10485760
videoFrameCount: 3

replyMaxLength: 500
replyMaxSegments: 8
stripMarkdown: true

allowGlobalUsageReport: false
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `openaiApiKey` | 百炼 / DashScope API Key |
| `openaiBasePath` | OpenAI 兼容模式地址 |
| `openaiModel` | 普通聊天模型，默认 `qwen-plus` |
| `chatgptTriggerKeyword` | 兼容旧触发词；私聊默认不需要 |
| `privateAutoReply` | 私聊是否自动回复所有文本 |
| `defaultGroupMode` | 群聊默认模式：`quiet` / `smart` / `active` |
| `botDataPath` | 本地数据文件 |
| `historyMessageLimit` | 每次对话带入的最近消息条数 |
| `agentRouterEnabled` | 是否启用 LLM 工具路由 |
| `multimodalEnabled` | 是否启用多模态 |
| `visionModel` | 图片/视频帧理解模型 |
| `audioModel` | 语音转写模型 |
| `maxMediaBytes` | 单个媒体文件最大字节数 |
| `videoFrameCount` | 视频最多抽帧数量 |
| `replyMaxLength` | 单条微信消息最大长度 |
| `replyMaxSegments` | 一次回复最多拆分几条 |
| `stripMarkdown` | 发送微信前是否移除 Markdown 标记 |
| `allowGlobalUsageReport` | 私聊中是否允许查看全局 token 用量 |

## 运行和维护

查看状态：

```bash
systemctl status chatgpt-on-wechat.service
```

实时日志：

```bash
journalctl -u chatgpt-on-wechat.service -f
```

重启：

```bash
systemctl restart chatgpt-on-wechat.service
```

停止：

```bash
systemctl stop chatgpt-on-wechat.service
```

更新代码：

```bash
cd /opt/chatgpt-on-wechat
git pull
/opt/node-v16.20.2-linux-x64/bin/npm install
/opt/node-v16.20.2-linux-x64/bin/npm run build
systemctl restart chatgpt-on-wechat.service
```

## 使用方式

### 私聊

私聊默认不用触发词：

```text
你好，帮我解释一下肠道菌群移植是什么
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
```

查看 token：

```text
今天 token 消耗怎么样？
```

### 群聊

群聊模式：

- `quiet`：安静模式，只在被 @ 或触发词出现时回复。
- `smart`：智能模式，被明显问到或需要工具时回复。
- `active`：活跃模式，会更积极参与，但有冷却时间，避免刷屏。

切换模式：

```text
机器人进入安静模式
机器人进入智能模式
机器人进入活跃模式
```

群聊里也可以 @：

```text
@布拿拿 帮我总结今天这个群聊了什么
```

## 多模态能力

### 图片

收到图片后，机器人会尝试：

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

视频处理是尽力而为：

1. 保存视频到临时目录。
2. 如果服务器有 `ffmpeg`，按 `videoFrameCount` 抽帧。
3. 将抽出的图片帧交给 `visionModel` 总结。
4. 如果没有 `ffmpeg`，会提示当前不能抽帧。

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

工具不是靠固定命令触发，而是由 LLM 路由判断。

支持的动作：

- `chat`：普通聊天
- `remember`：保存长期记忆
- `recall`：查询当前会话记忆
- `reminder`：设置提醒
- `summarize_today`：总结当天当前会话
- `usage_report`：查询当前会话 token 用量
- `ignore`：判断不需要回复

例如以下自然语言都可以：

```text
帮我记住我周五下午要交开题报告
我之前说的 DDL 有哪些？
明天早上8点提醒我查房前看一下这个病人的检验
总结一下今天群里讨论的重点
今天这个群消耗了多少 token？
```

## 数据文件

默认数据文件：

```bash
/opt/chatgpt-on-wechat/data/bot-store.json
```

包含：

- `messages`：消息历史
- `memories`：长期记忆
- `reminders`：提醒
- `usageRecords`：token 用量
- `groupSettings`：群聊模式

`data/` 已加入 `.gitignore`，不会提交到仓库。

建议定期备份：

```bash
tar -czf /root/mywechatbot-data-$(date +%F).tar.gz /opt/chatgpt-on-wechat/data
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
- 活跃模式：更积极，但有冷却时间。

可以在群里说：

```text
机器人进入活跃模式
```

### 如何确认 API 是否正常？

重启服务后日志里应有：

```text
ChatGPT starts success, ready to handle message!
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
git@github.com:Meloding/MyWechatBot.git
```
