// Playback URL decoding (plaintext, base64, and 0xa8 AES-128-CBC + SHA-512 envelope)
// (ported from openhongguo internal/protocol/playback_url.go).
import { base64UrlDecode, concatBytes, fromUtf8, hexDecode } from "../crypto/bytes.js";
import { sha512 } from "../crypto/sha512.js";

const PLAYBACK_URL_CONSTANTS_HEX =
  "4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524" +
  "f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58";

export function decodePlaybackURL(value, seed = "") {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    throw new Error("playback URL is empty");
  }
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    return trimmed;
  }
  let raw;
  try {
    raw = base64UrlDecode(trimmed);
  } catch {
    throw new Error("playback URL is not encoded data");
  }
  if (!raw || raw.length === 0) {
    throw new Error("playback URL is not encoded data");
  }
  if (raw[0] === 0xa8) {
    if (raw.length < 20 || raw[2] !== 1 || raw[3] !== 0 || (raw.length - 4) % 16 !== 0) {
      throw new Error("playback URL envelope is invalid");
    }
    let seedBytes;
    try {
      seedBytes = base64UrlDecode(String(seed || "").trim());
    } catch {
      throw new Error("playback URL seed is missing or invalid");
    }
    if (!seedBytes || seedBytes.length === 0) {
      throw new Error("playback URL seed is missing or invalid");
    }
    const constants = hexDecode(PLAYBACK_URL_CONSTANTS_HEX);
    const first = sha512(seedBytes);
    const key = sha512(concatBytes(first, constants));
    let plaintext = host.crypto.aes({
      mode: "cbc",
      key: key.subarray(0, 16),
      iv: key.subarray(16, 32),
      data: raw.subarray(4),
      decrypt: true,
      padding: "none",
    });
    const padding = plaintext[plaintext.length - 1];
    if (padding > 0 && padding <= 16) {
      plaintext = plaintext.subarray(0, plaintext.length - padding);
    }
    raw = plaintext;
  }
  const decoded = fromUtf8(raw).replace(/\x00+$/, "").trim();
  if (!decoded.startsWith("https://") && !decoded.startsWith("http://")) {
    throw new Error("playback URL has no HTTP(S) address");
  }
  return decoded;
}
