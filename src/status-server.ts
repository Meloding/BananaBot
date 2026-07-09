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
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #eef2f7; color: #172033; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .box { width: min(420px, calc(100% - 32px)); background: #fff; border: 1px solid #dde4ee; border-radius: 12px; padding: 28px; box-shadow: 0 22px 70px rgba(20, 32, 55, .12); }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 0 0 22px; color: #667085; line-height: 1.6; }
    label { display: block; font-size: 13px; color: #667085; margin-bottom: 8px; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #cfd7e3; border-radius: 8px; padding: 12px; font: inherit; }
    button { width: 100%; border: 0; border-radius: 8px; background: #2563eb; color: #fff; padding: 12px; font-weight: 800; margin-top: 14px; cursor: pointer; }
    .err { color: #b42318; min-height: 22px; margin-top: 12px; }
    .hint { margin-top: 18px; font-size: 12px; color: #8a94a6; }
  </style>
</head>
<body>
  <main class="box">
    <h1>Bot Console</h1>
    <p>输入 root token 后进入控制台。不要把 token 放进 URL 或截图里。</p>
    <form id="loginForm">
      <label for="token">Root token</label>
      <input id="token" name="token" type="password" autocomplete="current-password" autofocus />
      <button type="submit">登录</button>
      <div class="err" id="err"></div>
    </form>
    <div class="hint">建议后续给 dawnfy.top 配 HTTPS；HTTP 下 token 仍会经过明文链路。</div>
  </main>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async function (event) {
      event.preventDefault();
      const err = document.getElementById('err');
      err.textContent = '';
      const token = document.getElementById('token').value;
      const res = await fetch('./login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token })
      });
      if (res.ok) {
        location.href = './';
      } else {
        err.textContent = 'token 不对，或者服务器没有配置 rootAuthToken。';
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
  <title>MyWechatBot Console</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f3f6fb;
      --panel: #ffffff;
      --ink: #172033;
      --muted: #667085;
      --line: #dce3ed;
      --blue: #2563eb;
      --green: #078855;
      --amber: #b54708;
      --red: #b42318;
      --slate: #344054;
      --shadow: 0 14px 40px rgba(20, 32, 55, .08);
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
    .app { min-height: 100vh; display: grid; grid-template-columns: 236px 1fr; }
    aside { background: #111827; color: #eef2ff; padding: 22px 16px; position: sticky; top: 0; height: 100vh; }
    .brand { font-weight: 900; font-size: 19px; margin-bottom: 20px; }
    nav { display: grid; gap: 8px; }
    nav button { text-align: left; color: #cbd5e1; background: transparent; border: 0; border-radius: 8px; padding: 10px 12px; font: inherit; cursor: pointer; }
    nav button.active, nav button:hover { background: #253046; color: #fff; }
    .logout { display: block; color: #cbd5e1; text-decoration: none; margin-top: 22px; font-size: 13px; }
    main { padding: 24px; min-width: 0; }
    .topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 18px; }
    h1 { margin: 0; font-size: 26px; }
    .sub { color: var(--muted); margin-top: 4px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 6px 10px; font-size: 12px; font-weight: 800; background: #e7eefb; color: #1d4ed8; }
    .pill.ok { background: #dff7e8; color: #067647; }
    .pill.warn { background: #fff4db; color: #92400e; }
    .pill.bad { background: #ffe4e8; color: #b42318; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .grid.two { grid-template-columns: 1.2fr .8fr; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); padding: 16px; min-width: 0; }
    .metric-label { color: var(--muted); font-size: 13px; }
    .metric { font-size: 26px; font-weight: 900; margin-top: 6px; }
    .section { display: none; }
    .section.active { display: block; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 0 0 14px; }
    input, select { border: 1px solid #cfd7e3; border-radius: 8px; padding: 8px 10px; font: inherit; background: #fff; }
    button.action { border: 1px solid #cfd7e3; background: #fff; border-radius: 8px; padding: 8px 10px; cursor: pointer; }
    button.primary { background: var(--blue); color: #fff; border-color: var(--blue); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid var(--line); padding: 10px 8px; text-align: left; vertical-align: top; }
    th { color: #475467; font-size: 12px; background: #f8fafc; position: sticky; top: 0; z-index: 1; }
    tr:hover td { background: #fbfdff; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .muted { color: var(--muted); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .list { display: grid; gap: 10px; }
    .event { border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: #fff; }
    .event-title { font-weight: 800; }
    .event-detail { color: var(--muted); margin-top: 4px; word-break: break-word; }
    .split { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 14px; }
    .drawer { position: sticky; top: 18px; max-height: calc(100vh - 36px); overflow: auto; }
    .tabs { display: inline-flex; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
    .tabs button { border: 0; background: #fff; padding: 8px 12px; cursor: pointer; }
    .tabs button.active { background: #e7eefb; color: var(--blue); font-weight: 800; }
    .empty { color: var(--muted); padding: 18px; text-align: center; }
    .bar { height: 8px; background: #e8edf5; border-radius: 999px; overflow: hidden; }
    .bar span { display: block; height: 100%; background: #2563eb; }
    @media (max-width: 980px) {
      .app { grid-template-columns: 1fr; }
      aside { position: static; height: auto; }
      nav { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .grid, .grid.two, .split { grid-template-columns: 1fr; }
      main { padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <div class="brand">MyWechatBot</div>
      <nav>
        <button class="active" data-section="overview">总览</button>
        <button data-section="chats">会话</button>
        <button data-section="usage">Token</button>
        <button data-section="reminders">提醒</button>
        <button data-section="memories">记忆</button>
        <button data-section="recent">事件</button>
      </nav>
      <a class="logout" href="./logout">退出登录</a>
    </aside>
    <main>
      <div class="topbar">
        <div>
          <h1>Bot Console</h1>
          <div class="sub" id="subtitle">Loading...</div>
        </div>
        <div id="statePill" class="pill">Loading</div>
      </div>

      <section id="overview" class="section active">
        <div class="grid" id="metricGrid"></div>
        <div class="grid two" style="margin-top:14px;">
          <div class="card">
            <h3>高消耗会话</h3>
            <div id="topChats"></div>
          </div>
          <div class="card">
            <h3>模型</h3>
            <div id="modelBox"></div>
          </div>
        </div>
      </section>

      <section id="chats" class="section">
        <div class="toolbar">
          <div class="tabs">
            <button class="active" data-scope="">全部</button>
            <button data-scope="group">群聊</button>
            <button data-scope="private">私聊</button>
          </div>
          <input id="chatSearch" placeholder="搜索会话名" />
          <button class="action" id="refreshChats">刷新</button>
        </div>
        <div class="split">
          <div class="card" style="overflow:auto;">
            <table>
              <thead><tr><th>会话</th><th>状态</th><th>今日</th><th>总 Token</th><th>最近</th><th>操作</th></tr></thead>
              <tbody id="chatRows"></tbody>
            </table>
          </div>
          <div class="card drawer" id="chatDetail"><div class="empty">选择一个会话查看详情</div></div>
        </div>
      </section>

      <section id="usage" class="section">
        <div class="toolbar">
          <select id="usageDays"><option value="7">最近 7 天</option><option value="14">最近 14 天</option><option value="30">最近 30 天</option></select>
          <button class="action" id="refreshUsage">刷新</button>
        </div>
        <div class="grid" id="usageMetrics"></div>
        <div class="grid two" style="margin-top:14px;">
          <div class="card"><h3>按日期</h3><div id="usageByDate"></div></div>
          <div class="card"><h3>按模型 / 功能</h3><div id="usageByModel"></div></div>
        </div>
      </section>

      <section id="reminders" class="section">
        <div class="card" style="overflow:auto;">
          <table>
            <thead><tr><th>时间</th><th>会话</th><th>内容</th><th>状态</th><th>操作</th></tr></thead>
            <tbody id="reminderRows"></tbody>
          </table>
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
    const state = { section: 'overview', scope: '', chats: [], selectedChatId: '', showRaw: false };
    const groupModes = [
      ['quiet', '安静'],
      ['smart', '智能'],
      ['active', '活跃'],
      ['super_active', '超活跃'],
      ['talkative', '话唠']
    ];
    const accessOptions = [
      ['default', '默认'],
      ['allow', '允许'],
      ['deny', '禁止']
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
        ['会话', metrics.chats],
        ['群聊', metrics.groups],
        ['私聊', metrics.privates],
        ['今日 Token', metrics.usageToday.totalTokens],
        ['今日调用', metrics.usageToday.calls],
        ['提醒', metrics.pendingReminders + '/' + metrics.reminders],
        ['记忆', metrics.memories],
        ['总消息', metrics.messages]
      ].map(function (item) {
        return '<div class="card"><div class="metric-label">' + esc(item[0]) + '</div><div class="metric">' + esc(fmtNum(item[1])) + '</div></div>';
      }).join('');
    }
    async function loadOverview() {
      const data = await api('./api/overview');
      const status = data.status;
      document.getElementById('subtitle').textContent = '账号 ' + (status.loginUserName || '-') + ' · 运行 ' + Math.floor(status.uptimeSeconds / 60) + ' 分钟';
      const pill = document.getElementById('statePill');
      pill.textContent = status.wechatState === 'logged_in' ? '已登录' : status.wechatState;
      pill.className = 'pill ' + (status.wechatState === 'logged_in' ? 'ok' : status.wechatState === 'waiting_scan' ? 'warn' : 'bad');
      renderMetrics(data.totals);
      document.getElementById('modelBox').innerHTML = Object.entries(data.models).map(function (entry) {
        return '<p><span class="muted">' + esc(entry[0]) + '</span><br><code>' + esc(entry[1]) + '</code></p>';
      }).join('');
      document.getElementById('topChats').innerHTML = data.topChatsByTokens.length ? data.topChatsByTokens.map(function (chat) {
        const pct = data.topChatsByTokens[0].todayTokens ? Math.round(chat.todayTokens / data.topChatsByTokens[0].todayTokens * 100) : 0;
        return '<div style="margin:12px 0;"><div><b>' + esc(chat.chatName) + '</b> <span class="muted">' + esc(chat.scope) + '</span><span style="float:right">' + fmtNum(chat.todayTokens) + '</span></div><div class="bar"><span style="width:' + pct + '%"></span></div></div>';
      }).join('') : '<div class="empty">今天还没有 token 消耗</div>';
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
          ? '<select data-action="mode" data-id="' + esc(chat.chatId) + '">' + groupModes.map(function (m) { return '<option value="' + m[0] + '"' + (chat.groupMode === m[0] ? ' selected' : '') + '>' + m[1] + '</option>'; }).join('') + '</select>'
          : '<span class="muted">-</span>';
        const accessSelect = '<select data-action="access" data-id="' + esc(chat.chatId) + '">' + accessOptions.map(function (opt) { return '<option value="' + opt[0] + '"' + (chat.access === opt[0] ? ' selected' : '') + '>' + opt[1] + '</option>'; }).join('') + '</select>';
        const videoSelect = chat.scope === 'private'
          ? '<select data-action="privateVideo" data-id="' + esc(chat.chatId) + '">' + accessOptions.map(function (opt) { return '<option value="' + opt[0] + '"' + (chat.privateVideo === opt[0] ? ' selected' : '') + '>' + opt[1] + '</option>'; }).join('') + '</select>'
          : '<span class="muted">-</span>';
        return '<tr><td><button class="action" data-action="detail" data-id="' + esc(chat.chatId) + '">' + esc(chat.chatName) + '</button><br><code>' + esc(chat.idShort) + '</code> <span class="muted">' + esc(chat.scope === 'group' ? '群聊' : '私聊') + '</span></td><td>' + (chat.scope === 'group' ? '群模式 ' + esc(modeLabel(chat.groupMode)) + '<br>' : '视频 ' + esc(accessLabel(chat.privateVideo)) + '<br>') + '聊天 ' + esc(accessLabel(chat.access)) + '</td><td>消息 ' + fmtNum(chat.todayMessageCount) + '<br>Token ' + fmtNum(chat.todayTokens) + '</td><td>' + fmtNum(chat.totalTokens) + '</td><td>' + esc(fmtDate(chat.lastMessageAt)) + '<br><span class="muted">' + esc(chat.lastMessageType) + '</span></td><td>群模式 ' + modeSelect + '<br>聊天 ' + accessSelect + '<br>视频 ' + videoSelect + '</td></tr>';
      }).join('');
      document.getElementById('chatRows').innerHTML = rows || '<tr><td colspan="6" class="empty">没有会话</td></tr>';
    }
    async function loadChatDetail(chatId, raw) {
      state.selectedChatId = chatId;
      state.showRaw = Boolean(raw);
      const data = await api('./api/chat?id=' + encodeURIComponent(chatId) + '&raw=' + (state.showRaw ? '1' : '0'));
      const chat = data.chat;
      if (!chat) return;
      document.getElementById('chatDetail').innerHTML = '<h3>' + esc(chat.chatName) + '</h3><p class="muted">' + esc(chat.scope) + ' · ' + esc(chat.idShort || '') + '</p><button class="action" id="toggleRaw">' + (state.showRaw ? '隐藏原文' : '显示原文') + '</button><h4>最近消息</h4><div class="list">' + (data.messages.map(function (msg) { return '<div class="event"><div class="event-title">' + esc(msg.talkerName || msg.role) + ' · ' + esc(msg.messageType) + '</div><div class="muted">' + esc(fmtDate(msg.timestamp)) + '</div><div class="event-detail">' + esc(msg.text) + '</div></div>'; }).join('') || '<div class="empty">没有消息</div>') + '</div><h4>提醒</h4>' + smallList(data.reminders, 'content') + '<h4>记忆</h4>' + smallList(data.memories, 'content');
      document.getElementById('toggleRaw').onclick = function () { loadChatDetail(chatId, !state.showRaw); };
    }
    function smallList(items, field) {
      return '<div class="list">' + (items.slice(0, 8).map(function (item) { return '<div class="event"><div class="muted">' + esc(fmtDate(item.timestamp || item.remindAt || item.createdAt)) + '</div><div class="event-detail">' + esc(item[field] || '-') + '</div></div>'; }).join('') || '<div class="empty">无</div>') + '</div>';
    }
    async function loadUsage() {
      const days = document.getElementById('usageDays').value;
      const data = await api('./api/usage?days=' + days);
      document.getElementById('usageMetrics').innerHTML = [
        ['总 Token', data.total.totalTokens],
        ['调用次数', data.total.calls],
        ['输入 Token', data.total.promptTokens],
        ['输出 Token', data.total.completionTokens]
      ].map(function (item) { return '<div class="card"><div class="metric-label">' + item[0] + '</div><div class="metric">' + fmtNum(item[1]) + '</div></div>'; }).join('');
      document.getElementById('usageByDate').innerHTML = data.byDate.map(function (row) { return '<p><b>' + esc(row.date) + '</b><span style="float:right">' + fmtNum(row.totalTokens) + ' tokens</span></p>'; }).join('');
      document.getElementById('usageByModel').innerHTML = '<h4>模型</h4>' + usageList(data.byModel) + '<h4>功能</h4>' + usageList(data.byFeature);
    }
    function usageList(rows) {
      return rows.map(function (row) { return '<p><code>' + esc(row.name) + '</code><span style="float:right">' + fmtNum(row.totalTokens) + '</span></p>'; }).join('') || '<div class="empty">无</div>';
    }
    async function loadReminders() {
      const data = await api('./api/reminders');
      document.getElementById('reminderRows').innerHTML = data.items.map(function (item) {
        const cancel = item.status === 'pending' ? '<button class="action" data-action="cancelReminder" data-id="' + esc(item.id) + '">取消</button>' : '';
        return '<tr><td>' + esc(fmtDate(item.remindAt)) + '</td><td>' + esc(item.chatName) + '</td><td>' + esc(item.content) + '</td><td>' + esc(item.status) + '</td><td>' + cancel + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="empty">没有提醒</td></tr>';
    }
    async function loadMemories() {
      const data = await api('./api/memories');
      document.getElementById('memoryList').innerHTML = data.items.map(function (item) {
        return '<div class="event"><div class="event-title">' + esc(item.chatName) + '</div><div class="muted">' + esc(fmtDate(item.timestamp)) + '</div><div class="event-detail">' + esc(item.content) + '</div></div>';
      }).join('') || '<div class="empty">没有记忆</div>';
    }
    async function loadRecent() {
      const data = await api('./api/recent');
      document.getElementById('recentList').innerHTML = data.items.map(function (item) {
        return '<div class="event"><div class="event-title">' + esc(item.title) + '</div><div class="muted">' + esc(fmtDate(item.at)) + ' · ' + esc(item.type) + '</div><div class="event-detail">' + esc(item.detail) + '</div></div>';
      }).join('') || '<div class="empty">没有事件</div>';
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
