// Command vectors generates deterministic byte-for-byte test vectors from
// openhongguo v0.4.1 for validating the JavaScript Ichiwa plugin port.
package main

import (
	"crypto/sha512"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"vectors/ref/drm"
	"vectors/ref/protocol"
	"vectors/ref/protocol/sign"
	"vectors/ref/sdk/model"
)

type Vectors struct {
	Upstream       string               `json:"upstream"`
	SHA512         []HashVec            `json:"sha512"`
	SM3            []HashVec            `json:"sm3"`
	Spade          []SpadeVec           `json:"spade"`
	TTEncrypt      []TTEncryptVec       `json:"ttEncrypt"`
	PlaybackURL    []PlaybackURLVec     `json:"playbackUrl"`
	KeyHash        []KeyHashVec         `json:"keyHash"`
	Xmxor          []XmxorVec           `json:"xmxor"`
	EncryptV5      []EncryptV5Vec       `json:"encryptPlaybackV5"`
	F13V5          []F13V5Vec           `json:"f13V5"`
	Gorgon         []GorgonVec          `json:"gorgon"`
	Helios         []HeliosVec          `json:"helios"`
	MedusaDevice   []MedusaDeviceVec    `json:"medusaDevice"`
	MedusaV5       []MedusaV5Vec        `json:"medusaV5"`
	Argus          []ArgusVec           `json:"argus"`
	Ladon          []LadonVec           `json:"ladon"`
	EncodeQuery    []EncodeQueryVec     `json:"encodeQuery"`
	RequestBodies  RequestBodiesVec     `json:"requestBodies"`
	RegisterPlain  RegisterPlainVec     `json:"registerPlaintext"`
}

type HashVec struct {
	InputHex string `json:"inputHex"`
	Digest   string `json:"digest"`
}

type SpadeVec struct {
	SpadeA  string `json:"spadeA"`
	Hex     string `json:"hex"`
	Version string `json:"version"`
}

type TTEncryptVec struct {
	InputHex  string `json:"inputHex"`
	OutputHex string `json:"outputHex"`
}

type PlaybackURLVec struct {
	Value string `json:"value"`
	Seed  string `json:"seed"`
	Want  string `json:"want"`
}

type KeyHashVec struct {
	SignKeyHex string `json:"signKeyHex"`
	Random     uint32 `json:"random"`
	HashHex    string `json:"hashHex"`
	SeedHex    string `json:"seedHex"`
}

type XmxorVec struct {
	DataHex   string `json:"dataHex"`
	KeyHex    string `json:"keyHex"`
	OutputHex string `json:"outputHex"`
}

type EncryptV5Vec struct {
	DataHex   string `json:"dataHex"`
	KeyHex    string `json:"keyHex"`
	IVHex     string `json:"ivHex"`
	Timestamp uint32 `json:"timestamp"`
	OutputHex string `json:"outputHex"`
}

type F13V5Vec struct {
	QuerySM3Hex string `json:"querySM3Hex"`
	BodyMD5Hex  string `json:"bodyMD5Hex"`
	TS          uint32 `json:"ts"`
	Variant     uint32 `json:"variant"`
	HeadMD5Hex  string `json:"headMD5Hex"`
	HeadSHAHex  string `json:"headSHAHex"`
	TailHex     string `json:"tailHex"`
	FullHex     string `json:"fullHex,omitempty"`
	Supported   bool   `json:"supported"`
}

type GorgonVec struct {
	Query    string `json:"query"`
	BodyHex  string `json:"bodyHex"`
	HasBody  bool   `json:"hasBody"`
	Khronos  uint32 `json:"khronos"`
	Random   uint32 `json:"random"`
	FlagsHex string `json:"flagsHex"`
	Want     string `json:"want"`
}

type HeliosVec struct {
	TS     uint32 `json:"ts"`
	Random uint32 `json:"random"`
	Want   string `json:"want"`
}

type MedusaDeviceVec struct {
	Query        string `json:"query"`
	DeviceID     string `json:"deviceId"`
	LaunchMillis int64  `json:"launchMillis"`
	NowMillis    int64  `json:"nowMillis"`
	BlockHex     string `json:"blockHex"`
}

type MedusaV5Vec struct {
	Query        string `json:"query"`
	BodyHex      string `json:"bodyHex"`
	HasBody      bool   `json:"hasBody"`
	TS           uint32 `json:"ts"`
	DeviceID     string `json:"deviceId"`
	UseDevice    bool   `json:"useDevice"`
	Status       int64  `json:"status"`
	PID          int64  `json:"pid"`
	PPID         int64  `json:"ppid"`
	LaunchMillis int64  `json:"launchMillis"`
	Counter      int64  `json:"counter"`
	RndMessage   uint32 `json:"rndMessage"`
	RndKey       uint32 `json:"rndKey"`
	RndPacked    uint32 `json:"rndPacked"`
	Want         string `json:"want"`
}

type ArgusVec struct {
	Query     string `json:"query"`
	BodyHex   string `json:"bodyHex"`
	TS        uint32 `json:"ts"`
	Nonce     uint32 `json:"nonce"`
	AID       string `json:"aid"`
	DeviceID  string `json:"deviceId"`
	InstallID string `json:"installId"`
	Want      string `json:"want"`
}

type LadonVec struct {
	TS    uint32 `json:"ts"`
	Nonce uint32 `json:"nonce"`
	AID   string `json:"aid"`
	Want  string `json:"want"`
}

type EncodeQueryVec struct {
	Pairs [][2]string `json:"pairs"`
	Want  string      `json:"want"`
}

type RequestBodiesVec struct {
	Series           string `json:"series"`
	SeriesBatch      string `json:"seriesBatch"`
	Album            string `json:"album"`
	Playback         string `json:"playback"`
	ShortFilterPanel string `json:"shortFilterPanel"`
	ShortFilterQuery string `json:"shortFilterQuery"`
	UserWorksTabs    string `json:"userWorksTabs"`
	UserWorks        string `json:"userWorks"`
	Danmaku          string `json:"danmaku"`
}

type RegisterPlainVec struct {
	GeneratedAtMs int64  `json:"generatedAtMs"`
	CDID          string `json:"cdid"`
	OpenUDID      string `json:"openudid"`
	ClientUDID    string `json:"clientudid"`
	OAID          string `json:"oaid"`
	ReqID         string `json:"reqId"`
	Plaintext     string `json:"plaintext"`
}

// buildSpadeA synthesizes a valid spade_a blob for testing both v1 and v2 scramble paths.
func makeSpadeA(hexKey, version, tag string) string {
	v2 := len(tag) >= 6 && (tag[:6] == "app_v2" || tag[:6] == "web_v2")
	plain := make([]byte, 0, 1+len(hexKey)+len(version))
	plain = append(plain, fmt.Sprintf("%x", len(version))[0])
	plain = append(plain, []byte(hexKey)...)
	plain = append(plain, []byte(version)...)

	// Invert scramble(buf, v2)
	bits8 := func(v byte) byte {
		var n byte
		for v != 0 {
			v &= v - 1
			n++
		}
		return n
	}
	popcount := func(v uint32) int {
		return int(bits8(byte(v)) + bits8(byte(v>>8)) + bits8(byte(v>>16)) + bits8(byte(v>>24)))
	}
	buf := make([]byte, len(plain))
	var prev, cur byte = 0x55, 0xfa
	for i := range plain {
		term := -byte(0x15 + popcount(uint32(i)))
		var b byte
		if i%2 == 0 {
			if v2 {
				b = cur ^ (plain[i] - term + prev)
			} else {
				b = cur ^ (plain[i] - term)
			}
			cur = b
		} else {
			if v2 {
				b = prev ^ (plain[i] - term + prev)
			} else {
				b = prev ^ (plain[i] - term)
			}
			prev = b
		}
		buf[i] = b
	}
	if v2 {
		last := len(buf) - 1
		for i := 0; i+1 < len(buf); i += 2 {
			buf[i], buf[i+1] = buf[i+1], buf[i]
			if i == last-2 {
				break
			}
		}
	}

	prefixLen := len(tag)
	marker := byte(prefixLen + 0x30)
	// raw = [raw0] + buf + encodedTag; raw[0]^raw[1]^raw[2] == marker
	raw0 := marker ^ buf[0] ^ buf[1]
	raw := make([]byte, 0, 1+len(buf)+prefixLen)
	raw = append(raw, raw0)
	raw = append(raw, buf...)
	tail := len(raw)
	b16, b14 := raw[tail-2], raw[tail-1]
	for i := 0; i < prefixLen; i++ {
		raw = append(raw, tag[i]^b14^b16)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func main() {
	v := Vectors{Upstream: "v0.4.1"}

	// 1. SHA-512
	for _, in := range [][]byte{
		{},
		[]byte("abc"),
		[]byte("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"),
		make([]byte, 257),
	} {
		if len(in) == 257 {
			for i := range in {
				in[i] = byte(i * 37)
			}
		}
		sum := sha512.Sum512(in)
		v.SHA512 = append(v.SHA512, HashVec{
			InputHex: hex.EncodeToString(in),
			Digest:   hex.EncodeToString(sum[:]),
		})
	}

	// 2. SM3
	for _, in := range [][]byte{
		{},
		[]byte("abc"),
		make([]byte, 16),
		[]byte("aid=8662&device_id=7000000000000000001&ts=1795440816&_rticket=1795440816123"),
	} {
		sum := sign.SM3Sum(in)
		v.SM3 = append(v.SM3, HashVec{
			InputHex: hex.EncodeToString(in),
			Digest:   hex.EncodeToString(sum[:]),
		})
	}

	// 3. Spade DRM key derivation (live v1 + synthetic app_v2 & web_v2)
	spadeInputs := []string{
		"nLwSxG6JI85zhT//c7AK4HauO+lzrg7TdZwO0XWrP+J0pDypqQ==",
		makeSpadeA("0123456789abcdef0123456789abcdef", "2", "app_v2_test"),
		makeSpadeA("deadbeefcafebabe0011223344556677", "3a", "web_v2_drm"),
	}
	for _, sp := range spadeInputs {
		k, err := drm.Derive(sp)
		if err != nil {
			panic(err)
		}
		v.Spade = append(v.Spade, SpadeVec{SpadeA: sp, Hex: k.Hex, Version: k.Version})
	}

	// 4. TTEncrypt
	for _, in := range [][]byte{
		[]byte("hello hongguo"),
		[]byte(`{"magic_tag":"ss_app_log","header":{"aid":8662},"_gen_time":1795440816000}`),
	} {
		out := protocol.TTEncrypt(in)
		v.TTEncrypt = append(v.TTEncrypt, TTEncryptVec{
			InputHex:  hex.EncodeToString(in),
			OutputHex: hex.EncodeToString(out),
		})
	}

	// 5. Playback URL decoding (plaintext, base64, 0xa8 encrypted)
	seed := base64.StdEncoding.EncodeToString([]byte("fixed-seed-material-2026"))
	rawMediaURL := "https://v3-default.example.com/path/video.mp4?expires=1800000000&sign=abcdef"
	a8Val, err := protocol.WrapPlaybackURLA8(rawMediaURL, seed)
	if err != nil {
		panic(err)
	}
	for _, tc := range [][2]string{
		{rawMediaURL, ""},
		{base64.StdEncoding.EncodeToString([]byte(rawMediaURL)), ""},
		{a8Val, seed},
	} {
		got, err := protocol.PlaybackURL(tc[0], tc[1])
		if err != nil {
			panic(err)
		}
		v.PlaybackURL = append(v.PlaybackURL, PlaybackURLVec{Value: tc[0], Seed: tc[1], Want: got})
	}

	// 6. KeyHash & Xmxor
	for _, tc := range []struct {
		key []byte
		rnd uint32
	}{
		{sign.MedusaSignKey(), 2378451149},
		{sign.PlaybackV5SignKey(), 0x12345678},
		{sign.PlaybackV5SignKey(), 0x7fffffff},
	} {
		h, s := sign.KeyHash(tc.key, tc.rnd)
		v.KeyHash = append(v.KeyHash, KeyHashVec{
			SignKeyHex: hex.EncodeToString(tc.key),
			Random:     tc.rnd,
			HashHex:    hex.EncodeToString(h[:]),
			SeedHex:    hex.EncodeToString(s[:]),
		})
		data := []byte("0123456789abcdefghij0123456789")
		mixed := sign.Xmxor(data, h[:])
		v.Xmxor = append(v.Xmxor, XmxorVec{
			DataHex:   hex.EncodeToString(data),
			KeyHex:    hex.EncodeToString(h[:]),
			OutputHex: hex.EncodeToString(mixed),
		})
	}

	// 7. encryptPlaybackV5 across all 4 timestamp mod 4 values
	samplePlain := make([]byte, 260)
	for i := range samplePlain {
		samplePlain[i] = byte((i*73 + 19) & 0xff)
	}
	encKey := sign.MustHex("00112233445566778899aabbccddeeff")
	encIV := sign.MustHex("ffeeddccbbaa99887766554433221100")
	for _, ts := range []uint32{1795440800, 1795440801, 1795440802, 1795440803} {
		out := sign.EncryptPlaybackV5(samplePlain, encKey, encIV, ts)
		v.EncryptV5 = append(v.EncryptV5, EncryptV5Vec{
			DataHex:   hex.EncodeToString(samplePlain),
			KeyHex:    hex.EncodeToString(encKey),
			IVHex:     hex.EncodeToString(encIV),
			Timestamp: ts,
			OutputHex: hex.EncodeToString(out),
		})
	}

	// 8. f13V5 (cover both variant 5, variant 12, and unsupported variants + edge timestamps)
	var foundV5, foundV12, foundOther int
	for ts := uint32(1795440000); ts < 1795440400 && (foundV5 < 4 || foundV12 < 4 || foundOther < 2); ts++ {
		var qBuf [32]byte
		var bBuf [16]byte
		binary.LittleEndian.PutUint32(qBuf[:], ts)
		binary.BigEndian.PutUint32(qBuf[16:], ts*2654435761)
		binary.LittleEndian.PutUint32(bBuf[:], ts^0xdeadbeef)
		variant := sign.F13V5Variant(qBuf, bBuf, ts)
		take := false
		if variant == 5 && foundV5 < 4 {
			foundV5++
			take = true
		} else if variant == 12 && foundV12 < 4 {
			foundV12++
			take = true
		} else if variant != 5 && variant != 12 && foundOther < 2 {
			foundOther++
			take = true
		}
		if !take {
			continue
		}
		hMD5 := sign.F13V5HeadMD5(qBuf, bBuf, ts)
		hSHA := sign.F13V5HeadSHA(qBuf, bBuf, ts)
		tail := sign.F13V5Tail(hMD5)
		full, ok := sign.F13V5(qBuf, bBuf, ts)
		fv := F13V5Vec{
			QuerySM3Hex: hex.EncodeToString(qBuf[:]),
			BodyMD5Hex:  hex.EncodeToString(bBuf[:]),
			TS:          ts,
			Variant:     variant,
			HeadMD5Hex:  hex.EncodeToString(hMD5[:]),
			HeadSHAHex:  hex.EncodeToString(hSHA[:]),
			TailHex:     hex.EncodeToString(tail),
			Supported:   ok,
		}
		if ok {
			fv.FullHex = hex.EncodeToString(full[:])
		}
		v.F13V5 = append(v.F13V5, fv)
	}

	// 9. x-gorgon (GET + POST, emulator flags + device flags)
	for _, tc := range []struct {
		query   string
		body    []byte
		hasBody bool
		ts, rnd uint32
		flags   []byte
	}{
		{"aid=8662&device_id=7000000000000000001&ts=1795440816", nil, false, 1795440816, 0x1234, sign.EmulatorFlags()},
		{"aid=8662&device_id=7000000000000000001&ts=1795440816", []byte(`{"series_id":"12345"}`), true, 1795440816, 0xabcd, sign.DeviceFlags()},
		{"aid=8662&device_id=7000000000000000001&ts=1795440817", []byte{}, true, 1795440817, 0x00ff, sign.DeviceFlags()},
	} {
		v.Gorgon = append(v.Gorgon, GorgonVec{
			Query:    tc.query,
			BodyHex:  hex.EncodeToString(tc.body),
			HasBody:  tc.hasBody,
			Khronos:  tc.ts,
			Random:   tc.rnd,
			FlagsHex: hex.EncodeToString(tc.flags),
			Want:     sign.XGorgonFlags(tc.query, tc.body, tc.hasBody, tc.ts, tc.rnd, tc.flags),
		})
	}

	// 10. x-helios v5
	for _, tc := range [][2]uint32{
		{1795440816, 0x04030201},
		{1700000000, 0xdeadbeef},
		{1800000000, 0xffffffff},
	} {
		v.Helios = append(v.Helios, HeliosVec{
			TS:     tc[0],
			Random: tc[1],
			Want:   sign.HeliosV5(tc[0], tc[1]),
		})
	}

	// 11. medusaDeviceOf + medusaV5DeviceBlock
	devQuery := "aid=8662&device_id=7123456789012345678&device_type=23127PN0CC&device_brand=Xiaomi&os_version=14&version_name=7.3.9.32"
	envDev := sign.DefaultMedusaEnv(1795440000000)
	envDev.Device = sign.MedusaDeviceOf(devQuery, "7123456789012345678")
	block := sign.MedusaV5DeviceBlock("7123456789012345678", envDev, 1795440816543)
	v.MedusaDevice = append(v.MedusaDevice, MedusaDeviceVec{
		Query:        devQuery,
		DeviceID:     "7123456789012345678",
		LaunchMillis: 1795440000000,
		NowMillis:    1795440816543,
		BlockHex:     hex.EncodeToString(block),
	})

	// 12. assembleMedusaV5 (both emulator layout and real device layout, both GET and POST, variants 5 and 12)
	for _, useDev := range []bool{false, true} {
		for _, hasBody := range []bool{false, true} {
			var body []byte
			if hasBody {
				body = []byte(`{"series_id":"7690184933037329432"}`)
			}
			baseQ := "aid=8662&device_id=7123456789012345678&version_name=7.3.9.32"
			if useDev {
				baseQ = devQuery
			}
			for off := 0; off < 256; off++ {
				q := fmt.Sprintf("%s&ts=1795440816&_rticket=%d", baseQ, 1795440816000+off)
				env := sign.DefaultMedusaEnv(1795440000000)
				env.PID = 14321
				env.PPID = 678
				if useDev {
					env.Device = sign.MedusaDeviceOf(q, "7123456789012345678")
					env.Status = sign.DeviceStatus()
				} else {
					env.Status = sign.EmulatorStatus()
				}
				rnd := sign.MedusaRandom{Message: 12345678, Key: 0x3456789a, Packed: 0x56789abc}
				want, ok := sign.AssembleMedusaV5Fixed(q, body, 1795440816, "7123456789012345678", env, rnd, 42)
				if !ok {
					continue
				}
				v.MedusaV5 = append(v.MedusaV5, MedusaV5Vec{
					Query:        q,
					BodyHex:      hex.EncodeToString(body),
					HasBody:      hasBody,
					TS:           1795440816,
					DeviceID:     "7123456789012345678",
					UseDevice:    useDev,
					Status:       env.Status,
					PID:          env.PID,
					PPID:         env.PPID,
					LaunchMillis: env.LaunchMillis,
					Counter:      42,
					RndMessage:   rnd.Message,
					RndKey:       rnd.Key,
					RndPacked:    rnd.Packed,
					Want:         want,
				})
				break
			}
		}
	}

	// 13. Argus & Ladon (legacy playback)
	for _, tc := range []struct {
		query, body, aid, dev, iid string
		ts, nonce                  uint32
	}{
		{"aid=1967&device_id=test-device&iid=test-install", "", "1967", "test-device", "test-install", 1700000000, 659662259},
		{"aid=8662&device_id=7000000000000000001&iid=7000000000000000002&version_name=7.1.3.32&_rticket=1800000000999&ts=1800000000", `{"video_id":"123","biz_param":{"video_platform":3}}`, "8662", "7000000000000000001", "7000000000000000002", 1800000000, 4294967295},
		{"", "", "1967", "", "", 1700000000, 0},
	} {
		v.Argus = append(v.Argus, ArgusVec{
			Query:     tc.query,
			BodyHex:   hex.EncodeToString([]byte(tc.body)),
			TS:        tc.ts,
			Nonce:     tc.nonce,
			AID:       tc.aid,
			DeviceID:  tc.dev,
			InstallID: tc.iid,
			Want:      sign.ArgusHeader(tc.query, []byte(tc.body), tc.ts, tc.nonce, tc.aid, tc.dev, tc.iid),
		})
	}
	for _, tc := range []struct {
		ts, nonce uint32
		aid       string
	}{
		{1700000000, 0x04030201, "1967"},
		{1800000000, 0x04030201, "8662"},
		{1795440816, 0xfeedface, "8662"},
	} {
		v.Ladon = append(v.Ladon, LadonVec{
			TS:    tc.ts,
			Nonce: tc.nonce,
			AID:   tc.aid,
			Want:  sign.LadonHeader(tc.ts, tc.nonce, tc.aid),
		})
	}

	// 14. encodeQuery
	qPairs := [][2]string{
		{"query", "霸总 复仇!~*'()-_."},
		{"resolution", "1200*2670"},
		{"empty", ""},
	}
	v.EncodeQuery = append(v.EncodeQuery, EncodeQueryVec{
		Pairs: qPairs,
		Want:  sign.EncodeQuery(qPairs),
	})

	// 15. Request JSON bodies
	mustStr := func(b []byte, err error) string {
		if err != nil {
			panic(err)
		}
		return string(b)
	}
	v.RequestBodies = RequestBodiesVec{
		Series:           mustStr(protocol.SeriesBody("7690184933037329432")),
		SeriesBatch:      mustStr(protocol.SeriesBatchBody([]string{"7690184933037329432", "7100000000000101"})),
		Album:            mustStr(protocol.AlbumBody("7690184933037329432")),
		Playback:         mustStr(protocol.PlaybackBody("7690261304497458201")),
		ShortFilterPanel: mustStr(protocol.ShortFilterBody("default", nil, true, protocol.ShortCursor{})),
		ShortFilterQuery: mustStr(protocol.ShortFilterBody("comic_series", map[string][]string{"genre": {"comic_series"}, "sort": {"hot_score"}}, false, protocol.ShortCursor{Offset: 18, Seen: []string{"111", "222"}, Session: "sess-1"})),
		UserWorksTabs:    mustStr(protocol.UserWorksTabsBody("12345678")),
		UserWorks:        mustStr(protocol.UserWorksBody("12345678", "cur-1", protocol.WorksTab{Tab: 8, Sub: 100})),
		Danmaku:          mustStr(protocol.DanmakuBody("7690184933037329432", "7690261304497458201", 30000, 135000, 90, "")),
	}

	// 16. Register plaintext
	genTime := time.UnixMilli(1795440816123).UTC()
	regID := protocol.RegisterIdentity{
		CDID:       "11111111-1111-4111-8111-111111111111",
		OpenUDID:   "0123456789abcdef",
		ClientUDID: "22222222-2222-4222-8222-222222222222",
		OAID:       "33333333-3333-4333-8333-333333333333",
		ReqID:      "44444444-4444-4444-8444-444444444444",
		Device:     model.DefaultDevice,
	}
	plainReg, err := protocol.BuildBootstrapPlaintext(protocol.RegisterHeader(regID, genTime), genTime)
	if err != nil {
		panic(err)
	}
	v.RegisterPlain = RegisterPlainVec{
		GeneratedAtMs: genTime.UnixMilli(),
		CDID:          regID.CDID,
		OpenUDID:      regID.OpenUDID,
		ClientUDID:    regID.ClientUDID,
		OAID:          regID.OAID,
		ReqID:         regID.ReqID,
		Plaintext:     string(plainReg),
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
}
