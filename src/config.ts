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
    chatgptTriggerKeyword: process.env.CHATGPT_TRIGGER_KEYWORD,
    privateAutoReply: process.env.PRIVATE_AUTO_REPLY,
    defaultGroupMode: process.env.DEFAULT_GROUP_MODE,
    botDataPath: process.env.BOT_DATA_PATH,
    historyMessageLimit: process.env.HISTORY_MESSAGE_LIMIT,
    agentRouterEnabled: process.env.AGENT_ROUTER_ENABLED,
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
  chatgptTriggerKeyword: configFile.chatgptTriggerKeyword || "",
  privateAutoReply: parseBoolean(configFile.privateAutoReply, true),
  defaultGroupMode: configFile.defaultGroupMode || "smart",
  botDataPath: configFile.botDataPath || "./data/bot-store.json",
  historyMessageLimit: Number(configFile.historyMessageLimit || 12),
  agentRouterEnabled: parseBoolean(configFile.agentRouterEnabled, true),
};
