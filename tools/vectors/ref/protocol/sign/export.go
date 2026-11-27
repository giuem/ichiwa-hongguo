package sign

import (
	"encoding/hex"
	"strconv"
)

// Exported wrappers for vector generation.

func SM3Sum(msg []byte) [32]byte                                      { return sm3Sum(msg) }
func Xmxor(data, key []byte) []byte                                   { return xmxor(data, key) }
func KeyHash(signKey []byte, random uint32) ([32]byte, [4]byte)       { return keyHash(signKey, random) }
func MedusaSignKey() []byte                                           { return medusaSignKey() }
func PlaybackV5SignKey() []byte                                       { return playbackV5SignKey }
func F13V5Variant(q [32]byte, b [16]byte, ts uint32) uint32           { return f13V5Variant(q, b, ts) }
func F13V5HeadMD5(q [32]byte, b [16]byte, ts uint32) [16]byte         { return f13V5HeadMD5(q, b, ts) }
func F13V5HeadSHA(q [32]byte, b [16]byte, ts uint32) [16]byte         { return f13V5HeadSHA(q, b, ts) }
func F13V5Tail(head [16]byte) []byte                                  { return f13V5Tail(head) }
func F13V5(q [32]byte, b [16]byte, ts uint32) ([20]byte, bool)        { return f13V5(q, b, ts) }
func XGorgon(q string, b []byte, hasBody bool, ts, r uint32) string   { return xGorgon(q, b, hasBody, ts, r) }
func XGorgonFlags(q string, b []byte, hasBody bool, ts, r uint32, flags []byte) string {
	return xGorgonFlags(q, b, hasBody, ts, r, flags)
}
func HeliosV5(ts, r uint32) string { return heliosV5(ts, r) }
func EncryptPlaybackV5(data, key, iv []byte, ts uint32) []byte {
	return encryptPlaybackV5(data, key, iv, ts)
}
func MedusaDeviceOf(query, deviceID string) *MedusaDevice { return medusaDeviceOf(query, deviceID) }
func MedusaV5DeviceBlock(deviceID string, env MedusaEnv, nowMillis int64) []byte {
	return medusaV5DeviceBlock(deviceID, env, nowMillis)
}
func AssembleMedusaV5Fixed(query string, body []byte, ts uint32, deviceID string, env MedusaEnv, rnd MedusaRandom, counter int64) (string, bool) {
	in, ok := newMedusaV5Input(query, body, ts)
	if !ok {
		return "", false
	}
	if env.Device != nil {
		// Pin the atomic counter so the Go output is deterministic.
		medusaCounterOnce.Do(func() {})
		medusaCounter.Store(counter - 1)
	}
	return assembleMedusaV5(in, deviceID, env, rnd), true
}
func ArgusHeader(query string, body []byte, ts, nonce uint32, aid, deviceID, installID string) string {
	var bodyMD5 [16]byte
	if len(body) > 0 {
		bodyMD5 = md5Raw(body)
	}
	return argusHeader(query, bodyMD5, ts, nonce, aid, deviceID, installID)
}
func LadonHeader(ts, nonce uint32, aid string) string { return ladonHeader(ts, nonce, aid) }
func EncodeQuery(pairs [][2]string) string            { return encodeQuery(pairs) }
func MustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}
func DeviceFlags() []byte   { return medusaDeviceFlags }
func EmulatorFlags() []byte { return medusaEmulatorFlags }
func EmulatorStatus() int64 { return medusaEmulatorStatus }
func DeviceStatus() int64   { return medusaDeviceStatus }

// PinProcess fixes the process environment and the next Medusa counter, so a
// whole signed request comes out the same on every run.
func PinProcess(env MedusaEnv, counter int64) {
	medusaEnvOnce.Do(func() {})
	medusaEnv = env
	medusaCounterOnce.Do(func() {})
	medusaCounter.Store(counter - 1)
}

// SignRequestFixed is signRequest with the given entropy.
func SignRequestFixed(path string, pairs [][2]string, nowMillis int64, deviceID, versionName string, body []byte, ent Entropy) (string, map[string]string) {
	return signRequest(path, pairs, nowMillis, deviceID, versionName, body, &ent)
}

// SignPlaybackPOSTFixed is SignPlaybackPOST with fixed Argus and Ladon nonces.
// It keeps x-medusa: the port sends it on legacy playback, since the service
// answers an empty body without it (openhongguo#25).
func SignPlaybackPOSTFixed(path string, pairs [][2]string, nowMillis int64, deviceID, versionName string, body []byte, ent Entropy, argusNonce, ladonNonce uint32) (string, map[string]string) {
	query, headers := signRequest(path, pairs, nowMillis, deviceID, versionName, body, &ent)
	khronos, _ := strconv.ParseUint(headers["x-khronos"], 10, 64)
	ts := uint32(khronos)
	bodyMD5 := [16]byte{}
	if len(body) > 0 {
		bodyMD5 = md5Raw(body)
	}
	aid := playbackAID(query)
	headers["x-argus"] = argusHeader(query, bodyMD5, ts, argusNonce, aid, queryValue(query, "device_id"), queryValue(query, "iid"))
	headers["x-ladon"] = ladonHeader(ts, ladonNonce, aid)
	return query, headers
}
