// Portable tt-data registration envelope (ported from openhongguo internal/protocol/tt_encrypt.go).
import { concatBytes, hexDecode } from "./bytes.js";
import { sha512 } from "./sha512.js";

const TT_ENCRYPT_CONSTANT_HEX =
  "4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524" +
  "f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58";
const TT_ENCRYPT_PREFIX_HEX =
  "3176c9b6d71579d7e82179c9e7cbde787b54d541bad3b15f2e8fed92293fa25a";
const TT_HEADER = new Uint8Array([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);

export function ttEncrypt(input) {
  const prefix = hexDecode(TT_ENCRYPT_PREFIX_HEX);
  const constant = hexDecode(TT_ENCRYPT_CONSTANT_HEX);
  const prefixHash = sha512(prefix);
  const keyIV = sha512(concatBytes(prefixHash, constant));
  const digest = sha512(input);
  const plain = concatBytes(digest, input);
  const encrypted = host.crypto.aes({
    mode: "cbc",
    key: keyIV.subarray(0, 16),
    iv: keyIV.subarray(16, 32),
    data: plain,
    decrypt: false,
    padding: "pkcs7",
  });
  return concatBytes(TT_HEADER, prefix, encrypted);
}
