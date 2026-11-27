// Hongguo danmaku emoji code to Unicode emoji conversion
// (ported from ichiwa internal/catalog/danmaku.go).

export const DANMAKU_EMOJI = Object.freeze({
  "[笑哭]": "😂", "[捂脸]": "🤦", "[赞]": "👍", "[爱慕]": "🥰", "[吃瓜]": "🍉",
  "[偷笑]": "🤭", "[爽]": "😎", "[奸笑]": "😏", "[微笑]": "🙂", "[送花]": "💐",
  "[笑]": "😄", "[爱心]": "❤️", "[大笑]": "😆", "[哭]": "😭", "[尬笑]": "😅",
  "[什么]": "😳", "[鼓掌]": "👏", "[探究]": "🧐", "[委屈]": "🥺", "[没看够]": "🥺",
  "[惊呆]": "😱", "[震惊]": "😱", "[惊讶]": "😮", "[流泪]": "😭", "[快哭了]": "🥹",
  "[害羞]": "😊", "[怒]": "😠", "[生气]": "😠", "[发怒]": "😡", "[呲牙]": "😁",
  "[色]": "😍", "[可怜]": "🥺", "[强]": "💪", "[加油]": "💪", "[抱拳]": "🙏",
  "[比心]": "🫶", "[玫瑰]": "🌹", "[疑问]": "❓", "[再见]": "👋", "[OK]": "👌",
  "[胜利]": "✌️", "[握手]": "🤝", "[飞吻]": "😘", "[亲亲]": "😚", "[擦汗]": "😅",
  "[难过]": "😞", "[心碎]": "💔", "[火]": "🔥", "[灵机一动]": "💡", "[泣不成声]": "😭",
  "[可爱]": "🥰", "[酷]": "😎", "[晕]": "😵", "[睡]": "😴", "[思考]": "🤔",
  "[无语]": "😑", "[白眼]": "🙄", "[坏笑]": "😏", "[得意]": "😏", "[调皮]": "😜",
  "[石化]": "🗿",
});

export function emojify(input) {
  let s = String(input || "");
  if (!s.includes("[")) return s;
  let out = "";
  while (true) {
    let i = s.indexOf("[");
    if (i < 0) break;
    let j = s.indexOf("]", i);
    if (j < 0) break;
    out += s.slice(0, i);
    // A code inside another bracket, as in "[[笑]", starts at the last '[' before ']'.
    const k = s.slice(i, j).lastIndexOf("[");
    if (k > 0) {
      out += s.slice(i, i + k);
      i += k;
    }
    const code = s.slice(i, j + 1);
    out += DANMAKU_EMOJI[code] ?? code;
    s = s.slice(j + 1);
  }
  out += s;
  return out;
}
