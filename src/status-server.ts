import http from "http";
import { Config } from "./config.js";

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
      return (error.message || error.stack || "Unknown error").split("\n")[0].slice(0, 500);
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
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const snapshot = botStatus.snapshot();

    if (url.pathname === "/status.json") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(snapshot, null, 2));
      return;
    }

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(renderStatusHtml(snapshot));
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

function renderStatusHtml(snapshot: ReturnType<BotStatus["snapshot"]>): string {
  const stateText: Record<WechatState, string> = {
    starting: "启动中",
    waiting_scan: "等待扫码",
    logged_in: "已登录",
    logged_out: "已退出",
    error: "异常",
  };
  const stateClass =
    snapshot.wechatState === "logged_in"
      ? "ok"
      : snapshot.wechatState === "waiting_scan"
      ? "warn"
      : "bad";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="10" />
  <title>WeChat Bot Status</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f7fb; color: #172033; }
    main { max-width: 920px; margin: 0 auto; padding: 32px 18px; }
    h1 { margin: 0 0 18px; font-size: 28px; }
    .pill { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px; font-weight: 700; }
    .ok { background: #dff7e8; color: #116b35; }
    .warn { background: #fff1cc; color: #7a4d00; }
    .bad { background: #ffe0e0; color: #8a1e1e; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 18px; }
    section { background: #fff; border: 1px solid #e5eaf2; border-radius: 10px; padding: 16px; box-shadow: 0 8px 24px rgba(21, 34, 58, .05); }
    h2 { font-size: 14px; margin: 0 0 12px; color: #5e6a7e; }
    dl { margin: 0; display: grid; grid-template-columns: 92px 1fr; row-gap: 8px; column-gap: 10px; }
    dt { color: #647086; }
    dd { margin: 0; word-break: break-word; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    footer { margin-top: 16px; color: #7c8799; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <h1>WeChat Bot Status</h1>
    <div class="pill ${stateClass}">${escapeHtml(stateText[snapshot.wechatState])}</div>
    <div class="grid">
      <section>
        <h2>运行</h2>
        <dl>
          <dt>启动时间</dt><dd>${escapeHtml(formatDate(snapshot.serviceStartedAt))}</dd>
          <dt>运行时长</dt><dd>${escapeHtml(formatDuration(snapshot.uptimeSeconds))}</dd>
          <dt>微信账号</dt><dd>${escapeHtml(snapshot.loginUserName || "-")}</dd>
          <dt>最近登录</dt><dd>${escapeHtml(formatDate(snapshot.lastLoginAt))}</dd>
        </dl>
      </section>
      <section>
        <h2>模型</h2>
        <dl>
          <dt>聊天</dt><dd><code>${escapeHtml(snapshot.models.chat)}</code></dd>
          <dt>路由</dt><dd><code>${escapeHtml(snapshot.models.agent)}</code></dd>
          <dt>视觉</dt><dd><code>${escapeHtml(snapshot.models.vision)}</code></dd>
          <dt>语音</dt><dd><code>${escapeHtml(snapshot.models.audio)}</code></dd>
        </dl>
      </section>
      <section>
        <h2>消息</h2>
        <dl>
          <dt>收到</dt><dd>${snapshot.incomingMessageCount}</dd>
          <dt>发出</dt><dd>${snapshot.outgoingMessageCount}</dd>
          <dt>最近消息</dt><dd>${escapeHtml(formatLastMessage(snapshot.lastIncomingMessage))}</dd>
          <dt>最近回复</dt><dd>${escapeHtml(formatDate(snapshot.lastOutgoingAt))}</dd>
        </dl>
      </section>
      <section>
        <h2>API</h2>
        <dl>
          <dt>调用次数</dt><dd>${snapshot.apiCallCount}</dd>
          <dt>Token</dt><dd>${snapshot.totalTokens}</dd>
          <dt>最近模型</dt><dd><code>${escapeHtml(snapshot.lastApiModel || "-")}</code></dd>
          <dt>最近调用</dt><dd>${escapeHtml(formatDate(snapshot.lastApiAt))}</dd>
        </dl>
      </section>
    </div>
    <section style="margin-top: 12px;">
      <h2>最近错误</h2>
      <dl>
        <dt>时间</dt><dd>${escapeHtml(formatDate(snapshot.lastErrorAt))}</dd>
        <dt>内容</dt><dd>${escapeHtml(snapshot.lastError ? snapshot.lastError.slice(0, 500) : "-")}</dd>
      </dl>
    </section>
    <footer>页面每 10 秒自动刷新；JSON: <a href="./status.json">status.json</a></footer>
  </main>
</body>
</html>`;
}

function formatLastMessage(message?: LastIncomingMessage): string {
  if (!message) {
    return "-";
  }
  const scope = message.scope === "group" ? `群聊/${message.roomName}` : "私聊";
  return `${formatDate(message.at)} ${scope} ${message.talkerName || "-"} type=${message.type}`;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
