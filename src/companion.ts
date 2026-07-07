import { Config } from "./config.js";
import fs from "fs";
import http from "http";
import https from "https";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { FileBox } from "file-box";
import { Message } from "wechaty";
import { ContactInterface, RoomInterface } from "wechaty/impls";
import { Configuration, OpenAIApi } from "openai";
import {
  BotStore,
  ChatAccessStatus,
  ChatContext,
  ChatScope,
  GroupMode,
  KnownChat,
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
  | "agent_task"
  | "summarize_today"
  | "usage_report"
  | "set_group_mode"
  | "ignore";

interface RoutedIntent {
  action: ToolAction;
  mode?: GroupMode;
  agentTool?: AgentToolName;
  risk?: AgentRisk;
  code?: string;
  codeLanguage?: string;
  fileType?: string;
  title?: string;
  reply?: string;
  memory?: string;
  query?: string;
  remindAt?: string;
  reminderContent?: string;
  repeat?: ReminderRepeat;
  repeatCount?: number;
  tags?: string[];
  reason?: string;
}

interface ParsedReminder {
  remindAt: Date;
  content: string;
  repeat: ReminderRepeat;
  repeatCount: number;
}

type AgentToolName =
  | "schedule_document"
  | "file_create"
  | "usage_report_file"
  | "code_run"
  | "plan_only";

type AgentRisk = "low" | "medium" | "high";

interface PendingApproval {
  id: string;
  createdAt: number;
  context: ChatContext;
  intent: RoutedIntent;
  originalText: string;
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

interface RootListEntry {
  scope: ChatScope;
  chatId: string;
  chatName: string;
}

export class WechatCompanion {
  botName: string = "";
  startTime: Date = new Date();
  disableSelfChat: boolean = false;
  legacyTriggerKeyword: string = Config.legacyTriggerKeyword;
  companionErrorMessage: string = "我这边刚刚卡了一下，等会儿再试试。";
  SINGLE_MESSAGE_MAX_SIZE: number = 500;

  private store = new BotStore(Config.botDataPath);
  private openaiAccountConfig: any;
  private openaiApiInstance: any;
  private weChatBot: any;
  private reminderLoopStarted = false;
  private lastGroupReplyAt: Map<string, number> = new Map();
  private pendingMediaByChat: Map<string, PendingMediaMessage[]> = new Map();
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private pendingFilesByChat: Map<string, string[]> = new Map();
  private rootLastListByUser: Map<string, RootListEntry[]> = new Map();
  private readonly pendingMediaTtlMs = 10 * 60 * 1000;
  private readonly pendingMediaLimit = 6;
  private readonly pendingApprovalTtlMs = 10 * 60 * 1000;

  private get currentDate(): string {
    return this.formatLocalDate(new Date());
  }

  private get currentDateTime(): string {
    return this.formatLocalDateTime(new Date());
  }

  private get companionSystemContent(): string {
    return [
      "你是一个接入微信的口袋搭子，名字可以跟随当前微信账号。",
      "你的风格自然、温暖、有分寸，像一个可靠的朋友和工具人。",
      "你会记住用户明确交代的重要信息，但不要编造不存在的记忆。",
      "你支持私聊和群聊定时提醒；不要声称群聊不能定时，除非系统明确报错。",
      "你通过用户配置的模型 API 工作，回复会消耗 token；被问到成本或消耗时要诚实说明，并提示可以查询 token 用量。",
      "在群聊里不要刷屏，不确定是否该说话时保持克制。",
      "回答尽量像真人聊天：短一点、自然一点，能一句话说清就不要写长段。",
      `当前日期：${this.currentDate}`,
    ].join("\n");
  }

  setBotName(botName: string) {
    this.botName = botName;
  }

  private get chatGroupTriggerKeyword(): string {
    return `@${this.botName} ${this.legacyTriggerKeyword || ""}`;
  }

  async startCompanion() {
    try {
      this.openaiAccountConfig = new Configuration({
        organization: Config.openaiOrganizationID,
        apiKey: Config.openaiApiKey,
        basePath: Config.openaiBasePath || undefined,
      });
      this.openaiApiInstance = new OpenAIApi(this.openaiAccountConfig);
      console.log(`🤖️ Companion name is: ${this.botName}`);
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
      console.log(`✅ Companion starts success, ready to handle message!`);
    } catch (e) {
      console.error(`❌ ${e}`);
    }
  }

  startReminderLoop(weChatBot: any) {
    this.weChatBot = weChatBot;
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

    if (
      Config.ignoreOfficialAccounts &&
      this.isOfficialContact(message.talker()) &&
      !this.isRootAuthText(text)
    ) {
      return true;
    }

    const context = await this.createContext(message);
    const rootHandled = await this.handleRootControlMessage(message, context, text);
    if (rootHandled) {
      return true;
    }

    const modeCommand = this.parseDirectGroupModeCommand(text);
    if (context.scope === "group" && modeCommand.type === "menu") {
      await this.replyToContext(message, context, this.groupModeMenu());
      return true;
    }

    if (context.scope === "group" && modeCommand.type === "status") {
      const mode = this.store.getGroupMode(context.chatId, Config.defaultGroupMode);
      await this.replyToContext(message, context, `当前是：${this.describeGroupMode(mode)}`);
      return true;
    }

    if (context.scope === "group" && modeCommand.type === "switch") {
      this.store.setGroupMode(context.chatId, context.chatName, modeCommand.mode);
      await this.replyToContext(message, context, `已切换：${this.describeGroupMode(modeCommand.mode)}`);
      return true;
    }

    if (text === "菜单" || text === "帮助") {
      await this.replyToContext(message, context,
        [
          "我现在支持：",
          "1. 私聊直接对话，不需要 Hi bot:",
          "2. 群聊可用 /模式、/安静、/智能、/活跃、/超活跃、/话唠 切换模式",
          "3. 自然语言让我记住信息、查询记忆、设置提醒",
          "4. 说“总结今天”或“今天 token 消耗”查看总结",
        ].join("\n")
      );
      return true;
    }

    const myKeyword = "麦扣";
    if (text.includes(myKeyword)) {
      await this.replyToContext(message, context, "🤖️：call我做咩啊大佬");
      return true;
    }

    return false;
  }

  private async handleRootControlMessage(
    message: Message,
    context: ChatContext,
    text: string
  ): Promise<boolean> {
    if (this.isRootAuthText(text)) {
      this.store.addRootUser(context.talkerId, context.talkerName);
      await this.replyToContext(message, context, "添加 root 成功。发送 /root帮助 查看管理命令。");
      return true;
    }

    if (!this.store.isRootUser(context.talkerId)) {
      return false;
    }

    const compact = text.trim();
    if (!compact.startsWith("/")) {
      return false;
    }

    if (/^\/root帮助$/.test(compact)) {
      await this.replyToContext(message, context,
        [
          "root 命令：",
          "/好友列表",
          "/群列表",
          "/会话列表",
          "/白名单",
          "/允许 编号",
          "/禁止 编号",
          "/总结 编号",
          "/root列表",
        ].join("\n")
      );
      return true;
    }

    if (/^\/root列表$/.test(compact)) {
      const roots = this.store.getRootUsers();
      await this.replyToContext(message, context,
        roots.length
          ? roots.map((root, index) => `${index + 1}. ${root.talkerName}`).join("\n")
          : "还没有 root 用户。"
      );
      return true;
    }

    if (/^\/白名单$/.test(compact)) {
      const rules = this.store.getChatAccessRules();
      await this.replyToContext(message, context,
        rules.length
          ? rules
              .map(
                (rule, index) =>
                  `${index + 1}. ${rule.status === "allow" ? "允许" : "禁止"} [${
                    rule.scope === "group" ? "群" : "好友"
                  }] ${rule.chatName}`
              )
              .join("\n")
          : "当前没有显式白/黑名单规则。默认允许好友和群，root 可以用 /禁止 编号 关闭某个会话。"
      );
      return true;
    }

    if (/^\/好友列表$/.test(compact)) {
      const contacts = await this.listContactsForRoot();
      this.rootLastListByUser.set(context.talkerId, contacts);
      await this.replyToContext(message, context, this.formatRootList(contacts, "好友列表"));
      return true;
    }

    if (/^\/群列表$/.test(compact)) {
      const rooms = await this.listRoomsForRoot();
      this.rootLastListByUser.set(context.talkerId, rooms);
      await this.replyToContext(message, context, this.formatRootList(rooms, "群列表"));
      return true;
    }

    if (/^\/会话列表$/.test(compact)) {
      const chats = this.store.getKnownChats().map((chat) => this.knownChatToRootEntry(chat));
      this.rootLastListByUser.set(context.talkerId, chats);
      await this.replyToContext(message, context, this.formatRootList(chats, "已知会话"));
      return true;
    }

    const accessMatch = compact.match(/^\/(允许|禁止|剔除|拉黑)\s*(\d+|.+)$/);
    if (accessMatch) {
      const status: ChatAccessStatus =
        accessMatch[1] === "允许" ? "allow" : "deny";
      const target = this.resolveRootListEntry(context.talkerId, accessMatch[2]);
      if (!target) {
        await this.replyToContext(message, context, "没找到这个编号。请先发送 /好友列表、/群列表 或 /会话列表。");
        return true;
      }
      this.store.setChatAccess(target, status, context.talkerName);
      await this.replyToContext(message, context,
        `${status === "allow" ? "已允许" : "已禁止"} [${
          target.scope === "group" ? "群" : "好友"
        }] ${target.chatName}`
      );
      return true;
    }

    const summaryMatch = compact.match(/^\/总结\s*(\d+|.+)$/);
    if (summaryMatch) {
      const target = this.resolveRootListEntry(context.talkerId, summaryMatch[1]);
      if (!target) {
        await this.replyToContext(message, context, "没找到这个编号。请先发送 /会话列表。");
        return true;
      }
      await this.replyToContext(message, context, await this.summarizeChatForRoot(target, context));
      return true;
    }

    return false;
  }

  private isRootAuthText(text: string): boolean {
    const token = Config.rootAuthToken.trim();
    if (!token || token.length < 16) {
      return false;
    }
    const normalized = text.trim();
    return normalized === token || normalized === `/root ${token}`;
  }

  private isChatAllowed(context: ChatContext): boolean {
    if (context.scope === "system" || this.store.isRootUser(context.talkerId)) {
      return true;
    }
    const rule = this.store.getChatAccess(context.chatId);
    return rule?.status !== "deny";
  }

  private async listContactsForRoot(): Promise<RootListEntry[]> {
    if (!this.weChatBot?.Contact?.findAll) {
      return this.store
        .getKnownChats("private")
        .map((chat) => this.knownChatToRootEntry(chat));
    }
    const contacts = await this.weChatBot.Contact.findAll();
    return contacts
      .filter((contact: any) => !contact.self?.() && !this.isOfficialContact(contact))
      .map((contact: any) => ({
        scope: "private" as ChatScope,
        chatId: contact.id,
        chatName: contact.name?.() || contact.id,
      }))
      .sort((a: RootListEntry, b: RootListEntry) =>
        a.chatName.localeCompare(b.chatName, "zh-CN")
      );
  }

  private async listRoomsForRoot(): Promise<RootListEntry[]> {
    if (!this.weChatBot?.Room?.findAll) {
      return this.store
        .getKnownChats("group")
        .map((chat) => this.knownChatToRootEntry(chat));
    }
    const rooms = await this.weChatBot.Room.findAll();
    const entries: RootListEntry[] = [];
    for (const room of rooms) {
      entries.push({
        scope: "group",
        chatId: room.id,
        chatName: (await room.topic()) || room.id,
      });
    }
    return entries.sort((a, b) => a.chatName.localeCompare(b.chatName, "zh-CN"));
  }

  private knownChatToRootEntry(chat: KnownChat): RootListEntry {
    return {
      scope: chat.scope,
      chatId: chat.chatId,
      chatName: chat.chatName,
    };
  }

  private formatRootList(entries: RootListEntry[], title: string): string {
    if (!entries.length) {
      return `${title}为空。`;
    }
    const lines = entries.slice(0, 80).map((entry, index) => {
      const rule = this.store.getChatAccess(entry.chatId);
      const status = rule?.status === "deny" ? "禁止" : "允许";
      return `${index + 1}. [${entry.scope === "group" ? "群" : "好友"}][${
        status
      }] ${entry.chatName}`;
    });
    if (entries.length > lines.length) {
      lines.push(`还有 ${entries.length - lines.length} 个未显示。`);
    }
    return [`${title}：`, ...lines].join("\n");
  }

  private resolveRootListEntry(
    rootTalkerId: string,
    text: string
  ): RootListEntry | null {
    const entries = this.rootLastListByUser.get(rootTalkerId) || [];
    const trimmed = text.trim();
    if (/^\d+$/.test(trimmed)) {
      return entries[Number(trimmed) - 1] || null;
    }
    return (
      entries.find((entry) => entry.chatName.includes(trimmed)) ||
      this.store
        .getKnownChats()
        .map((chat) => this.knownChatToRootEntry(chat))
        .find((entry) => entry.chatName.includes(trimmed)) ||
      null
    );
  }

  private async summarizeChatForRoot(
    target: RootListEntry,
    requesterContext: ChatContext
  ): Promise<string> {
    const messages = this.store.getRecentMessages(target.chatId, 160);
    if (!messages.length) {
      return "这个会话还没有可总结的聊天记录。";
    }
    const text = messages
      .map((message) => `${message.talkerName}[${message.role}]: ${message.text}`)
      .join("\n");
    const result = await this.completeChat(
      [
        {
          role: "system",
          content:
            "你是 root 管理员的聊天摘要工具。请总结目标会话的主题、重要信息、待办、风险点。不要编造。",
        },
        {
          role: "user",
          content: `目标会话：${target.chatName}\n\n${text}`,
        },
      ],
      requesterContext,
      "root_chat_summary",
      0.2,
      Config.agentModel
    );
    return result.text;
  }

  async onMessage(message: Message) {
    const context = await this.createContext(message);
    const talker = message.talker();
    const rawText = message.text() || "";
    const messageType = message.type();

    this.logMessageMeta(message, context, messageType, rawText);

    if (this.isIgnorable(talker, messageType, rawText)) {
      return;
    }

    if (!this.isChatAllowed(context)) {
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
    const approvalReply = await this.handlePendingApprovalReply(
      cleanText || rawText,
      context
    );
    if (approvalReply) {
      const sentMessage = await this.replyToContext(message, context, approvalReply);
      await this.sendPendingFiles(message, context);
      this.store.addMessage({
        ...context,
        role: "assistant",
        text: sentMessage,
        messageType: MessageType.Text,
      });
      return;
    }

    const mediaContext = await this.consumeReferencedMediaIfNeeded(
      cleanText || rawText,
      context,
      rawText
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
    await this.sendPendingFiles(message, context);
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
      case "agent_task":
        return this.handleAgentTask(intent, text, context);
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
        return this.onCompanionChat(text, context);
    }
  }

  private async onCompanionChat(text: string, context: ChatContext): Promise<string> {
    const messages = this.createMessages(text, context);
    try {
      const result = await this.completeChat(messages, context, "chat");
      console.log(`🤖️ Companion says: ${result.text}`);
      return result.text;
    } catch (e: any) {
      this.logApiError(e);
      return this.companionErrorMessage;
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
        content: this.companionSystemContent,
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
    if (this.isUsageReportRequest(userText)) {
      if (this.wantsGeneratedFile(userText)) {
        return {
          action: "agent_task",
          agentTool: "usage_report_file",
          fileType: /csv|表格|excel|xlsx/i.test(userText)
            ? "csv"
            : /txt|文本/i.test(userText)
            ? "txt"
            : "md",
          risk: "low",
        };
      }
      return { action: "usage_report" };
    }
    const parsedReminder = this.parseReminderRequest(userText);
    if (parsedReminder) {
      return {
        action: "reminder",
        remindAt: parsedReminder.remindAt.toISOString(),
        reminderContent: parsedReminder.content,
        repeat: parsedReminder.repeat,
        repeatCount: parsedReminder.repeatCount,
      };
    }
    if (this.isReminderListRequest(userText, context)) {
      return { action: "list_reminders" };
    }
    const agentIntent = this.parseDeterministicAgentIntent(userText);
    if (agentIntent) {
      return agentIntent;
    }
    return null;
  }

  private parseDeterministicAgentIntent(text: string): RoutedIntent | null {
    const compact = text.replace(/\s+/g, "");
    if (/跑(一下)?代码|执行(一下)?代码|运行(一下)?代码|code|python|javascript|node/i.test(compact)) {
      return {
        action: "agent_task",
        agentTool: "code_run",
        code: this.extractCodeBlock(text),
        codeLanguage: this.inferCodeLanguage(text),
        risk: "high",
      };
    }
    if (/日程表|计划表|复习计划|考试安排表|ddl表|待办表|整理成.*表|生成.*表格/i.test(compact)) {
      return {
        action: "agent_task",
        agentTool: "schedule_document",
        fileType: /csv|表格|excel|xlsx/i.test(text) ? "csv" : "md",
        title: "日程计划",
        risk: "medium",
      };
    }
    if (/生成.*(文件|文档|报告|markdown|md|txt|csv)|写一份.*(文档|报告)|导出.*(文件|文档)/i.test(compact)) {
      return {
        action: "agent_task",
        agentTool: "file_create",
        fileType: /csv|表格|excel|xlsx/i.test(text)
          ? "csv"
          : /txt|文本/i.test(text)
          ? "txt"
          : "md",
        title: this.extractTitle(text) || "生成文档",
        risk: "medium",
      };
    }
    if (/分步骤|计划一下|拆解任务|帮我规划/i.test(compact)) {
      return {
        action: "agent_task",
        agentTool: "plan_only",
        risk: "low",
      };
    }
    return null;
  }

  private isUsageReportRequest(text: string): boolean {
    return /(token|tokens|调用|api|模型).*(消耗|用量|统计|总消耗|花费|成本|调用次数)|((消耗|用量|统计|花费|成本).*(token|tokens|调用|api|模型))/i.test(
      text.replace(/\s+/g, "")
    );
  }

  private wantsGeneratedFile(text: string): boolean {
    return /文件|文档|报告|txt|md|markdown|csv|表格|excel|xlsx|导出|生成一份|给我一份/i.test(
      text
    );
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
      repeatCount: this.parseReminderRepeatCount(text),
    };
  }

  private parseReminderRepeatCount(text: string): number {
    const compact = text.replace(/\s+/g, "");
    const match = compact.match(
      /(?:连续(?:提醒我?)?|重复(?:提醒我?)?|多提醒|提醒我?)([0-9一二两三四五六七八九十两]{1,3})(?:次|遍|回)/
    );
    if (!match) {
      return 1;
    }
    const count = this.parseChineseNumber(match[1]);
    if (!count || count < 1) {
      return 1;
    }
    return Math.min(count, 6);
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
    return asksReminder || (context.scope !== "system" && /^\/提醒$/.test(compact));
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
      /(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)?([0-9一二两三四五六七八九十两]{1,4})(?:点|时)(半|([0-9一二两三四五六七八九十]{1,3})分?)?/
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

    if (/下午|傍晚|晚上|夜里/.test(period) && hour < 12) {
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
        /(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)?([0-9一二两三四五六七八九十两]{1,4})(?:点|时)(半|([0-9一二两三四五六七八九十]{1,3})分?)?/g,
        " "
      )
      .replace(/([01]?\d|2[0-3])[:：]([0-5]\d)/g, " ")
      .replace(/能不能|可不可以|可以不|可以|能否|能/g, " ")
      .replace(/帮我|给我|麻烦你|麻烦|请你|请/g, " ")
      .replace(/设置|设个|定个|定一个|建个|创建/g, " ")
      .replace(/连续(?:提醒我?)?[0-9一二两三四五六七八九十两]{1,3}(?:次|遍|回)/g, " ")
      .replace(/重复(?:提醒我?)?[0-9一二两三四五六七八九十两]{1,3}(?:次|遍|回)/g, " ")
      .replace(/提醒我?[0-9一二两三四五六七八九十两]{1,3}(?:次|遍|回)/g, " ")
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
      "action 只能是 chat, remember, recall, reminder, list_reminders, agent_task, summarize_today, usage_report, set_group_mode, ignore。",
      "如果用户让你记住、保存、登记信息，使用 remember，并提取 memory。",
      "如果用户询问之前保存的信息，使用 recall，并提取 query。",
      "如果用户要求设置提醒，使用 reminder，并给出 remindAt 的 ISO 8601 时间和 reminderContent；每天/每日提醒时 repeat 为 daily；连续提醒多次时给 repeatCount。",
      "如果用户询问有哪些提醒、为什么没提醒、之前让你提醒过什么，使用 list_reminders。",
      "如果用户要求生成文件、整理日程表、执行代码、做多步骤规划，使用 agent_task。",
      "agent_task 需要给出 agentTool：schedule_document、file_create、code_run 或 plan_only；执行代码 risk 为 high。",
      "如果用户要求总结今天/本群/当前对话，使用 summarize_today。",
      "只有当用户明确询问 API、模型、token 的消耗/用量/统计/费用/调用次数时，才使用 usage_report；如果 token 只是书名、标题、搜索词或普通话题的一部分，必须保持 chat。",
      "如果群聊用户想调整机器人发言频率，使用 set_group_mode，并给出 mode：quiet、smart、active、super_active 或 talkative。",
      "quiet 表示少说话、只在被点名时回复；smart 表示正常智能判断；active 表示更主动参与；super_active 表示更高频参与；talkative 表示话唠模式。",
      `当前日期：${this.currentDate}`,
      `当前时间：${this.currentDateTime}`,
      `会话：${context.chatName}`,
      `会话类型：${context.scope}`,
      `发言人：${context.talkerName}`,
      "示例输出：",
      "{\"action\":\"remember\",\"memory\":\"高数考试是7月10日上午\",\"tags\":[\"考试\"]}",
      "{\"action\":\"reminder\",\"remindAt\":\"2026-07-05T08:00:00+08:00\",\"reminderContent\":\"交作业\",\"repeat\":\"none\",\"repeatCount\":1}",
      "{\"action\":\"agent_task\",\"agentTool\":\"schedule_document\",\"fileType\":\"md\",\"risk\":\"medium\"}",
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
        0.1,
        Config.agentModel
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
    return this.onCompanionChat(
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
    const repeatCount = Math.max(1, Math.min(Number(intent.repeatCount || 1), 6));
    const createdTimes: Date[] = [];
    for (let index = 0; index < repeatCount; index += 1) {
      const time = new Date(remindAt);
      time.setMinutes(
        time.getMinutes() + index * Config.reminderFollowupIntervalMinutes
      );
      this.store.addReminder(context, time.toISOString(), content, repeat);
      createdTimes.push(time);
    }
    const target = context.scope === "group" ? "在本群" : "私聊";
    const repeatText = repeat === "daily" ? "每天 " : "";
    const timesText =
      repeatCount > 1
        ? createdTimes.map((time) => this.formatLocalDateTime(time).slice(11)).join("、")
        : this.formatLocalDateTime(remindAt);
    return `好，我会${target}${repeatText}${timesText} 提醒你：${content}${
      repeatCount > 1 ? `（共 ${repeatCount} 次）` : ""
    }`;
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

  private async handleAgentTask(
    intent: RoutedIntent,
    text: string,
    context: ChatContext
  ): Promise<string> {
    const tool = intent.agentTool || this.inferAgentTool(text);
    if (this.requiresConfirmation(intent, tool)) {
      const approval = this.createPendingApproval(intent, text, context, tool);
      return [
        `这个任务需要确认后执行：${this.describeAgentTool(tool)}`,
        `风险等级：${intent.risk || "high"}`,
        "请回复 /确认执行 继续，或回复 /取消 放弃。",
        `确认编号：${approval.id}`,
      ].join("\n");
    }

    if (tool === "schedule_document") {
      return this.createScheduleDocument(text, context, intent.fileType || "md");
    }
    if (tool === "file_create") {
      return this.createAgentDocument(text, context, intent.fileType || "md");
    }
    if (tool === "usage_report_file") {
      return this.createUsageReportFile(context, intent.fileType || "md");
    }
    if (tool === "plan_only") {
      return this.createAgentPlan(text, context);
    }
    if (tool === "code_run") {
      return "执行代码属于高风险操作，需要回复 /确认执行 后才会运行。";
    }
    return this.createAgentPlan(text, context);
  }

  private async createScheduleDocument(
    text: string,
    context: ChatContext,
    fileType: string
  ): Promise<string> {
    const source = this.buildAgentContext(context, 160);
    const result = await this.completeChat(
      [
        {
          role: "system",
          content: [
            "你是日程整理 agent。",
            "请根据当前会话历史和记忆，整理考试、作业、DDL、提醒、待办。",
            "只使用给定材料，不要编造日期；不确定的时间标为待确认。",
            fileType === "csv"
              ? "输出 CSV 内容，第一行表头为：类型,事项,时间,地点,状态,备注。"
              : "输出 Markdown，包含总览、日程表、待确认信息、建议行动。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [`用户请求：${text}`, "", "材料：", source].join("\n"),
        },
      ],
      context,
      "agent_schedule_document",
      0.2,
      Config.agentModel
    );
    const extension = fileType === "csv" ? "csv" : "md";
    const filePath = this.writeGeneratedFile(
      context,
      "schedule",
      extension,
      result.text
    );
    this.queueFileForChat(context.chatId, filePath);
    return `我整理好日程表了，已生成文件：${path.basename(filePath)}`;
  }

  private async createAgentDocument(
    text: string,
    context: ChatContext,
    fileType: string
  ): Promise<string> {
    const source = this.buildAgentContext(context, 120);
    const result = await this.completeChat(
      [
        {
          role: "system",
          content: [
            "你是文件生成 agent。",
            "请根据用户请求生成一份可直接保存的内容。",
            "如果材料不足，先给出合理模板，并标注需要用户补充的部分。",
            fileType === "csv"
              ? "输出 CSV 内容，不要 Markdown 代码块。"
              : "输出 Markdown 正文，不要外层代码块。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [`用户请求：${text}`, "", "可参考的当前会话材料：", source].join(
            "\n"
          ),
        },
      ],
      context,
      "agent_file_create",
      0.4,
      Config.agentModel
    );
    const extension = ["csv", "txt"].includes(fileType) ? fileType : "md";
    const filePath = this.writeGeneratedFile(
      context,
      "document",
      extension,
      result.text
    );
    this.queueFileForChat(context.chatId, filePath);
    return `文件已生成：${path.basename(filePath)}`;
  }

  private createUsageReportFile(context: ChatContext, fileType: string): string {
    const today = this.formatLocalDate(new Date());
    const chatToday = this.store.getUsageSummary(today, context.chatId);
    const chatTotal = this.store.getUsageSummary(undefined, context.chatId);
    const canSeeGlobal =
      this.store.isRootUser(context.talkerId) ||
      (Config.allowGlobalUsageReport && context.scope === "private");
    const globalToday = canSeeGlobal ? this.store.getUsageSummary(today) : null;
    const globalTotal = canSeeGlobal ? this.store.getUsageSummary() : null;
    const extension = ["csv", "txt"].includes(fileType) ? fileType : "md";
    const content =
      extension === "csv"
        ? this.formatUsageCsv(context, today, chatToday, chatTotal, globalToday, globalTotal)
        : this.formatUsageMarkdown(
            context,
            today,
            chatToday,
            chatTotal,
            globalToday,
            globalTotal
          );
    const filePath = this.writeGeneratedFile(
      context,
      "usage",
      extension,
      content
    );
    this.queueFileForChat(context.chatId, filePath);
    return `token 用量文件已生成：${path.basename(filePath)}`;
  }

  private formatUsageMarkdown(
    context: ChatContext,
    today: string,
    chatToday: ReturnType<BotStore["getUsageSummary"]>,
    chatTotal: ReturnType<BotStore["getUsageSummary"]>,
    globalToday: ReturnType<BotStore["getUsageSummary"]> | null,
    globalTotal: ReturnType<BotStore["getUsageSummary"]> | null
  ): string {
    const lines = [
      "# Token 用量报告",
      "",
      `日期：${today}`,
      `会话：${context.chatName}`,
      "",
      "## 当前会话今日",
      `调用次数：${chatToday.calls}`,
      `总 tokens：${chatToday.totalTokens}`,
      `输入/输出：${chatToday.promptTokens}/${chatToday.completionTokens}`,
      "",
      "## 当前会话累计",
      `调用次数：${chatTotal.calls}`,
      `总 tokens：${chatTotal.totalTokens}`,
      `输入/输出：${chatTotal.promptTokens}/${chatTotal.completionTokens}`,
    ];
    if (globalToday && globalTotal) {
      lines.push(
        "",
        "## 全局今日",
        `调用次数：${globalToday.calls}`,
        `总 tokens：${globalToday.totalTokens}`,
        "",
        "## 全局累计",
        `调用次数：${globalTotal.calls}`,
        `总 tokens：${globalTotal.totalTokens}`
      );
    }
    return lines.join("\n");
  }

  private formatUsageCsv(
    context: ChatContext,
    today: string,
    chatToday: ReturnType<BotStore["getUsageSummary"]>,
    chatTotal: ReturnType<BotStore["getUsageSummary"]>,
    globalToday: ReturnType<BotStore["getUsageSummary"]> | null,
    globalTotal: ReturnType<BotStore["getUsageSummary"]> | null
  ): string {
    const rows: Array<Array<string | number>> = [
      ["范围", "日期", "会话", "调用次数", "总tokens", "输入tokens", "输出tokens"],
      [
        "当前会话今日",
        today,
        context.chatName,
        chatToday.calls,
        chatToday.totalTokens,
        chatToday.promptTokens,
        chatToday.completionTokens,
      ],
      [
        "当前会话累计",
        "全部",
        context.chatName,
        chatTotal.calls,
        chatTotal.totalTokens,
        chatTotal.promptTokens,
        chatTotal.completionTokens,
      ],
    ];
    if (globalToday && globalTotal) {
      rows.push(
        [
          "全局今日",
          today,
          "全部",
          globalToday.calls,
          globalToday.totalTokens,
          globalToday.promptTokens,
          globalToday.completionTokens,
        ],
        [
          "全局累计",
          "全部",
          "全部",
          globalTotal.calls,
          globalTotal.totalTokens,
          globalTotal.promptTokens,
          globalTotal.completionTokens,
        ]
      );
    }
    return rows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
  }

  private async createAgentPlan(text: string, context: ChatContext): Promise<string> {
    const result = await this.completeChat(
      [
        {
          role: "system",
          content: [
            "你是任务规划 agent。",
            "请把用户的需求拆成清晰步骤，指出需要哪些工具、哪些权限、哪些信息缺口。",
            "不要假装已经执行工具；只给计划和下一步建议。",
          ].join("\n"),
        },
        { role: "user", content: text },
      ],
      context,
      "agent_plan",
      0.3,
      Config.agentModel
    );
    return result.text;
  }

  private async handlePendingApprovalReply(
    text: string,
    context: ChatContext
  ): Promise<string | null> {
    this.prunePendingApprovals();
    const compact = text.replace(/\s+/g, "");
    const approval = this.pendingApprovals.get(context.chatId);
    if (!approval) {
      return null;
    }
    if (/^\/?(取消|放弃|不执行|cancel)$/i.test(compact)) {
      this.pendingApprovals.delete(context.chatId);
      return "已取消这个待确认任务。";
    }
    if (!/^\/?(确认执行|确认|执行|yes|ok)$/i.test(compact)) {
      return null;
    }
    this.pendingApprovals.delete(context.chatId);
    return this.executeApprovedAgentTask(approval);
  }

  private async executeApprovedAgentTask(
    approval: PendingApproval
  ): Promise<string> {
    const tool = approval.intent.agentTool || this.inferAgentTool(approval.originalText);
    if (tool === "code_run") {
      return this.runCodeTask(approval.intent, approval.originalText, approval.context);
    }
    return this.handleAgentTask(
      {
        ...approval.intent,
        risk: "medium",
      },
      approval.originalText,
      approval.context
    );
  }

  private async runCodeTask(
    intent: RoutedIntent,
    text: string,
    context: ChatContext
  ): Promise<string> {
    const code = intent.code || this.extractCodeBlock(text);
    if (!code) {
      return "我没有找到可执行的代码。请用 Markdown 代码块发送，例如 ```python ... ```。";
    }
    const language = intent.codeLanguage || this.inferCodeLanguage(text);
    const runner =
      language === "javascript" || language === "node"
        ? { command: process.execPath, extension: "js" }
        : { command: "python3", extension: "py" };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-agent-code-"));
    const codePath = path.join(tempDir, `task.${runner.extension}`);
    fs.writeFileSync(codePath, code, "utf8");
    try {
      const result = await execFileAsync(runner.command, [codePath], {
        timeout: 8000,
        maxBuffer: 80 * 1024,
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      const clipped = output.slice(0, 2500) || "代码执行完成，没有输出。";
      this.store.addUsage({
        scope: context.scope,
        chatId: context.chatId,
        chatName: context.chatName,
        model: "local-code-runner",
        feature: "agent_code_run",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimated: true,
      });
      return [`代码执行完成：`, clipped].join("\n");
    } catch (error: any) {
      const stderr = error?.stderr || error?.message || String(error);
      return `代码执行失败：${String(stderr).slice(0, 1800)}`;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private requiresConfirmation(intent: RoutedIntent, tool: AgentToolName): boolean {
    return tool === "code_run" || intent.risk === "high";
  }

  private createPendingApproval(
    intent: RoutedIntent,
    text: string,
    context: ChatContext,
    tool: AgentToolName
  ): PendingApproval {
    const approval: PendingApproval = {
      id: `appr_${Date.now().toString(36)}`,
      createdAt: Date.now(),
      context,
      intent: {
        ...intent,
        agentTool: tool,
      },
      originalText: text,
    };
    this.pendingApprovals.set(context.chatId, approval);
    return approval;
  }

  private prunePendingApprovals() {
    const now = Date.now();
    for (const [chatId, approval] of this.pendingApprovals.entries()) {
      if (now - approval.createdAt > this.pendingApprovalTtlMs) {
        this.pendingApprovals.delete(chatId);
      }
    }
  }

  private inferAgentTool(text: string): AgentToolName {
    const compact = text.replace(/\s+/g, "");
    if (/代码|python|javascript|node|运行|执行/.test(compact)) {
      return "code_run";
    }
    if (/日程|计划表|考试|ddl|待办表/.test(compact)) {
      return "schedule_document";
    }
    if (/文件|文档|报告|表格|markdown|md|txt|csv/.test(compact)) {
      return "file_create";
    }
    return "plan_only";
  }

  private describeAgentTool(tool: AgentToolName): string {
    const descriptions: Record<AgentToolName, string> = {
      schedule_document: "整理日程/待办并生成文件",
      file_create: "生成文档文件",
      usage_report_file: "导出 token 用量文件",
      code_run: "执行用户提供的代码",
      plan_only: "规划复杂任务",
    };
    return descriptions[tool];
  }

  private extractCodeBlock(text: string): string {
    const fenced = text.match(/```(?:python|py|javascript|js|node)?\s*([\s\S]*?)```/i);
    if (fenced) {
      return fenced[1].trim();
    }
    const lines = text.split("\n");
    if (lines.length > 1) {
      return lines.slice(1).join("\n").trim();
    }
    return "";
  }

  private inferCodeLanguage(text: string): string {
    if (/```(?:javascript|js|node)/i.test(text) || /javascript|node\.?js|js/i.test(text)) {
      return "javascript";
    }
    return "python";
  }

  private extractTitle(text: string): string {
    const quoted = text.match(/[“"]([^”"]{2,40})[”"]/);
    if (quoted) {
      return quoted[1];
    }
    const title = text
      .replace(/帮我|生成|创建|写一份|写一个|导出|文件|文档|报告/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return title.slice(0, 24);
  }

  private buildAgentContext(context: ChatContext, limit: number): string {
    const memories = this.store
      .searchMemories(context, "", 20)
      .map((memory) => `记忆：${memory.content}`);
    const messages = this.store
      .getRecentMessages(context.chatId, limit)
      .map((message) => `${message.talkerName}[${message.role}]: ${message.text}`);
    return [...memories, ...messages].slice(-limit).join("\n") || "暂无材料。";
  }

  private writeGeneratedFile(
    context: ChatContext,
    prefix: string,
    extension: string,
    content: string
  ): string {
    fs.mkdirSync(Config.generatedFilesPath, { recursive: true });
    const safeChat = context.chatName.replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 24);
    const timestamp = this.formatLocalDateTime(new Date())
      .replace(/[-: ]/g, "")
      .slice(0, 12);
    const filePath = path.join(
      Config.generatedFilesPath,
      `${prefix}_${safeChat}_${timestamp}.${extension}`
    );
    fs.writeFileSync(filePath, this.stripCodeFence(content), "utf8");
    return filePath;
  }

  private stripCodeFence(content: string): string {
    return content
      .replace(/^```[a-zA-Z0-9_-]*\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  private queueFileForChat(chatId: string, filePath: string) {
    const files = this.pendingFilesByChat.get(chatId) || [];
    files.push(filePath);
    this.pendingFilesByChat.set(chatId, files);
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
      MessageType.Emoticon,
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
    context: ChatContext,
    rawText: string = text
  ): Promise<string> {
    this.prunePendingMedia(context.chatId);
    const pending = this.pendingMediaByChat.get(context.chatId) || [];
    if (!pending.length || !this.referencesRecentMedia(text, rawText)) {
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

  private referencesRecentMedia(text: string, rawText: string = text): boolean {
    const compact = text.replace(/\s+/g, "");
    return (
      this.isMentioned(rawText) ||
      this.startsWithTrigger(text) ||
      /这张|这个图|这个表情|这段视频|这条语音|刚才.*(图|图片|截图|照片|视频|语音|音频|表情)|上面.*(图|图片|截图|照片|视频|语音|音频|表情)|上一条|前面.*(图|图片|截图|照片|视频|语音|音频|表情)|图片|截图|照片|图里|图中|视频|语音|音频|表情包|表情|看一下|看看|识别|转文字|解释一下/i.test(
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
    if (/表情包|表情/i.test(text)) {
      return MessageType.Emoticon;
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
    if (messageType === MessageType.Emoticon) {
      return this.describeEmoticonMessage(message, context);
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

  private async describeEmoticonMessage(
    message: Message,
    context: ChatContext
  ): Promise<string> {
    if (!Config.multimodalEnabled) {
      return "[Emoticon] 已收到表情包，但多模态功能未开启。";
    }
    const media = await this.readMessageMedia(message, MessageType.Emoticon);
    const result = await this.completeChat(
      [
        {
          role: "system",
          content:
            "你是微信表情包理解模块。请识别表情包的画面、文字、情绪和可能的回复语境。简洁输出。",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "请理解这个微信表情包的含义。" },
            { type: "image_url", image_url: { url: media.dataUrl } },
          ],
        },
      ],
      context,
      "emoticon_understanding",
      0.2,
      Config.visionModel
    );
    return `[表情包理解]\n${result.text}`;
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
    if (messageType === MessageType.Image || messageType === MessageType.Emoticon) {
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
    if (this.pendingApprovals.has(context.chatId) && this.isApprovalReplyText(text)) {
      return true;
    }
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

    if (mode === "active") {
      return this.shouldSpeakInActiveGroup(text, context, {
        direct,
        modeSwitch,
        cooldownSeconds: Config.activeGroupCooldownSeconds,
        casual: false,
        talkative: false,
      });
    }

    if (mode === "super_active") {
      return this.shouldSpeakInActiveGroup(text, context, {
        direct,
        modeSwitch,
        cooldownSeconds: Config.superActiveGroupCooldownSeconds,
        casual: true,
        talkative: false,
      });
    }

    if (mode === "talkative") {
      return this.shouldSpeakInActiveGroup(text, context, {
        direct,
        modeSwitch,
        cooldownSeconds: Config.talkativeGroupCooldownSeconds,
        casual: true,
        talkative: true,
      });
    }

    return direct || modeSwitch || this.looksAddressedToBot(text);
  }

  private shouldSpeakInActiveGroup(
    text: string,
    context: ChatContext,
    options: {
      direct: boolean;
      modeSwitch: boolean;
      cooldownSeconds: number;
      casual: boolean;
      talkative: boolean;
    }
  ): boolean {
    const now = Date.now();
    const lastReplyAt = this.lastGroupReplyAt.get(context.chatId) || 0;
    const cooledDown = now - lastReplyAt > options.cooldownSeconds * 1000;
    const casualCue = options.casual && this.looksLikeConversationalCue(text);
    const talkativeCue = options.talkative && this.looksWorthCasualReply(text);
    const shouldSpeak =
      options.direct ||
      options.modeSwitch ||
      this.looksAddressedToBot(text) ||
      this.mayNeedTool(text, context) ||
      (cooledDown &&
        (this.looksLikeOpenQuestion(text) || casualCue || talkativeCue));
    if (shouldSpeak) {
      this.lastGroupReplyAt.set(context.chatId, now);
    }
    return shouldSpeak;
  }

  private looksLikeConversationalCue(text: string): boolean {
    const compact = text.replace(/\s+/g, "");
    if (this.isLowSignalGroupText(compact)) {
      return false;
    }
    return /[?？]|怎么|为什么|咋办|感觉|是不是|要不要|可以|离谱|有点|笑死|确实|真的假的|有人|谁/.test(
      compact
    );
  }

  private looksWorthCasualReply(text: string): boolean {
    const compact = text.replace(/\s+/g, "");
    if (this.isLowSignalGroupText(compact)) {
      return false;
    }
    return (
      compact.length >= 6 ||
      this.looksLikeOpenQuestion(compact) ||
      this.looksLikeConversationalCue(compact)
    );
  }

  private isLowSignalGroupText(text: string): boolean {
    if (!text) {
      return true;
    }
    if (/^https?:\/\//i.test(text)) {
      return true;
    }
    if (/^[\p{P}\p{S}\s]+$/u.test(text)) {
      return true;
    }
    return /^(嗯+|哦+|噢+|好+|行+|可以+|哈哈+|hh+|ok|收到|对|是)$/i.test(
      text
    );
  }

  private cleanMessage(rawText: string, context: ChatContext): string {
    let text = rawText;
    if (context.scope === "group") {
      const mention = `@${this.botName}`;
      if (text.startsWith(mention)) {
        text = text.slice(mention.length).trimStart();
      }
    }
    if (this.legacyTriggerKeyword && text.startsWith(this.legacyTriggerKeyword)) {
      text = text.slice(this.legacyTriggerKeyword.length);
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
      (Config.ignoreOfficialAccounts && this.isOfficialContact(talker)) ||
      messageType === MessageType.Unknown ||
      messageType === MessageType.Contact ||
      messageType === MessageType.ChatHistory ||
      messageType === MessageType.GroupNote ||
      messageType === MessageType.Transfer ||
      messageType === MessageType.Post ||
      messageType === MessageType.MiniProgram ||
      messageType === MessageType.Location ||
      messageType === MessageType.Recalled ||
      messageType === MessageType.RedEnvelope ||
      text.includes("收到一条视频/语音聊天消息，请在手机上查看") ||
      text.includes("收到红包，请在手机上查看") ||
      text.includes("/cgi-bin/mmwebwx-bin/webwxgetpubliclinkimg")
    );
  }

  private isOfficialContact(talker: any): boolean {
    try {
      const contactType = talker.type?.();
      return contactType === 2 || String(contactType).toLowerCase() === "official";
    } catch {
      return false;
    }
  }

  private logMessageMeta(
    message: Message,
    context: ChatContext,
    messageType: MessageType,
    text: string
  ) {
    if (!Config.debugMessageTypes) {
      return;
    }
    const roomText = context.scope === "group" ? ` room="${context.chatName}"` : "";
    const textPreview = text ? ` text="${text.slice(0, 80)}"` : "";
    console.log(
      `📨 type=${MessageType[messageType] || messageType} scope=${context.scope}${roomText} talker="${context.talkerName}"${textPreview}`
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

  private async sendPendingFiles(message: Message, context: ChatContext) {
    const files = this.pendingFilesByChat.get(context.chatId) || [];
    if (!files.length) {
      return;
    }
    this.pendingFilesByChat.delete(context.chatId);
    const room = message.room();
    const target = context.scope === "group" && room ? room : message.talker();
    for (const filePath of files) {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      await target.say(FileBox.fromFile(filePath));
    }
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
      "agent_task",
      "summarize_today",
      "usage_report",
      "set_group_mode",
      "ignore",
    ].includes(String(action));
  }

  private isGroupMode(mode: unknown): mode is GroupMode {
    return ["quiet", "smart", "active", "super_active", "talkative"].includes(
      String(mode)
    );
  }

  private mayNeedTool(text: string, context?: ChatContext): boolean {
    const compact = text.replace(/\s+/g, "");
    return (
      /记住|记一下|保存|存一下|帮我存|收纳一下|我之前|之前说|总结|复盘/i.test(
        compact
      ) ||
      this.looksLikeReminderCreateRequest(text) ||
      Boolean(context && this.isReminderListRequest(text, context)) ||
      this.isUsageReportRequest(text) ||
      /日程表|计划表|复习计划|考试安排|ddl|deadline|待办表|整理成.*表|生成.*表格/i.test(
        compact
      ) ||
      /生成.*(文件|文档|报告|markdown|md|txt|csv)|写一份.*(文档|报告)|导出.*(文件|文档)/i.test(
        compact
      ) ||
      /执行代码|运行代码|跑代码|```|python|javascript|node/i.test(compact) ||
      (context?.scope === "group" && this.looksLikeModeSwitchRequest(text))
    );
  }

  private startsWithTrigger(text: string): boolean {
    return Boolean(
      this.legacyTriggerKeyword && text.startsWith(this.legacyTriggerKeyword)
    );
  }

  private isApprovalReplyText(text: string): boolean {
    const compact = text.replace(/\s+/g, "");
    return /^\/?(确认执行|确认|执行|取消|放弃|不执行|yes|ok|cancel)$/i.test(
      compact
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
  ):
    | { type: "none" }
    | { type: "menu" }
    | { type: "status" }
    | { type: "switch"; mode: GroupMode } {
    const compact = text.replace(/\s+/g, "");
    if (/^\/(模式|群模式|机器人模式|mode|help|\?)$/i.test(compact)) {
      return { type: "menu" };
    }
    if (/^\/([12345])(?:安静|智能|活跃|超级活跃|超活跃|话唠)?$/.test(compact)) {
      const modeMap: Record<string, GroupMode> = {
        "1": "quiet",
        "2": "smart",
        "3": "active",
        "4": "super_active",
        "5": "talkative",
      };
      return { type: "switch", mode: modeMap[compact[1]] };
    }
    if (/^\/(安静|静默|少说话|quiet|silent)$/.test(compact)) {
      return { type: "switch", mode: "quiet" };
    }
    if (/^\/(智能|正常|默认|smart|normal)$/.test(compact)) {
      return { type: "switch", mode: "smart" };
    }
    if (/^\/(活跃|主动|积极|多说话|active)$/.test(compact)) {
      return { type: "switch", mode: "active" };
    }
    if (/^\/(超级活跃|超活跃|很活跃|superactive|super_active)$/.test(compact)) {
      return { type: "switch", mode: "super_active" };
    }
    if (/^\/(话唠|畅聊|talkative|chatty)$/.test(compact)) {
      return { type: "switch", mode: "talkative" };
    }
    if (/^(群聊模式|群模式|机器人模式|切换模式|模式切换)$/.test(compact)) {
      return { type: "menu" };
    }
    if (/现在(是)?什么模式|当前(是)?什么模式|什么群聊模式|什么机器人模式/.test(compact)) {
      return { type: "status" };
    }
    const mode = this.parseNaturalGroupMode(text);
    return mode ? { type: "switch", mode } : { type: "none" };
  }

  private parseNaturalGroupMode(text: string): GroupMode | null {
    const compact = text.replace(/\s+/g, "");
    if (/安静一点|少说话|别太主动|别刷屏|只@/.test(compact)) {
      return "quiet";
    }
    if (/恢复正常|正常回复|默认模式|智能一点/.test(compact)) {
      return "smart";
    }
    if (/话唠|畅聊|特别能聊|多聊点|话多一点/.test(compact)) {
      return "talkative";
    }
    if (/超级活跃|超活跃|更活跃|很活跃/.test(compact)) {
      return "super_active";
    }
    if (/活跃一点|积极一点|多说点|主动一点/.test(compact)) {
      return "active";
    }
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
    if (/话唠|畅聊|特别能聊|多聊/.test(compact)) {
      return "talkative";
    }
    if (/超级活跃|超活跃|很活跃|更活跃/.test(compact)) {
      return "super_active";
    }
    if (/活跃|主动|积极|多说话/.test(compact)) {
      return "active";
    }
    return null;
  }

  private looksLikeModeSwitchRequest(text: string): boolean {
    return /群聊模式|群模式|机器人模式|切换模式|进入.*模式|改成.*模式|安静一点|少说话|别太主动|活跃一点|超级活跃|超活跃|话唠|多聊点|积极一点|多说点|正常回复|默认模式/i.test(
      text.replace(/\s+/g, "")
    );
  }

  private groupModeMenu(): string {
    return [
      "群聊模式：",
      "/1 安静：只在被 @ 或触发词出现时回复",
      "/2 智能：明显问到我或需要工具时回复",
      `/3 活跃：更主动参与，${Config.activeGroupCooldownSeconds} 秒冷却`,
      `/4 超活跃：更积极接话，${Config.superActiveGroupCooldownSeconds} 秒冷却`,
      `/5 话唠：高频聊天，${Config.talkativeGroupCooldownSeconds} 秒冷却`,
      "也可以直接发：/安静 /智能 /活跃 /超活跃 /话唠",
    ].join("\n");
  }

  private describeGroupMode(mode: GroupMode): string {
    const descriptions: Record<GroupMode, string> = {
      quiet: "安静模式：只在被 @ 或触发词出现时回复",
      smart: "智能模式：被明显问到或需要工具时回复",
      active: `活跃模式：会更积极参与，${Config.activeGroupCooldownSeconds} 秒冷却`,
      super_active: `超级活跃模式：更积极接话，${Config.superActiveGroupCooldownSeconds} 秒冷却`,
      talkative: `话唠模式：更像群友聊天，${Config.talkativeGroupCooldownSeconds} 秒冷却`,
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
