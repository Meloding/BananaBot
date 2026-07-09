import type { ChatContext } from "./store.js";

export interface PrepareReplyOptions {
  stripMarkdown: boolean;
  botName: string;
  context?: ChatContext;
}

export function prepareReplyForWechat(
  text: string,
  options: PrepareReplyOptions
): string {
  const withoutMarkdown = options.stripMarkdown ? stripMarkdown(text) : text;
  return stripReplySpeakerPrefix(withoutMarkdown, options.context, options.botName)
    .replace(/\n{4,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function stripReplySpeakerPrefix(
  text: string,
  context?: ChatContext,
  botName = ""
): string {
  if (context?.scope !== "private") {
    return text;
  }
  let result = text.trimStart();
  const names = [
    context.talkerName,
    botName,
    context.chatName,
    "用户",
    "User",
    "Assistant",
    "助手",
    "机器人",
  ].filter(Boolean);
  for (const name of names) {
    result = result.replace(new RegExp(`^${escapeRegExp(name)}\\s*[:：]\\s*`), "");
  }
  return result;
}

export function stripMarkdown(text: string): string {
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

export function splitWechatMessage(
  text: string,
  maxLength: number,
  maxSegments: number
): string[] {
  const segments: string[] = [];
  let rest = text.trim();
  while (rest.length > maxLength && segments.length < maxSegments - 1) {
    const cutAt = findSplitIndex(rest, maxLength);
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

export function findSplitIndex(text: string, maxLength: number): number {
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

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
