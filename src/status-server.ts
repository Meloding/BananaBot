import crypto from "crypto";
import fs from "fs";
import http, { IncomingMessage, ServerResponse } from "http";
import { Config } from "./config.js";
import {
  BotStore,
  ChatAccessStatus,
  ChatScope,
  GroupMode,
} from "./store.js";

type WechatState = "starting" | "waiting_scan" | "logged_in" | "logged_out" | "error";

interface LastIncomingMessage {
  at: string;
  scope: "private" | "group" | "unknown";
  talkerName: string;
  roomName: string;
  type: string;
}

interface BotRuntimeStatus {
  serviceStartedAt: string;
  wechatState: WechatState;
  companionReady: boolean;
  loginUserName: string;
  lastScanAt: string;
  scanStatus: string;
  lastLoginAt: string;
  lastLogoutAt: string;
  lastIncomingMessage?: LastIncomingMessage;
  lastOutgoingAt: string;
  lastErrorAt: string;
  lastError: string;
  incomingMessageCount: number;
  outgoingMessageCount: number;
  apiCallCount: number;
  totalTokens: number;
  lastApiAt: string;
  lastApiModel: string;
  lastApiFeature: string;
}

interface StoreData {
  messages?: Array<any>;
  memories?: Array<any>;
  reminders?: Array<any>;
  usageRecords?: Array<any>;
  groupSettings?: Record<string, any>;
  rootUsers?: Record<string, string>;
  chatAccess?: Record<string, any>;
  privateVideoAccess?: Record<string, any>;
  knownChats?: Record<string, any>;
}

const COOKIE_NAME = "wechat_console_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const MESSAGE_TYPE_NAMES: Record<number, string> = {
  0: "Unknown",
  1: "Attachment",
  2: "Audio",
  3: "Contact",
  4: "ChatHistory",
  5: "Emoticon",
  6: "Image",
  7: "Text",
  8: "Location",
  9: "MiniProgram",
  10: "GroupNote",
  11: "Transfer",
  12: "RedEnvelope",
  13: "Recalled",
  14: "Url",
  15: "Video",
  16: "Post",
};

class BotStatus {
  private state: BotRuntimeStatus = {
    serviceStartedAt: new Date().toISOString(),
    wechatState: "starting",
    companionReady: false,
    loginUserName: "",
    lastScanAt: "",
    scanStatus: "",
    lastLoginAt: "",
    lastLogoutAt: "",
    lastOutgoingAt: "",
    lastErrorAt: "",
    lastError: "",
    incomingMessageCount: 0,
    outgoingMessageCount: 0,
    apiCallCount: 0,
    totalTokens: 0,
    lastApiAt: "",
    lastApiModel: "",
    lastApiFeature: "",
  };

  update(patch: Partial<BotRuntimeStatus>) {
    this.state = { ...this.state, ...patch };
  }

  markScan(status: string) {
    this.update({
      wechatState: "waiting_scan",
      lastScanAt: new Date().toISOString(),
      scanStatus: status,
    });
  }

  markLogin(userName: string) {
    this.update({
      wechatState: "logged_in",
      companionReady: true,
      loginUserName: userName,
      lastLoginAt: new Date().toISOString(),
      lastErrorAt: "",
      lastError: "",
    });
  }

  markLogout(userName: string) {
    this.update({
      wechatState: "logged_out",
      companionReady: false,
      loginUserName: userName || this.state.loginUserName,
      lastLogoutAt: new Date().toISOString(),
    });
  }

  recordError(error: unknown) {
    this.update({
      wechatState: this.state.wechatState === "logged_in" ? "logged_in" : "error",
      lastErrorAt: new Date().toISOString(),
      lastError: this.formatError(error),
    });
  }

  async recordIncomingMessage(message: any) {
    const room = await message.room?.();
    const talker = message.talker?.();
    const messageType =
      typeof message.type === "function" ? String(message.type()) : "unknown";
    this.update({
      incomingMessageCount: this.state.incomingMessageCount + 1,
      lastIncomingMessage: {
        at: new Date().toISOString(),
        scope: room ? "group" : "private",
        talkerName: this.safeName(talker),
        roomName: room ? this.safeName(room) : "",
        type: messageType,
      },
    });
  }

  recordOutgoingMessage() {
    this.update({
      outgoingMessageCount: this.state.outgoingMessageCount + 1,
      lastOutgoingAt: new Date().toISOString(),
    });
  }

  recordUsage(model: string, feature: string, totalTokens: number) {
    this.update({
      apiCallCount: this.state.apiCallCount + 1,
      totalTokens: this.state.totalTokens + totalTokens,
      lastApiAt: new Date().toISOString(),
      lastApiModel: model,
      lastApiFeature: feature,
    });
  }

  snapshot() {
    return {
      ...this.state,
      uptimeSeconds: Math.floor(
        (Date.now() - Date.parse(this.state.serviceStartedAt)) / 1000
      ),
      models: {
        chat: Config.openaiModel,
        agent: Config.agentModel,
        vision: Config.visionModel,
        audio: Config.audioModel,
      },
      statusPage: {
        enabled: Config.statusPageEnabled,
        host: Config.statusHost,
        port: Config.statusPort,
      },
    };
  }

  private safeName(entity: any): string {
    try {
      if (entity && typeof entity.name === "function") {
        return entity.name();
      }
      if (entity && typeof entity.topic === "function") {
        return entity.topic();
      }
    } catch {
      return "";
    }
    return "";
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return (error.message || error.stack || "Unknown error")
        .split("\n")[0]
        .slice(0, 500);
    }
    return String(error).split("\n")[0].slice(0, 500);
  }
}

export const botStatus = new BotStatus();

export function startStatusServer() {
  if (!Config.statusPageEnabled) {
    return;
  }

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error(`Status console failed: ${error instanceof Error ? error.stack : error}`);
      sendJson(response, 500, { error: "internal_error" });
    });
  });

  server.on("error", (error) => {
    console.error(`Status page failed: ${error instanceof Error ? error.message : error}`);
  });

  server.listen(Config.statusPort, Config.statusHost, () => {
    console.log(
      `Status page listening on http://${Config.statusHost}:${Config.statusPort}`
    );
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const pathName = url.pathname.replace(/\/+$/, "") || "/";

  if (pathName === "/healthz") {
    sendJson(response, 200, { ok: true, state: botStatus.snapshot().wechatState });
    return;
  }

  if (pathName === "/login" && request.method === "GET") {
    sendHtml(response, renderLoginHtml());
    return;
  }

  if (pathName === "/login" && request.method === "POST") {
    await handleLogin(request, response);
    return;
  }

  if (pathName === "/logout") {
    response.writeHead(302, {
      "set-cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      location: "./login",
    });
    response.end();
    return;
  }

  if (!isAuthenticated(request)) {
    if (pathName.startsWith("/api") || pathName === "/status.json") {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    redirect(response, "./login");
    return;
  }

  if (pathName === "/") {
    sendHtml(response, renderDashboardHtml());
    return;
  }

  if (pathName === "/status.json") {
    sendJson(response, 200, botStatus.snapshot());
    return;
  }

  if (pathName === "/api/overview") {
    sendJson(response, 200, buildOverview());
    return;
  }

  if (pathName === "/api/chats") {
    const scope = url.searchParams.get("scope") || "";
    sendJson(
      response,
      200,
      buildChatList(scope === "group" || scope === "private" ? scope : undefined)
    );
    return;
  }

  if (pathName === "/api/chat") {
    sendJson(
      response,
      200,
      buildChatDetail(
        url.searchParams.get("id") || "",
        url.searchParams.get("raw") === "1"
      )
    );
    return;
  }

  if (pathName === "/api/usage") {
    sendJson(response, 200, buildUsageReport(Number(url.searchParams.get("days") || 7)));
    return;
  }

  if (pathName === "/api/reminders") {
    sendJson(response, 200, buildReminderList(url.searchParams.get("chatId") || ""));
    return;
  }

  if (pathName === "/api/memories") {
    sendJson(response, 200, buildMemoryList(url.searchParams.get("chatId") || ""));
    return;
  }

  if (pathName === "/api/recent") {
    sendJson(response, 200, buildRecentEvents());
    return;
  }

  if (pathName === "/api/settings/group-mode" && request.method === "POST") {
    await handleSetGroupMode(request, response);
    return;
  }

  if (pathName === "/api/settings/chat-access" && request.method === "POST") {
    await handleSetChatAccess(request, response);
    return;
  }

  if (pathName === "/api/settings/private-video" && request.method === "POST") {
    await handleSetPrivateVideoAccess(request, response);
    return;
  }

  if (pathName === "/api/reminders/cancel" && request.method === "POST") {
    await handleCancelReminder(request, response);
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

async function handleLogin(request: IncomingMessage, response: ServerResponse) {
  const rootToken = Config.rootAuthToken.trim();
  if (!rootToken) {
    sendJson(response, 403, { error: "root_token_not_configured" });
    return;
  }
  const body = await readBodyJson(request);
  const token = String(body.token || "").trim();
  if (!safeEqual(token, rootToken)) {
    sendJson(response, 401, { error: "bad_token" });
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "set-cookie": `${COOKIE_NAME}=${createSessionToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${
      SESSION_TTL_MS / 1000
    }`,
  });
  response.end(JSON.stringify({ ok: true }));
}

async function handleSetGroupMode(request: IncomingMessage, response: ServerResponse) {
  const body = await readBodyJson(request);
  const chatId = String(body.chatId || "");
  const mode = String(body.mode || "") as GroupMode;
  if (!isGroupMode(mode)) {
    sendJson(response, 400, { error: "bad_mode" });
    return;
  }
  const chat = getChat(chatId);
  if (!chat || chat.scope !== "group") {
    sendJson(response, 404, { error: "group_not_found" });
    return;
  }
  new BotStore(Config.botDataPath).setGroupMode(chat.chatId, chat.chatName, mode);
  sendJson(response, 200, { ok: true });
}

async function handleSetChatAccess(request: IncomingMessage, response: ServerResponse) {
  const body = await readBodyJson(request);
  const chatId = String(body.chatId || "");
  const status = String(body.status || "");
  if (!["allow", "deny", "default"].includes(status)) {
    sendJson(response, 400, { error: "bad_status" });
    return;
  }
  const chat = getChat(chatId);
  if (!chat) {
    sendJson(response, 404, { error: "chat_not_found" });
    return;
  }
  const store = new BotStore(Config.botDataPath);
  if (status === "default") {
    store.clearChatAccess(chat.chatId);
  } else {
    store.setChatAccess(chat, status as ChatAccessStatus, "status-console");
  }
  sendJson(response, 200, { ok: true });
}

async function handleSetPrivateVideoAccess(
  request: IncomingMessage,
  response: ServerResponse
) {
  const body = await readBodyJson(request);
  const chatId = String(body.chatId || "");
  const status = String(body.status || "");
  if (!["allow", "deny", "default"].includes(status)) {
    sendJson(response, 400, { error: "bad_status" });
    return;
  }
  const chat = getChat(chatId);
  if (!chat || chat.scope !== "private") {
    sendJson(response, 404, { error: "private_chat_not_found" });
    return;
  }
  const store = new BotStore(Config.botDataPath);
  if (status === "default") {
    store.clearPrivateVideoAccess(chat.chatId);
  } else {
    store.setPrivateVideoAccess(chat, status as ChatAccessStatus, "status-console");
  }
  sendJson(response, 200, { ok: true });
}

async function handleCancelReminder(request: IncomingMessage, response: ServerResponse) {
  const body = await readBodyJson(request);
  const id = String(body.id || "");
  const ok = new BotStore(Config.botDataPath).cancelReminder(id);
  sendJson(response, ok ? 200 : 404, ok ? { ok: true } : { error: "reminder_not_found" });
}

function buildOverview() {
  const data = readStoreData();
  const status = botStatus.snapshot();
  const chats = buildChatList().items;
  const usageToday = summarizeUsage(safeArray(data.usageRecords), localDateKey(new Date()));
  const recentErrors = status.lastError
    ? [{ at: status.lastErrorAt, message: status.lastError }]
    : [];
  return {
    status,
    totals: {
      chats: chats.length,
      groups: chats.filter((chat) => chat.scope === "group").length,
      privates: chats.filter((chat) => chat.scope === "private").length,
      roots: Object.keys(safeObject(data.rootUsers)).length,
      reminders: safeArray(data.reminders).length,
      pendingReminders: safeArray(data.reminders).filter((item) => item.status === "pending")
        .length,
      memories: safeArray(data.memories).length,
      messages: safeArray(data.messages).length,
      usageToday,
    },
    models: status.models,
    recentErrors,
    topChatsByTokens: chats
      .slice()
      .sort((a, b) => b.todayTokens - a.todayTokens)
      .slice(0, 8),
    recentEvents: buildRecentEvents().items.slice(0, 12),
  };
}

function buildChatList(scope?: ChatScope) {
  const data = readStoreData();
  const messages = safeArray(data.messages);
  const usage = safeArray(data.usageRecords);
  const knownChats = dedupeKnownChats(Object.values(safeObject(data.knownChats)));
  const today = localDateKey(new Date());
  const items = knownChats
    .filter((chat: any) => !scope || chat.scope === scope)
    .map((chat: any) => {
      const aliasIds = safeArray(chat.aliasIds).length ? safeArray(chat.aliasIds) : [chat.chatId];
      const chatMessages = messages.filter((message) => aliasIds.includes(message.chatId));
      const todayMessages = chatMessages.filter((message) =>
        sameLocalDate(message.timestamp, today)
      );
      const chatUsage = usage.filter((record) => aliasIds.includes(record.chatId));
      const todayUsage = chatUsage.filter((record) => record.date === today);
      const lastMessage = chatMessages[chatMessages.length - 1];
      const access = findRuleForIds(safeObject(data.chatAccess), aliasIds);
      const groupSetting = findRuleForIds(safeObject(data.groupSettings), aliasIds);
      const videoRule = findRuleForIds(safeObject(data.privateVideoAccess), aliasIds);
      return {
        scope: chat.scope,
        chatId: chat.chatId,
        idShort: shortId(chat.chatId),
        chatName: chat.chatName,
        lastSeenAt: chat.lastSeenAt,
        access: access?.status || "default",
        groupMode:
          chat.scope === "group"
            ? groupSetting?.mode || Config.defaultGroupMode
            : "",
        privateVideo: chat.scope === "private" ? videoRule?.status || "default" : "",
        messageCount: chatMessages.length,
        todayMessageCount: todayMessages.length,
        assistantReplyCount: chatMessages.filter((message) => message.role === "assistant")
          .length,
        todayTokens: sum(todayUsage, "totalTokens"),
        totalTokens: sum(chatUsage, "totalTokens"),
        usageCalls: chatUsage.length,
        lastMessageAt: lastMessage?.timestamp || chat.lastSeenAt,
        lastMessagePreview: lastMessage ? preview(lastMessage.text, 60) : "",
        lastMessageType: lastMessage
          ? messageTypeName(lastMessage.messageType)
          : "-",
      };
    })
    .sort((a, b) => String(b.lastMessageAt || "").localeCompare(String(a.lastMessageAt || "")));
  return { items };
}

function buildChatDetail(chatId: string, raw: boolean) {
  const data = readStoreData();
  const chat = getChat(chatId);
  if (!chat) {
    return { chat: null, messages: [], memories: [], reminders: [], usage: [] };
  }
  const messages = safeArray(data.messages)
    .filter((message) => message.chatId === chatId)
    .slice(-80)
    .map((message) => ({
      id: message.id,
      timestamp: message.timestamp,
      role: message.role,
      talkerName: message.talkerName,
      messageType: messageTypeName(message.messageType),
      text: raw ? message.text : preview(message.text, 120),
      raw,
    }));
  const memories = safeArray(data.memories)
    .filter((memory) => memory.chatId === chatId)
    .slice(-30)
    .reverse();
  const reminders = safeArray(data.reminders)
    .filter((reminder) => reminder.chatId === chatId)
    .slice(-30)
    .reverse();
  const usage = safeArray(data.usageRecords)
    .filter((record) => record.chatId === chatId)
    .slice(-40)
    .reverse();
  return {
    chat: buildChatList().items.find((item) => item.chatId === chatId) || chat,
    messages,
    memories,
    reminders,
    usage,
  };
}

function buildUsageReport(days: number) {
  const data = readStoreData();
  const records = safeArray(data.usageRecords);
  const limitedDays = Math.min(Math.max(days || 7, 1), 30);
  const dateKeys = Array.from({ length: limitedDays }, (_value, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (limitedDays - index - 1));
    return localDateKey(date);
  });
  const inRange = records.filter((record) => dateKeys.includes(record.date));
  return {
    total: summarizeRecords(inRange),
    byDate: dateKeys.map((date) => ({
      date,
      ...summarizeRecords(inRange.filter((record) => record.date === date)),
    })),
    byModel: groupUsage(inRange, "model"),
    byFeature: groupUsage(inRange, "feature"),
    byChat: groupUsage(inRange, "chatName").slice(0, 20),
  };
}

function buildReminderList(chatId = "") {
  const reminders = safeArray(readStoreData().reminders)
    .filter((reminder) => !chatId || reminder.chatId === chatId)
    .sort((a, b) => String(a.remindAt).localeCompare(String(b.remindAt)))
    .slice(0, 200);
  return { items: reminders };
}

function buildMemoryList(chatId = "") {
  const memories = safeArray(readStoreData().memories)
    .filter((memory) => !chatId || memory.chatId === chatId)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, 200);
  return { items: memories };
}

function buildRecentEvents() {
  const data = readStoreData();
  const messageEvents = safeArray(data.messages)
    .slice(-120)
    .map((message) => ({
      at: message.timestamp,
      type: "message",
      title: `${message.role === "assistant" ? "回复" : "消息"} / ${message.chatName}`,
      detail: `${message.talkerName || "-"} · ${messageTypeName(message.messageType)} · ${preview(
        message.text,
        90
      )}`,
    }));
  const usageEvents = safeArray(data.usageRecords)
    .slice(-80)
    .map((record) => ({
      at: record.timestamp,
      type: "usage",
      title: `模型调用 / ${record.feature}`,
      detail: `${record.model} · ${record.chatName} · ${record.totalTokens} tokens`,
    }));
  return {
    items: [...messageEvents, ...usageEvents]
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 120),
  };
}

function summarizeUsage(records: Array<any>, date: string) {
  return summarizeRecords(records.filter((record) => record.date === date));
}

function summarizeRecords(records: Array<any>) {
  return {
    calls: records.length,
    promptTokens: sum(records, "promptTokens"),
    completionTokens: sum(records, "completionTokens"),
    totalTokens: sum(records, "totalTokens"),
  };
}

function groupUsage(records: Array<any>, key: string) {
  const grouped = new Map<string, Array<any>>();
  for (const record of records) {
    const groupKey = String(record[key] || "-");
    grouped.set(groupKey, [...(grouped.get(groupKey) || []), record]);
  }
  return Array.from(grouped.entries())
    .map(([name, rows]) => ({ name, ...summarizeRecords(rows) }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

function getChat(chatId: string) {
  const chat = safeObject(readStoreData().knownChats)[chatId];
  if (!chat) {
    return null;
  }
  return {
    scope: chat.scope as ChatScope,
    chatId: chat.chatId,
    chatName: chat.chatName,
  };
}

function readStoreData(): StoreData {
  try {
    if (!fs.existsSync(Config.botDataPath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(Config.botDataPath, "utf8"));
  } catch (error) {
    console.error(`Failed to read status store: ${error}`);
    return {};
  }
}

function isAuthenticated(request: IncomingMessage): boolean {
  return verifySessionToken(parseCookies(request.headers.cookie || "")[COOKIE_NAME] || "");
}

function createSessionToken(): string {
  const payload = Buffer.from(
    JSON.stringify({
      iat: Date.now(),
      exp: Date.now() + SESSION_TTL_MS,
      nonce: crypto.randomBytes(12).toString("hex"),
    })
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", Config.rootAuthToken.trim())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifySessionToken(token: string): boolean {
  const secret = Config.rootAuthToken.trim();
  if (!secret || !token.includes(".")) {
    return false;
  }
  const [payload, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (!safeEqual(signature, expected)) {
    return false;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(data.exp || 0) > Date.now();
  } catch {
    return false;
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(cookieHeader: string): Record<string, string> {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) {
          return [part, ""];
        }
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

async function readBodyJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }
  const contentType = String(request.headers["content-type"] || "");
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }
  return JSON.parse(raw);
}

function sendJson(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data, null, 2));
}

function sendHtml(response: ServerResponse, html: string) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

function redirect(response: ServerResponse, location: string) {
  response.writeHead(302, { location });
  response.end();
}

function safeArray(value: unknown): Array<any> {
  return Array.isArray(value) ? value : [];
}

function safeObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function dedupeKnownChats(chats: Array<any>): Array<any> {
  const byKey = new Map<string, any>();
  for (const chat of chats) {
    if (!isUsefulDisplayName(chat?.chatName, chat?.chatId)) {
      continue;
    }
    const key = `${chat.scope}:${chat.chatName}`;
    const existing = byKey.get(key);
    const aliasIds = [
      ...(existing?.aliasIds || []),
      ...(chat.aliasIds || []),
      chat.chatId,
    ].filter(Boolean);
    const merged = {
      ...(existing || {}),
      ...chat,
      aliasIds: Array.from(new Set(aliasIds)),
    };
    if (!existing || String(chat.lastSeenAt || "").localeCompare(String(existing.lastSeenAt || "")) >= 0) {
      byKey.set(key, merged);
    } else {
      byKey.set(key, {
        ...existing,
        aliasIds: merged.aliasIds,
      });
    }
  }
  return Array.from(byKey.values());
}

function findRuleForIds(rules: Record<string, any>, ids: Array<string>) {
  let best: any;
  for (const id of ids) {
    if (rules[id]) {
      if (
        !best ||
        String(rules[id].updatedAt || "").localeCompare(String(best.updatedAt || "")) > 0
      ) {
        best = rules[id];
      }
    }
  }
  return best;
}

function isUsefulDisplayName(name: string, id?: string): boolean {
  const value = String(name || "").trim();
  if (!value || value === id) {
    return false;
  }
  return !/^@{1,2}[0-9a-f]{24,}$/i.test(value);
}

function sum(rows: Array<any>, key: string): number {
  return rows.reduce((total, row) => total + Number(row[key] || 0), 0);
}

function preview(text: string, length: number): string {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

function messageTypeName(type: unknown): string {
  const numeric = Number(type);
  return MESSAGE_TYPE_NAMES[numeric] || String(type || "-");
}

function shortId(id: string): string {
  return String(id || "").slice(-8) || "-";
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sameLocalDate(value: string, key: string): boolean {
  if (!value) {
    return false;
  }
  return localDateKey(new Date(value)) === key;
}

function formatDate(value: string): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${days}天 ${hours}小时 ${minutes}分 ${rest}秒`;
}

function isGroupMode(mode: unknown): mode is GroupMode {
  return ["quiet", "smart", "active", "super_active", "talkative"].includes(
    String(mode)
  );
}

function groupModeLabel(mode: GroupMode): string {
  const labels: Record<GroupMode, string> = {
    quiet: "安静",
    smart: "智能",
    active: "活跃",
    super_active: "超活跃",
    talkative: "话唠",
  };
  return labels[mode] || String(mode);
}

function accessLabel(status: string): string {
  if (status === "allow") {
    return "允许";
  }
  if (status === "deny") {
    return "禁止";
  }
  return "默认";
}

function renderLoginHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bot Console Login</title>
  <script>
    (function(){
      try {
        var theme = localStorage.getItem('bot_console_theme') || 'system';
        if (theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
          document.documentElement.setAttribute('data-theme', 'dark');
        } else if (theme && theme !== 'system' && theme !== 'light') {
          document.documentElement.setAttribute('data-theme', theme);
        }
      } catch(e) {}
    })();
  </script>
  <style>
    :root {
      --bg: #f8fafc;
      --panel: #ffffff;
      --ink: #0f172a;
      --muted: #64748b;
      --line: #e2e8f0;
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
      --err: #ef4444;
    }
    [data-theme="dark"] {
      --bg: #0f172a;
      --panel: #1e293b;
      --ink: #f8fafc;
      --muted: #94a3b8;
      --line: #334155;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --shadow: 0 20px 25px -5px rgb(0 0 0 / 0.4), 0 8px 10px -6px rgb(0 0 0 / 0.4);
      --err: #f87171;
    }
    [data-theme="ocean"] {
      --bg: #ecfeff;
      --panel: #ffffff;
      --ink: #083344;
      --muted: #0e7490;
      --line: #bae6fd;
      --primary: #0891b2;
      --primary-hover: #0e7490;
      --shadow: 0 20px 40px -12px rgb(8 145 178 / 0.22);
      --err: #e11d48;
    }
    [data-theme="forest"] {
      --bg: #f0fdf4;
      --panel: #ffffff;
      --ink: #052e16;
      --muted: #15803d;
      --line: #bbf7d0;
      --primary: #16a34a;
      --primary-hover: #15803d;
      --shadow: 0 20px 40px -12px rgb(22 101 52 / 0.2);
      --err: #dc2626;
    }
    [data-theme="sunset"] {
      --bg: #fff7ed;
      --panel: #ffffff;
      --ink: #431407;
      --muted: #c2410c;
      --line: #fed7aa;
      --primary: #ea580c;
      --primary-hover: #c2410c;
      --shadow: 0 20px 40px -12px rgb(234 88 12 / 0.22);
      --err: #be123c;
    }
    [data-theme="berry"] {
      --bg: #fdf2f8;
      --panel: #ffffff;
      --ink: #500724;
      --muted: #be185d;
      --line: #fbcfe8;
      --primary: #db2777;
      --primary-hover: #be185d;
      --shadow: 0 20px 40px -12px rgb(219 39 119 / 0.22);
      --err: #dc2626;
    }
    [data-theme="terminal"] {
      --bg: #020617;
      --panel: #07140d;
      --ink: #dcfce7;
      --muted: #86efac;
      --line: #14532d;
      --primary: #22c55e;
      --primary-hover: #16a34a;
      --shadow: 0 20px 40px -12px rgb(34 197 94 / 0.2);
      --err: #fb7185;
    }
    body { 
      margin: 0; min-height: 100vh; display: grid; place-items: center; 
      background: var(--bg); color: var(--ink); 
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      transition: background-color 0.3s ease;
    }
    .box { 
      width: min(420px, calc(100% - 32px)); 
      background: var(--panel); 
      border: 1px solid var(--line); 
      border-radius: 16px; 
      padding: 32px; 
      box-shadow: var(--shadow); 
      transition: background-color 0.3s ease, border-color 0.3s ease;
    }
    h1 { margin: 0 0 8px; font-size: 26px; font-weight: 800; }
    p { margin: 0 0 24px; color: var(--muted); line-height: 1.6; font-size: 14px; }
    label { display: block; font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 8px; }
    input { 
      width: 100%; box-sizing: border-box; 
      border: 2px solid var(--line); 
      border-radius: 10px; 
      padding: 12px 16px; font: inherit; 
      background: transparent; color: var(--ink);
      transition: border-color 0.2s;
      outline: none;
    }
    input:focus { border-color: var(--primary); }
    button { 
      width: 100%; border: 0; border-radius: 10px; 
      background: var(--primary); color: #fff; 
      padding: 14px; font-weight: 700; font-size: 15px; 
      margin-top: 16px; cursor: pointer; 
      transition: background-color 0.2s, transform 0.1s; 
    }
    button:hover { background: var(--primary-hover); }
    button:active { transform: scale(0.98); }
    .err { color: var(--err); min-height: 22px; margin-top: 12px; font-size: 14px; font-weight: 500;}
    .hint { margin-top: 24px; font-size: 12px; color: var(--muted); line-height: 1.5; text-align: center; }
  </style>
</head>
<body>
  <main class="box">
    <h1>Bot Console</h1>
    <p>请输入 root token 进入控制台。请勿泄露您的访问凭据。</p>
    <form id="loginForm">
      <label for="token">Root Token</label>
      <input id="token" name="token" type="password" autocomplete="current-password" placeholder="••••••••" autofocus />
      <button type="submit">登录安全终端</button>
      <div class="err" id="err"></div>
    </form>
    <div class="hint">安全建议：生产环境请配置 HTTPS 证书，<br>避免 Token 在 HTTP 下明文传输。</div>
  </main>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async function (event) {
      event.preventDefault();
      const err = document.getElementById('err');
      err.textContent = '';
      const token = document.getElementById('token').value;
      const btn = event.target.querySelector('button');
      btn.textContent = '登录中...';
      btn.style.opacity = '0.7';
      try {
        const res = await fetch('./login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token })
        });
        if (res.ok) {
          location.href = './';
        } else {
          err.textContent = 'Token 校验失败，或服务器未配置 rootAuthToken。';
          btn.textContent = '登录安全终端';
          btn.style.opacity = '1';
        }
      } catch (e) {
        err.textContent = '网络请求失败，请重试。';
        btn.textContent = '登录安全终端';
        btn.style.opacity = '1';
      }
    });
  </script>
</body>
</html>`;
}

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BananaBot Console</title>
  <script>
    (function(){
      try {
        var theme = localStorage.getItem('bot_console_theme') || 'system';
        if (theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
          document.documentElement.setAttribute('data-theme', 'dark');
        } else if (theme && theme !== 'system' && theme !== 'light') {
          document.documentElement.setAttribute('data-theme', theme);
        }
      } catch(e) {}
    })();
  </script>
  <style>
    :root {
      color-scheme: light;
      --bg: #f8fafc;
      --panel: #ffffff;
      --ink: #0f172a;
      --muted: #64748b;
      --line: #e2e8f0;
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --primary-bg: #e0e7ff;
      --success-bg: #dcfce7;
      --success-text: #166534;
      --warn-bg: #fef9c3;
      --warn-text: #854d0e;
      --danger-bg: #fee2e2;
      --danger-text: #991b1b;
      --sidebar-bg: #0f172a;
      --sidebar-text: #f1f5f9;
      --sidebar-hover: #1e293b;
      --sidebar-muted: #94a3b8;
      --shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05), 0 2px 4px -2px rgb(0 0 0 / 0.05);
      --radius: 16px;
    }
    [data-theme="dark"] {
      color-scheme: dark;
      --bg: #020617;
      --panel: #0f172a;
      --ink: #f8fafc;
      --muted: #94a3b8;
      --line: #1e293b;
      --primary: #6366f1;
      --primary-hover: #818cf8;
      --primary-bg: rgba(79, 70, 229, 0.2);
      --success-bg: rgba(22, 101, 52, 0.3);
      --success-text: #4ade80;
      --warn-bg: rgba(133, 77, 14, 0.3);
      --warn-text: #facc15;
      --danger-bg: rgba(153, 27, 27, 0.3);
      --danger-text: #f87171;
      --sidebar-bg: #020617;
      --sidebar-text: #f8fafc;
      --sidebar-hover: #1e293b;
      --sidebar-muted: #64748b;
      --shadow: 0 4px 6px -1px rgb(0 0 0 / 0.4);
    }
    [data-theme="ocean"] {
      color-scheme: light;
      --bg: #ecfeff;
      --panel: #ffffff;
      --ink: #083344;
      --muted: #0e7490;
      --line: #bae6fd;
      --primary: #0891b2;
      --primary-hover: #0e7490;
      --primary-bg: #cffafe;
      --success-bg: #ccfbf1;
      --success-text: #0f766e;
      --warn-bg: #fef3c7;
      --warn-text: #92400e;
      --danger-bg: #ffe4e6;
      --danger-text: #be123c;
      --sidebar-bg: #083344;
      --sidebar-text: #ecfeff;
      --sidebar-hover: #155e75;
      --sidebar-muted: #a5f3fc;
      --shadow: 0 10px 28px -16px rgb(8 145 178 / 0.36);
    }
    [data-theme="forest"] {
      color-scheme: light;
      --bg: #f0fdf4;
      --panel: #ffffff;
      --ink: #052e16;
      --muted: #15803d;
      --line: #bbf7d0;
      --primary: #16a34a;
      --primary-hover: #15803d;
      --primary-bg: #dcfce7;
      --success-bg: #bbf7d0;
      --success-text: #166534;
      --warn-bg: #fef9c3;
      --warn-text: #854d0e;
      --danger-bg: #fee2e2;
      --danger-text: #991b1b;
      --sidebar-bg: #052e16;
      --sidebar-text: #f0fdf4;
      --sidebar-hover: #14532d;
      --sidebar-muted: #bbf7d0;
      --shadow: 0 10px 28px -16px rgb(22 101 52 / 0.32);
    }
    [data-theme="sunset"] {
      color-scheme: light;
      --bg: #fff7ed;
      --panel: #ffffff;
      --ink: #431407;
      --muted: #c2410c;
      --line: #fed7aa;
      --primary: #ea580c;
      --primary-hover: #c2410c;
      --primary-bg: #ffedd5;
      --success-bg: #dcfce7;
      --success-text: #166534;
      --warn-bg: #fef3c7;
      --warn-text: #92400e;
      --danger-bg: #ffe4e6;
      --danger-text: #be123c;
      --sidebar-bg: #431407;
      --sidebar-text: #fff7ed;
      --sidebar-hover: #7c2d12;
      --sidebar-muted: #fed7aa;
      --shadow: 0 10px 28px -16px rgb(234 88 12 / 0.34);
    }
    [data-theme="berry"] {
      color-scheme: light;
      --bg: #fdf2f8;
      --panel: #ffffff;
      --ink: #500724;
      --muted: #be185d;
      --line: #fbcfe8;
      --primary: #db2777;
      --primary-hover: #be185d;
      --primary-bg: #fce7f3;
      --success-bg: #dcfce7;
      --success-text: #166534;
      --warn-bg: #fef3c7;
      --warn-text: #92400e;
      --danger-bg: #fee2e2;
      --danger-text: #991b1b;
      --sidebar-bg: #500724;
      --sidebar-text: #fdf2f8;
      --sidebar-hover: #831843;
      --sidebar-muted: #fbcfe8;
      --shadow: 0 10px 28px -16px rgb(219 39 119 / 0.32);
    }
    [data-theme="terminal"] {
      color-scheme: dark;
      --bg: #020617;
      --panel: #07140d;
      --ink: #dcfce7;
      --muted: #86efac;
      --line: #14532d;
      --primary: #22c55e;
      --primary-hover: #16a34a;
      --primary-bg: rgba(34, 197, 94, 0.18);
      --success-bg: rgba(34, 197, 94, 0.18);
      --success-text: #86efac;
      --warn-bg: rgba(250, 204, 21, 0.18);
      --warn-text: #fde047;
      --danger-bg: rgba(244, 63, 94, 0.18);
      --danger-text: #fb7185;
      --sidebar-bg: #000000;
      --sidebar-text: #dcfce7;
      --sidebar-hover: #052e16;
      --sidebar-muted: #86efac;
      --shadow: 0 10px 28px -16px rgb(34 197 94 / 0.4);
    }
    * { box-sizing: border-box; }
    body { 
      margin: 0; background: var(--bg); color: var(--ink); 
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; 
      transition: background-color 0.3s ease, color 0.3s ease;
    }
    .app { min-height: 100vh; display: grid; grid-template-columns: 240px 1fr; }
    aside { 
      background: var(--sidebar-bg); color: var(--sidebar-text); 
      padding: 24px 16px; position: sticky; top: 0; height: 100vh; 
      display: flex; flex-direction: column;
      border-right: 1px solid var(--line);
      transition: background-color 0.3s ease;
    }
    .brand { font-weight: 900; font-size: 20px; margin-bottom: 24px; padding: 0 12px; letter-spacing: -0.5px;}
    nav { display: grid; gap: 6px; flex: 1; align-content: flex-start; }
    nav button { 
      text-align: left; color: var(--sidebar-muted); background: transparent; 
      border: 0; border-radius: 10px; padding: 12px 14px; font: inherit; font-size: 14px; font-weight: 500;
      cursor: pointer; transition: all 0.2s; 
    }
    nav button.active, nav button:hover { background: var(--sidebar-hover); color: var(--sidebar-text); }
    .aside-footer { margin-top: auto; display: grid; gap: 12px; padding: 0 12px;}
    .theme-select {
      width: 100%; padding: 10px; background: var(--sidebar-hover); color: var(--sidebar-text);
      border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; font-size: 13px; outline: none; cursor: pointer;
    }
    .logout { display: block; color: var(--sidebar-muted); text-decoration: none; font-size: 14px; padding: 8px 0; transition: color 0.2s;}
    .logout:hover { color: var(--danger-text); }
    
    main { padding: 32px; min-width: 0; }
    .topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 24px; }
    h1 { margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.5px; }
    .sub { color: var(--muted); margin-top: 6px; font-size: 14px; }
    .pill { 
      display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; 
      padding: 6px 14px; font-size: 13px; font-weight: 700; 
      background: var(--primary-bg); color: var(--primary); 
    }
    .pill.ok { background: var(--success-bg); color: var(--success-text); }
    .pill.warn { background: var(--warn-bg); color: var(--warn-text); }
    .pill.bad { background: var(--danger-bg); color: var(--danger-text); }
    
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
    .grid.two { grid-template-columns: 1.2fr .8fr; }
    .card { 
      background: var(--panel); border: 1px solid var(--line); 
      border-radius: var(--radius); box-shadow: var(--shadow); 
      padding: 24px; min-width: 0; 
      transition: background-color 0.3s ease, border-color 0.3s ease;
    }
    .card h3 { margin: 0 0 16px 0; font-size: 16px; font-weight: 700; }
    .metric-label { color: var(--muted); font-size: 14px; font-weight: 500; }
    .metric { font-size: 30px; font-weight: 800; margin-top: 8px; letter-spacing: -0.5px;}
    
    .section { display: none; animation: fadeIn 0.3s ease; }
    .section.active { display: block; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    
    .toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 0 0 20px; }
    input, select { 
      border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; 
      font: inherit; background: var(--panel); color: var(--ink); font-size: 14px; outline: none;
      transition: border-color 0.2s;
    }
    input:focus, select:focus { border-color: var(--primary); }
    button.action { 
      border: 1px solid var(--line); background: var(--panel); color: var(--ink);
      border-radius: 10px; padding: 10px 14px; cursor: pointer; font-size: 14px; font-weight: 500;
      transition: all 0.2s;
    }
    button.action:hover { border-color: var(--primary); color: var(--primary); }
    
    .table-container { overflow-x: auto; margin: -24px; padding: 24px; }
    table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 14px; }
    th, td { border-bottom: 1px solid var(--line); padding: 14px 12px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 13px; font-weight: 600; background: var(--bg); position: sticky; top: 0; z-index: 1; }
    th:first-child { border-top-left-radius: 8px; border-bottom-left-radius: 8px; }
    th:last-child { border-top-right-radius: 8px; border-bottom-right-radius: 8px; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--bg); }
    
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; background: var(--bg); padding: 2px 6px; border-radius: 6px; color: var(--primary); }
    .muted { color: var(--muted); }
    .list { display: grid; gap: 12px; }
    .event { border: 1px solid var(--line); border-radius: 12px; padding: 16px; background: var(--panel); transition: border-color 0.2s; }
    .event:hover { border-color: var(--primary); }
    .event-title { font-weight: 700; font-size: 15px;}
    .event-detail { color: var(--muted); margin-top: 8px; word-break: break-word; line-height: 1.5;}
    
    .split { display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 20px; }
    .drawer { position: sticky; top: 32px; max-height: calc(100vh - 64px); overflow: auto; }
    .tabs { display: inline-flex; background: var(--line); border-radius: 10px; overflow: hidden; padding: 2px; }
    .tabs button { border: 0; background: transparent; padding: 8px 16px; cursor: pointer; color: var(--muted); font-weight: 500; border-radius: 8px; font-size: 14px; transition: all 0.2s;}
    .tabs button:hover { color: var(--ink); }
    .tabs button.active { background: var(--panel); color: var(--primary); font-weight: 700; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .empty { color: var(--muted); padding: 32px 16px; text-align: center; font-size: 14px; }
    
    .bar { height: 6px; background: var(--line); border-radius: 999px; overflow: hidden; margin-top: 8px; }
    .bar span { display: block; height: 100%; background: var(--primary); border-radius: 999px; }
    
    @media (max-width: 1024px) {
      .app { grid-template-columns: 1fr; }
      aside { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--line); padding: 16px; }
      nav { grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 8px; }
      .aside-footer { flex-direction: row; justify-content: space-between; align-items: center; margin-top: 16px; padding: 0; }
      .theme-select { width: auto; }
      .grid, .grid.two, .split { grid-template-columns: 1fr; }
      main { padding: 20px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <div class="brand">BananaBot</div>
      <nav>
        <button class="active" data-section="overview">仪表盘总览</button>
        <button data-section="chats">会话管理</button>
        <button data-section="usage">Token 消耗</button>
        <button data-section="reminders">定时提醒</button>
        <button data-section="memories">记忆库</button>
        <button data-section="recent">实时事件</button>
      </nav>
      <div class="aside-footer">
        <select class="theme-select" id="themeSelect">
          <option value="system">跟随系统</option>
          <option value="light">浅色模式</option>
          <option value="dark">暗黑模式</option>
          <option value="ocean">海盐蓝</option>
          <option value="forest">青竹绿</option>
          <option value="sunset">日落橙</option>
          <option value="berry">荔枝粉</option>
          <option value="terminal">终端绿</option>
        </select>
        <a class="logout" href="./logout">退出登录</a>
      </div>
    </aside>
    <main>
      <div class="topbar">
        <div>
          <h1>控制台数据中心</h1>
          <div class="sub" id="subtitle">正在加载数据...</div>
        </div>
        <div id="statePill" class="pill">加载中</div>
      </div>

      <section id="overview" class="section active">
        <div class="grid" id="metricGrid"></div>
        <div class="grid two" style="margin-top:20px;">
          <div class="card">
            <h3>高消耗会话 Top 8</h3>
            <div id="topChats"></div>
          </div>
          <div class="card">
            <h3>模型配置参数</h3>
            <div id="modelBox"></div>
          </div>
        </div>
      </section>

      <section id="chats" class="section">
        <div class="toolbar">
          <div class="tabs">
            <button class="active" data-scope="">全部分组</button>
            <button data-scope="group">仅群聊</button>
            <button data-scope="private">仅私聊</button>
          </div>
          <input id="chatSearch" placeholder="搜索会话名称..." style="flex:1; max-width: 300px;" />
          <button class="action" id="refreshChats">↻ 刷新列表</button>
        </div>
        <div class="split">
          <div class="card">
            <div class="table-container">
              <table>
                <thead><tr><th>会话名称</th><th>权限状态</th><th>今日统计</th><th>总 Token</th><th>最近活跃</th><th>管理操作</th></tr></thead>
                <tbody id="chatRows"></tbody>
              </table>
            </div>
          </div>
          <div class="card drawer" id="chatDetail"><div class="empty">👈 请在左侧选择一个会话查看详细信息</div></div>
        </div>
      </section>

      <section id="usage" class="section">
        <div class="toolbar">
          <select id="usageDays">
            <option value="7">查看最近 7 天</option>
            <option value="14">查看最近 14 天</option>
            <option value="30">查看最近 30 天</option>
          </select>
          <button class="action" id="refreshUsage">↻ 重新计算</button>
        </div>
        <div class="grid" id="usageMetrics"></div>
        <div class="grid two" style="margin-top:20px;">
          <div class="card"><h3>按日期统计</h3><div id="usageByDate"></div></div>
          <div class="card"><h3>按模型与功能分类</h3><div id="usageByModel"></div></div>
        </div>
      </section>

      <section id="reminders" class="section">
        <div class="card">
          <div class="table-container">
            <table>
              <thead><tr><th>触发时间</th><th>目标会话</th><th>提醒内容</th><th>当前状态</th><th>管理</th></tr></thead>
              <tbody id="reminderRows"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="memories" class="section">
        <div class="card"><div class="list" id="memoryList"></div></div>
      </section>

      <section id="recent" class="section">
        <div class="card"><div class="list" id="recentList"></div></div>
      </section>
    </main>
  </div>

  <script>
    // --- Theme Logic ---
    const themeSelect = document.getElementById('themeSelect');
    const root = document.documentElement;

    function applyTheme(theme) {
      if (theme === 'system') {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
          root.setAttribute('data-theme', 'dark');
        } else {
          root.removeAttribute('data-theme');
        }
      } else if (theme === 'dark') {
        root.setAttribute('data-theme', 'dark');
      } else if (theme && theme !== 'light') {
        root.setAttribute('data-theme', theme);
      } else {
        root.removeAttribute('data-theme');
      }
    }

    const savedTheme = localStorage.getItem('bot_console_theme') || 'system';
    themeSelect.value = themeSelect.querySelector('option[value="' + savedTheme + '"]') ? savedTheme : 'system';
    applyTheme(themeSelect.value);

    themeSelect.addEventListener('change', function (e) {
      const theme = e.target.value;
      localStorage.setItem('bot_console_theme', theme);
      applyTheme(theme);
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
      if (localStorage.getItem('bot_console_theme') === 'system') {
        applyTheme('system');
      }
    });

    // --- State & App Logic ---
    const state = { section: 'overview', scope: '', chats: [], selectedChatId: '', showRaw: false };
    const groupModes = [
      ['quiet', '安静模式'],
      ['smart', '智能模式'],
      ['active', '活跃模式'],
      ['super_active', '超活跃模式'],
      ['talkative', '话唠模式']
    ];
    const accessOptions = [
      ['default', '默认策略'],
      ['allow', '强制允许'],
      ['deny', '强制禁止']
    ];

    function esc(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
    function fmtDate(value) {
      return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
    }
    function fmtNum(value) {
      return Number(value || 0).toLocaleString('zh-CN');
    }
    function modeLabel(mode) {
      const found = groupModes.find(function (item) { return item[0] === mode; });
      return found ? found[1] : mode || '-';
    }
    function accessLabel(status) {
      return status === 'allow' ? '允许' : status === 'deny' ? '禁止' : '默认';
    }
    async function api(path, options) {
      const res = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, options || {}));
      if (res.status === 401) {
        location.href = './login';
        throw new Error('unauthorized');
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'request failed');
      return data;
    }
    function renderMetrics(metrics) {
      document.getElementById('metricGrid').innerHTML = [
        ['总计会话', metrics.chats],
        ['服务群聊', metrics.groups],
        ['服务私聊', metrics.privates],
        ['今日 Token', metrics.usageToday.totalTokens],
        ['今日调用', metrics.usageToday.calls],
        ['待办提醒', metrics.pendingReminders + ' / ' + metrics.reminders],
        ['留存记忆', metrics.memories],
        ['处理消息', metrics.messages]
      ].map(function (item) {
        return '<div class="card"><div class="metric-label">' + esc(item[0]) + '</div><div class="metric">' + esc(fmtNum(item[1])) + '</div></div>';
      }).join('');
    }
    async function loadOverview() {
      const data = await api('./api/overview');
      const status = data.status;
      document.getElementById('subtitle').textContent = '登陆微信: ' + (status.loginUserName || '未登录') + ' · 稳定运行 ' + Math.floor(status.uptimeSeconds / 60) + ' 分钟';
      const pill = document.getElementById('statePill');
      pill.textContent = status.wechatState === 'logged_in' ? '🟢 引擎运行中' : (status.wechatState === 'waiting_scan' ? '🟡 等待扫码' : '🔴 ' + status.wechatState);
      pill.className = 'pill ' + (status.wechatState === 'logged_in' ? 'ok' : status.wechatState === 'waiting_scan' ? 'warn' : 'bad');
      renderMetrics(data.totals);
      document.getElementById('modelBox').innerHTML = Object.entries(data.models).map(function (entry) {
        return '<div style="margin-bottom: 12px;"><div class="metric-label">' + esc(entry[0].toUpperCase()) + '</div><code style="display:inline-block; margin-top:4px;">' + esc(entry[1]) + '</code></div>';
      }).join('');
      document.getElementById('topChats').innerHTML = data.topChatsByTokens.length ? data.topChatsByTokens.map(function (chat) {
        const pct = data.topChatsByTokens[0].todayTokens ? Math.round(chat.todayTokens / data.topChatsByTokens[0].todayTokens * 100) : 0;
        return '<div style="margin:16px 0;"><div><b style="font-size:14px;">' + esc(chat.chatName) + '</b> <span class="muted" style="font-size:12px; margin-left:4px;">' + esc(chat.scope) + '</span><span style="float:right; font-weight:700; color:var(--primary);">' + fmtNum(chat.todayTokens) + '</span></div><div class="bar"><span style="width:' + pct + '%"></span></div></div>';
      }).join('') : '<div class="empty">今天还没有产生任何 Token 消耗</div>';
    }
    async function loadChats() {
      const data = await api('./api/chats' + (state.scope ? '?scope=' + encodeURIComponent(state.scope) : ''));
      state.chats = data.items;
      renderChats();
    }
    function renderChats() {
      const query = document.getElementById('chatSearch').value.trim().toLowerCase();
      const rows = state.chats.filter(function (chat) {
        return !query || chat.chatName.toLowerCase().includes(query);
      }).map(function (chat) {
        const modeSelect = chat.scope === 'group'
          ? '<select data-action="mode" data-id="' + esc(chat.chatId) + '" style="margin-bottom:4px;width:100%;">' + groupModes.map(function (m) { return '<option value="' + m[0] + '"' + (chat.groupMode === m[0] ? ' selected' : '') + '>' + m[1] + '</option>'; }).join('') + '</select>'
          : '';
        const accessSelect = '<select data-action="access" data-id="' + esc(chat.chatId) + '" style="margin-bottom:4px;width:100%;">' + accessOptions.map(function (opt) { return '<option value="' + opt[0] + '"' + (chat.access === opt[0] ? ' selected' : '') + '>聊天: ' + opt[1] + '</option>'; }).join('') + '</select>';
        const videoSelect = chat.scope === 'private'
          ? '<select data-action="privateVideo" data-id="' + esc(chat.chatId) + '" style="width:100%;">' + accessOptions.map(function (opt) { return '<option value="' + opt[0] + '"' + (chat.privateVideo === opt[0] ? ' selected' : '') + '>视频: ' + opt[1] + '</option>'; }).join('') + '</select>'
          : '';
        return '<tr>' +
          '<td><button class="action" data-action="detail" data-id="' + esc(chat.chatId) + '" style="margin-bottom:6px;">' + esc(chat.chatName) + '</button><br><code>' + esc(chat.idShort) + '</code> <span class="muted" style="font-size:12px">' + esc(chat.scope === 'group' ? '群聊' : '私聊') + '</span></td>' +
          '<td><div style="font-size:13px; line-height: 1.6;">' + (chat.scope === 'group' ? '<span class="muted">群模式</span> ' + esc(modeLabel(chat.groupMode)) + '<br>' : '<span class="muted">视频</span> ' + esc(accessLabel(chat.privateVideo)) + '<br>') + '<span class="muted">聊天</span> ' + esc(accessLabel(chat.access)) + '</div></td>' +
          '<td><div style="font-size:13px; line-height: 1.6;"><span class="muted">消息</span> ' + fmtNum(chat.todayMessageCount) + '<br><span class="muted">Token</span> <span style="color:var(--primary); font-weight:600">' + fmtNum(chat.todayTokens) + '</span></div></td>' +
          '<td><span style="font-weight:600">' + fmtNum(chat.totalTokens) + '</span></td>' +
          '<td><div style="font-size:12px; line-height: 1.6;">' + esc(fmtDate(chat.lastMessageAt)) + '<br><span class="pill" style="padding:2px 8px; font-size:11px; margin-top:4px;">' + esc(chat.lastMessageType) + '</span></div></td>' +
          '<td style="min-width:130px;">' + modeSelect + accessSelect + videoSelect + '</td>' +
          '</tr>';
      }).join('');
      document.getElementById('chatRows').innerHTML = rows || '<tr><td colspan="6" class="empty">列表中暂无会话数据</td></tr>';
    }
    async function loadChatDetail(chatId, raw) {
      state.selectedChatId = chatId;
      state.showRaw = Boolean(raw);
      const data = await api('./api/chat?id=' + encodeURIComponent(chatId) + '&raw=' + (state.showRaw ? '1' : '0'));
      const chat = data.chat;
      if (!chat) return;
      document.getElementById('chatDetail').innerHTML = '<h3 style="margin-top:0; font-size:20px;">' + esc(chat.chatName) + '</h3><p class="muted" style="font-size:13px; margin-bottom: 24px;">' + esc(chat.scope) + ' · ' + esc(chat.idShort || '') + '</p><div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;"><h4 style="margin:0;">最近消息</h4><button class="action" id="toggleRaw" style="padding: 6px 12px; font-size: 12px;">' + (state.showRaw ? '隐藏原文' : '显示原文') + '</button></div><div class="list">' + (data.messages.map(function (msg) { return '<div class="event" style="padding:12px;"><div class="event-title" style="font-size:14px;">' + esc(msg.talkerName || msg.role) + ' <span class="muted" style="font-weight:normal; font-size:12px; margin-left:4px;">' + esc(msg.messageType) + '</span></div><div class="muted" style="font-size:12px; margin-top:2px;">' + esc(fmtDate(msg.timestamp)) + '</div><div class="event-detail" style="font-size:13px; margin-top:6px;">' + esc(msg.text) + '</div></div>'; }).join('') || '<div class="empty" style="padding:16px;">没有消息</div>') + '</div><h4 style="margin-top:32px; margin-bottom:12px;">定时提醒</h4>' + smallList(data.reminders, 'content') + '<h4 style="margin-top:32px; margin-bottom:12px;">记忆片段</h4>' + smallList(data.memories, 'content');
      document.getElementById('toggleRaw').onclick = function () { loadChatDetail(chatId, !state.showRaw); };
    }
    function smallList(items, field) {
      return '<div class="list">' + (items.slice(0, 8).map(function (item) { return '<div class="event" style="padding:12px;"><div class="muted" style="font-size:12px;">' + esc(fmtDate(item.timestamp || item.remindAt || item.createdAt)) + '</div><div class="event-detail" style="font-size:13px; margin-top:4px;">' + esc(item[field] || '-') + '</div></div>'; }).join('') || '<div class="empty" style="padding:16px;">暂无记录</div>') + '</div>';
    }
    async function loadUsage() {
      const days = document.getElementById('usageDays').value;
      const data = await api('./api/usage?days=' + days);
      document.getElementById('usageMetrics').innerHTML = [
        ['累计 Token', data.total.totalTokens],
        ['模型调用次数', data.total.calls],
        ['输入 (Prompt) Token', data.total.promptTokens],
        ['输出 (Completion) Token', data.total.completionTokens]
      ].map(function (item) { return '<div class="card"><div class="metric-label">' + item[0] + '</div><div class="metric" style="color:var(--primary);">' + fmtNum(item[1]) + '</div></div>'; }).join('');
      document.getElementById('usageByDate').innerHTML = data.byDate.map(function (row) { return '<div style="display:flex; justify-content:space-between; padding: 12px 0; border-bottom: 1px dashed var(--line);"><b style="font-size:14px; color:var(--muted);">' + esc(row.date) + '</b><span style="font-weight:700;">' + fmtNum(row.totalTokens) + ' <span style="font-weight:normal; font-size:12px; color:var(--muted);">tokens</span></span></div>'; }).join('');
      document.getElementById('usageByModel').innerHTML = '<h4 style="margin-top:0;">按模型分发</h4>' + usageList(data.byModel) + '<h4 style="margin-top:32px;">按功能场景</h4>' + usageList(data.byFeature);
    }
    function usageList(rows) {
      return rows.map(function (row) { return '<div style="display:flex; justify-content:space-between; align-items:center; padding: 8px 0; border-bottom: 1px solid var(--line);"><code>' + esc(row.name) + '</code><span style="font-weight:600;">' + fmtNum(row.totalTokens) + '</span></div>'; }).join('') || '<div class="empty" style="padding:16px;">无数据</div>';
    }
    async function loadReminders() {
      const data = await api('./api/reminders');
      document.getElementById('reminderRows').innerHTML = data.items.map(function (item) {
        const cancel = item.status === 'pending' ? '<button class="action" data-action="cancelReminder" data-id="' + esc(item.id) + '" style="color:var(--danger-text); border-color:var(--danger-bg);">取消提醒</button>' : '';
        const statusPill = item.status === 'pending' ? '<span class="pill warn">待执行</span>' : '<span class="pill ok">' + esc(item.status) + '</span>';
        return '<tr><td>' + esc(fmtDate(item.remindAt)) + '</td><td style="font-weight:500;">' + esc(item.chatName) + '</td><td>' + esc(item.content) + '</td><td>' + statusPill + '</td><td>' + cancel + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="empty">没有设置任何提醒</td></tr>';
    }
    async function loadMemories() {
      const data = await api('./api/memories');
      document.getElementById('memoryList').innerHTML = data.items.map(function (item) {
        return '<div class="event"><div style="display:flex; justify-content:space-between; align-items:center;"><div class="event-title">' + esc(item.chatName) + '</div><div class="muted" style="font-size:13px;">' + esc(fmtDate(item.timestamp)) + '</div></div><div class="event-detail" style="margin-top:12px;">' + esc(item.content) + '</div></div>';
      }).join('') || '<div class="empty">知识库中暂无记忆</div>';
    }
    async function loadRecent() {
      const data = await api('./api/recent');
      document.getElementById('recentList').innerHTML = data.items.map(function (item) {
        return '<div class="event"><div style="display:flex; justify-content:space-between; align-items:flex-start;"><div class="event-title" style="color:var(--primary);">' + esc(item.title) + '</div><div class="muted" style="font-size:12px; text-align:right;">' + esc(fmtDate(item.at)) + '<br><span style="background:var(--bg); padding:2px 6px; border-radius:4px; margin-top:4px; display:inline-block;">' + esc(item.type) + '</span></div></div><div class="event-detail" style="margin-top:8px;">' + esc(item.detail) + '</div></div>';
      }).join('') || '<div class="empty">近期没有任何事件</div>';
    }
    async function setGroupMode(chatId, mode) {
      await api('./api/settings/group-mode', { method: 'POST', body: JSON.stringify({ chatId, mode }) });
      await loadChats();
    }
    async function setAccess(chatId, status) {
      await api('./api/settings/chat-access', { method: 'POST', body: JSON.stringify({ chatId, status }) });
      await loadChats();
    }
    async function setPrivateVideo(chatId, status) {
      await api('./api/settings/private-video', { method: 'POST', body: JSON.stringify({ chatId, status }) });
      await loadChats();
    }
    async function cancelReminder(id) {
      await api('./api/reminders/cancel', { method: 'POST', body: JSON.stringify({ id }) });
      await loadReminders();
    }
    function activate(section) {
      state.section = section;
      document.querySelectorAll('nav button').forEach(function (button) { button.classList.toggle('active', button.dataset.section === section); });
      document.querySelectorAll('.section').forEach(function (panel) { panel.classList.toggle('active', panel.id === section); });
      if (section === 'overview') loadOverview();
      if (section === 'chats') loadChats();
      if (section === 'usage') loadUsage();
      if (section === 'reminders') loadReminders();
      if (section === 'memories') loadMemories();
      if (section === 'recent') loadRecent();
    }
    document.addEventListener('click', function (event) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const nav = target.closest('nav button');
      if (nav) activate(nav.dataset.section);
      const scope = target.closest('[data-scope]');
      if (scope) {
        state.scope = scope.dataset.scope || '';
        document.querySelectorAll('[data-scope]').forEach(function (button) { button.classList.toggle('active', button.dataset.scope === state.scope); });
        loadChats();
      }
      if (target.dataset.action === 'detail') loadChatDetail(target.dataset.id, false);
      if (target.dataset.action === 'cancelReminder') cancelReminder(target.dataset.id);
    });
    document.addEventListener('change', function (event) {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement)) return;
      if (target.dataset.action === 'mode') setGroupMode(target.dataset.id, target.value);
      if (target.dataset.action === 'access') setAccess(target.dataset.id, target.value);
      if (target.dataset.action === 'privateVideo') setPrivateVideo(target.dataset.id, target.value);
    });
    document.getElementById('chatSearch').addEventListener('input', renderChats);
    document.getElementById('refreshChats').onclick = loadChats;
    document.getElementById('refreshUsage').onclick = loadUsage;
    document.getElementById('usageDays').onchange = loadUsage;
    
    loadOverview();
    setInterval(function () {
      if (state.section === 'overview') loadOverview();
    }, 10000);
  </script>
</body>
</html>`;
}
