import type { Message } from "wechaty";
import type { ChatContext, ChatScope, GroupMode, ReminderRepeat } from "./store.js";
import type { MessageType } from "./message-type.js";

export type ToolAction =
  | "chat"
  | "remember"
  | "recall"
  | "reminder"
  | "list_reminders"
  | "agent_task"
  | "summarize_today"
  | "usage_report"
  | "set_group_mode"
  | "time_query"
  | "ignore";

export interface RoutedIntent {
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

export interface ParsedReminder {
  remindAt: Date;
  content: string;
  repeat: ReminderRepeat;
  repeatCount: number;
}

export type AgentToolName =
  | "schedule_document"
  | "file_create"
  | "usage_report_file"
  | "code_run"
  | "plan_only";

export type AgentRisk = "low" | "medium" | "high";

export interface PendingApproval {
  id: string;
  createdAt: number;
  context: ChatContext;
  intent: RoutedIntent;
  originalText: string;
}

export interface CompletionResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
}

export interface MediaFile {
  name: string;
  mediaType: string;
  extension: string;
  buffer: Buffer;
  base64: string;
  dataUrl: string;
}

export interface PendingMediaMessage {
  message: Message;
  messageType: MessageType;
  typeName: string;
  cacheKey: string;
  timestamp: number;
  talkerName: string;
  processedText?: string;
}

export interface PendingMediaRequest {
  message: Message;
  context: ChatContext;
  text: string;
  rawText: string;
  preferredType: MessageType | null;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface EmoticonCacheEntry {
  meaning: string;
  timestamp: number;
}

export interface RootListEntry {
  scope: ChatScope;
  chatId: string;
  chatName: string;
}
