import { Config } from "./config.js";
import fs from "fs";
import http from "http";
import https from "https";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { Message } from "wechaty";
import { ContactInterface, RoomInterface } from "wechaty/impls";
import { Configuration, OpenAIApi } from "openai";
import {
  BotStore,
  ChatContext,
  ChatScope,
  GroupMode,
  ReminderItem,
  ReminderRepeat,
} from "./store.js";

const execFileAsync = promisify(execFile);

enum MessageType {
  Unknown = 0,
  Attachment = 1,
  Audio = 2,
  Contact = 3,
  ChatHistory = 4,
  Emoticon = 5,
  Image = 6,
  Text = 7,
  Location = 8,
  MiniProgram = 9,
  GroupNote = 10,
  Transfer = 11,
  RedEnvelope = 12,
  Recalled = 13,
  Url = 14,
  Video = 15,
  Post = 16,
}

type ToolAction =
  | "chat"
  | "remember"
  | "recall"
  | "reminder"
  | "list_reminders"
  | "summarize_today"
  | "usage_report"
  | "set_group_mode"
  | "ignore";

interface RoutedIntent {
  action: ToolAction;
  mode?: GroupMode;
  reply?: string;
  memory?: string;
  query?: string;
  remindAt?: string;
  reminderContent?: string;
  repeat?: ReminderRepeat;
  tags?: string[];
  reason?: string;
}

interface ParsedReminder {
  remindAt: Date;
  content: string;
  repeat: ReminderRepeat;
}

interface CompletionResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
}

interface MediaFile {
  name: string;
  mediaType: string;
  extension: string;
  buffer: Buffer;
  base64: string;
  dataUrl: string;
}

interface PendingMediaMessage {
  message: Message;
  messageType: MessageType;
  typeName: string;
  timestamp: number;
  talkerName: string;
  processedText?: string;
}

export class ChatGPTBot {
  botName: string = "";
  startTime: Date = new Date();
  disableSelfChat: boolean = false;
  chatgptTriggerKeyword: string = Config.chatgptTriggerKeyword;
  chatgptErrorMessage: string = "ChatGPT摆烂了，请稍后再试～";
  SINGLE_MESSAGE_MAX_SIZE: number = 500;

  private store = new BotStore(Config.botDataPath);
  private openaiAccountConfig: any;
  private openaiApiInstance: any;
  private reminderLoopStarted = false;
  private lastGroupReplyAt: Map<string, number> = new Map();
  private pendingMediaByChat: Map<string, PendingMediaMessage[]> = new Map();
  private readonly pendingMediaTtlMs = 10 * 60 * 1000;
  private readonly pendingMediaLimit = 6;

  private chatgptModelConfig: object = {
    model: Config.openaiModel,
    temperature: 0.8,
  };

  private get currentDate(): string {
    return this.formatLocalDate(new Date());
  }

  private get currentDateTime(): string {
    return this.formatLocalDateTime(new Date());
  }

  private get chatgptSystemContent(): string {
    return [
      "你是一个接入微信的 Qwen 系列智能助手。",
      "你的风格自然、温暖、有分寸，像一个可靠的朋友和工具人。",
      "你会记住用户明确交代的重要信息，但不要编造不存在的记忆。",
      "你支持私聊和群聊定时提醒；不要声称群聊不能定时，除非系统明确报错。",
      "你通过用户配置的模型 API 工作，回复会消耗 token；被问到成本或消耗时要诚实说明，并提示可以查询 token 用量。",
      "在群聊里不要刷屏，不确定是否该说话时保持克制。",
      "回答尽量使用用户的语言，简洁但不要冷冰冰。",
      `当前日期：${this.currentDate}`,
    ].join("\n");
  }

  setBotName(botName: string) {
    this.botName = botName;
  }

  private get chatGroupTriggerKeyword(): string {
    return `@${this.botName} ${this.chatgptTriggerKeyword || ""}`;
  }

  async startGPTBot() {
    try {
      this.openaiAccountConfig = new Configuration({
        organization: Config.openaiOrganizationID,
        apiKey: Config.openaiApiKey,
        basePath: Config.openaiBasePath || undefined,
      });
      this.openaiApiInstance = new OpenAIApi(this.openaiAccountConfig);
      console.log(`🤖️ ChatGPT name is: ${this.botName}`);
      console.log(
        `🎯 Private chat auto reply is: ${Config.privateAutoReply ? "on" : "off"}`
      );
      console.log(`🎯 Default group mode is: ${Config.defaultGroupMode}`);
      console.log(
        `🎯 Trigger keyword in group quiet mode is: ${this.chatGroupTriggerKeyword}`
      );
      await this.completeChat(
        [{ role: "user", content: "Say Hello World" }],
        this.systemContext(),
        "startup",
        0.2
      );
      console.log(`✅ ChatGPT starts success, ready to handle message!`);
    } catch (e) {
      console.error(`❌ ${e}`);
    }
  }

  startReminderLoop(weChatBot: any) {
    if (this.reminderLoopStarted) {
      return;
    }
    this.reminderLoopStarted = true;
    setInterval(async () => {
      const dueReminders = this.store.getDueReminders();
      for (const reminder of dueReminders) {
        await this.sendReminder(weChatBot, reminder);
      }
    }, 30 * 1000);
  }

  async onCustimzedTask(message: Message): Promise<boolean> {
    const text = message.text()?.trim() || "";
    if (!text) {
      return false;
    }

    const context = await this.createContext(message);
    const modeCommand = this.parseDirectGroupModeCommand(text);
    if (context.scope === "group" && modeCommand.type === "menu") {
      await message.say(this.groupModeMenu());
      return true;
    }

    if (context.scope === "group" && modeCommand.type === "switch") {
      this.store.setGroupMode(context.chatId, context.chatName, modeCommand.mode);
      await message.say(`已切换：${this.describeGroupMode(modeCommand.mode)}`);
      return true;
    }

    if (text === "菜单" || text === "帮助") {
      await message.say(
        [
          "我现在支持：",
          "1. 私聊直接对话，不需要 Hi bot:",
          "2. 群聊可用 #模式 / #安静 / #智能 / #活跃 切换模式",
          "3. 自然语言让我记住信息、查询记忆、设置提醒",
          "4. 说“总结今天”或“今天 token 消耗”查看总结",
        ].join("\n")
      );
      return true;
    }

    const myKeyword = "麦扣";
    if (text.includes(myKeyword)) {
      await message.say("🤖️：call我做咩啊大佬");
      return true;
    }

    return false;
  }

  async onMessage(message: Message) {
    const context = await this.createContext(message);
    const talker = message.talker();
    const rawText = message.text() || "";
    const messageType = message.type();

    if (this.isIgnorable(talker, messageType, rawText)) {
      return;
    }

    if (messageType !== MessageType.Text && messageType !== MessageType.Url) {
      await this.handleNonTextMessage(message, context, messageType);
      return;
    }

    this.store.addMessage({
      ...context,
      role: "user",
      text: rawText,
      messageType,
    });

    if (!this.shouldRespond(rawText, context)) {
      return;
    }

    const cleanText = this.cleanMessage(rawText, context).trim();
    const mediaContext = await this.consumeReferencedMediaIfNeeded(
      cleanText || rawText,
      context
    );
    const enrichedText = await this.enrichTextWithLink(cleanText || rawText);
    const userText = mediaContext
      ? [
          enrichedText,
          "",
          "用户正在询问最近收到的媒体，以下是媒体理解结果：",
          mediaContext,
        ].join("\n")
      : enrichedText;
    const replyMessage = await this.handleUserText(userText, context);
    if (!replyMessage) {
      return;
    }

    const sentMessage = await this.replyToContext(message, context, replyMessage);
    this.store.addMessage({
      ...context,
      role: "assistant",
      text: sentMessage,
      messageType: MessageType.Text,
    });
  }

  private async handleUserText(
    text: string,
    context: ChatContext
  ): Promise<string> {
    const deterministicIntent = this.parseDeterministicToolIntent(text, context);
    if (deterministicIntent) {
      return this.handleIntent(deterministicIntent, text, context);
    }

    const intent = await this.routeIntentIfNeeded(text, context);
    return this.handleIntent(intent, text, context);
  }

  private async handleIntent(
    intent: RoutedIntent,
    text: string,
    context: ChatContext
  ): Promise<string> {
    switch (intent.action) {
      case "remember":
        return this.handleRemember(intent, text, context);
      case "recall":
        return this.handleRecall(intent, text, context);
      case "reminder":
        return this.handleReminder(intent, text, context);
      case "list_reminders":
        return this.handleListReminders(context);
      case "summarize_today":
        return this.handleSummarizeToday(context);
      case "usage_report":
        return this.handleUsageReport(context);
      case "set_group_mode":
        return this.handleSetGroupMode(intent, context);
      case "ignore":
        return intent.reply || "";
      case "chat":
      default:
        return this.onChatGPT(text, context);
    }
  }

  private async onChatGPT(text: string, context: ChatContext): Promise<string> {
    const messages = this.createMessages(text, context);
    try {
      const result = await this.completeChat(messages, context, "chat");
      console.log(`🤖️ ChatGPT says: ${result.text}`);
      return result.text;
    } catch (e: any) {
      this.logApiError(e);
      return this.chatgptErrorMessage;
    }
  }

  private createMessages(text: string, context: ChatContext): Array<any> {
    const recentMessages = this.store
      .getRecentMessages(context.chatId, Config.historyMessageLimit)
      .map((message) => ({
        role: message.role,
        content: `${message.talkerName}: ${message.text}`,
      }));
    const memories = this.store.searchMemories(context, text, 8);
    const memoryText = memories.length
      ? memories.map((memory) => `- ${memory.content}`).join("\n")
      : "暂无可用长期记忆。";

    return [
      {
        role: "system",
        content: this.chatgptSystemContent,
      },
      {
        role: "system",
        content: [
          `当前会话类型：${context.scope === "group" ? "群聊" : "私聊"}`,
          `当前会话：${context.chatName}`,
          `当前发言人：${context.talkerName}`,
          "相关长期记忆：",
          memoryText,
        ].join("\n"),
      },
      ...recentMessages,
      {
        role: "user",
        content: text,
      },
    ];
  }

  private parseDeterministicToolIntent(
    text: string,
    context: ChatContext
  ): RoutedIntent | null {
    const userText = text.split("\n\n用户正在询问最近收到的媒体")[0].trim();
    const parsedReminder = this.parseReminderRequest(userText);
    if (parsedReminder) {
      return {
        action: "reminder",
        remindAt: parsedReminder.remindAt.toISOString(),
        reminderContent: parsedReminder.content,
        repeat: parsedReminder.repeat,
      };
    }
    if (this.isReminderListRequest(userText, context)) {
      return { action: "list_reminders" };
    }
    return null;
  }

  private parseReminderRequest(text: string): ParsedReminder | null {
    if (!this.looksLikeReminderCreateRequest(text)) {
      return null;
    }
    const time = this.parseTimeOfDay(text);
    if (!time) {
      return null;
    }

    const now = new Date();
    const date = this.parseReminderDate(text, now);
    const remindAt = new Date(
      date.year,
      date.month,
      date.day,
      time.hour,
      time.minute,
      0,
      0
    );
    const repeat: ReminderRepeat = /每天|每日|天天|每一天/.test(text)
      ? "daily"
      : "none";

    if (repeat === "daily") {
      while (remindAt.getTime() <= now.getTime()) {
        remindAt.setDate(remindAt.getDate() + 1);
      }
    } else if (!date.explicit && remindAt.getTime() <= now.getTime()) {
      remindAt.setDate(remindAt.getDate() + 1);
    }

    const content = this.extractReminderContent(text);
    return {
      remindAt,
      content: content || "提醒事项",
      repeat,
    };
  }

  private looksLikeReminderCreateRequest(text: string): boolean {
    const compact = text.replace(/\s+/g, "");
    const hasReminderCue = /提醒|闹钟|别忘|定时|叫我|喊我|到点|到时候/.test(
      compact
    );
    const hasFutureTaskCue =
      /(今天|明天|后天|大后天|每天|每日|天天|每一天).*(帮我|能帮我|可以帮我|麻烦|记得|给我)/.test(
        compact
      ) && /[点时:：]/.test(compact);
    return hasReminderCue || hasFutureTaskCue;
  }

  private isReminderListRequest(text: string, context: ChatContext): boolean {
    const compact = text.replace(/\s+/g, "");
    const asksReminder =
      /提醒/.test(compact) &&
      /(哪些|什么|列表|还有|有没有|查|查看|为什么|没提醒|没有提醒|忘了吗|忘了|昨天|之前|刚才)/.test(
        compact
      );
    return asksReminder || (context.scope !== "system" && /^#提醒$/.test(compact));
  }

  private parseReminderDate(text: string, now: Date) {
    const ymd = text.match(/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})/);
    if (ymd) {
      return {
        year: Number(ymd[1]),
        month: Number(ymd[2]) - 1,
        day: Number(ymd[3]),
        explicit: true,
      };
    }

    const md = text.match(
      /([0-9一二两三四五六七八九十]{1,3})月([0-9一二两三四五六七八九十]{1,3})(?:日|号)?/
    );
    if (md) {
      const month = this.parseChineseNumber(md[1]);
      const day = this.parseChineseNumber(md[2]);
      if (month && day) {
        let year = now.getFullYear();
        const candidate = new Date(year, month - 1, day);
        if (candidate.getTime() < this.startOfDay(now).getTime()) {
          year += 1;
        }
        return { year, month: month - 1, day, explicit: true };
      }
    }

    let offset = 0;
    if (/大后天/.test(text)) {
      offset = 3;
    } else if (/后天/.test(text)) {
      offset = 2;
    } else if (/明天/.test(text)) {
      offset = 1;
    }
    const date = new Date(now);
    date.setDate(now.getDate() + offset);
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      explicit: offset > 0 || /今天/.test(text),
    };
  }

  private parseTimeOfDay(text: string): { hour: number; minute: number } | null {
    const colon = text.match(/([01]?\d|2[0-3])[:：]([0-5]\d)/);
    if (colon) {
      return { hour: Number(colon[1]), minute: Number(colon[2]) };
    }

    const compact = text.replace(/\s+/g, "");
    const match = compact.match(
      /(凌晨|早上|上午|中午|下午|晚上|夜里)?([0-9一二两三四五六七八九十两]{1,4})(?:点|时)(半|([0-9一二两三四五六七八九十]{1,3})分?)?/
    );
    if (!match) {
      return null;
    }

    const period = match[1] || "";
    const hourValue = this.parseChineseNumber(match[2]);
    if (hourValue === null || hourValue < 0 || hourValue > 24) {
      return null;
    }
    let hour = hourValue;
    let minute = 0;
    if (match[3] === "半") {
      minute = 30;
    } else if (match[4]) {
      const minuteValue = this.parseChineseNumber(match[4]);
      if (minuteValue === null || minuteValue < 0 || minuteValue > 59) {
        return null;
      }
      minute = minuteValue;
    }

    if (/下午|晚上|夜里/.test(period) && hour < 12) {
      hour += 12;
    } else if (/中午/.test(period) && hour > 0 && hour < 11) {
      hour += 12;
    } else if (hour === 24) {
      hour = 0;
    }
    return { hour, minute };
  }

  private extractReminderContent(text: string): string {
    let content = text
      .replace(/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})/g, " ")
      .replace(
        /([0-9一二两三四五六七八九十]{1,3})月([0-9一二两三四五六七八九十]{1,3})(?:日|号)?/g,
        " "
      )
      .replace(/每天|每日|天天|每一天|今天|明天|后天|大后天/g, " ")
      .replace(
        /(凌晨|早上|上午|中午|下午|晚上|夜里)?([0-9一二两三四五六七八九十两]{1,4})(?:点|时)(半|([0-9一二两三四五六七八九十]{1,3})分?)?/g,
        " "
      )
      .replace(/([01]?\d|2[0-3])[:：]([0-5]\d)/g, " ")
      .replace(/能不能|可不可以|可以不|可以|能否|能/g, " ")
      .replace(/帮我|给我|麻烦你|麻烦|请你|请/g, " ")
      .replace(/设置|设个|定个|定一个|建个|创建/g, " ")
      .replace(/提醒我|提醒一下我|提醒一下|提醒|闹钟|定时|叫我|喊我|别忘了|别忘|记得/g, " ")
      .replace(/到时候|到点/g, " ")
      .replace(/[吗嘛呢吧]$/g, " ")
      .replace(/[?？!！。,.，]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    content = content.replace(/^(我|一下|一个|一条)+/, "").trim();
    return content;
  }

  private async routeIntentIfNeeded(
    text: string,
    context: ChatContext
  ): Promise<RoutedIntent> {
    if (!Config.agentRouterEnabled || !this.mayNeedTool(text, context)) {
      return { action: "chat" };
    }

    const routerPrompt = [
      "你是微信机器人的工具路由器。请判断用户是否需要调用工具。",
      "不要因为用户没有写命令就拒绝；自然语言也可以触发工具。",
      "只输出 JSON，不要 Markdown。",
      "action 只能是 chat, remember, recall, reminder, list_reminders, summarize_today, usage_report, set_group_mode, ignore。",
      "如果用户让你记住、保存、登记信息，使用 remember，并提取 memory。",
      "如果用户询问之前保存的信息，使用 recall，并提取 query。",
      "如果用户要求设置提醒，使用 reminder，并给出 remindAt 的 ISO 8601 时间和 reminderContent；每天/每日提醒时 repeat 为 daily。",
      "如果用户询问有哪些提醒、为什么没提醒、之前让你提醒过什么，使用 list_reminders。",
      "如果用户要求总结今天/本群/当前对话，使用 summarize_today。",
      "如果用户询问 token、消耗、调用次数，使用 usage_report。",
      "如果群聊用户想调整机器人发言频率，使用 set_group_mode，并给出 mode：quiet、smart 或 active。",
      "quiet 表示少说话、只在被点名时回复；smart 表示正常智能判断；active 表示更主动参与。",
      `当前日期：${this.currentDate}`,
      `当前时间：${this.currentDateTime}`,
      `会话：${context.chatName}`,
      `会话类型：${context.scope}`,
      `发言人：${context.talkerName}`,
      "示例输出：",
      "{\"action\":\"remember\",\"memory\":\"高数考试是7月10日上午\",\"tags\":[\"考试\"]}",
      "{\"action\":\"reminder\",\"remindAt\":\"2026-07-05T08:00:00+08:00\",\"reminderContent\":\"交作业\",\"repeat\":\"none\"}",
      "{\"action\":\"set_group_mode\",\"mode\":\"quiet\"}",
    ].join("\n");

    try {
      const result = await this.completeChat(
        [
          { role: "system", content: routerPrompt },
          { role: "user", content: text },
        ],
        context,
        "router",
        0.1
      );
      return this.parseIntent(result.text);
    } catch (e: any) {
      this.logApiError(e);
      return { action: "chat" };
    }
  }

  private handleRemember(
    intent: RoutedIntent,
    text: string,
    context: ChatContext
  ): string {
    const memory = intent.memory || text;
    this.store.addMemory(context, memory, intent.tags || []);
    return intent.reply || `我记住了：${memory}`;
  }

  private async handleRecall(
    intent: RoutedIntent,
    text: string,
    context: ChatContext
  ): Promise<string> {
    const query = intent.query || text;
    const memories = this.store.searchMemories(context, query, 12);
    if (!memories.length) {
      return "我这里还没找到相关记忆。你可以直接告诉我“帮我记住……”";
    }
    const memoryText = memories
      .map((memory, index) => `${index + 1}. ${memory.content}`)
      .join("\n");
    return this.onChatGPT(
      `用户正在查询记忆：“${query}”。请根据这些记忆自然回答，不要编造：\n${memoryText}`,
      context
    );
  }

  private handleReminder(
    intent: RoutedIntent,
    text: string,
    context: ChatContext
  ): string {
    let remindAt = intent.remindAt ? new Date(intent.remindAt) : null;
    if (!remindAt || Number.isNaN(remindAt.getTime())) {
      return "我想帮你设提醒，但没能确定具体时间。你可以说得更明确一点，比如“明天上午9点提醒我交作业”。";
    }
    const repeat: ReminderRepeat = intent.repeat === "daily" ? "daily" : "none";
    if (repeat === "daily") {
      while (remindAt.getTime() <= Date.now()) {
        remindAt.setDate(remindAt.getDate() + 1);
      }
    } else if (remindAt.getTime() <= Date.now()) {
      return "这个提醒时间已经过去了。你可以换一个未来时间，比如“明天上午9点提醒我交作业”。";
    }
    const content = intent.reminderContent || intent.memory || text;
    this.store.addReminder(context, remindAt.toISOString(), content, repeat);
    const target = context.scope === "group" ? "在本群" : "私聊";
    const repeatText = repeat === "daily" ? "每天 " : "";
    return `好，我会${target}${repeatText}${this.formatLocalDateTime(
      remindAt
    )} 提醒你：${content}`;
  }

  private handleListReminders(context: ChatContext): string {
    const reminders = this.store.getReminders(context.chatId, 12);
    if (!reminders.length) {
      return "当前会话里还没有提醒记录。你可以说“明天上午9点提醒我交作业”。";
    }

    const statusText: Record<ReminderItem["status"], string> = {
      pending: "待提醒",
      sent: "已提醒",
      cancelled: "已取消",
    };
    const lines = reminders.map((reminder, index) => {
      const repeat = reminder.repeat === "daily" ? "每天，" : "";
      const sent = reminder.lastSentAt
        ? `；上次提醒：${this.formatLocalDateTime(new Date(reminder.lastSentAt))}`
        : "";
      return `${index + 1}. ${statusText[reminder.status]}：${repeat}${this.formatLocalDateTime(
        new Date(reminder.remindAt)
      )}，${reminder.content}${sent}`;
    });
    return ["当前会话的提醒记录：", ...lines].join("\n");
  }

  private async handleSummarizeToday(context: ChatContext): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    const messages = this.store.getMessagesForDate(context.chatId, today);
    if (!messages.length) {
      return "今天这个会话里还没有可总结的记录。";
    }
    const text = messages
      .slice(-120)
      .map((message) => `${message.talkerName}[${message.role}]: ${message.text}`)
      .join("\n");
    const result = await this.completeChat(
      [
        {
          role: "system",
          content:
            "请总结今天的微信对话，提取主题、待办、决定、重要信息。保持简洁自然。",
        },
        { role: "user", content: text },
      ],
      context,
      "summary",
      0.3
    );
    return result.text;
  }

  private handleUsageReport(context: ChatContext): string {
    const today = new Date().toISOString().slice(0, 10);
    const chatSummary = this.store.getUsageSummary(today, context.chatId);
    const lines = [
      `当前会话今天调用：${chatSummary.calls} 次`,
      `当前会话今天消耗：${chatSummary.totalTokens} tokens`,
      `输入/输出：${chatSummary.promptTokens}/${chatSummary.completionTokens}`,
    ];
    if (Config.allowGlobalUsageReport && context.scope === "private") {
      const todaySummary = this.store.getUsageSummary(today);
      const totalSummary = this.store.getUsageSummary();
      lines.push(`今天全局总消耗：${todaySummary.totalTokens} tokens`);
      lines.push(`累计全局总消耗：${totalSummary.totalTokens} tokens`);
    }
    return lines.join("\n");
  }

  private handleSetGroupMode(intent: RoutedIntent, context: ChatContext): string {
    if (context.scope !== "group") {
      return "群聊模式只能在群里切换。";
    }
    const mode = this.isGroupMode(intent.mode) ? intent.mode : null;
    if (!mode) {
      return this.groupModeMenu();
    }
    this.store.setGroupMode(context.chatId, context.chatName, mode);
    return `已切换：${this.describeGroupMode(mode)}`;
  }

  private async completeChat(
    messages: Array<any>,
    context: ChatContext,
    feature: string,
    temperature?: number,
    model: string = Config.openaiModel
  ): Promise<CompletionResult> {
    const response = await this.openaiApiInstance.createChatCompletion({
      model,
      temperature,
      messages,
    });
    const text = response?.data?.choices[0]?.message?.content?.trim() || "";
    const usage = response?.data?.usage;
    const estimatedPrompt = this.estimateTokens(
      messages.map((message) => this.stringifyContent(message.content)).join("\n")
    );
    const estimatedCompletion = this.estimateTokens(text);
    const promptTokens = usage?.prompt_tokens || estimatedPrompt;
    const completionTokens = usage?.completion_tokens || estimatedCompletion;
    const totalTokens =
      usage?.total_tokens || promptTokens + completionTokens || estimatedPrompt;
    this.store.addUsage({
      scope: context.scope,
      chatId: context.chatId,
      chatName: context.chatName,
      model,
      feature,
      promptTokens,
      completionTokens,
      totalTokens,
      estimated: !usage,
    });
    return {
      text,
      promptTokens,
      completionTokens,
      totalTokens,
      estimated: !usage,
    };
  }

  private async handleNonTextMessage(
    message: Message,
    context: ChatContext,
    messageType: MessageType
  ) {
    const typeName = MessageType[messageType] || "Unknown";
    const shouldProcess = this.shouldProcessMediaMessage(
      message.text() || "",
      context
    );

    this.rememberPendingMedia(message, context, messageType, typeName);

    if (!shouldProcess) {
      this.store.addMessage({
        ...context,
        role: "user",
        text: `[${typeName}] 已收到，未调用多模态模型。需要理解时可在后续消息中 @我并说“看一下这张图/这段语音/这个视频”。`,
        messageType,
      });
      return;
    }

    let understoodText = "";

    try {
      understoodText = await this.processMediaMessage(message, context, messageType);
    } catch (error) {
      console.error(`❌ Failed to process ${typeName} message: ${error}`);
      understoodText = `[${typeName}] 多模态处理失败：${error}`;
    }

    this.store.addMessage({
      ...context,
      role: "user",
      text: understoodText,
      messageType,
    });

    const replyMessage = await this.handleUserText(understoodText, context);
    if (replyMessage) {
      const sentMessage = await this.replyToContext(message, context, replyMessage);
      this.store.addMessage({
        ...context,
        role: "assistant",
        text: sentMessage,
        messageType: MessageType.Text,
      });
    }
  }

  private shouldProcessMediaMessage(text: string, context: ChatContext): boolean {
    if (context.scope === "private") {
      return Config.privateAutoReply || this.startsWithTrigger(text);
    }
    if (!text.trim()) {
      return false;
    }
    return this.shouldRespond(text, context);
  }

  private isSupportedMediaMessage(messageType: MessageType): boolean {
    return [
      MessageType.Audio,
      MessageType.Image,
      MessageType.Video,
    ].includes(messageType);
  }

  private rememberPendingMedia(
    message: Message,
    context: ChatContext,
    messageType: MessageType,
    typeName: string
  ) {
    if (!this.isSupportedMediaMessage(messageType)) {
      return;
    }
    this.prunePendingMedia(context.chatId);
    const pending = this.pendingMediaByChat.get(context.chatId) || [];
    pending.push({
      message,
      messageType,
      typeName,
      timestamp: Date.now(),
      talkerName: context.talkerName,
    });
    this.pendingMediaByChat.set(
      context.chatId,
      pending.slice(-this.pendingMediaLimit)
    );
  }

  private async consumeReferencedMediaIfNeeded(
    text: string,
    context: ChatContext
  ): Promise<string> {
    this.prunePendingMedia(context.chatId);
    const pending = this.pendingMediaByChat.get(context.chatId) || [];
    if (!pending.length || !this.referencesRecentMedia(text)) {
      return "";
    }

    const preferredType = this.preferredMediaTypeFromText(text);
    const media =
      [...pending]
        .reverse()
        .find((item) => !preferredType || item.messageType === preferredType) ||
      pending[pending.length - 1];
    if (!media) {
      return "";
    }

    if (!media.processedText) {
      media.processedText = await this.processMediaMessage(
        media.message,
        context,
        media.messageType
      );
      this.store.addMessage({
        ...context,
        talkerName: media.talkerName,
        role: "user",
        text: media.processedText,
        messageType: media.messageType,
      });
    }

    return [
      `最近媒体类型：${media.typeName}`,
      `发送者：${media.talkerName}`,
      media.processedText,
    ].join("\n");
  }

  private prunePendingMedia(chatId: string) {
    const now = Date.now();
    const pending = (this.pendingMediaByChat.get(chatId) || []).filter(
      (item) => now - item.timestamp <= this.pendingMediaTtlMs
    );
    if (pending.length) {
      this.pendingMediaByChat.set(chatId, pending);
    } else {
      this.pendingMediaByChat.delete(chatId);
    }
  }

  private referencesRecentMedia(text: string): boolean {
    const compact = text.replace(/\s+/g, "");
    return (
      this.isMentioned(text) ||
      this.startsWithTrigger(text) ||
      /这张|这个图|这段视频|这条语音|刚才.*(图|图片|截图|照片|视频|语音|音频)|上面.*(图|图片|截图|照片|视频|语音|音频)|上一条|前面.*(图|图片|截图|照片|视频|语音|音频)|图片|截图|照片|图里|图中|视频|语音|音频|看一下|看看|识别|转文字|解释一下/i.test(
        compact
      )
    );
  }

  private preferredMediaTypeFromText(text: string): MessageType | null {
    if (/语音|音频|录音|转文字/i.test(text)) {
      return MessageType.Audio;
    }
    if (/视频|片段|抽帧/i.test(text)) {
      return MessageType.Video;
    }
    if (/图片|截图|照片|图里|图中|这张/i.test(text)) {
      return MessageType.Image;
    }
    return null;
  }

  private async processMediaMessage(
    message: Message,
    context: ChatContext,
    messageType: MessageType
  ): Promise<string> {
    if (messageType === MessageType.Audio) {
      return this.transcribeAudioMessage(message, context);
    }
    if (messageType === MessageType.Image) {
      return this.describeImageMessage(message, context);
    }
    if (messageType === MessageType.Video) {
      return this.describeVideoMessage(message, context);
    }
    return `[${MessageType[messageType] || "Unknown"}]`;
  }

  private async describeImageMessage(
    message: Message,
    context: ChatContext
  ): Promise<string> {
    if (!Config.multimodalEnabled) {
      return "[Image] 已收到图片，但多模态功能未开启。";
    }
    const media = await this.readMessageMedia(message, MessageType.Image);
    const result = await this.completeChat(
      [
        {
          role: "system",
          content:
            "你是微信机器人的视觉理解模块。请识别图片内容、文字和关键细节。若是截图，请优先提取可读文字和用户可能关心的问题。",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "请理解这张微信图片，并给出对用户有帮助的回答。" },
            { type: "image_url", image_url: { url: media.dataUrl } },
          ],
        },
      ],
      context,
      "image_understanding",
      0.2,
      Config.visionModel
    );
    return `[图片理解]\n${result.text}`;
  }

  private async transcribeAudioMessage(
    message: Message,
    context: ChatContext
  ): Promise<string> {
    if (!Config.multimodalEnabled) {
      return "[Audio] 已收到语音，但多模态功能未开启。";
    }
    const media = await this.readMessageMedia(message, MessageType.Audio);
    try {
      const result = await this.completeChat(
        [
          {
            role: "system",
            content:
              "你是微信语音转写模块。请只输出语音转写文本，不要解释，不要加前后缀。",
          },
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: {
                  data: media.base64,
                  format: media.extension.replace(/^\./, "") || "sil",
                },
              },
            ],
          },
        ],
        context,
        "audio_transcription",
        0.1,
        Config.audioModel
      );
      return `[语音转文字]\n${result.text}`;
    } catch (error) {
      return [
        "[Audio]",
        `我已收到语音文件 ${media.name}，但当前音频模型没有成功识别。`,
        "微信 Web 协议不能稳定调用微信内置“转文字”。如果这是 .sil 微信语音，可能需要先加 silk/ffmpeg 转码后再送 ASR。",
      ].join("\n");
    }
  }

  private async describeVideoMessage(
    message: Message,
    context: ChatContext
  ): Promise<string> {
    if (!Config.multimodalEnabled) {
      return "[Video] 已收到视频，但多模态功能未开启。";
    }
    const media = await this.readMessageMedia(message, MessageType.Video);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-video-"));
    const videoPath = path.join(tempDir, media.name || `video${media.extension}`);
    fs.writeFileSync(videoPath, media.buffer);
    try {
      const framePaths = await this.extractVideoFrames(videoPath, tempDir);
      if (!framePaths.length) {
        return "[Video] 已收到视频，但当前服务器没有可用 ffmpeg，暂时无法抽帧理解。";
      }
      const content: Array<any> = [
        {
          type: "text",
          text: "这些图片是同一个微信视频中抽取的关键帧。请总结视频大意、画面变化和可能需要注意的信息。",
        },
      ];
      for (const framePath of framePaths) {
        const buffer = fs.readFileSync(framePath);
        content.push({
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${buffer.toString("base64")}`,
          },
        });
      }
      const result = await this.completeChat(
        [
          {
            role: "system",
            content: "你是微信视频理解模块。请根据抽帧图片总结视频内容。",
          },
          {
            role: "user",
            content,
          },
        ],
        context,
        "video_understanding",
        0.2,
        Config.visionModel
      );
      return `[视频理解]\n${result.text}`;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async readMessageMedia(
    message: Message,
    messageType: MessageType
  ): Promise<MediaFile> {
    const fileBox = await message.toFileBox();
    const buffer = await fileBox.toBuffer();
    if (buffer.length > Config.maxMediaBytes) {
      throw new Error(
        `媒体文件过大：${buffer.length} bytes，限制为 ${Config.maxMediaBytes} bytes`
      );
    }
    const name = fileBox.name || `message-${message.id}`;
    const extension = path.extname(name).toLowerCase();
    const mediaType = this.inferMediaType(fileBox.mediaType, extension, messageType);
    const base64 = buffer.toString("base64");
    return {
      name,
      mediaType,
      extension,
      buffer,
      base64,
      dataUrl: `data:${mediaType};base64,${base64}`,
    };
  }

  private inferMediaType(
    mediaType: string,
    extension: string,
    messageType: MessageType
  ): string {
    if (mediaType && mediaType !== "application/unknown") {
      return mediaType;
    }
    const map: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".m4a": "audio/mp4",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".sil": "audio/silk",
      ".amr": "audio/amr",
    };
    if (map[extension]) {
      return map[extension];
    }
    if (messageType === MessageType.Image) {
      return "image/jpeg";
    }
    if (messageType === MessageType.Audio) {
      return "audio/silk";
    }
    if (messageType === MessageType.Video) {
      return "video/mp4";
    }
    return "application/octet-stream";
  }

  private async extractVideoFrames(
    videoPath: string,
    tempDir: string
  ): Promise<string[]> {
    const frameCount = Math.max(1, Config.videoFrameCount);
    const outputPattern = path.join(tempDir, "frame-%02d.jpg");
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-i",
        videoPath,
        "-vf",
        `fps=1/${Math.max(1, Math.floor(30 / frameCount))}`,
        "-vframes",
        String(frameCount),
        outputPattern,
      ]);
    } catch (error) {
      console.warn(`ffmpeg frame extraction failed: ${error}`);
      return [];
    }
    return fs
      .readdirSync(tempDir)
      .filter((file) => /^frame-\d+\.jpg$/.test(file))
      .sort()
      .map((file) => path.join(tempDir, file));
  }

  private async enrichTextWithLink(text: string): Promise<string> {
    const url = this.extractFirstUrl(text);
    if (!url) {
      return text;
    }
    try {
      const snippet = await this.fetchWebPageSnippet(url);
      if (!snippet) {
        return text;
      }
      return [
        text,
        "",
        "以下是链接预读取内容，回答时可以参考：",
        snippet,
      ].join("\n");
    } catch (error) {
      console.warn(`link preview failed: ${error}`);
      return text;
    }
  }

  private extractFirstUrl(text: string): string | null {
    const match = text.match(/https?:\/\/[^\s<>"'，。)）]+/i);
    return match?.[0] || null;
  }

  private async fetchWebPageSnippet(urlText: string): Promise<string> {
    const url = new URL(urlText);
    if (!["http:", "https:"].includes(url.protocol) || this.isUnsafeHost(url.hostname)) {
      return "";
    }
    const html = await this.fetchText(url, 120000);
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
    const body = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
    return [`标题：${this.cleanHtmlText(title)}`, `正文摘录：${body.slice(0, 1800)}`]
      .filter((line) => !line.endsWith("："))
      .join("\n");
  }

  private fetchText(url: URL, maxBytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      const request = client.get(
        url,
        {
          timeout: 8000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; MyWechatBot/1.0; +https://github.com/Meloding/MyWechatBot)",
          },
        },
        (response) => {
          const statusCode = response.statusCode || 0;
          if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
            response.resume();
            const nextUrl = new URL(response.headers.location, url);
            if (this.isUnsafeHost(nextUrl.hostname)) {
              reject(new Error("unsafe redirect host"));
              return;
            }
            this.fetchText(nextUrl, maxBytes).then(resolve).catch(reject);
            return;
          }
          if (statusCode < 200 || statusCode >= 300) {
            response.resume();
            reject(new Error(`HTTP ${statusCode}`));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= maxBytes) {
              chunks.push(chunk);
            } else {
              response.destroy();
            }
          });
          response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          response.on("error", reject);
        }
      );
      request.on("timeout", () => request.destroy(new Error("request timeout")));
      request.on("error", reject);
    });
  }

  private isUnsafeHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local")) {
      return true;
    }
    return /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(
      host
    );
  }

  private cleanHtmlText(text: string): string {
    return text
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  }

  private shouldRespond(text: string, context: ChatContext): boolean {
    if (context.scope === "private") {
      return Config.privateAutoReply || this.startsWithTrigger(text);
    }

    const mode = this.store.getGroupMode(context.chatId, Config.defaultGroupMode);
    const direct = this.isMentioned(text) || this.startsWithTrigger(text);
    const modeSwitch = this.looksLikeModeSwitchRequest(text);
    if (mode === "quiet") {
      return direct || modeSwitch;
    }

    if (mode === "smart") {
      return direct || modeSwitch || this.looksAddressedToBot(text);
    }

    const now = Date.now();
    const lastReplyAt = this.lastGroupReplyAt.get(context.chatId) || 0;
    const cooledDown = now - lastReplyAt > 90 * 1000;
    const shouldSpeak =
      direct ||
      modeSwitch ||
      this.looksAddressedToBot(text) ||
      this.mayNeedTool(text, context) ||
      (cooledDown && this.looksLikeOpenQuestion(text));
    if (shouldSpeak) {
      this.lastGroupReplyAt.set(context.chatId, now);
    }
    return shouldSpeak;
  }

  private cleanMessage(rawText: string, context: ChatContext): string {
    let text = rawText;
    if (context.scope === "group") {
      const mention = `@${this.botName}`;
      if (text.startsWith(mention)) {
        text = text.slice(mention.length).trimStart();
      }
    }
    if (this.chatgptTriggerKeyword && text.startsWith(this.chatgptTriggerKeyword)) {
      text = text.slice(this.chatgptTriggerKeyword.length);
    }
    return text;
  }

  private isIgnorable(
    talker: ContactInterface,
    messageType: MessageType,
    text: string
  ): boolean {
    return (
      (this.disableSelfChat && talker.self()) ||
      talker.name() === "微信团队" ||
      messageType === MessageType.Unknown ||
      messageType === MessageType.Contact ||
      messageType === MessageType.ChatHistory ||
      messageType === MessageType.GroupNote ||
      messageType === MessageType.Transfer ||
      messageType === MessageType.Post ||
      messageType === MessageType.MiniProgram ||
      messageType === MessageType.Emoticon ||
      messageType === MessageType.Location ||
      messageType === MessageType.Recalled ||
      messageType === MessageType.RedEnvelope ||
      text.includes("收到一条视频/语音聊天消息，请在手机上查看") ||
      text.includes("收到红包，请在手机上查看") ||
      text.includes("/cgi-bin/mmwebwx-bin/webwxgetpubliclinkimg")
    );
  }

  private async createContext(message: Message): Promise<ChatContext> {
    const talker: any = message.talker();
    const room: any = message.room();
    if (room) {
      const topic = await room.topic();
      return {
        scope: "group",
        chatId: room.id,
        chatName: topic || room.id,
        talkerId: talker.id,
        talkerName: talker.name(),
      };
    }
    return {
      scope: "private",
      chatId: talker.id,
      chatName: talker.name(),
      talkerId: talker.id,
      talkerName: talker.name(),
    };
  }

  private async replyToContext(
    message: Message,
    context: ChatContext,
    text: string
  ): Promise<string> {
    const preparedText = this.prepareReplyForWechat(text);
    if (!preparedText.trim()) {
      return "";
    }
    const room = message.room();
    if (context.scope === "group" && room) {
      await this.reply(room, preparedText);
      return preparedText;
    }
    await this.reply(message.talker(), preparedText);
    return preparedText;
  }

  private async reply(
    talker: RoomInterface | ContactInterface,
    message: string
  ): Promise<void> {
    const messages = this.splitWechatMessage(
      message,
      Config.replyMaxLength || this.SINGLE_MESSAGE_MAX_SIZE,
      Config.replyMaxSegments || 8
    );
    for (const msg of messages) {
      await talker.say(msg);
    }
  }

  private prepareReplyForWechat(text: string): string {
    const withoutMarkdown = Config.stripMarkdown ? this.stripMarkdown(text) : text;
    return withoutMarkdown
      .replace(/\n{4,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  private stripMarkdown(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, (block) =>
        block.replace(/```[a-zA-Z0-9_-]*/g, "").replace(/```/g, "")
      )
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/_([^_\n]+)_/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "• ")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）")
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1（图片：$2）")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/\n\s*\|[-:| ]+\|\s*\n/g, "\n")
      .replace(/\|/g, "｜");
  }

  private splitWechatMessage(
    text: string,
    maxLength: number,
    maxSegments: number
  ): string[] {
    const segments: string[] = [];
    let rest = text.trim();
    while (rest.length > maxLength && segments.length < maxSegments - 1) {
      const cutAt = this.findSplitIndex(rest, maxLength);
      segments.push(rest.slice(0, cutAt).trim());
      rest = rest.slice(cutAt).trim();
    }
    if (rest.length > maxLength && segments.length >= maxSegments - 1) {
      segments.push(`${rest.slice(0, maxLength - 18).trim()}\n\n（内容较长，已截断）`);
    } else if (rest) {
      segments.push(rest);
    }
    return segments.filter(Boolean);
  }

  private findSplitIndex(text: string, maxLength: number): number {
    const candidates = ["\n\n", "\n", "。", "？", "！", ".", "?", "!", "；", ";", "，", ","];
    let best = -1;
    for (const delimiter of candidates) {
      const index = text.lastIndexOf(delimiter, maxLength);
      if (index > Math.floor(maxLength * 0.45)) {
        best = Math.max(best, index + delimiter.length);
      }
    }
    return best > 0 ? best : maxLength;
  }

  private async sendReminder(weChatBot: any, reminder: ReminderItem) {
    try {
      const target =
        reminder.scope === "group"
          ? weChatBot.Room.load(reminder.chatId)
          : weChatBot.Contact.load(reminder.chatId);
      const message = await this.createReminderMessage(reminder);
      await target.say(message);
      this.store.markReminderSent(reminder.id);
    } catch (error) {
      console.error(`❌ Failed to send reminder ${reminder.id}: ${error}`);
    }
  }

  private async createReminderMessage(reminder: ReminderItem): Promise<string> {
    if (!this.shouldGenerateReminderContent(reminder.content)) {
      return `提醒：${reminder.content}`;
    }
    const context: ChatContext = {
      scope: reminder.scope,
      chatId: reminder.chatId,
      chatName: reminder.chatName,
      talkerId: reminder.createdBy,
      talkerName: reminder.createdBy,
    };
    try {
      const result = await this.completeChat(
        [
          {
            role: "system",
            content: [
              "你正在执行一个微信定时任务。",
              "如果用户要求写文案、慰问、回复、总结或生成内容，请直接给出可发送的正文。",
              "不要解释自己是模型，不要说不能定时，不要再反问。",
              `当前时间：${this.currentDateTime}`,
            ].join("\n"),
          },
          {
            role: "user",
            content: `到点了，请执行这个任务：${reminder.content}`,
          },
        ],
        context,
        "scheduled_task",
        0.6
      );
      return result.text || `提醒：${reminder.content}`;
    } catch (error) {
      console.error(`❌ Failed to generate reminder content: ${error}`);
      return `提醒：${reminder.content}`;
    }
  }

  private shouldGenerateReminderContent(content: string): boolean {
    return /写|生成|起草|拟|文案|慰问|回复|总结/.test(content);
  }

  private parseIntent(raw: string): RoutedIntent {
    const cleaned = raw
      .replace(/^```json/i, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (this.isToolAction(parsed.action)) {
        return parsed;
      }
    } catch {
      // Fall through to chat.
    }
    return { action: "chat" };
  }

  private isToolAction(action: unknown): action is ToolAction {
    return [
      "chat",
      "remember",
      "recall",
      "reminder",
      "list_reminders",
      "summarize_today",
      "usage_report",
      "set_group_mode",
      "ignore",
    ].includes(String(action));
  }

  private isGroupMode(mode: unknown): mode is GroupMode {
    return ["quiet", "smart", "active"].includes(String(mode));
  }

  private mayNeedTool(text: string, context?: ChatContext): boolean {
    return (
      /记住|记一下|保存|存一下|提醒|闹钟|别忘|定时|总结|复盘|消耗|token|用量|花了多少|我之前|之前说|安排|ddl|deadline|考试|作业/i.test(
        text
      ) ||
      (context?.scope === "group" && this.looksLikeModeSwitchRequest(text))
    );
  }

  private startsWithTrigger(text: string): boolean {
    return Boolean(
      this.chatgptTriggerKeyword && text.startsWith(this.chatgptTriggerKeyword)
    );
  }

  private isMentioned(text: string): boolean {
    return Boolean(this.botName && text.includes(`@${this.botName}`));
  }

  private looksAddressedToBot(text: string): boolean {
    return (
      this.isMentioned(text) ||
      text.includes(this.botName) ||
      /机器人|bot|助手|小助手|你觉得|你能|能不能帮|帮我|记住|提醒|总结/i.test(
        text
      )
    );
  }

  private looksLikeOpenQuestion(text: string): boolean {
    return /[?？]|吗|怎么|为什么|如何|谁知道|有没有|能不能|可以不|咋办/.test(
      text
    );
  }

  private parseDirectGroupModeCommand(
    text: string
  ): { type: "none" } | { type: "menu" } | { type: "switch"; mode: GroupMode } {
    const compact = text.replace(/\s+/g, "");
    if (/^#(模式|群模式|机器人模式|mode|help|\?)$/i.test(compact)) {
      return { type: "menu" };
    }
    if (/^#([123])$/.test(compact)) {
      const modeMap: Record<string, GroupMode> = {
        "1": "quiet",
        "2": "smart",
        "3": "active",
      };
      return { type: "switch", mode: modeMap[compact.slice(1)] };
    }
    if (/^#(安静|静默|少说话|quiet|silent)$/.test(compact)) {
      return { type: "switch", mode: "quiet" };
    }
    if (/^#(智能|正常|默认|smart|normal)$/.test(compact)) {
      return { type: "switch", mode: "smart" };
    }
    if (/^#(活跃|主动|积极|多说话|active)$/.test(compact)) {
      return { type: "switch", mode: "active" };
    }
    if (/^(群聊模式|群模式|机器人模式|切换模式|模式切换)$/.test(compact)) {
      return { type: "menu" };
    }
    const mode = this.parseNaturalGroupMode(text);
    return mode ? { type: "switch", mode } : { type: "none" };
  }

  private parseNaturalGroupMode(text: string): GroupMode | null {
    const compact = text.replace(/\s+/g, "");
    const looksLikeModeCommand =
      /群聊模式|群模式|机器人模式|进入.*模式|切换.*模式|改成.*模式/.test(
        compact
      );
    if (!looksLikeModeCommand) {
      return null;
    }
    if (/安静|静默|只@|只艾特|少说话/.test(compact)) {
      return "quiet";
    }
    if (/智能|聪明|正常|默认/.test(compact)) {
      return "smart";
    }
    if (/活跃|主动|积极|多说话/.test(compact)) {
      return "active";
    }
    return null;
  }

  private looksLikeModeSwitchRequest(text: string): boolean {
    return /群聊模式|群模式|机器人模式|切换模式|进入.*模式|改成.*模式|安静一点|少说话|别太主动|活跃一点|积极一点|多说点|正常回复|默认模式/i.test(
      text.replace(/\s+/g, "")
    );
  }

  private groupModeMenu(): string {
    return [
      "群聊模式：",
      "#1 安静：只在被 @ 或触发词出现时回复",
      "#2 智能：明显问到我或需要工具时回复",
      "#3 活跃：更主动参与，但有冷却时间",
      "也可以直接发：#安静 / #智能 / #活跃",
    ].join("\n");
  }

  private describeGroupMode(mode: GroupMode): string {
    const descriptions: Record<GroupMode, string> = {
      quiet: "安静模式：只在被 @ 或触发词出现时回复",
      smart: "智能模式：被明显问到或需要工具时回复",
      active: "活跃模式：会更积极参与，但仍有冷却时间避免刷屏",
    };
    return descriptions[mode];
  }

  private parseChineseNumber(text: string): number | null {
    if (/^\d+$/.test(text)) {
      return Number(text);
    }
    const digits: Record<string, number> = {
      零: 0,
      〇: 0,
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
    };
    if (text === "十") {
      return 10;
    }
    const tenIndex = text.indexOf("十");
    if (tenIndex >= 0) {
      const tensText = text.slice(0, tenIndex);
      const onesText = text.slice(tenIndex + 1);
      const tens = tensText ? digits[tensText] : 1;
      const ones = onesText ? digits[onesText] : 0;
      if (tens === undefined || ones === undefined) {
        return null;
      }
      return tens * 10 + ones;
    }
    if (text.length === 1 && digits[text] !== undefined) {
      return digits[text];
    }
    return null;
  }

  private startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  private formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private formatLocalDateTime(date: Date): string {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${this.formatLocalDate(date)} ${hours}:${minutes}`;
  }

  private estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 2));
  }

  private stringifyContent(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  private systemContext(): ChatContext {
    return {
      scope: "system",
      chatId: "system",
      chatName: "system",
      talkerId: "system",
      talkerName: "system",
    };
  }

  private logApiError(e: any) {
    console.error(`❌ ${e}`);
    const errorResponse = e?.response;
    const errorCode = errorResponse?.status;
    const errorStatus = errorResponse?.statusText;
    const errorMessage = errorResponse?.data?.error?.message;
    if (errorCode && errorStatus) {
      console.error(`❌ Code ${errorCode}: ${errorStatus}`);
    }
    if (errorMessage) {
      console.error(`❌ ${errorMessage}`);
    }
  }
}
