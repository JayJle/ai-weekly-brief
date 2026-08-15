import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 4;
const TRACKING_PARAMETERS = new Set([
  "fbclid", "gclid", "ref", "source", "campaign", "mc_cid", "mc_eid",
]);

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first === 0;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
    || normalized.startsWith("fd") || normalized.startsWith("fe8")
    || normalized.startsWith("fe9") || normalized.startsWith("fea")
    || normalized.startsWith("feb");
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

export function normalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  return url.toString();
}

export async function validatePublicUrl(input: string): Promise<URL> {
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("只允许 HTTP/HTTPS URL");
  if (!url.hostname || url.username || url.password) throw new Error("URL 格式不安全");
  if (url.hostname === "localhost" || url.hostname.endsWith(".local")) throw new Error("不允许访问本机或局域网地址");

  if (isIP(url.hostname)) {
    if (isPrivateAddress(url.hostname)) throw new Error("不允许访问私有或保留 IP");
    return url;
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new Error("目标域名解析到私有或不可用地址");
  }
  return url;
}

async function readLimitedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) throw new Error("网页正文超过大小限制");
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error("网页正文超过大小限制");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function decodeEntities(value: string): string {
  return value
    .replaceAll(/&nbsp;/giu, " ")
    .replaceAll(/&amp;/giu, "&")
    .replaceAll(/&lt;/giu, "<")
    .replaceAll(/&gt;/giu, ">")
    .replaceAll(/&quot;/giu, '"')
    .replaceAll(/&#39;/giu, "'")
    .replaceAll(/&#(\d+);/gu, (_, digits: string) => String.fromCodePoint(Number(digits)));
}

export function htmlToText(html: string): string {
  return decodeEntities(html
    .replaceAll(/<(script|style|noscript|svg|nav|footer|header)[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replaceAll(/<br\s*\/?>/giu, "\n")
    .replaceAll(/<\/p\s*>/giu, "\n")
    .replaceAll(/<[^>]+>/gu, " "))
    .normalize("NFKC")
    .replaceAll(/[ \t]+/gu, " ")
    .replaceAll(/\n\s*\n\s*\n+/gu, "\n\n")
    .trim();
}

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  canonicalUrl: string;
  contentType: string;
  text: string;
  fetchedAt: string;
  untrustedContent: true;
}

export async function safeFetch(input: string): Promise<FetchResult> {
  let current = await validatePublicUrl(input);
  const requestedUrl = current.toString();
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "User-Agent": "AIWeeklyBrief/0.1 (+private research agent)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("重定向响应缺少 Location");
      current = await validatePublicUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`网页请求失败：HTTP ${response.status}`);
    const contentType = (response.headers.get("content-type") ?? "text/plain").toLowerCase();
    if (!contentType.includes("text/") && !contentType.includes("application/json")) {
      throw new Error(`不支持的网页类型：${contentType}`);
    }
    const raw = await readLimitedBody(response);
    return {
      requestedUrl,
      finalUrl: current.toString(),
      canonicalUrl: normalizeUrl(current.toString()),
      contentType,
      text: contentType.includes("html") ? htmlToText(raw) : raw.normalize("NFKC").trim(),
      fetchedAt: new Date().toISOString(),
      untrustedContent: true,
    };
  }
  throw new Error("网页重定向次数过多");
}
