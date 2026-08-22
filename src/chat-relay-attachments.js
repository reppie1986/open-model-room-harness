import { downloadDiscordImageAttachment } from "./vision.js";

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

const SUPPORTED_TEXT_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/xml",
  "text/yaml",
]);

const SUPPORTED_TEXT_EXTENSIONS = /\.(?:c|conf|cpp|cs|css|csv|diff|env\.example|go|h|hpp|htm|html|ini|java|js|json|jsonl|jsx|log|lua|md|mjs|patch|php|ps1|py|rb|rs|sh|sql|toml|ts|tsx|txt|xml|yaml|yml)$/i;

function normalizedType(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function supportedImageReference({ contentType, filename }) {
  return SUPPORTED_IMAGE_TYPES.has(normalizedType(contentType)) || /\.(?:gif|jpe?g|png|webp)$/i.test(String(filename || ""));
}

function supportedTextReference({ contentType, filename }) {
  return SUPPORTED_TEXT_TYPES.has(normalizedType(contentType)) || SUPPORTED_TEXT_EXTENSIONS.test(String(filename || ""));
}

function discordCdnUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase();
    if (
      hostname !== "cdn.discordapp.com" &&
      hostname !== "media.discordapp.net" &&
      !/^images-ext-\d+\.discordapp\.net$/.test(hostname)
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function discordImageUrl(value) {
  return discordCdnUrl(value);
}

function values(collection) {
  return [...(collection?.values?.() || [])];
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function collectRelayImageAttachments(message, maxAttachments = 4) {
  const requestedLimit = Number(maxAttachments);
  const limit = Math.max(0, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 4, 10));
  const references = [];
  const seen = new Set();

  const add = ({ source, url, filename = null, contentType = null, size = null, width = null, height = null }) => {
    const safeUrl = discordImageUrl(url);
    if (!safeUrl || seen.has(safeUrl) || references.length >= limit) return;
    if (!supportedImageReference({ contentType, filename }) && !String(source).startsWith("embed-")) return;
    seen.add(safeUrl);
    references.push({
      source,
      url: safeUrl,
      filename: filename ? String(filename).slice(0, 200) : null,
      contentType: normalizedType(contentType) || null,
      size: optionalNumber(size),
      width: optionalNumber(width),
      height: optionalNumber(height),
    });
  };

  for (const attachment of values(message?.attachments)) {
    add({
      source: "attachment",
      url: attachment.url,
      filename: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
    });
  }

  for (const embed of message?.embeds || []) {
    add({
      source: "embed-image",
      url: embed.image?.proxyURL || embed.image?.url,
      filename: "embed-image",
      contentType: "image/webp",
      width: embed.image?.width,
      height: embed.image?.height,
    });
    add({
      source: "embed-thumbnail",
      url: embed.thumbnail?.proxyURL || embed.thumbnail?.url,
      filename: "embed-thumbnail",
      contentType: "image/webp",
      width: embed.thumbnail?.width,
      height: embed.thumbnail?.height,
    });
  }

  for (const sticker of values(message?.stickers)) {
    add({
      source: "sticker",
      url: sticker.url,
      filename: sticker.name || "sticker",
      contentType: "image/png",
    });
  }

  return references;
}

export function collectRelayTextAttachments(message, maxAttachments = 4) {
  const requestedLimit = Number(maxAttachments);
  const limit = Math.max(0, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 4, 10));
  const references = [];
  const seen = new Set();

  for (const attachment of values(message?.attachments)) {
    const safeUrl = discordCdnUrl(attachment.url);
    if (!safeUrl || seen.has(safeUrl) || references.length >= limit) continue;
    if (!supportedTextReference({ contentType: attachment.contentType, filename: attachment.name })) continue;
    seen.add(safeUrl);
    references.push({
      source: "attachment",
      url: safeUrl,
      filename: attachment.name ? String(attachment.name).slice(0, 200) : null,
      contentType: normalizedType(attachment.contentType) || null,
      size: optionalNumber(attachment.size),
    });
  }

  return references;
}

export function publicRelayImageAttachment(reference, index) {
  return {
    index,
    source: reference.source,
    filename: reference.filename,
    contentType: reference.contentType,
    size: reference.size,
    width: reference.width,
    height: reference.height,
  };
}

export function publicRelayTextAttachment(reference, index) {
  return {
    index,
    source: reference.source,
    filename: reference.filename,
    contentType: reference.contentType,
    size: reference.size,
  };
}

export async function fetchRelayImageAttachment(reference, {
  fetchImplementation = fetch,
  maxBytes = 8_000_000,
  timeoutMs = 15_000,
} = {}) {
  const byteLimit = Math.max(1_024, Math.min(Number(maxBytes) || 8_000_000, 20_000_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || 15_000));
  try {
    const image = await downloadDiscordImageAttachment({
      ...reference,
      name: reference?.filename,
    }, {
      fetchImplementation,
      maxBytes: byteLimit,
      signal: controller.signal,
      allowGif: true,
      limitName: "relay",
    });
    return { data: image.bytes.toString("base64"), mimeType: image.mimeType, size: image.bytes.length };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchRelayTextAttachment(reference, {
  fetchImplementation = fetch,
  maxBytes = 256_000,
  timeoutMs = 15_000,
} = {}) {
  const byteLimit = Math.max(1_024, Math.min(Number(maxBytes) || 256_000, 1_000_000));
  const safeUrl = discordCdnUrl(reference?.url);
  if (!safeUrl) throw new Error("Discord text attachment must use an approved HTTPS Discord CDN or proxy URL.");
  if (!supportedTextReference({ contentType: reference?.contentType, filename: reference?.filename })) {
    throw new Error("Discord attachment is not a supported text file.");
  }
  if (Number(reference?.size || 0) > byteLimit) {
    throw new Error(`Discord text attachment '${reference?.filename || "file"}' exceeds the ${byteLimit}-byte relay limit.`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || 15_000));
  try {
    const response = await fetchImplementation(safeUrl, { redirect: "error", signal: controller.signal });
    if (!response?.ok) throw new Error(`Discord text attachment fetch failed with HTTP ${response?.status || "error"}.`);
    const declaredLength = Number(response.headers?.get?.("content-length") || 0);
    if (declaredLength > byteLimit) {
      throw new Error(`Discord text attachment '${reference?.filename || "file"}' exceeds the ${byteLimit}-byte relay limit.`);
    }
    const contentType = normalizedType(response.headers?.get?.("content-type")) || normalizedType(reference?.contentType) || "text/plain";
    if (!supportedTextReference({ contentType, filename: reference?.filename })) {
      throw new Error("Discord attachment response is not a supported text file.");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > byteLimit) {
      throw new Error(`Discord text attachment '${reference?.filename || "file"}' exceeds the ${byteLimit}-byte relay limit.`);
    }
    const text = bytes.toString("utf8");
    if (text.includes("\uFFFD")) throw new Error("Discord text attachment is not valid UTF-8 text.");
    return { text, mimeType: contentType, size: bytes.length };
  } finally {
    clearTimeout(timeout);
  }
}
