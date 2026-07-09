import { MessageType } from "./message-type.js";

export function createEmoticonStoryboardFilter(
  frameCount: number | null,
  maxFrames: number
): string {
  if (!frameCount || frameCount < 1) {
    return `${storyboardFrameFilter()},tile=4x4:padding=8:margin=8:color=white`;
  }

  const indices =
    frameCount <= maxFrames
      ? Array.from({ length: frameCount }, (_value, index) => index)
      : Array.from({ length: maxFrames }, (_value, index) =>
          Math.round((index * (frameCount - 1)) / (maxFrames - 1))
        );
  const uniqueIndices = [...new Set(indices)].sort((a, b) => a - b);
  const cols = Math.ceil(Math.sqrt(uniqueIndices.length));
  const rows = Math.ceil(uniqueIndices.length / cols);
  const select = uniqueIndices.map((index) => `eq(n\\,${index})`).join("+");
  return `select=${select},${storyboardFrameFilter()},tile=${cols}x${rows}:padding=8:margin=8:color=white`;
}

export function storyboardFrameFilter(): string {
  return [
    "scale=240:240:force_original_aspect_ratio=decrease",
    "pad=240:240:(ow-iw)/2:(oh-ih)/2:white",
  ].join(",");
}

export function hasStillImageMagic(buffer: Buffer): boolean {
  return ["image/jpeg", "image/png"].includes(detectMediaTypeFromBuffer(buffer));
}

export function detectMediaTypeFromBuffer(buffer: Buffer): string {
  if (buffer.length < 12) {
    return "";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  const head = buffer.slice(0, 12).toString("ascii");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  return "";
}

export function extensionFromMediaType(mediaType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "audio/silk": ".sil",
    "audio/amr": ".amr",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
  };
  return map[mediaType.toLowerCase()] || "";
}

export function isInlineVideoMediaType(mediaType: string, extension: string): boolean {
  return mediaType === "video/mp4" || extension === ".mp4";
}

export function extractUrlsFromXml(rawXml: string): string[] {
  const urls: string[] = [];
  const attrPattern = /\b(?:cdnurl|thumburl|encrypturl|url)\s*=\s*"([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(rawXml))) {
    const decoded = decodeXmlAttribute(match[1]);
    if (/^https?:\/\//i.test(decoded)) {
      urls.push(decoded);
    }
  }
  return [...new Set(urls)];
}

export function decodeXmlAttribute(text: string): string {
  let previous = "";
  let decoded = text;
  for (let index = 0; index < 5 && decoded !== previous; index += 1) {
    previous = decoded;
    decoded = decoded
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
        String.fromCharCode(parseInt(code, 16))
      );
  }
  return decoded;
}

export function inferMediaType(
  mediaType: string,
  extension: string,
  messageType: MessageType
): string {
  if (mediaType && mediaType !== "application/unknown") {
    return mediaType;
  }
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".sil": "audio/silk",
    ".amr": "audio/amr",
  };
  if (map[extension]) {
    return map[extension];
  }
  if (messageType === MessageType.Image || messageType === MessageType.Emoticon) {
    return "image/jpeg";
  }
  if (messageType === MessageType.Audio) {
    return "audio/silk";
  }
  if (messageType === MessageType.Video) {
    return "video/mp4";
  }
  return "application/octet-stream";
}

export function isUnsafeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) {
    return true;
  }
  return /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(
    host
  );
}

export function cleanHtmlText(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
