package protocol

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha512"
	"encoding/base64"
	"time"
)

// PlaybackURL exports playbackURL for vector generation.
func PlaybackURL(value, seed string) (string, error) {
	return playbackURL(value, seed)
}

// RegisterHeader exports registerHeader for vector generation.
func RegisterHeader(p RegisterIdentity, now time.Time) map[string]any {
	return registerHeader(p, now)
}

// WrapPlaybackURLA8 creates a deterministic 0xa8 encrypted playback URL for testing.
func WrapPlaybackURLA8(rawURL, seed string) (string, error) {
	seedBytes, err := decodePlaybackBase64(seed)
	if err != nil {
		return "", err
	}
	constants := []byte{
		0x4d, 0xd4, 0xc2, 0xe6, 0xb8, 0x31, 0x62, 0x09, 0x0e, 0x52, 0xb3, 0xc7, 0xa6, 0x73, 0x3b, 0xa4,
		0x1c, 0xb2, 0x46, 0x2b, 0x82, 0x9a, 0xb5, 0x8a, 0x19, 0x6b, 0x39, 0xdb, 0x57, 0x17, 0x75, 0x24,
		0xf4, 0x9b, 0xaf, 0x7f, 0x08, 0xe8, 0xd6, 0x8d, 0x26, 0xa7, 0x2e, 0x37, 0xc1, 0xa9, 0x5a, 0x2f,
		0x1f, 0x05, 0xa5, 0x18, 0x92, 0xae, 0xf2, 0x94, 0x97, 0x32, 0xb6, 0x2a, 0x38, 0xaa, 0xdd, 0x58,
	}
	first := sha512.Sum512(seedBytes)
	key := sha512.Sum512(append(first[:], constants...))
	plain := append([]byte(nil), []byte(rawURL)...)
	pad := aes.BlockSize - len(plain)%aes.BlockSize
	for i := 0; i < pad; i++ {
		plain = append(plain, byte(pad))
	}
	block, err := aes.NewCipher(key[:16])
	if err != nil {
		return "", err
	}
	enc := make([]byte, len(plain))
	cipher.NewCBCEncrypter(block, key[16:32]).CryptBlocks(enc, plain)
	out := append([]byte{0xa8, 0x00, 0x01, 0x00}, enc...)
	return base64.StdEncoding.EncodeToString(out), nil
}
