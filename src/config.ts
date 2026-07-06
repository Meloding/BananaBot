import * as dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import { parse } from "yaml";
import { IConfig } from "./interface";

let configFile: any = {};

// get configurations from 'config.yaml' first
if (fs.existsSync("./config.yaml")) {
  const file = fs.readFileSync("./config.yaml", "utf8");
  configFile = parse(file);
}
// if 'config.yaml' not exist, read them from env
else {
  configFile = {
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiOrganizationID: process.env.OPENAI_ORGANIZATION_KEY,
    openaiBasePath: process.env.OPENAI_BASE_PATH,
    openaiModel: process.env.OPENAI_MODEL,
    agentModel: process.env.AGENT_MODEL,
    chatgptTriggerKeyword: process.env.CHATGPT_TRIGGER_KEYWORD,
    privateAutoReply: process.env.PRIVATE_AUTO_REPLY,
    defaultGroupMode: process.env.DEFAULT_GROUP_MODE,
    botDataPath: process.env.BOT_DATA_PATH,
    historyMessageLimit: process.env.HISTORY_MESSAGE_LIMIT,
    agentRouterEnabled: process.env.AGENT_ROUTER_ENABLED,
    rootAuthToken: process.env.ROOT_AUTH_TOKEN,
    ignoreOfficialAccounts: process.env.IGNORE_OFFICIAL_ACCOUNTS,
    activeGroupCooldownSeconds: process.env.ACTIVE_GROUP_COOLDOWN_SECONDS,
    reminderFollowupIntervalMinutes: process.env.REMINDER_FOLLOWUP_INTERVAL_MINUTES,
    debugMessageTypes: process.env.DEBUG_MESSAGE_TYPES,
    multimodalEnabled: process.env.MULTIMODAL_ENABLED,
    visionModel: process.env.VISION_MODEL,
    audioModel: process.env.AUDIO_MODEL,
    maxMediaBytes: process.env.MAX_MEDIA_BYTES,
    videoFrameCount: process.env.VIDEO_FRAME_COUNT,
    replyMaxLength: process.env.REPLY_MAX_LENGTH,
    replyMaxSegments: process.env.REPLY_MAX_SEGMENTS,
    stripMarkdown: process.env.STRIP_MARKDOWN,
    allowGlobalUsageReport: process.env.ALLOW_GLOBAL_USAGE_REPORT,
    generatedFilesPath: process.env.GENERATED_FILES_PATH,
  };
}

// warning if no OpenAI API key found
if (configFile.openaiApiKey === undefined) {
  console.error(
    "⚠️ No OPENAI_API_KEY found in env, please export to env or configure in config.yaml"
  );
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return !["false", "0", "no", "off"].includes(value.toLowerCase());
  }
  return fallback;
}

export const Config: IConfig = {
  openaiApiKey: configFile.openaiApiKey,
  openaiOrganizationID: configFile.openaiOrganizationID || "",
  openaiBasePath: configFile.openaiBasePath || "",
  openaiModel: configFile.openaiModel || "qwen-plus",
  agentModel: configFile.agentModel || "qwen-turbo",
  chatgptTriggerKeyword: configFile.chatgptTriggerKeyword || "",
  privateAutoReply: parseBoolean(configFile.privateAutoReply, true),
  defaultGroupMode: configFile.defaultGroupMode || "smart",
  botDataPath: configFile.botDataPath || "./data/bot-store.json",
  historyMessageLimit: Number(configFile.historyMessageLimit || 12),
  agentRouterEnabled: parseBoolean(configFile.agentRouterEnabled, true),
  rootAuthToken: configFile.rootAuthToken || "",
  ignoreOfficialAccounts: parseBoolean(configFile.ignoreOfficialAccounts, true),
  activeGroupCooldownSeconds: Number(configFile.activeGroupCooldownSeconds || 30),
  reminderFollowupIntervalMinutes: Number(
    configFile.reminderFollowupIntervalMinutes || 5
  ),
  debugMessageTypes: parseBoolean(configFile.debugMessageTypes, true),
  multimodalEnabled: parseBoolean(configFile.multimodalEnabled, true),
  visionModel: configFile.visionModel || "qwen-vl-plus",
  audioModel: configFile.audioModel || "qwen-audio-turbo-latest",
  maxMediaBytes: Number(configFile.maxMediaBytes || 10 * 1024 * 1024),
  videoFrameCount: Number(configFile.videoFrameCount || 3),
  replyMaxLength: Number(configFile.replyMaxLength || 500),
  replyMaxSegments: Number(configFile.replyMaxSegments || 8),
  stripMarkdown: parseBoolean(configFile.stripMarkdown, true),
  allowGlobalUsageReport: parseBoolean(configFile.allowGlobalUsageReport, false),
  generatedFilesPath: configFile.generatedFilesPath || "./data/generated",
};
