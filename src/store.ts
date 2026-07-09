import fs from "fs";
import path from "path";

export type ChatScope = "private" | "group";
export type GroupMode = "quiet" | "smart" | "active" | "super_active" | "talkative";
export type ReminderRepeat = "none" | "daily";
export type ReminderStatus = "pending" | "sent" | "cancelled" | "failed";
export type ChatAccessStatus = "allow" | "deny";

export interface ChatContext {
  scope: ChatScope | "system";
  chatId: string;
  chatName: string;
  talkerId: string;
  talkerName: string;
}

export interface StoredMessage {
  id: string;
  timestamp: string;
  scope: ChatScope | "system";
  chatId: string;
  chatName: string;
  talkerId: string;
  talkerName: string;
  role: "user" | "assistant";
  text: string;
  messageType?: number;
}

export interface KnownChat {
  scope: ChatScope;
  chatId: string;
  chatName: string;
  lastSeenAt: string;
}

export interface MemoryItem {
  id: string;
  timestamp: string;
  scope: ChatScope | "global";
  chatId: string;
  chatName: string;
  createdBy: string;
  content: string;
  tags: string[];
}

export interface ReminderItem {
  id: string;
  createdAt: string;
  remindAt: string;
  scope: ChatScope;
  chatId: string;
  chatName: string;
  createdBy: string;
  content: string;
  repeat?: ReminderRepeat;
  lastSentAt?: string;
  lastFailedAt?: string;
  lastError?: string;
  failureCount?: number;
  status: ReminderStatus;
}

export interface ChatAccessRule {
  scope: ChatScope;
  chatId: string;
  chatName: string;
  status: ChatAccessStatus;
  updatedAt: string;
  updatedBy: string;
}

export interface PrivateVideoAccessRule {
  chatId: string;
  chatName: string;
  status: ChatAccessStatus;
  updatedAt: string;
  updatedBy: string;
}

export interface UsageRecord {
  id: string;
  timestamp: string;
  date: string;
  scope: ChatScope | "system";
  chatId: string;
  chatName: string;
  model: string;
  feature: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
}

export interface GroupSetting {
  groupId: string;
  groupName: string;
  mode: GroupMode;
  updatedAt: string;
}

interface BotData {
  messages: StoredMessage[];
  memories: MemoryItem[];
  reminders: ReminderItem[];
  usageRecords: UsageRecord[];
  groupSettings: Record<string, GroupSetting>;
  rootUsers: Record<string, string>;
  chatAccess: Record<string, ChatAccessRule>;
  privateVideoAccess: Record<string, PrivateVideoAccessRule>;
  knownChats: Record<string, KnownChat>;
}

const emptyData = (): BotData => ({
  messages: [],
  memories: [],
  reminders: [],
  usageRecords: [],
  groupSettings: {},
  rootUsers: {},
  chatAccess: {},
  privateVideoAccess: {},
  knownChats: {},
});

export class BotStore {
  private data: BotData;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  addMessage(message: Omit<StoredMessage, "id" | "timestamp"> & { timestamp?: string }) {
    this.reload();
    const timestamp = message.timestamp || new Date().toISOString();
    this.data.messages.push({
      id: this.createId("msg"),
      timestamp,
      ...message,
    });
    this.rememberChat(message.scope, message.chatId, message.chatName, timestamp);
    this.save();
  }

  rememberChat(
    scope: ChatScope | "system",
    chatId: string,
    chatName: string,
    lastSeenAt = new Date().toISOString()
  ) {
    if (scope === "system") {
      return;
    }
    const normalizedName = this.normalizeChatName(chatName, chatId);
    this.mergeRenamedSessionChat(scope, chatId, normalizedName, lastSeenAt);
    this.data.knownChats[chatId] = {
      scope,
      chatId,
      chatName: normalizedName,
      lastSeenAt,
    };
  }

  getKnownChats(scope?: ChatScope): KnownChat[] {
    this.reload();
    return this.dedupeKnownChats(Object.values(this.data.knownChats))
      .filter((chat) => !scope || chat.scope === scope)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  getRecentMessages(chatId: string, limit: number): StoredMessage[] {
    this.reload();
    return this.data.messages
      .filter((message) => message.chatId === chatId)
      .slice(-limit);
  }

  getMessagesForDate(chatId: string, date: string): StoredMessage[] {
    this.reload();
    return this.data.messages.filter(
      (message) =>
        message.chatId === chatId && message.timestamp.slice(0, 10) === date
    );
  }

  addMemory(
    context: ChatContext,
    content: string,
    tags: string[] = [],
    scope: ChatScope | "global" = context.scope === "system" ? "global" : context.scope
  ): MemoryItem {
    this.reload();
    const memory: MemoryItem = {
      id: this.createId("mem"),
      timestamp: new Date().toISOString(),
      scope,
      chatId: context.chatId,
      chatName: context.chatName,
      createdBy: context.talkerName,
      content,
      tags,
    };
    this.data.memories.push(memory);
    this.save();
    return memory;
  }

  searchMemories(context: ChatContext, query: string, limit: number): MemoryItem[] {
    this.reload();
    const normalizedQuery = query.trim().toLowerCase();
    const queryParts = normalizedQuery
      .split(/[\s,，。:：;；、]+/)
      .map((part) => part.trim())
      .filter(Boolean);

    return this.data.memories
      .filter((memory) => memory.chatId === context.chatId)
      .map((memory) => ({
        memory,
        score: this.scoreMemory(memory, normalizedQuery, queryParts),
      }))
      .filter(({ score }) => score > 0 || queryParts.length === 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ memory }) => memory);
  }

  addReminder(
    context: ChatContext,
    remindAt: string,
    content: string,
    repeat: ReminderRepeat = "none"
  ): ReminderItem {
    this.reload();
    const reminder: ReminderItem = {
      id: this.createId("rem"),
      createdAt: new Date().toISOString(),
      remindAt,
      scope: context.scope === "system" ? "private" : context.scope,
      chatId: context.chatId,
      chatName: context.chatName,
      createdBy: context.talkerName,
      content,
      repeat,
      status: "pending",
    };
    this.data.reminders.push(reminder);
    this.save();
    return reminder;
  }

  getReminders(chatId: string, limit = 20): ReminderItem[] {
    this.reload();
    return this.data.reminders
      .filter((reminder) => reminder.chatId === chatId)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
      .slice(0, limit);
  }

  getDueReminders(now = new Date()): ReminderItem[] {
    this.reload();
    const nowTime = now.getTime();
    return this.data.reminders.filter(
      (reminder) =>
        reminder.status === "pending" &&
        new Date(reminder.remindAt).getTime() <= nowTime
    );
  }

  markReminderSent(id: string) {
    this.reload();
    const reminder = this.data.reminders.find((item) => item.id === id);
    if (reminder) {
      reminder.lastSentAt = new Date().toISOString();
      reminder.lastFailedAt = undefined;
      reminder.lastError = undefined;
      reminder.failureCount = 0;
      if (reminder.repeat === "daily") {
        const next = new Date(reminder.remindAt);
        const now = new Date();
        do {
          next.setDate(next.getDate() + 1);
        } while (next.getTime() <= now.getTime());
        reminder.remindAt = next.toISOString();
        reminder.status = "pending";
      } else {
        reminder.status = "sent";
      }
      this.save();
    }
  }

  markReminderFailed(
    id: string,
    error: string,
    maxFailures = 3
  ): ReminderItem | undefined {
    this.reload();
    const reminder = this.data.reminders.find((item) => item.id === id);
    if (!reminder) {
      return undefined;
    }
    reminder.failureCount = (reminder.failureCount || 0) + 1;
    reminder.lastFailedAt = new Date().toISOString();
    reminder.lastError = error.slice(0, 500);
    if (reminder.failureCount >= maxFailures) {
      reminder.status = "failed";
    }
    this.save();
    return reminder;
  }

  cancelReminder(id: string): boolean {
    this.reload();
    const reminder = this.data.reminders.find((item) => item.id === id);
    if (!reminder) {
      return false;
    }
    reminder.status = "cancelled";
    this.save();
    return true;
  }

  addUsage(record: Omit<UsageRecord, "id" | "timestamp" | "date">) {
    this.reload();
    const now = new Date();
    this.data.usageRecords.push({
      id: this.createId("use"),
      timestamp: now.toISOString(),
      date: now.toISOString().slice(0, 10),
      ...record,
    });
    this.save();
  }

  getUsageSummary(date?: string, chatId?: string) {
    this.reload();
    const records = this.data.usageRecords.filter(
      (record) =>
        (!date || record.date === date) && (!chatId || record.chatId === chatId)
    );
    return records.reduce(
      (summary, record) => {
        summary.calls += 1;
        summary.promptTokens += record.promptTokens;
        summary.completionTokens += record.completionTokens;
        summary.totalTokens += record.totalTokens;
        if (record.scope === "private") {
          summary.privateTokens += record.totalTokens;
        } else if (record.scope === "group") {
          summary.groupTokens += record.totalTokens;
        } else {
          summary.systemTokens += record.totalTokens;
        }
        return summary;
      },
      {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        privateTokens: 0,
        groupTokens: 0,
        systemTokens: 0,
      }
    );
  }

  addRootUser(talkerId: string, talkerName: string) {
    this.reload();
    this.data.rootUsers[talkerId] = talkerName;
    this.save();
  }

  isRootUser(talkerId: string): boolean {
    this.reload();
    return Boolean(this.data.rootUsers[talkerId]);
  }

  getRootUsers() {
    this.reload();
    return Object.entries(this.data.rootUsers).map(([talkerId, talkerName]) => ({
      talkerId,
      talkerName,
    }));
  }

  setChatAccess(
    context: Pick<ChatAccessRule, "scope" | "chatId" | "chatName">,
    status: ChatAccessStatus,
    updatedBy: string
  ) {
    this.reload();
    this.data.chatAccess[context.chatId] = {
      ...context,
      status,
      updatedAt: new Date().toISOString(),
      updatedBy,
    };
    this.save();
  }

  getChatAccess(chatId: string): ChatAccessRule | undefined {
    this.reload();
    return this.data.chatAccess[chatId];
  }

  getChatAccessRules(status?: ChatAccessStatus): ChatAccessRule[] {
    this.reload();
    return Object.values(this.data.chatAccess)
      .filter((rule) => !status || rule.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  clearChatAccess(chatId: string): boolean {
    this.reload();
    const existed = Boolean(this.data.chatAccess[chatId]);
    delete this.data.chatAccess[chatId];
    this.save();
    return existed;
  }

  setPrivateVideoAccess(
    context: Pick<PrivateVideoAccessRule, "chatId" | "chatName">,
    status: ChatAccessStatus,
    updatedBy: string
  ) {
    this.reload();
    this.data.privateVideoAccess[context.chatId] = {
      ...context,
      status,
      updatedAt: new Date().toISOString(),
      updatedBy,
    };
    this.save();
  }

  getPrivateVideoAccess(chatId: string): PrivateVideoAccessRule | undefined {
    this.reload();
    return this.data.privateVideoAccess[chatId];
  }

  getPrivateVideoAccessRules(status?: ChatAccessStatus): PrivateVideoAccessRule[] {
    this.reload();
    return Object.values(this.data.privateVideoAccess)
      .filter((rule) => !status || rule.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  clearPrivateVideoAccess(chatId: string): boolean {
    this.reload();
    const existed = Boolean(this.data.privateVideoAccess[chatId]);
    delete this.data.privateVideoAccess[chatId];
    this.save();
    return existed;
  }

  setGroupMode(groupId: string, groupName: string, mode: GroupMode) {
    this.reload();
    this.data.groupSettings[groupId] = {
      groupId,
      groupName,
      mode,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  getGroupMode(groupId: string, fallback: GroupMode): GroupMode {
    this.reload();
    return this.data.groupSettings[groupId]?.mode || fallback;
  }

  private reload() {
    this.data = this.load();
  }

  private load(): BotData {
    if (!fs.existsSync(this.filePath)) {
      return emptyData();
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      return {
        ...emptyData(),
        ...JSON.parse(raw),
      };
    } catch (error) {
      console.error(`Failed to load bot store: ${error}`);
      return emptyData();
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  private scoreMemory(memory: MemoryItem, query: string, queryParts: string[]) {
    const text = `${memory.content} ${memory.tags.join(" ")}`.toLowerCase();
    let score = 0;
    if (query && text.includes(query)) {
      score += 10;
    }
    for (const part of queryParts) {
      if (part.length > 1 && text.includes(part)) {
        score += 2;
      }
    }
    return score;
  }

  private createId(prefix: string) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private mergeRenamedSessionChat(
    scope: ChatScope,
    chatId: string,
    chatName: string,
    lastSeenAt: string
  ) {
    if (!this.isStableDisplayName(chatName, chatId)) {
      return;
    }
    for (const oldChat of Object.values(this.data.knownChats)) {
      if (
        oldChat.chatId === chatId ||
        oldChat.scope !== scope ||
        oldChat.chatName !== chatName
      ) {
        continue;
      }
      if (scope === "group" && this.data.groupSettings[oldChat.chatId]) {
        const oldRule = this.data.groupSettings[oldChat.chatId];
        const currentRule = this.data.groupSettings[chatId];
        if (!currentRule || oldRule.updatedAt.localeCompare(currentRule.updatedAt) > 0) {
          this.data.groupSettings[chatId] = {
            ...oldRule,
            groupId: chatId,
            groupName: chatName,
            updatedAt: oldRule.updatedAt || lastSeenAt,
          };
        }
        delete this.data.groupSettings[oldChat.chatId];
      }
      if (this.data.chatAccess[oldChat.chatId]) {
        const oldRule = this.data.chatAccess[oldChat.chatId];
        const currentRule = this.data.chatAccess[chatId];
        if (!currentRule || oldRule.updatedAt.localeCompare(currentRule.updatedAt) > 0) {
          this.data.chatAccess[chatId] = {
            ...oldRule,
            chatId,
            chatName,
            updatedAt: oldRule.updatedAt || lastSeenAt,
          };
        }
        delete this.data.chatAccess[oldChat.chatId];
      }
      if (scope === "private" && this.data.privateVideoAccess[oldChat.chatId]) {
        const oldRule = this.data.privateVideoAccess[oldChat.chatId];
        const currentRule = this.data.privateVideoAccess[chatId];
        if (!currentRule || oldRule.updatedAt.localeCompare(currentRule.updatedAt) > 0) {
          this.data.privateVideoAccess[chatId] = {
            ...oldRule,
            chatId,
            chatName,
            updatedAt: oldRule.updatedAt || lastSeenAt,
          };
        }
        delete this.data.privateVideoAccess[oldChat.chatId];
      }
      delete this.data.knownChats[oldChat.chatId];
    }
  }

  private dedupeKnownChats(chats: KnownChat[]): KnownChat[] {
    const byKey = new Map<string, KnownChat>();
    for (const chat of chats) {
      if (!this.isStableDisplayName(chat.chatName, chat.chatId)) {
        continue;
      }
      const key = `${chat.scope}:${chat.chatName}`;
      const existing = byKey.get(key);
      if (!existing || chat.lastSeenAt.localeCompare(existing.lastSeenAt) > 0) {
        byKey.set(key, chat);
      }
    }
    return Array.from(byKey.values());
  }

  private normalizeChatName(chatName: string, chatId: string): string {
    const name = String(chatName || "").trim();
    return name || this.fallbackChatName(chatId);
  }

  private fallbackChatName(chatId: string): string {
    const id = String(chatId || "");
    return id ? `未命名${id.slice(-6)}` : "未命名会话";
  }

  private isStableDisplayName(chatName: string, chatId: string): boolean {
    const name = String(chatName || "").trim();
    if (!name || name === chatId) {
      return false;
    }
    return !/^@{1,2}[0-9a-f]{24,}$/i.test(name);
  }
}
