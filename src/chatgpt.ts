import { Config } from "./config.js";
import { Message } from "wechaty";
import { ContactInterface, RoomInterface } from "wechaty/impls";
import { Configuration, OpenAIApi } from "openai";
import {
  BotStore,
  ChatContext,
  ChatScope,
  GroupMode,
  ReminderItem,
} from "./store.js";

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
  | "summarize_today"
  | "usage_report"
  | "ignore";

interface RoutedIntent {
  action: ToolAction;
  reply?: string;
  memory?: string;
  query?: string;
  remindAt?: string;
  reminderContent?: string;
  tags?: string[];
  reason?: string;
}

interface CompletionResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
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

  private chatgptModelConfig: object = {
    model: Config.openaiModel,
    temperature: 0.8,
  };

  private get currentDate(): string {
    return new Date().toISOString().split("T")[0];
  }

  private get chatgptSystemContent(): string {
    return [
      "你是一个接入微信的 Qwen 系列智能助手。",
      "你的风格自然、温暖、有分寸，像一个可靠的朋友和工具人。",
      "你会记住用户明确交代的重要信息，但不要编造不存在的记忆。",
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
    const mode = this.parseGroupModeCommand(text);
    if (context.scope === "group" && mode) {
      this.store.setGroupMode(context.chatId, context.chatName, mode);
      await message.say(
        `已切换为${this.describeGroupMode(mode)}。你也可以说“机器人进入安静模式/智能模式/活跃模式”来调整。`
      );
      return true;
    }

    if (text === "菜单" || text === "帮助") {
      await message.say(
        [
          "我现在支持：",
          "1. 私聊直接对话，不需要 Hi bot:",
          "2. 群聊可切换安静模式、智能模式、活跃模式",
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
    const replyMessage = await this.handleUserText(cleanText || rawText, context);
    if (!replyMessage) {
      return;
    }

    await this.replyToContext(message, context, replyMessage);
    this.store.addMessage({
      ...context,
      role: "assistant",
      text: replyMessage,
      messageType: MessageType.Text,
    });
  }

  private async handleUserText(
    text: string,
    context: ChatContext
  ): Promise<string> {
    const intent = await this.routeIntentIfNeeded(text, context);
    switch (intent.action) {
      case "remember":
        return this.handleRemember(intent, text, context);
      case "recall":
        return this.handleRecall(intent, text, context);
      case "reminder":
        return this.handleReminder(intent, text, context);
      case "summarize_today":
        return this.handleSummarizeToday(context);
      case "usage_report":
        return this.handleUsageReport(context);
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

  private async routeIntentIfNeeded(
    text: string,
    context: ChatContext
  ): Promise<RoutedIntent> {
    if (!Config.agentRouterEnabled || !this.mayNeedTool(text)) {
      return { action: "chat" };
    }

    const routerPrompt = [
      "你是微信机器人的工具路由器。请判断用户是否需要调用工具。",
      "不要因为用户没有写命令就拒绝；自然语言也可以触发工具。",
      "只输出 JSON，不要 Markdown。",
      "action 只能是 chat, remember, recall, reminder, summarize_today, usage_report, ignore。",
      "如果用户让你记住、保存、登记信息，使用 remember，并提取 memory。",
      "如果用户询问之前保存的信息，使用 recall，并提取 query。",
      "如果用户要求提醒，使用 reminder，并给出 remindAt 的 ISO 8601 时间和 reminderContent。",
      "如果用户要求总结今天/本群/当前对话，使用 summarize_today。",
      "如果用户询问 token、消耗、调用次数，使用 usage_report。",
      `当前日期：${this.currentDate}`,
      `会话：${context.chatName}`,
      `发言人：${context.talkerName}`,
      "示例输出：",
      "{\"action\":\"remember\",\"memory\":\"高数考试是7月10日上午\",\"tags\":[\"考试\"]}",
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
    const remindAt = intent.remindAt;
    if (!remindAt || Number.isNaN(new Date(remindAt).getTime())) {
      return "我想帮你设提醒，但没能确定具体时间。你可以说得更明确一点，比如“明天上午9点提醒我交作业”。";
    }
    const content = intent.reminderContent || intent.memory || text;
    this.store.addReminder(context, remindAt, content);
    return `好，我会在 ${new Date(remindAt).toLocaleString("zh-CN", {
      hour12: false,
    })} 提醒你：${content}`;
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
    const todaySummary = this.store.getUsageSummary(today);
    const chatSummary = this.store.getUsageSummary(today, context.chatId);
    const totalSummary = this.store.getUsageSummary();
    return [
      `今天总调用：${todaySummary.calls} 次，${todaySummary.totalTokens} tokens`,
      `当前会话今天：${chatSummary.calls} 次，${chatSummary.totalTokens} tokens`,
      `私聊/群聊/系统：${todaySummary.privateTokens}/${todaySummary.groupTokens}/${todaySummary.systemTokens}`,
      `累计总消耗：${totalSummary.totalTokens} tokens`,
    ].join("\n");
  }

  private async completeChat(
    messages: Array<any>,
    context: ChatContext,
    feature: string,
    temperature?: number
  ): Promise<CompletionResult> {
    const response = await this.openaiApiInstance.createChatCompletion({
      ...this.chatgptModelConfig,
      temperature,
      messages,
    });
    const text = response?.data?.choices[0]?.message?.content?.trim() || "";
    const usage = response?.data?.usage;
    const estimatedPrompt = this.estimateTokens(
      messages.map((message) => message.content).join("\n")
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
      model: Config.openaiModel,
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
    const shouldReply = this.shouldRespond(message.text() || "", context);
    const typeName = MessageType[messageType] || "Unknown";
    this.store.addMessage({
      ...context,
      role: "user",
      text: `[${typeName}]`,
      messageType,
    });

    if (!shouldReply) {
      return;
    }

    if (messageType === MessageType.Audio) {
      await this.replyToContext(
        message,
        context,
        "我收到语音了。语音转文字接口已经预留，下一步接入后我就能直接听懂语音。"
      );
      return;
    }
    if (messageType === MessageType.Image) {
      await this.replyToContext(
        message,
        context,
        "我收到图片了。图片理解会接到 Qwen-VL，下一步可以做截图分析、OCR 和看图总结。"
      );
      return;
    }
    if (messageType === MessageType.Video) {
      await this.replyToContext(
        message,
        context,
        "我收到视频了。视频先暂不处理，后面会做抽帧后再总结。"
      );
    }
  }

  private shouldRespond(text: string, context: ChatContext): boolean {
    if (context.scope === "private") {
      return Config.privateAutoReply || this.startsWithTrigger(text);
    }

    const mode = this.store.getGroupMode(context.chatId, Config.defaultGroupMode);
    const direct = this.isMentioned(text) || this.startsWithTrigger(text);
    if (mode === "quiet") {
      return direct;
    }

    if (mode === "smart") {
      return direct || this.looksAddressedToBot(text);
    }

    const now = Date.now();
    const lastReplyAt = this.lastGroupReplyAt.get(context.chatId) || 0;
    const cooledDown = now - lastReplyAt > 90 * 1000;
    const shouldSpeak =
      direct ||
      this.looksAddressedToBot(text) ||
      this.mayNeedTool(text) ||
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
  ): Promise<void> {
    if (!text.trim()) {
      return;
    }
    const room = message.room();
    if (context.scope === "group" && room) {
      await this.reply(room, text);
      return;
    }
    await this.reply(message.talker(), text);
  }

  private async reply(
    talker: RoomInterface | ContactInterface,
    message: string
  ): Promise<void> {
    const messages: Array<string> = [];
    let rest = message;
    while (rest.length > this.SINGLE_MESSAGE_MAX_SIZE) {
      messages.push(rest.slice(0, this.SINGLE_MESSAGE_MAX_SIZE));
      rest = rest.slice(this.SINGLE_MESSAGE_MAX_SIZE);
    }
    messages.push(rest);
    for (const msg of messages) {
      await talker.say(msg);
    }
  }

  private async sendReminder(weChatBot: any, reminder: ReminderItem) {
    try {
      const target =
        reminder.scope === "group"
          ? weChatBot.Room.load(reminder.chatId)
          : weChatBot.Contact.load(reminder.chatId);
      await target.say(`提醒：${reminder.content}`);
      this.store.markReminderSent(reminder.id);
    } catch (error) {
      console.error(`❌ Failed to send reminder ${reminder.id}: ${error}`);
    }
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
      "summarize_today",
      "usage_report",
      "ignore",
    ].includes(String(action));
  }

  private mayNeedTool(text: string): boolean {
    return /记住|记一下|保存|存一下|提醒|闹钟|别忘|总结|复盘|消耗|token|用量|花了多少|我之前|之前说|安排|ddl|deadline|考试|作业/i.test(
      text
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

  private parseGroupModeCommand(text: string): GroupMode | null {
    const compact = text.replace(/\s+/g, "");
    const looksLikeModeCommand = /群聊模式|群模式|机器人模式|进入.*模式|切换.*模式|改成.*模式/.test(
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

  private describeGroupMode(mode: GroupMode): string {
    const descriptions: Record<GroupMode, string> = {
      quiet: "安静模式：只在被 @ 或触发词出现时回复",
      smart: "智能模式：被明显问到或需要工具时回复",
      active: "活跃模式：会更积极参与，但仍有冷却时间避免刷屏",
    };
    return descriptions[mode];
  }

  private estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 2));
  }

  private systemContext(): ChatContext {
    return {
      scope: "system",
      chatId: "system",
      chatName: "system",
      talkerId: "system",
      talkerName: "system",
    } as unknown as ChatContext;
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
