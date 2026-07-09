import { Config } from "./config.js";
import type { GroupMode } from "./store.js";

export type DirectGroupModeCommand =
  | { type: "none" }
  | { type: "menu" }
  | { type: "status" }
  | { type: "switch"; mode: GroupMode };

export function isGroupMode(mode: unknown): mode is GroupMode {
  return ["quiet", "smart", "active", "super_active", "talkative"].includes(
    String(mode)
  );
}

export function parseGroupModeValue(text: string): GroupMode | null {
  const compact = text.trim().replace(/^\/+/, "").toLowerCase();
  const modeMap: Record<string, GroupMode> = {
    "1": "quiet",
    quiet: "quiet",
    "安静": "quiet",
    "少说话": "quiet",
    "2": "smart",
    smart: "smart",
    "智能": "smart",
    "正常": "smart",
    "3": "active",
    active: "active",
    "活跃": "active",
    "4": "super_active",
    superactive: "super_active",
    "super_active": "super_active",
    "超活跃": "super_active",
    "超级活跃": "super_active",
    "5": "talkative",
    talkative: "talkative",
    chatty: "talkative",
    "话唠": "talkative",
    "畅聊": "talkative",
  };
  return modeMap[compact] || null;
}

export function parseDirectGroupModeCommand(text: string): DirectGroupModeCommand {
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
  const mode = parseNaturalGroupMode(text);
  return mode ? { type: "switch", mode } : { type: "none" };
}

export function parseNaturalGroupMode(text: string): GroupMode | null {
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

export function looksLikeModeSwitchRequest(text: string): boolean {
  return /群聊模式|群模式|机器人模式|切换模式|进入.*模式|改成.*模式|安静一点|少说话|别太主动|活跃一点|超级活跃|超活跃|话唠|多聊点|积极一点|多说点|正常回复|默认模式/i.test(
    text.replace(/\s+/g, "")
  );
}

export function groupModeMenu(): string {
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

export function describeGroupMode(mode: GroupMode): string {
  const descriptions: Record<GroupMode, string> = {
    quiet: "安静模式：只在被 @ 或触发词出现时回复",
    smart: "智能模式：被明显问到或需要工具时回复",
    active: `活跃模式：会更积极参与，${Config.activeGroupCooldownSeconds} 秒冷却`,
    super_active: `超级活跃模式：更积极接话，${Config.superActiveGroupCooldownSeconds} 秒冷却`,
    talkative: `话唠模式：更像群友聊天，${Config.talkativeGroupCooldownSeconds} 秒冷却`,
  };
  return descriptions[mode];
}

export function shortGroupModeLabel(mode: GroupMode): string {
  const labels: Record<GroupMode, string> = {
    quiet: "安静",
    smart: "智能",
    active: "活跃",
    super_active: "超活跃",
    talkative: "话唠",
  };
  return labels[mode];
}
