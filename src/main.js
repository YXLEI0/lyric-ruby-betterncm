/*
 * 西文字母片假名注音 · BetterNCM 插件入口
 *
 * 给日语歌歌词里的西文字母（clover / light / diorama / Sekai / Отчизну /
 * Θάλασσα …）标片假名读音。方向跟另一个片假名注音插件（片假名 -> 英文）正好相反，
 * 两个可以同时开：一行里既有片假名又有英文时，两种注音一起出现。
 *
 * 读音来源（层序在 core/reading.js 里定，面板里可调）：
 *   1. 离线词典（core/dict.js，6895 条）：人工词条、官方歌名读音、运行期沉淀、大模型批量
 *   2. 日式罗马音切分（sekai -> セカイ，歌词里官方写的罗马音）
 *   3. 西文各语种的拼读（core/langs.js：法 / 德 / 拉 / 葡 / 荷 / 斯瓦希里 / 拼音 / 俄 / 希）
 *      以及各语言的借词表（core/loan.js）
 *   4. 大模型校正 / 免费接口（配了 key 或开着在线时，只查"猜的、没把握"的词）
 *   5. 英文音译规则（light -> ライト，兜底，永远给得出结果）
 *
 * 另外两档"整首 / 整句专属读音"排在所有层前面（core/songs.js 与本文件里的
 * LINE_READINGS）；"连字符标记长音"是在常规读音之后再补一拍。
 */
(function () {
  "use strict";

  var LOG = "[歌词注音]";
  var REPO_URL = "https://github.com/YXLEI0/lyric-ruby-betterncm";

  /*
   * 日语歌词的字体栈。中文 Windows 上「微软雅黑」会把日文汉字按中文写法渲染
   * （`直` 的竖折、`骨` 的框内、`今` 的最后一笔都不一样），日文字体排在前面就能纠正。
   * 字体名写在这里只是默认值，面板可以改（老版本 JapaneseFonts 也是让用户填的）。
   */
  var JP_FONT_DEFAULT =
    "'Yu Gothic UI', 'Yu Gothic', '游ゴシック', 'Meiryo UI', 'Meiryo', 'MS Gothic', 'MS Mincho', 'Microsoft YaHei'";

  /**
   * 把面板里填的字体串洗成能用的 CSS。
   *
   * 输入框里很容易写进竖线、分号、换行（`"fontA" | "fontB"` 这种），那会让整条 CSS 规则
   * 被浏览器丢掉 —— 现象就是"改了字体没生效"。
   *
   * 只删真正会破坏规则的字符，**不做白名单**：字体名里可以有日文
   * （`游ゴシック`、`ヒラギノ角ゴ`），白名单一刀切会把它们削成半个名字（`游`），
   * 那比原样保留更糟 —— 名字对不上就静默回落，同样"没生效"。
   */
  function fontStack(raw) {
    var v = String(raw == null ? "" : raw);
    v = v.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
    v = v.replace(/\u3000/g, " ");
    /*
     * 按分隔符切开、逐项清洗、再拼回去。
     *
     * 以前只是把 `|` `;` 换成空格，结果 `"fontA" "fontB" x` 里两个字符串直接相邻 ——
     * **整条规则仍然非法**，浏览器丢弃赋值，`style.fontFamily` 读回来是空的，
     * 看起来还是"没生效"。逐项清洗才能保证拼出来一定合法：
     *   - 分隔符认 `,` `;` `|`（用户当成"或者"随手写的）
     *   - 每项去掉引号和会破坏规则的字符，保留日文（`游ゴシック`）和名字里的空格
     *   - 名字里有空格或非 ASCII 就加双引号；`serif` 这类通用族不加
     */
    var parts = v.split(/[,;|\uFF0C\uFF1B]/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i].replace(/["']/g, "").replace(/[{}\[\]<>\\\r\n\t]/g, " ");
      name = name.replace(/\s+/g, " ").trim();
      if (!name) continue;
      var generic = /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif)$/i.test(name);
      out.push(generic ? name : '"' + name + '"');
    }
    return out.length ? out.join(", ") : JP_FONT_DEFAULT;
  }

  /*
   * 插件改过两次名：latin-katakana -> western-katakana（0.1.x 之前）-> lyric-ruby（1.0）。
   * localStorage 的键前缀跟着换，但已有的配置、学会的词、缓存、用量账本不该因为改名全丢，
   * 所以做一次性搬家：新键不存在、老键存在才复制，老键留着不删（万一要回退）。
   * 从老版本一路升上来的人两条老前缀都要试；得在读 config / 建各层之前跑。
   */
  (function migrateStorage() {
    var SUFFIX = [".config", ".trace", ".learned.v1", ".usage", ".llm.v1", ".cache.v1", ".off", ".dev"];
    var OLD_PREFIX = ["latin-katakana", "western-katakana"];
    try {
      for (var p = 0; p < OLD_PREFIX.length; p++) {
        for (var i = 0; i < SUFFIX.length; i++) {
          var oldKey = OLD_PREFIX[p] + SUFFIX[i];
          var newKey = "lyric-ruby" + SUFFIX[i];
          var val = localStorage.getItem(oldKey);
          if (val !== null && localStorage.getItem(newKey) === null) localStorage.setItem(newKey, val);
        }
      }
    } catch (e) {
      /* localStorage 不可用就跳过（隐私模式 / 配额满） */
    }
  })();

  // ------------------------------------------------------------ 基础工具

  /*
   * 查表的统一入口：只认对象自己的键。
   *
   * 词表 / 词条都是对象字面量，`tbl[key]` 查不到时会顺着原型链往上找 ——
   * 歌词里出现 `constructor` / `valueOf` / `toString` 这种词时，命中的是
   * Object.prototype 上的函数，读出来的就是函数源码。
   */
  function own(tbl, key) {
    return !!tbl && Object.prototype.hasOwnProperty.call(tbl, key);
  }

  function log() {
    var msg = "";
    try {
      msg = Array.prototype.join.call(arguments, " ");
    } catch (e) {
      msg = "(unserializable)";
    }
    try {
      console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {
      /* ignore */
    }
    return msg;
  }

  function warn() {
    var msg = "";
    try {
      msg = Array.prototype.join.call(arguments, " ");
    } catch (e) {
      msg = "(unserializable)";
    }
    trace("WARN", msg);
    try {
      console.warn.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {
      /* ignore */
    }
  }

  /*
   * 运行轨迹信标：把每轮扫描的关键信息和异常写进 localStorage，
   * 出问题时可以离线读出来（tools/read-trace.js 能直接从网易云的 leveldb 里读，
   * 那里面的值是 Snappy 压缩的、还跨 record 分片，别手工捞）。
   * 上限 250 行，超出丢最旧的，避免把配额写爆。
   */
  var TRACE_KEY = "lyric-ruby.trace";
  var TRACE_MAX = 250;

  function trace(kind, msg) {
    try {
      if (typeof localStorage === "undefined") return;
      var arr = [];
      try {
        arr = JSON.parse(localStorage.getItem(TRACE_KEY)) || [];
      } catch (e) {
        arr = [];
      }
      var t = new Date();
      var pad = function (n) {
        return (n < 10 ? "0" : "") + n;
      };
      var stamp = pad(t.getHours()) + ":" + pad(t.getMinutes()) + ":" + pad(t.getSeconds());
      arr.push(stamp + " [" + kind + "] " + String(msg).slice(0, 300));
      if (arr.length > TRACE_MAX) arr = arr.slice(arr.length - TRACE_MAX);
      localStorage.setItem(TRACE_KEY, JSON.stringify(arr));
    } catch (e) {
      /* 写不进去就算了，绝不能因为记日志把插件搞崩 */
    }
  }

  var CONFIG_KEY = "lyric-ruby.config";

  var DEFAULTS = {
    enabled: true,
    online: true, // 词典/规则都没把握时是否联网校正（Google 接口，不用填 key）
    // ---- 大模型校正（质量比规则高一个数量级，需要自己填 key）
    llmEnabled: true,
    llmEndpoint: "https://api.deepseek.com/chat/completions",
    llmModel: "deepseek-chat",
    llmKey: "",
    /*
     * 让大模型按整句切词（熟字训优先）。**单独一个开关**，默认关：
     * 每句一次请求，比"只问个别词"那档重得多；而且离线词典本来就能读大多数词，
     * 这一档是给"帷帳 とばり / 今日 きょう"这种熟字训和生词兜底的。
     */
    llmSegment: false,
    /*
     * 读音来源的调用顺序（越靠前越优先），设置面板里可以上下调。
     * 记号 / 缩写 / 字母名 / 长音符罗马字不在这张表里 —— 那是"这个词该怎么断"，
     * 不是"读音该信谁"，永远最先判（见 core/reading.js 的 lookup）。
     */
    layerOrder: ["dict", "romaji", "llm", "google", "rule"],
    // ---- API 用量统计：单价只用来"估算花费"，0 = 不算（单位：元 / 百万 token）
    usagePriceIn: 0,
    usagePriceOut: 0,
    annotateAll: true, // 除歌词外，也标播放栏的歌名/歌手
    /*
     * 非日语歌（歌词里一个假名都没有，比如纯英语/法语/中文歌）是否也注音。
     * 默认 true = 照旧全标；打开「只标日语歌」就整首跳过（含播放栏标题）。
     * 判据看整首歌词（有一行含假名就算日语歌），所以日语歌里的纯英文行
     * 不会被误伤。
     */
    annotateNonJapanese: true,
    /*
     * 汉字（普通话读音）与谚文（朝鲜语读音）也注片假名。默认关：这两种字铺满整行，
     * 观感变化很大 —— 想要的人在面板里自己打开。
     * 只对"非日语歌、且这一行没有假名"的行生效：日语歌里的汉字绝不能用普通话音去读
     * （`東京` 是 トウキョウ，不是 ドンジン）。
     */
    annotateHanzi: false,
    annotateHangul: false,
    /*
     * 西文歌词（英文 / 法德拉丁俄希…）标片假名。默认开；关掉之后只注日语振假名和汉字读音。
     * 为什么要这个开关：有些人只想看日文汉字的读音，满屏英文单词的片假名反而吵。
     */
    annotateLatin: true,
    // 日语汉字振假名：默认开（装了本插件就是要看读音）；平假名是日语歌词的惯例
    furigana: true,
    furiganaKana: "hiragana",
    // 自定义读音：一行一条 `底字=假名`（面板里「高级设置 → 自定义读音」）
    furiganaOverrides: "",
    // 歌词界面里就地改的读音（老版本，按词；启动时迁到下面那套）
    furiganaLineFixes: {},
    // 就地改的读音（按位置）：{ 整行原文: [[起点, 底字, 假名], ...] }
    // 按位置存才能"只改这一处"—— 同一行里两个相同的字不会一起变
    furiganaLineSpans: {},
    // 统一行距：有注音的行和没注音的行一样高（给整行一个固定 line-height）
    uniformLineHeight: true,
    // 统一行距用的行高（有注音/没注音都按它）
    lineHeight: 1.6,
    // 日语歌的歌词换成日文字体（中文字体里的日文汉字字形是中文写法，`直` / `骨` 这种一眼看出）
    jpnFont: true,
    jpnFontFamily: JP_FONT_DEFAULT,
    scope: "all", // titles | lyrics | all | custom
    customSelector: "",
    rtSize: 55, // 注音字号（相对底字百分比）
    rtOpacity: 80, // 注音不透明度
    colorBySource: false, // 按读音来源给注音上色（排障用，见设置面板的图例）
    verbose: false,
  };

  // ------------------------------------------------------------ 读音来源与顺序

  /*
   * 这几层能在设置面板里上下调，越靠前越优先。语义是"排在当前答案前面的在线层"
   * 才有资格覆盖它：把英文音译规则提到大模型 / 免费接口前面，就等于一个请求都不发
   * （不想联网的用法）；把大模型提到词典前面，则连词典命中的词也要让它判一遍。
   *
   * 记号 / 缩写 / 字母名 / 长音符罗马字（`D/N/A`、`I'll`、`LDK`、`Tōkyō`）不在这张表里，
   * 它们决定的不是"读音该信谁"，而是"这个词该怎么断"，永远最先判。
   */
  var LAYER_IDS = ["dict", "romaji", "llm", "google", "rule"];
  var LAYER_NAMES = {
    dict: "离线词典",
    romaji: "日式罗马音",
    llm: "大模型校正",
    google: "免费接口",
    rule: "英文音译规则",
  };
  // 异步层（要发请求、结果晚一点回来）；另外三层是同步的，读的时候当场就有答案
  var ASYNC_LAYERS = { llm: true, google: true };

  /** 去重 + 补齐：脏配置、旧版本配置都不至于少一层（缺的按默认顺序补在后面） */
  function normalizeLayerOrder(list) {
    var out = [];
    var src = list && typeof list.length === "number" ? list : [];
    var i;
    for (i = 0; i < src.length; i++) {
      if (LAYER_IDS.indexOf(src[i]) >= 0 && out.indexOf(src[i]) < 0) out.push(src[i]);
    }
    for (i = 0; i < LAYER_IDS.length; i++) {
      if (out.indexOf(LAYER_IDS[i]) < 0) out.push(LAYER_IDS[i]);
    }
    return out;
  }

  /** 这一层在配置的层序里排第几（越小越优先）；不在表里的（如 letters）算最优先 */
  function layerRank(id) {
    var i = config.layerOrder.indexOf(id);
    return i < 0 ? -1 : i;
  }

  /**
   * 当前层序里「英文音译规则」有没有挡住离线词典 / 日式罗马音。
   *
   * 规则层对每个词都给得出答案（它就是拼写猜测），排在它下面的层永远轮不到。把
   * 词典往下拖了几格就是这么踩的：`the` 变成规则猜的 セ、`this` 变黄（也是规则层）、
   * `I'll` 被拆成「イ + ル」= イル，大模型也不再被咨询（规则先答了）。面板里的 ↑↓
   * 已经不让这么换，这个函数兜住手改配置 / 老配置，并在设置面板里说出来。
   *
   * @returns {Array<string>} 被挡住的层名（空数组 = 没问题）
   */
  function ruleBlocksSync() {
    var ruleIdx = config.layerOrder.indexOf("rule");
    var out = [];
    if (ruleIdx < 0) return out;
    for (var i = ruleIdx + 1; i < config.layerOrder.length; i++) {
      var id = config.layerOrder[i];
      if (id === "dict" || id === "romaji") out.push(LAYER_NAMES[id] || id);
    }
    return out;
  }

  /*
   * 这一行是不是日语罗马字 —— 决定短音节按罗马音还是按英文词读。
   *
   * 案例：`Yes, PA PI PU PE PO POP UP!(Hey!!)Yes, MA MI MU ME MO MORE JUMP!(Yeah!!)`
   * 这种"罗马音节练习"式写法，用词典效果很差。打架的正是那几个短音节：
   *   PI 词典=パイ（英文 pi）  罗马音=ピ
   *   PE 词典=ピーイー（把 "P E" 当字母念）罗马音=ペ
   *   PO 词典=ピーオー        罗马音=ポ
   *   MI/ME/MO 词典=ミー/ミー/モー  罗马音=ミ/メ/モ
   * `pi/pe/po/mi/me/mo` 又全都在英文常用词表里，所以"它是不是英文词"这条判据分不开
   * （`me`/`no`/`so` 真是英文词，`pi`/`po` 只是被词表收进去了）。能分开的是整行的构成：
   * 一行里同时出现好几个"词典读音和罗马音读音打架"的短音节，那就是罗马字行，英文歌词
   * 不会这么写。
   *
   * 判据：一行里有 5 个以上不同的「≤3 字母 + 能切成罗马音 + 词典里有条目但读音不同」的词。
   *   `PA PI PU PE PO`（5 个）、`MA MI MU ME MO`（5 个）、示例那行（6 个）都算
   *   `No, no, no, I need you so`（no/i/so/you = 4 个）不算，英文行，保持词典读音
   *   `we can go to the sea`（we/go/to = 3 个）不算
   * 3 个 / 4 个都不行，常见英文短词凑到四个太容易：实测那两行就是这么被判进去的，
   * go/to/no/you 被读成 ゴ/ト/ノ/ヨウ。5 个才真正是"罗马音节练习"。命中之后这些词会
   * 标成没把握，在线层（大模型）拿到整句语境还能改回去。
   *
   * 另外整行还得几乎都是短词（≤3 字母占 60% 以上）：只数"打架几个"的话，`Shoo, Gimme more`
   * 这种长词句也可能被算进去。真正的罗马字行短词占比很高（实测示例那行 83%，
   * `Shoo, Gimme more` 是 0%）。
   */
  var ROMAJI_LINE_MIN = 5;
  var ROMAJI_LINE_SHORT_RATIO = 0.6;
  var romajiLineCache = new Map();
  var ROMAJI_LINE_CACHE_MAX = 200;
  /** 每一行的语种判定也缓存（同一行会被问很多次） */
  var langLineCache = new Map();
  var LANG_CACHE_MAX = 200;

  /*
   * 只在英语拼写里出现的字母组合：日语罗马字里没有 th / wh / ck / gh / ph，也没有 q 和 x
   * （θ・w・ク・q・x 都不是日语音节）。
   *
   * 案例：`Knock knock! Let me go in and get the ace` 里 `me` 曾读成 メ。`me` 的词典
   * 读音是 ミー（对的），但这一行被判成了罗马字行，于是整行短词都改按罗马音读，`me`→メ、
   * `go`→ゴ…。这类英文行只要再多一个打架的短词（`so`/`no`/`you`…）就够 5 个门槛，
   * 用短词数分不开英文行和罗马字行。
   *
   * 拼写能分开：罗马字写不出 `ck`（knock）、`th`（the/with）、`wh`（what）、`q`（question）。
   * 所以这一行里出现这类组合就不是罗马字行，词典读音照用 —— 比调整阈值稳得多。
   * 对照：`PA PI PU PE PO POP UP!` / `MA MI MU ME MO MORE JUMP!` 里一个都没有，
   * 仍然是罗马字行（那里要的正是 パピプペポ）。
   */
  var RE_ENGLISH_ONLY = /(th|wh|ck|gh|ph|q|x)/;

  /** ≤3 个纯字母、且能干净地切成日语罗马音 -> 返回那个读音，否则 null */
  function shortRomajiOf(word) {
    var w = String(word || "").toLowerCase();
    if (!/^[a-z]{1,3}$/.test(w)) return null;
    if (typeof WKReading === "undefined" || !WKReading.romajiToKatakana) return null;
    try {
      return WKReading.romajiToKatakana(w) || null;
    } catch (e) {
      return null;
    }
  }

  function lineLooksRomaji(line) {
    if (!line) return false;
    var key = String(line);
    if (romajiLineCache.has(key)) return romajiLineCache.get(key);
    var looks = false;
    try {
      var tokens = WKMatcher.scan(key);
      var dict = typeof WKDict !== "undefined" ? WKDict.words : {};
      var seen = {};
      var distinct = 0;
      var latin = 0;
      var short = 0;
      var englishOnly = false;
      for (var i = 0; i < tokens.length; i++) {
        var w0 = String(tokens[i].text || "").toLowerCase();
        if (!/^[a-z]+$/.test(w0)) continue;
        latin++;
        if (/^[a-z]{1,3}$/.test(w0)) short++;
        if (RE_ENGLISH_ONLY.test(w0)) englishOnly = true;
        if (own(seen, w0)) continue;
        seen[w0] = true;
        var rom = shortRomajiOf(w0);
        if (!rom) continue;
        var dictKana = own(dict, w0) ? dict[w0] : undefined;
        // 词典里有、而且和罗马音读音不一样 —— 这才是"会读歪"的那种词
        if (dictKana && dictKana !== rom) distinct++;
      }
      // 光数"打架几个"不够：英文行也能凑够（`No, no, no, I need you so` 到 4 个）。
      // 真正的罗马字行短词占比很高（`PA PI PU PE PO POP UP` 83%），所以再加一条 60% 的门槛
      var shortRatio = latin ? short / latin : 0;
      // 三条一起看：打架的短音节够多、整行几乎都是短词、拼写上不像英语（见 RE_ENGLISH_ONLY）
      looks = !englishOnly && distinct >= ROMAJI_LINE_MIN && shortRatio >= ROMAJI_LINE_SHORT_RATIO;
    } catch (e) {
      looks = false; // 判断失败就当它不是罗马字行，绝不因此影响注音
    }
    if (romajiLineCache.size > ROMAJI_LINE_CACHE_MAX) romajiLineCache.clear();
    romajiLineCache.set(key, looks);
    return looks;
  }

  /**
   * 一个本地答案在"谁说了算"上的实际名次：一般就是它所在层的名次，但没把握的答案
   * （confident:false）一律按最低那层（英文音译规则）算，排在它后面的在线层就有资格覆盖它。
   *
   * 罗马音层只是"整串能切成日语音节"，`shake`(sha-ke) / `open`(o-pe-n) 这种英文词会被它
   * 读成 シャケ / オペン。按名次拍板的话（罗马音排在在线层前面）这些词就永远读错、大模型
   * 也没机会纠；标成没把握再按这个名次算，在线层就能接手。把「英文音译规则」拖到在线层
   * 前面（纯离线用法）时，这个名次也跟着变成最优先，在线层照样不会被打扰。
   */
  function effectiveRank(r) {
    if (!r) return -1;
    // 「学会的词」是离线词条，名次按离线词典算（在线层不再覆盖它 —— 省的就是这一笔）
    if (r.source === "learned") return layerRank("dict");
    if (r.source !== "letters" && r.confident === false) return layerRank("rule");
    return layerRank(r.source);
  }

  /** 大模型那层现在能不能用（开关 + 填了 key） */
  function llmAvailable() {
    if (!state.llm || !state.llm.config) return false;
    var c = state.llm.config();
    return !!(c.enabled && c.hasKey);
  }

  function googleAvailable() {
    return !!(config.online && state.corrector);
  }

  function layerAvailable(id) {
    if (id === "llm") return llmAvailable();
    if (id === "google") return googleAvailable();
    return true;
  }

  /** 同步层（词典/罗马音/规则）在配置层序里的相对次序 */
  function syncLayerOrder() {
    var out = [];
    for (var i = 0; i < config.layerOrder.length; i++) {
      if (!ASYNC_LAYERS[config.layerOrder[i]]) out.push(config.layerOrder[i]);
    }
    return out;
  }

  /** 把顺序推给读音引擎；配置坏了先纠正，免得引擎拿到半张表 */
  function applyLayerOrder() {
    config.layerOrder = normalizeLayerOrder(config.layerOrder);
    if (state.reader && state.reader.setOrder) state.reader.setOrder(syncLayerOrder());
  }

  /*
   * 读配置：先把默认值铺一遍，再用存下来的值覆盖同名的键。
   *
   * 合并是"按 DEFAULTS 的键白名单"做的，所以不需要版本号也不需要迁移：
   * 老版本存下来的键只要还在 DEFAULTS 里就继续生效，已经不认识的键自动忽略，
   * 新加的键（老配置里没有）直接拿默认值。只有一个例外要单独收拾 ——
   * layerOrder 是数组、还可能被手改坏，见下面 normalizeLayerOrder。
   */
  function loadConfig() {
    var saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
    } catch (e) {
      /* 坏了就用默认值 */
    }
    var cfg = {};
    for (var k in DEFAULTS) cfg[k] = DEFAULTS[k];
    for (var k2 in saved) if (own(DEFAULTS, k2)) cfg[k2] = saved[k2];
    // 层序是数组，且可能被手改坏：当场去重补齐（也顺便复制一份，别改到 DEFAULTS）
    cfg.layerOrder = normalizeLayerOrder(cfg.layerOrder);
    return cfg;
  }

  function saveConfig() {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch (e) {
      warn("设置保存失败", e && e.message);
    }
  }

  var config = loadConfig();

  /*
   * 紧急开关：插件一旦把页面搞崩，设置面板也进不去，所以留一个不依赖 UI 的关闭方式。
   * 在网易云的开发者工具控制台执行：
   *     localStorage['lyric-ruby.off'] = '1'   // 并重启
   */
  function emergencyOff() {
    try {
      return localStorage.getItem("lyric-ruby.off") === "1";
    } catch (e) {
      return false;
    }
  }

  function devMode() {
    try {
      if (typeof plugin !== "undefined" && plugin.devMode) return true;
      return localStorage.getItem("lyric-ruby.dev") === "1";
    } catch (e) {
      return false;
    }
  }
  var DEV = devMode();

  // ------------------------------------------------------------ 状态

  var state = {
    reader: null,
    corrector: null,
    llm: null,
    usage: null,
    learned: null,
    annotator: null,
    observer: null,
    timer: null,
    timerIsRaf: false,
    tickTimer: null,
    applied: false,
    lastPassMs: 0,
    lastPassAt: 0,
    lastResult: null,
    error: null,
    betterncmVersion: "",
    // 整首专属读音表（见 SONG_READINGS，每轮扫描开始时按歌名/歌词重算）
    songWords: null,
    // 「连字符串」（连字符标记长音，见 collectLongVowelWords）：同一趟扫描算出来
    longWords: null,
  };

  // ------------------------------------------------------------ 读音

  /*
   * 取一个词的显示读音，连同"这个读音最终是谁给的"一起返回：
   *   { kana, source }，source ∈ dict / romaji / rule / letters / llm / google
   *
   * 层序在设置面板里定，默认 离线词典 > 罗马音 > 大模型校正 > 免费接口 > 英文音译规则。
   * 同步层（词典 / 罗马音 / 规则）当场给答案，异步层（大模型 / 免费接口）要发请求。规则是
   * 拼写音译（hello -> ヘッラオ、question -> クワエサション），所以默认排在在线层后面，
   * 但它也是一切的兜底：在线层挂了 / 没配 / 在退避时立刻放行，否则断网就等于一个字都不标。
   * 排序顺带给了两个用法 —— 把「英文音译规则」提到在线层前面就是一个请求都不发（纯离线），
   * 把「大模型」提到词典前面则连词典命中的词也让它判一遍（词典偶有错条目，这是逃生门）。
   *
   * 底线是绝不返回 null 让这行空着：高优先的在线层还在问的时候，用现成的答案顶上并标成
   * "暂定"（`wk-pending`，样式淡一点），结果回来由 annotate.relabel() 就地改写 ——
   * "全英文行标注后有概率消失"就是这么修的。source 是给排障用的（「按来源着色」
   * 把每一层染成不同颜色），只要读音字符串的调用方走 readForDisplay()，控制台 WK.display() 用它。
   */
  /**
   * 本地几层给的答案（含"罗马字行里的短音节改读罗马音"这条修正）。
   * resolveReading 和 isProvisional 必须用同一个答案，否则会出现"页面上显示得很确定、
   * 其实正在问模型"这种不同步。
   */
  /**
   * 全大写的 2~3 字母紧贴着假名出现（`ATフィールド`、`のSOS`、`BGMオン`）。
   *
   * 案例：`対バンにはATフィールド` 把 `AT` 读成了词典里的英文词 at（アット），正确是
   * エーティー。这一条我们自己分不清（`AT`/`NO`/`GO`/`UP` 拼写一样、场合不同），所以只调
   * "把握"、不改读音：标成没把握，让大模型按整句判（判完还会自动沉淀成离线词条）。
   * 模型没开时显示的还是原来的词音，不会更差。
   */
  /**
   * 这一行是什么语言（带缓存），判不出来返回 null —— 那就按老规矩走：离线词典 ->
   * 日语罗马音 -> 英文规则。
   *
   * 支持的语言在 core/langs.js 里：法语 / 德语 / 拉丁语 / 葡萄牙语 / 荷兰语 / 斯瓦希里语 /
   * 汉语拼音 / 俄语（西里尔）/ 希腊语。判定分两层：① 这一行自己的特征（WKLangs.detect）；
   * ② 整首歌词的多数语种兜底（songLanguage）—— `Dominatus`、`Ukuu ukuu` 这种两三个词的
   * 短行自己分数不够，但整首都是拉丁语 / 斯瓦希里语时应该照那种语言读，不然一行一个读法。
   */
  function lineLang(line) {
    if (!line) return null;
    var key = String(line);
    if (langLineCache.has(key)) return langLineCache.get(key);
    var id = null;
    try {
      if (typeof WKLangs !== "undefined" && WKLangs.detect) {
        id = WKLangs.detect(key);
        if (!id) {
          var song = songLanguage();
          if (song && WKLangs.fits(song, key)) id = song;
        }
      }
    } catch (e) {
      id = null; // 判语言失败绝不影响注音
    }
    if (langLineCache.size > LANG_CACHE_MAX) langLineCache.clear();
    langLineCache.set(key, id);
    return id;
  }

  /**
   * 整首歌词的语种：数每一行自己判出来的语种，取出现次数最多的那个（至少 2 行）。
   * 只用来兜住短行，不参与长行的判定；按歌词文本缓存（换歌才重算）。
   */
  var songLangCache = { key: "", value: null };
  function songLanguage() {
    if (typeof WKLangs === "undefined" || !WKLangs.detect) return null;
    if (!state.annotator || !state.annotator.findRegions) return null;
    var regions;
    try {
      regions = state.annotator.findRegions("lyrics");
    } catch (e) {
      return null;
    }
    if (!regions || !regions.length) return null;
    var texts = [];
    for (var i = 0; i < regions.length; i++) texts.push(regionText(regions[i]));
    var key = texts.join("\n").slice(0, 4000);
    if (songLangCache.key === key) return songLangCache.value;
    var counts = {};
    var best = null;
    var bestN = 0;
    for (var j = 0; j < texts.length; j++) {
      var id = null;
      try {
        id = WKLangs.detect(texts[j]);
      } catch (e3) {
        id = null;
      }
      if (!id) continue;
      counts[id] = (counts[id] || 0) + 1;
      if (counts[id] > bestN) {
        bestN = counts[id];
        best = id;
      }
    }
    songLangCache = { key: key, value: bestN >= 2 ? best : null };
    return songLangCache.value;
  }

  /*
   * 单字母单位符号：整串字母全是单位时才按单位名读。
   *
   * 案例：`誰にも邪魔されないような（V, W, A）`，这三个是物理单位（ボルト / ワット /
   * アンペア），要读单位名而不是字母名。而 `(A, B) 退屈に打つ QTE` 里的 A / B 要读字母名
   * （エー / ビー）—— 两者都是括号里的字母串，区别是这一串里有没有非单位的字母：`B` 不是单位，
   * 那一串就按字母名；`V / W / A` 全是单位，按单位名。判据见 lineAllUnitSymbols。
   * `Ω` 是希腊字母，另有单位读法（オーム，见 localReading）。
   * 想加单位（`J` ジュール、`N` ニュートン…）就往这张表里补一行，但每加一个都会让"全是单位"
   * 更容易成立（`N/A` 就是这么会中的），所以只收常用、低歧义的。
   */
  var UNIT_SYMBOL = {
    V: "\u30DC\u30EB\u30C8", // ボルト
    W: "\u30EF\u30C3\u30C8", // ワット
    A: "\u30A2\u30F3\u30DA\u30A2", // アンペア
  };

  /*
   * 单位词（两个以上字母的）：同样只在紧跟在数字后面时按单位读。
   *
   * 案例：`半径300mmの体で必死に鳴いてる` 的 `mm` 没注音 —— 那首歌的罗马音行唱的就是
   * `sa n bya ku mi ri`（ミリ），所以这里给 ミリ。判据只看"紧跟数字"，`mm~`（语气词）、
   * `PV:` 这种不会被误伤。表是人工维护的（读法唯一、日语里就这么写），想加就往里补一行。
   */
  var UNIT_WORD = {
    MM: "\u30DF\u30EA", // ミリ
    CM: "\u30BB\u30F3\u30C1", // センチ
    KM: "\u30AD\u30ED", // キロ
    KG: "\u30AD\u30ED", // キロ
    ML: "\u30DF\u30EA\u30EA\u30C3\u30C8\u30EB", // ミリリットル
    HZ: "\u30D8\u30EB\u30C4", // ヘルツ
    KHZ: "\u30AD\u30ED\u30D8\u30EB\u30C4", // キロヘルツ
    MHZ: "\u30E1\u30AC\u30D8\u30EB\u30C4", // メガヘルツ
    DB: "\u30C7\u30B7\u30D9\u30EB", // デシベル
    KW: "\u30AD\u30ED\u30EF\u30C3\u30C8", // キロワット
    KV: "\u30AD\u30ED\u30DC\u30EB\u30C8", // キロボルト
  };

  /**
   * 这一行里的单字母全是单位符号（`（V, W, A）` ✓、`(A, B)` ✗ —— B 不是单位）。
   *
   * 还要有**两种以上不同的**单位符号：`A A A A A` 那种同一个字母重复的读字母名
   * （案例：`A A A A A じゃないか` 里的 A 被读成了 アンペア）。
   */
  var unitLineCache = new Map();
  function lineAllUnitSymbols(line) {
    var s = String(line == null ? "" : line);
    if (!s || typeof WKMatcher === "undefined") return false;
    if (unitLineCache.has(s)) return unitLineCache.get(s);
    var ok = false;
    var n = 0;
    var kinds = {};
    var distinct = 0;
    try {
      var toks = WKMatcher.scan(s);
      ok = true;
      for (var i = 0; i < toks.length; i++) {
        var t = String(toks[i].text);
        if (t.length !== 1) continue;
        if (!own(UNIT_SYMBOL, t)) {
          ok = false;
          break;
        }
        if (!kinds[t]) {
          kinds[t] = true;
          distinct++;
        }
        n++;
      }
    } catch (e) {
      ok = false;
    }
    var out = ok && n >= 2 && distinct >= 2; // 孤零零一个字母、或同一个字母重复，都不算单位表
    if (unitLineCache.size > 500) unitLineCache.clear();
    unitLineCache.set(s, out);
    return out;
  }

  /** 这个词在行里是不是紧跟在数字后面（`30W` の W、`100V` の V、`5A` の A） */
  function digitBefore(word, line) {
    var s = String(line == null ? "" : line);
    var w = String(word == null ? "" : word);
    if (!s || !w) return false;
    var esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("[0-9\uFF10-\uFF19]\\s*" + esc + "(?![0-9\uFF10-\uFF19])").test(s);
  }

  /** 字母紧挨着数字（`B4` / `A4` / `2B`）：型号 / 规格里的字母，读字母名 */
  function digitAdjacent(word, line) {
    var s = String(line == null ? "" : line);
    var w = String(word == null ? "" : word);
    if (!s || !w) return false;
    var esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var D = "[0-9\uFF10-\uFF19]";
    return new RegExp("(?:" + D + "\\s*" + esc + "|" + esc + "\\s*" + D + ")").test(s);
  }

  /** 一个日文字（假名 / 汉字）—— `gluedToJapanese`、`gluedUpperCase` 共用 */
  var CJK_CHAR = /[\u3041-\u3096\u30A1-\u30FA\u4E00-\u9FFF]/;

  /**
   * 字母紧贴着日文（`T氏` / `B面` / `X線`：字母前后直接是汉字 / 假名，中间没空格）。
   *
   * 注音层把 token 传进来时，按**这个词自己在 DOM 上的左右邻字**判。
   * 不能只拿整行做正则搜索：那个"贴着"可能来自行里另一个词 ——
   * RNP 的行元素里，罗马音层结尾的 `…na ra` 会和中文翻译 `为我讲述吧` 直接拼在一起，
   * `ra为` 里的 `a` + 汉字就命中了，于是这一行**每个** `a` 都读成 エイ
   * （`Tell me a story` 的冠词 a 变成了 エイ）。
   * 没有 token 的调用方（控制台 WK.read 之类）仍旧退回整行搜索。
   */
  function gluedToJapanese(word, line, token) {
    var w = String(word == null ? "" : word);
    if (!w) return false;
    if (token) {
      /*
       * 还要看中间有没有空格：`X が導く` 里的 X 是独立的词（留白），
       * `X線` 才是贴着日文（エックス線）。token.afterSpaced / beforeSpaced
       * 就是注音层跨节点取到的"中间夹没夹空格"。
       */
      var around = letterAround(line, token);
      var afterGlued = !!around.after && !around.afterSpaced && CJK_CHAR.test(around.after);
      var beforeGlued = !!around.before && !around.beforeSpaced && CJK_CHAR.test(around.before);
      return afterGlued || beforeGlued;
    }
    var s = String(line == null ? "" : line);
    if (!s) return false;
    var esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var CJK = "[\\u3041-\\u3096\\u30A1-\\u30FA\\u4E00-\\u9FFF]";
    return new RegExp("(?:" + CJK + esc + "|" + esc + CJK + ")").test(s);
  }

  /*
   * 单字母左右两边各是什么字（以及中间有没有空格）。
   *
   * 邻字优先用注音层从 DOM 上现取的（`token.after` / `token.before`）：逐字歌词
   * 把一个字拆进各自的 `<span>`，`line`（整行文本）配 `token.end` 这种偏移量
   * 根本对不上。控制台和测试直接调读音层时没有这些字段，退回行文本。
   */
  function letterAround(line, token) {
    var out = { before: "", beforeSpaced: false, after: "", afterSpaced: false };
    if (token && typeof token.after === "string") {
      out.after = token.after;
      out.afterSpaced = token.afterSpaced === true;
      out.before = typeof token.before === "string" ? token.before : "";
      out.beforeSpaced = token.beforeSpaced === true;
      return out;
    }
    var s = String(line == null ? "" : line);
    if (!s || !token || typeof token.end !== "number") return out;
    var m = /^(\s*)([\s\S])/.exec(s.slice(token.end));
    if (m) {
      out.afterSpaced = m[1].length > 0;
      out.after = m[2];
    }
    var head = s.slice(0, typeof token.start === "number" ? token.start : 0);
    var m2 = /([\s\S])(\s*)$/.exec(head);
    if (m2) {
      out.beforeSpaced = m2[2].length > 0;
      out.before = m2[1];
    }
    return out;
  }

  /** 同一行里还有没有别的西文词（长度 ≥2）—— `T Is My Everything` 里的 T 是句子里的字母 */
  function lineHasOtherWord(word, line) {
    var s = String(line == null ? "" : line);
    if (!s || typeof WKMatcher === "undefined") return false;
    var w = String(word == null ? "" : word);
    var toks;
    try {
      toks = WKMatcher.scan(s);
    } catch (e) {
      return false;
    }
    for (var i = 0; i < toks.length; i++) {
      var t = String(toks[i].text);
      if (t === w) continue;
      if (t.length >= 2 && /[A-Za-z]/.test(t)) return true;
    }
    return false;
  }

  /**
   * 这一行是不是 ASCII art / 颜文字（`~i.!.|| i !!i !!~`、`( ﾟ∀ﾟ)o彡ﾟ …`）。
   *
   * 案例：图案里的 `i` 被标成 アイ、颜文字 `)o彡ﾟ` 里的 `o` 被标成 オ —— 那些字母
   * 是画用的，不是词。判据故意收得很紧，宁可漏判也不能把正常歌词整行跳过：① 这一行的西文词
   * 全是单个字母（正常歌词里几乎不会这样）；② 符号字符（非字母、非假名、非汉字、非空白）
   * 有 6 个以上。`(A, B)`（符号 3 个）和 `（V, W, A）`（符号 4 个）都不够，那两种照旧注音。
   *
   * 全角标点（`（）：、《》…`）不算符号：它们本来就是日文 / 中文正文里的标点，
   * 而这里的 `line` 常常是"原文 + 中文翻译"拼起来的整行（网易云一个 `<li>` 里两个 `<p>`，
   * 语境取长的那个）——翻译那一行随便几个括号顿号就能凑够 6 个符号，于是
   * `ズ干Cャ` 这种"字母当假名用"的正经歌词被整行当成图案，一个注音都不给
   * （案例里那首歌整页空白，就是这一条吃掉的）。ASCII 那一套（`( ) , . ! ?`）
   * 照旧算符号，所以纯图案行和颜文字行不受影响。
   */
  var JP_PUNCT = /[\u3000\u3001\u3002\uFF01\uFF08\uFF09\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F\u300C\u300D\u300E\u300F\u3010\u3011\u3014\u3015\u300A\u300B\u3008\u3009\uFF3B\uFF3D\uFF5B\uFF5D\u2026\u2025\u30FB\uFF5E\u301C\uFF0D]/;

  function looksLikeAsciiArt(line) {
    var s = String(line == null ? "" : line);
    if (!s || typeof WKMatcher === "undefined") return false;
    var toks;
    try {
      toks = WKMatcher.scan(s);
    } catch (e) {
      return false;
    }
    if (!toks.length) return false;
    for (var i = 0; i < toks.length; i++) {
      // 记号零件（`D/N/A` 的 D）不算"单个字母的词"：那是正经的字母串
      if (toks[i].notation === true) return false;
      if (String(toks[i].text).length !== 1) return false;
    }
    var sym = 0;
    for (var j = 0; j < s.length; j++) {
      var ch = s.charAt(j);
      if (ch === " " || ch === "\t") continue;
      if (/[A-Za-z\u00C0-\u024F\u1E00-\u1EFF\uFF21-\uFF3A\uFF41-\uFF5A]/.test(ch)) continue;
      // 数字也算"正文"（`100V と 5A と 30W の電源` 不能被当成图案）
      if (/[0-9\uFF10-\uFF19]/.test(ch)) continue;
      if (/[\u3041-\u3096\u30A1-\u30FA\u4E00-\u9FFF\u3005\u3006\u30FC]/.test(ch)) continue;
      if (JP_PUNCT.test(ch)) continue;
      sym++;
    }
    return sym >= 6;
  }

  function gluedUpperCase(word, line) {
    var w = String(word == null ? "" : word);
    if (!/^[A-Z]{2,3}$/.test(w)) return false;
    var s = String(line == null ? "" : line);
    if (!s) return false;
    var esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var KANA = "[\\u3041-\\u3096\\u30A1-\\u30FA]";
    return new RegExp("(?:" + KANA + esc + "|" + esc + KANA + ")").test(s);
  }

  /*
   * 日语里通行的那批首字母缩写：紧贴假名时按字母名读。
   *
   * 案例：`対バンにはATフィールド` 的 `AT` 被读成 アット（词典里 at = アット 先命中了），
   * 该读 エーティー（A.T.フィールド）。同类还有 OP 映像 / ED テーマ / CM ソング / BGM…
   *
   * 不写"全大写 2~3 个字母紧贴假名就逐字母读"那种通则，是因为歌词里 `YOU` / `SKY` / `DAY` /
   * `NO` / `GO` / `UP` 也常写成全大写，那几个要按词读，光看拼写分不出来（`AT` 既是英文介词 at、
   * 也是 A.T.）。只有这张人工核过的表才钉成字母名，表外的照旧标成没把握、交给大模型按整句判。
   */
  var GLUED_ACRONYM = {
    at: "\u30A8\u30FC\u30C6\u30A3\u30FC", // エーティー（ATフィールド）
    op: "\u30AA\u30FC\u30D4\u30FC", // オーピー（OP映像）
    ed: "\u30A4\u30FC\u30C7\u30A3\u30FC", // イーディー（EDテーマ）
    cm: "\u30B7\u30FC\u30A8\u30E0", // シーエム
    pv: "\u30D4\u30FC\u30D6\u30A4", // ピーブイ
    mv: "\u30A8\u30E0\u30D6\u30A4", // エムブイ
    se: "\u30A8\u30B9\u30A4\u30FC", // エスイー（効果音）
    bgm: "\u30D3\u30FC\u30B8\u30FC\u30A8\u30E0", // ビージーエム
    iq: "\u30A2\u30A4\u30AD\u30E5\u30FC", // アイキュー
    dj: "\u30C7\u30A3\u30FC\u30B8\u30A7\u30FC", // ディージェー
    mc: "\u30A8\u30E0\u30B7\u30FC", // エムシー
    cg: "\u30B7\u30FC\u30B8\u30FC", // シージー
    ng: "\u30A8\u30CC\u30B8\u30FC", // エヌジー
    ol: "\u30AA\u30FC\u30A8\u30EB", // オーエル
    hp: "\u30A8\u30A4\u30C1\u30D4\u30FC", // エイチピー
    pc: "\u30D4\u30FC\u30B7\u30FC", // ピーシー
    sf: "\u30A8\u30B9\u30A8\u30D5", // エスエフ
  };

  /*
   * 全大写缩写里，日语习惯读法**不是字母名**的那几个。
   *
   * 案例：`LVあげすぎて` 的 `LV` 被逐字母读成 エルブイ —— 日语里 LV 就是 "level"，
   * 读 レベル。这类词按字母名念反而听不懂，所以单独钉一张小表（排在缩写规则前面）。
   */
  var ACRONYM_WORD = {
    lv: "\u30EC\u30D9\u30EB", // レベル
    // 规则：`OMG 情けない` 的 OMG 要展开成 oh my god（不是逐字母 オーエムジー）
    omg: "\u30AA\u30FC\u30DE\u30A4\u30B4\u30C3\u30C9", // オーマイゴッド
  };

  /*
   * 掩码词（`T○itter`）：`○` 是**一个字被涂掉**，整串仍是一个词。
   * 按"一个字母的通配"去词典里找，只有一个候选就按它读（t○itter → twitter →
   * ツイッター）；找不出或不止一个就退回普通读法。
   */
  var maskCache = {};
  /** 被涂掉的那个字的符号（`T○itter` / `UN◯` / `UN〇` / 打码星号 `****ed`）：几种都认 */
  var MASK_CHAR = /[\u25CB\u25CF\u25EF\u3007\u2B55*\uFF0A]/;
  /*
   * 人工核过的**掩码词**（`?` 代表被涂掉的那个字母）：通配查词有时会同时命中好几个
   * 词条（`un?` 能对上 uno / una / une…），这时以这张表为准。
   * 案例 `UN◯♡。`：那个 ◯ 就是 UNO 里的 O，读 ウノ。
   */
  var MASKED_WORD_KANA = {
    "un?": "\u30A6\u30CE", // ウノ
  };
  /*
   * **打码词**（星号盖住的脏话）：按被隐去的原词读 ——
   * `Oh, I'll be ****ed up` 的 `****ed` 读 ファックド（词典里 fucked 就是这么读的）。
   *
   * 为什么不能像 `T○itter` 那样交给通配查词：一个星号顶一个字母，`????ed` 在词典里
   * 有 60 多个候选（agreed / buried / fucked / locked…），谁也不敢猜。所以这张表按
   * 打码的**原样**（星号个数 + 露出来的词尾）钉死；表里没有的照旧留白。
   */
  var CENSORED_WORD_KANA = {
    "****ed": "\u30D5\u30A1\u30C3\u30AF\u30C9", // ファックド
    "****ing": "\u30D5\u30A1\u30C3\u30AD\u30F3\u30B0", // ファッキング
    "****er": "\u30D5\u30A1\u30C3\u30AB\u30FC", // ファッカー
    "****": "\u30D5\u30A1\u30C3\u30AF", // ファック
    "f***": "\u30D5\u30A1\u30C3\u30AF", // ファック
    "f**k": "\u30D5\u30A1\u30C3\u30AF", // ファック
    "s***": "\u30B7\u30C3\u30C8", // シット
    "s**t": "\u30B7\u30C3\u30C8", // シット
    "b***h": "\u30D3\u30C3\u30C1", // ビッチ
    "b**ch": "\u30D3\u30C3\u30C1", // ビッチ
  };
  function maskedReading(word) {
    var raw = String(word == null ? "" : word);
    if (!MASK_CHAR.test(raw)) return null;
    if (maskCache[raw] !== undefined) return maskCache[raw];
    var out = null;
    try {
      var low = raw.toLowerCase();
      // 先查人工核过的掩码词表（`un?` = UN◯ → ウノ）：通配可能命中好几个词条时靠它定案
      var patternKey = low.replace(new RegExp(MASK_CHAR.source, "g"), "?");
      if (MASKED_WORD_KANA[patternKey]) {
        maskCache[raw] = MASKED_WORD_KANA[patternKey];
        return maskCache[raw];
      }
      var dict = typeof WKDict !== "undefined" ? WKDict.words : null;
      if (dict) {
        var src = "";
        for (var ci = 0; ci < low.length; ci++) {
          var ch = low.charAt(ci);
          if (MASK_CHAR.test(ch)) src += "[a-z]";
          else if (ch >= "a" && ch <= "z") src += ch;
        }
        var re = new RegExp("^" + src + "$");
        var hit = null;
        var keys = Object.keys(dict);
        for (var i = 0; i < keys.length; i++) {
          if (!re.test(keys[i])) continue;
          if (hit !== null && hit !== dict[keys[i]]) {
            hit = null; // 不止一个候选：不猜
            break;
          }
          hit = dict[keys[i]];
        }
        out = hit;
      }
    } catch (e) {
      out = null;
    }
    maskCache[raw] = out;
    return out;
  }

  /*
   * 颜文字里的字母读的是**表情的音**，不是字母名 —— `:-b`（吐舌头）读 ボ（规则：
   * 不要长音）。表里没有的字母退回字母名。
   */
  var EMOTICON_LETTER_KANA = {
    b: "\u30DC", // ボ
  };

  /*
   * 连字符**切断**的片段读法（`wa-wa-wait` 的 `wa-`、`ar-ar-ar-ar` 的 `ar-`、
   * `Ni-ni-ni-ni-ni-` 的 `ni-`）：逐条定的读法 —— 这些片段不是在念字母或单词，
   * 是在重复那个音的开头，所以 `wa-` ウェ、`ar-` ア、`ni-` ネ
   * （单独一个 `wa` 还是 ワ、`ar` 还是 アール，只有被连字符切断时才按这张表读）。
   */
  var DASH_FRAGMENT_KANA = {
    wa: "\u30A6\u30A7", // ウェ
    ar: "\u30A2", // ア
    ni: "\u30CD", // ネ
    hy: "\u30A2\u30A4", // アイ（`as thy- hy - hy -` 里那几个 hy-）
  };
  /*
   * 切断片段右边那种"横线"：ASCII 短横线、各种破折号，还有全角减号 `－` 和
   * 片假名长音符 `ー` —— 歌词里这几种混着用（案例里那几条 `wa—wait`、
   * `ar—ar—ar—` 的横线都不是 ASCII 那一版）。
   */
  var DASH_CUT = /^[-\u2010-\u2011\u2013\u2014\u2212\uFF0D\u30FC]$/;

  /*
   * 回声片段（把前一个词的尾音重复一遍的那几个小片段）：
   * `You can't deny, ny ny ny` 里的 `ny` 是 deny 的尾音 → ナイ（逐条定的）。
   */
  var ECHO_FRAGMENT_KANA = {
    ny: "\u30CA\u30A4", // ナイ
  };

  /**
   * 这个词是不是"回声片段"：小写、出现在表里、行里另有一个词以同样的字母结尾，
   * 而且它自己在行里重复了两次以上（`ny ny ny`）。
   */
  function echoFragment(word, line) {
    var w = String(word == null ? "" : word);
    if (!ECHO_FRAGMENT_KANA[w]) return false;
    if (!/^[a-z]{2,3}$/.test(w)) return false; // 大写的是缩写（NY），不走这条
    var s = String(line == null ? "" : line);
    if (!s) return false;
    var times = s.match(new RegExp(w + "(?![A-Za-z])", "g"));
    if (!times || times.length < 2) return false;
    return new RegExp("[A-Za-z]" + w + "(?![A-Za-z])", "i").test(s);
  }

  /*
   * 孤零零一个希腊字母（不在希腊语行上时）：读日语里通行的字母名 / 单位读法。
   *
   * 案例：`無限増幅回路（Ω）` 里的 Ω 是电阻单位，日语读 オーム（不是 オメガ）。大写 Ω 按单位，
   * 小写 ω 保留字母名 オメガ（颜文字里的 ω 由 letters.js 的"装饰符号粘连"挡住，根本不标）。
   * 希腊语行上的单字母是词（`η` 是冠词、`ω` 是感叹词），照旧走希腊语引擎。
   */
  var GREEK_LETTER_KANA = {
    "\u03B1": "\u30A2\u30EB\u30D5\u30A1", "\u03B2": "\u30D9\u30FC\u30BF", "\u03B3": "\u30AC\u30F3\u30DE",
    "\u03B4": "\u30C7\u30EB\u30BF", "\u03B5": "\u30A4\u30D7\u30B7\u30ED\u30F3", "\u03B6": "\u30BC\u30FC\u30BF",
    "\u03B7": "\u30A4\u30FC\u30BF", "\u03B8": "\u30B7\u30FC\u30BF", "\u03B9": "\u30A4\u30AA\u30BF",
    "\u03BA": "\u30AB\u30C3\u30D1", "\u03BB": "\u30E9\u30E0\u30C0", "\u03BC": "\u30DF\u30E5\u30FC",
    "\u03BD": "\u30CB\u30E5\u30FC", "\u03BE": "\u30AF\u30B7\u30FC", "\u03BF": "\u30AA\u30DF\u30AF\u30ED\u30F3",
    "\u03C0": "\u30D1\u30A4", "\u03C1": "\u30ED\u30FC", "\u03C3": "\u30B7\u30B0\u30DE", "\u03C2": "\u30B7\u30B0\u30DE",
    "\u03C4": "\u30BF\u30A6", "\u03C5": "\u30A6\u30D7\u30B7\u30ED\u30F3", "\u03C6": "\u30D5\u30A1\u30A4",
    "\u03C7": "\u30AB\u30A4", "\u03C8": "\u30D7\u30B5\u30A4", "\u03C9": "\u30AA\u30E1\u30AC",
  };

  /**
   * 俄语（西里尔）字母名：全大写缩写的逐字母读法（`СССР` -> エスエスエスエル）。
   *
   * 案例：苏联国歌那几行里的 `СССР` 被读成 スル —— 引擎把它当词，又按俄语正字法把重复的 С
   * 并成一个，于是就剩 С+Р。缩写不是词：西里尔全大写、又没有元音的（СССР / РФ / КГБ / МВД /
   * ЛГБТ…）一律逐字母读，和拉丁那边的 `spellOutAcronym`（SOS -> エスオーエス）同一个口径。
   * 带元音的（`ГИМН` ギムン、`ЛЮБОВЬ`）不是缩写，照旧走俄语引擎。
   */
  var CYRILLIC_LETTER_KANA = {
    "\u0430": "\u30A2\u30FC", // а アー
    "\u0431": "\u30D9\u30FC", // б ベー
    "\u0432": "\u30F4\u30A7\u30FC", // в ヴェー
    "\u0433": "\u30B2\u30FC", // г ゲー
    "\u0434": "\u30C7\u30FC", // д デー
    "\u0435": "\u30A4\u30A7\u30FC", // е イェー
    "\u0451": "\u30E8\u30FC", // ё ヨー
    "\u0436": "\u30B8\u30A7\u30FC", // ж ジェー
    "\u0437": "\u30BC\u30FC", // з ゼー
    "\u0438": "\u30A4\u30FC", // и イー
    "\u0439": "\u30A4\u30FC", // й イー
    "\u043A": "\u30AB\u30FC", // к カー
    "\u043B": "\u30A8\u30EA", // л エリ
    "\u043C": "\u30A8\u30E0", // м エム
    "\u043D": "\u30A8\u30CC", // н エヌ
    "\u043E": "\u30AA\u30FC", // о オー
    "\u043F": "\u30DA\u30FC", // п ペー
    "\u0440": "\u30A8\u30EB", // р エル
    "\u0441": "\u30A8\u30B9", // с エス
    "\u0442": "\u30C6\u30FC", // т テー
    "\u0443": "\u30A6\u30FC", // у ウー
    "\u0444": "\u30A8\u30D5", // ф エフ
    "\u0445": "\u30CF\u30FC", // х ハー
    "\u0446": "\u30C4\u30A7\u30FC", // ц ツェー
    "\u0447": "\u30C1\u30A7\u30FC", // ч チェー
    "\u0448": "\u30B7\u30E3\u30FC", // ш シャー
    "\u0449": "\u30B7\u30C1\u30E3\u30FC", // щ シチャー
    "\u044B": "\u30A6\u30A3", // ы ウィ
    "\u044D": "\u30A8\u30FC", // э エー
    "\u044E": "\u30E6\u30FC", // ю ユー
    "\u044F": "\u30E4\u30FC", // я ヤー
  };

  /** 西里尔全大写、且一个元音都没有的缩写（СССР / РФ / КГБ…） */
  function cyrillicAcronym(word) {
    var w = String(word == null ? "" : word);
    if (!/^[\u0410-\u042F\u0401]{2,6}$/.test(w)) return false;
    return !/[\u0410\u0415\u0401\u0418\u041E\u0423\u042B\u042D\u042E\u042F]/.test(w);
  }

  /*
   * 全大写未知词的**本地兜底读音**：罗马音层读不出来的那几个（`KRO` 这种 kr 连缀），
   * 先按这里给的读法顶着（标成"没把握"，配了 key 时大模型仍然可以改），
   * 表里也没有的就先空着、只交给大模型。
   */
  var UNCERTAIN_FALLBACK = {
    kro: "\u30AF\u30ED", // クロ
  };

  /*
   * 单字母 + **小写假名**：作者拿拉丁字母当假名用（`ズチCゃ` = ズチチャ、`洒ツKゃ` = ツキャ、
   * `ラR ァ` = ラリア）—— 逐条定：C 读チ、K 读キ、R 读リ。所以这种"字母 + 小写假名"
   * 读的是那个音的**辅音那一拍**（チ/キ/リ…），不是字母名。
   */
  var LETTER_CONSONANT_KANA = {
    b: "\u30D3", c: "\u30C1", d: "\u30C7\u30A3", f: "\u30D5", g: "\u30AE", h: "\u30D2", j: "\u30B8",
    k: "\u30AD", l: "\u30EA", m: "\u30DF", n: "\u30CB", p: "\u30D4", q: "\u30AF", r: "\u30EA", s: "\u30B7",
    t: "\u30C6\u30A3", v: "\u30F4", z: "\u30B8",
  };
  /** 小写假名（ゃゅょ / ァィゥェォ 这种，用来跟前面的辅音拼一拍） */
  var SMALL_KANA = /[\u3083\u3085\u3087\u3041\u3043\u3045\u3047\u3049\u30E3\u30E5\u30E7\u30A1\u30A3\u30A5\u30A7\u30A9]/;
  /** 一个假名字（平假名 / 片假名 / 半角片假名） */
  var KANA_CHAR = /[\u3041-\u3096\u30A1-\u30FA\uFF66-\uFF9D]/;

  /*
   * 字母当假名用、但**不是**贴着写时候的默认音：`ラR ア` 的 R 读 **ラ**。
   *
   * 规则：`らLa ラR ア 羅rA 乱` 里那几个字母是在给前面的假名配罗马字
   * （`ラR` = ララ），`R` 不该读字母名 アール。贴着写的那种（`Cゃ` / `Kゃ`）
   * 另走 LETTER_CONSONANT_KANA 读辅音那一拍。
   */
  var LETTER_AS_KANA_DEFAULT = {
    r: "\u30E9", // ラ
    l: "\u30E9", // ラ
  };

  /*
   * 有固定读法的**记号**（点号写的词）：`p.h.` = 化学的 pH，日语读 ペーハー
   * （案例 `p.h.って、胃酸を`，官方翻译那行写着"靠着 p.h."）。
   * 标记见 letters.js 的 notationWord。
   */
  var NOTATION_WORD_KANA = {
    ph: "\u30DA\u30FC\u30CF\u30FC", // ペーハー
  };

  /*
   * 两个字母的**英文/缩写**常用词：它们在词典里有确定读音（`no` ノー、`me` ミー…），
   * 别被"全大写不确定 → 交给大模型"那条抢走（那条是给 `KRO` / `NE` 这种
   * "可能是日语罗马字"的词准备的）。
   */
  var EN_TWO_LETTER = {
    am: 1, an: 1, as: 1, at: 1, be: 1, by: 1, do: 1, go: 1, he: 1, hi: 1, if: 1, in: 1, is: 1, it: 1,
    me: 1, my: 1, no: 1, of: 1, oh: 1, ok: 1, on: 1, or: 1, so: 1, to: 1, up: 1, us: 1, we: 1, ye: 1,
    ah: 1, uh: 1, id: 1, tv: 1, cd: 1, dj: 1, mc: 1, pc: 1, pm: 1, se: 1, mv: 1, pv: 1, bg: 1,
  };

  /**
   * 整首 / 整句专属读音：这首歌（或这一句歌词）里的这个词就这么读。两个作用域，都是
   * 人工核过、不许别的层改的读音。
   *
   * 1. 整首（`SONG_READINGS`，按这一首歌名做）：按歌名（播放栏那行）或者整首
   *    歌词里的识别词命中，命中后这首歌里的这些词一律按表读。例：`夢現妄想世界`
   *    （夢限大みゅーたいぷ）把日语词写成罗马字，短横线是长音 —— `MO-SO` モーソー（妄想）、
   *    `SO-ZO` ソーゾー（創造）、`KYO-SO` キョーソー（競争）、`YUME` ユメ（夢）。
   *    没有这张表时 `ZO` 走罗马音层读成 ゾ、`KYO` 读成 キョ（那个 ZO 还被换行拆到了下一行，
   *    模型也只看得到 `ZOは海をこえ`）。
   *
   * 2. 整句（`LINE_READINGS`）：只有这一句歌词里的这个词这么读。规则：
   *    `Xだけの"人マニア"` 的 X 指的是 Twitter（那首歌官方翻译那行写着 `X(Twitter)`），
   *    要读 ツイッター；但"日语行里孤零零一个 X 一律读 Twitter"太宽了，只在这一句歌词命中，
   *    别处的 X 该是字母名（`X線` エックス線）或者留白。
   *
   * 两处都按"词 + 形状"配对，命中才换读音；返回的读音带自己的来源名 `song`，层序里它排在
   * 所有层前面（`layerRank("song")` 是 -1，在线层不会被咨询）。
   */
  var SONG_READINGS = (typeof WKSongs !== "undefined" && WKSongs.list) || [];

  var LINE_READINGS = [{ word: "X", line: /X\s*だけの/, kana: "\u30C4\u30A4\u30C3\u30BF\u30FC" }];

  /** 这一句里有没有为这个词指定的专属读音（见 LINE_READINGS） */
  function lineReading(word, line) {
    var w = String(word == null ? "" : word);
    var s = String(line == null ? "" : line);
    if (!s) return null;
    for (var i = 0; i < LINE_READINGS.length; i++) {
      if (LINE_READINGS[i].word !== w) continue;
      if (LINE_READINGS[i].line.test(s)) return LINE_READINGS[i].kana;
    }
    return null;
  }

  /** 歌名或整首歌词命中哪一条整首专属读音（都没有返回 null） */
  function matchSongReading(title, lyrics) {
    var t = String(title == null ? "" : title);
    var l = String(lyrics == null ? "" : lyrics);
    for (var i = 0; i < SONG_READINGS.length; i++) {
      var e = SONG_READINGS[i];
      if (e.title && t && e.title.test(t)) return e.words;
      if (e.marker && l && e.marker.test(l)) return e.words;
    }
    return null;
  }

  /**
   * 连字符标记长音：由短横线串起来的全大写罗马字音节（`MO-SO` / `KYO-SO` / `SO-ZO`）每一节
   * 都读长音 —— 规则（「夢現妄想世界」里 `MO-SO` モーソー、`SO-ZO` ソーゾー、
   * `KYO-SO` キョーソー）。
   *
   * 约束是宁可漏不可错：只认全大写、形如罗马字音节的词（1~2 个辅音字母 + 一个元音，共
   * 2~3 个字母），德语复合词（`Looser-Krankheit-Was`）、小写词（`mo-so`）、记号里的单字母
   * （`X-Y`，那是逐字母读的另一档）都不吃这条；短横线必须紧贴前一个词（`MO-SO` 算，
   * `MO - SO` 不算）；至少两节（孤零零一个 `MO-` 不算）。
   *
   * 扫描范围是整首歌词（拼成一段看），因为这种词常被歌词换行拆开（上一行结尾 `SO-`、
   * 下一行开头 `ZOは海をこえ`），只看一行判不出来。
   */
  var RE_LONG_SYL = /^[A-Z]{1,2}[AIUEO]$/;
  var RE_HYPHEN_HEAD = /^[-\u2010-\u2015]/;

  function collectLongVowelWords(text) {
    var out = {};
    var s = String(text == null ? "" : text);
    if (!s) return out;
    // 交替取出「词」「词后面的间隔」
    var re = /([A-Za-z]+)([^A-Za-z]*)/g;
    var words = [];
    var gaps = [];
    var m;
    while ((m = re.exec(s))) {
      words.push(m[1]);
      gaps.push(m[2]);
    }
    for (var i = 0; i < words.length; i++) {
      if (!RE_LONG_SYL.test(words[i]) || !RE_HYPHEN_HEAD.test(gaps[i] || "")) continue;
      // 从这一节往后把整串收完（A-B-C 三节都要）
      var run = [words[i]];
      var j = i;
      while (j + 1 < words.length && RE_HYPHEN_HEAD.test(gaps[j] || "") && RE_LONG_SYL.test(words[j + 1])) {
        run.push(words[j + 1]);
        j++;
      }
      if (run.length < 2) continue;
      for (var k = 0; k < run.length; k++) out[run[k]] = true;
      i = j;
    }
    return out;
  }

  /** 这个词是不是"连字符串"里的一节（见 collectLongVowelWords） */
  function isLongVowelWord(word) {
    var w = String(word == null ? "" : word);
    return own(state.longWords, w);
  }

  /**
   * 连字符标记长音：常规读出来的尾拍补上 ー（已经有长音符就不动）。
   *
   * 补出来之后**标成确定**：这是定下来的规则（`ZO` ゾー、`KYO` キョー），
   * 不能让模型按句语境改回去 —— 案例里那两个音就是被模型的 ズ / キョ 盖掉的。
   */
  function withLongVowel(word, r) {
    if (!r || !r.kana || !isLongVowelWord(word)) return r;
    if (/\u30FC$/.test(r.kana)) return { kana: r.kana, source: r.source, confident: true };
    return { kana: r.kana + "\u30FC", source: r.source, confident: true };
  }

  /**
   * 这一轮扫描时"整首专属读音"表是哪一张（换歌要重新算）。
   *
   * 歌名取播放栏那行（复用注音层认的那套选择器，见 annotate.js 的 TARGET_SELECTORS）；
   * 拿不到歌名就只靠歌词里的识别词。结果按"歌名 + 歌词开头"缓存，避免每轮都重算。
   * 顺带把「连字符串」（见 collectLongVowelWords）也算出来 —— 同一趟扫描、同一份歌词。
   */
  function updateSongScope() {
    if (!state.annotator) return;
    var title = "";
    var lyrics = "";
    try {
      var ts = state.annotator.findRegions("titles");
      if (ts && ts.length) title = regionText(ts[0]);
    } catch (e) {
      title = "";
    }
    try {
      var ls = state.annotator.findRegions("lyrics");
      var buf = [];
      for (var i = 0; i < (ls ? ls.length : 0); i++) buf.push(regionText(ls[i]));
      lyrics = buf.join("\n");
    } catch (e2) {
      lyrics = "";
    }
    var key = title + "\u0000" + lyrics.slice(0, 4000);
    if (songScopeCache.key === key) return;
    songScopeCache = { key: key, words: matchSongReading(title, lyrics), longWords: collectLongVowelWords(lyrics) };
    state.songWords = songScopeCache.words;
    state.longWords = songScopeCache.longWords;
  }

  /**
   * 这一行里有没有"成串的大写单字母"（`(A, B)`、`A・B`、`A B C`）。
   *
   * 规则：`(A, B) 退屈に打つ QTE (Why?)` 里的 A / B 该读字母名（エー / ビー），而英文行里
   * 当冠词的 A 该读 ア。只看"单个大写字母"分不出来，得看整行，但判据不能用"这行有两个单字母"：
   * `A story of love and I` 也有两个（冠词 A 和代词 I），那样 A 就被读成 エー 了。所以只认两种
   * 形状：被标点串起来的（A, B）、A・B、A&B；还有三个以上孤立的 A B C。
   */
  function lineLetterRun(line) {
    var s = String(line == null ? "" : line);
    if (!s) return false;
    if (/[A-Z]\s*[,.\u3001\u30FB\u00B7\u2022\/&|]\s*[A-Z]/.test(s)) return true;
    if (typeof WKMatcher === "undefined") return false;
    var toks;
    try {
      toks = WKMatcher.scan(s);
    } catch (e) {
      return false;
    }
    /*
     * 记号（`D/N/A`、`M・I・D・I`、`X-Y`）在 matcher 里已经拆成了一个字母一个词
     * （分别注在每个字母上），所以这里数的是"记号零件"：有两个就说明
     * 这一行是逐字母读的。剩下的那种（`A B C` 三个以上孤立的）照旧数非粘连的单字母。
     */
    var nota = 0;
    var iso = 0;
    for (var i = 0; i < toks.length; i++) {
      if (toks[i].notation === true) nota++;
      else if (/^[A-Z]$/.test(toks[i].text) && toks[i].glued !== true) iso++;
      if (nota >= 2 || iso >= 3) return true;
    }
    return false;
  }

  /**
   * 像打码的重复字母串：后面紧挨着平假名（`“XX”してる`、`XXの…`、`XXする`）。
   *
   * `YY` 要标、而"打码的 XX 还是留白更好"，两者拼写一模一样（都是全大写 2~3 个
   * 重复字母），本地只能看用法：打码词是当句子里一个词用的，后面必然跟着日语词尾 / 助词
   * （してる・の・する…），缩写是独立写的（`「YY」`、`YY!`、`YY と`）。所以判据就是"后面紧挨着
   * 的一个字符是不是平假名"。两可的极端情况宁可留白：留白只是少一个注音，标错是错的读音。
   */
  function censorLikeRun(word, line) {
    var w = String(word == null ? "" : word);
    if (!/^([BCDFGHJKLMNPQRSTVWXYZ])\1{1,2}$/.test(w)) return false;
    var s = String(line == null ? "" : line);
    if (!s) return false;
    var esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 中间允许夹一个收尾的引号/括号（`“XX”してる`、`（XX）する`）
    var tail = "[\u2019\u201D\u300D\u300F\uFF09\u3011\"']*[\u3041-\u3096]";
    if (new RegExp(esc + tail).test(s)) return true;
    /*
     * 旁边就是打码符号的也算打码（案例 `俺の XXX ! !`）：
     * `XXX` 后面隔一个空格就是 `****`，那一串和 `****` 是同一个用法（把脏话抹掉），
     * 读成 エックスエックスエックス 反而错 —— 要留白。
     * 判据：这个词后面（可夹空白/引号括号）紧跟两个以上的 `*` / `＊` / `×` / `※`，
     * 或者前面紧挨着这种符号串（`XXX`）。
     */
    var marks = "[*\uFF0A\u00D7\u203B]{2,}";
    var between = "[\\s\u2019\u201D\u300D\u300F\uFF09\u3011\"']*";
    if (new RegExp(esc + between + marks).test(s)) return true;
    return new RegExp(marks + between + esc).test(s);
  }

  /**
   * 紧挨在打码符号后面的词（`ed` 里的 `ed`、`*ing` 里的 `ing`）：
   * 那是被隐去的词的一部分，单个片段没有意义 —— 不标。
   * 案例：`Oh, I'll be ed up` 里只有 `ed` 头上有 エド。
   *
   * 两个以上才算打码：单个 `*` / `※` 是脚注或演奏提示，后面往往是一个完整的词
   * （案例 `(*teto sax solo)` —— `teto` 被当成 `ed` 的碎片跳过了，
   * 那一行里 `sax` / `solo` 都标了、就它空着）。
   */
  function censoredBefore(word, line) {
    var w = String(word == null ? "" : word);
    var s = String(line == null ? "" : line);
    if (!w || !s) return false;
    var esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("[*\uFF0A\u00D7\u203B]{2,}\u200B*" + esc + "(?![A-Za-z])").test(s);
  }

  /**
   * 单个大写字母的段标（`(A:` / `B:` / `A：`）：不注音。
   *
   * 案例：拉丁语歌词里的 `Vindicia (A: Vanitatum sentio) (B: Sentio dolor, …)`
   * —— 这里的 A / B 是分句、分段的标记，既不是字母名也不是单词。判据只看
   * "这个字母后面紧跟冒号"，所以 `(A, B)` 那种成串的照样读字母名（当初就是那样定的），
   * 就是那个），英文行里的冠词 A 也不受影响。
   */
  function labelLetter(word, line, token) {
    var w = String(word == null ? "" : word);
    if (!/^[A-Z]$/.test(w)) return false;
    /*
     * 注音层把 token 一起传进来时，按 token 的 `label` 标记判（位置准）：
     * `M: 匿名Mです。` 里行首那个 `M:` 是说话人标记（留白），而 `匿名M` 的 M 要读 エム ——
     * 只看"这一行里有没有 `M:`"会把两个都留白（案例）。
     */
    if (token) return token.label === true;
    var s = String(line == null ? "" : line);
    if (!s) return false;
    var esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 控制台调用（没有 token）时退回老判据：这一行里有"这个字母 + 冒号"
    return new RegExp(esc + "\\s*[:：]").test(s);
  }

  /** 这段文字里有没有"后面紧跟日语词尾"的重复字母串（打码）—— 给排障用 */
  function looksCensoredRun(text) {
    var s = String(text == null ? "" : text);
    var runs = s.match(/[A-Za-z]{2,3}/g);
    if (!runs) return false;
    for (var i = 0; i < runs.length; i++) {
      if (!/^([A-Za-z])\1+$/.test(runs[i])) continue;
      if (censorLikeRun(runs[i], s)) return true;
    }
    return false;
  }

  /**
   * 全角西文字母折成半角（`ＮＯ` -> `NO`、`ｄｒｅａｍ` -> `dream`）。
   *
   * 案例：`こんなんじゃ（ＮＯ!）` 里的 `ＮＯ` 是全角的（歌词排版常这么写），
   * 而 matcher 之前只认半角字母，于是整个词压根没被当成词，一个注音都没有。
   * 折的是判断用的副本 —— 注音层写回 DOM 的底字用的是 token.text（原文），
   * 所以页面上一个字符都不会变。
   */
  function foldFullwidthLetters(s) {
    return String(s == null ? "" : s).replace(/[\uFF21-\uFF3A\uFF41-\uFF5A]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    });
  }

  /** 全字母逐个读成字母名（`AM` -> エーエム）；表里没的字母返回 null */
  function letterNames(word) {
    if (typeof WKReading === "undefined" || !WKReading.LETTER_KANA) return null;
    var s = String(word == null ? "" : word).toLowerCase();
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var k = WKReading.LETTER_KANA[s.charAt(i)];
      if (!k) return null;
      out += k;
    }
    return out || null;
  }

  /**
   * 全大写拉丁缩写紧贴数字（`AM6:00` / `PM11:30` / `AC30` / `MP3`）：型号、时刻那种写法。
   *
   * 案例：`AM6:00 目覚まし時計を起こして` 里的 `AM` 被离线词典的英语单词 `am`
   * （アム）接走了 —— 词典键都是小写，分不清 `am` 和 `AM`。这一判排在词典那一层
   * 前面：全大写又贴着数字的，是缩写不是词。
   *
   * 位置用 token 的（分词时算好的，最准）；没有 token 的调用方退回在行里找。
   */
  function capsBeforeDigit(word, line, token) {
    var w = String(word == null ? "" : word);
    if (!/^[A-Z]{2,6}$/.test(w)) return false;
    /*
     * 别误伤全大写写的真词：`LOVE2` / `HEY3` 这种是歌词在喊词，不是缩写
     * （逐字母念成 エルオーブイイー 就毁了）。判据：3 个字母以上、带元音、
     * 而且词典或英文常用词表里有它 —— 那就不算缩写。
     * `AM` / `PM` 只有两个字母，恰好是"同一个拼写的词"里最常见的例外
     * （`am` 是英语动词、`pm` 不是词），贴着数字时读字母名。
     */
    if (w.length > 2 && /[AEIOUY]/.test(w)) {
      var low = w.toLowerCase();
      var dict = typeof WKDict !== "undefined" ? WKDict.words : null;
      var enWords = typeof WKEnWords !== "undefined" ? WKEnWords.words : null;
      if (own(dict, low) || own(enWords, low)) return false;
    }
    var s = String(line == null ? "" : line);
    if (!s) return false;
    if (token && typeof token.end === "number" && typeof token.start === "number" && s.slice(token.start, token.end) === w) {
      return /[0-9]/.test(s.charAt(token.end));
    }
    return new RegExp("(^|[^A-Za-z])" + w + "(?=[0-9])").test(s);
  }

  function localReading(word, line, token) {
    /*
     * 全角字母先折半角（见 foldFullwidthLetters）：词和它所在的那一行都折，
     * 后面查词典 / 沉淀 / 模型 / 语种判定 / 打码与段标那几判就都按折过的看。
     */
    word = foldFullwidthLetters(word);
    if (line != null) line = foldFullwidthLetters(line);
    /*
     * 整行只有一个全大写词（`MWAH!` / `LOVE`）：这不是缩写，是喊出来的一个词，照常读。
     * 不特判的话它会落进"全大写 = 缩写"那条兜底里，然后被判成读不出来（留白）。
     */
    var bareLine = String(line == null ? "" : line).replace(/[\s!！?？.,、。~〜\-—]+/g, "");
    if (/^[A-Z]{2,}$/.test(word) && bareLine === word) {
      var soloRead = state.reader ? state.reader.read(word) : null;
      if (soloRead && soloRead.kana) {
        return { kana: soloRead.kana, source: soloRead.source || "rule", confident: true };
      }
    }
    /*
     * 数字后面的单位词（`300mm` ミリ、`5kg` キロ、`60Hz` ヘルツ）。
     *
     * 必须排在打码那几判前面：`mm` 长得就像打码用的重复字母串（`XX`），
     * 而它后面又紧跟着假名（`300mmの体で`）—— 放到后面就会被当成打码留白
     * （第一版就是这么错的）。案例：`半径300mmの体で` 的 `mm` 原来没注音，
     * 那首歌的罗马音行唱的就是 `sa n bya ku mi ri`（ミリ）。
     */
    var unitKey = String(word).toUpperCase();
    var unitWord = own(UNIT_WORD, unitKey) ? UNIT_WORD[unitKey] : null;
    if (unitWord && digitBefore(word, line)) {
      return { kana: unitWord, source: "letters", confident: true };
    }
    /*
     * 段标（`(A:` / `B:`）排在所有层前面：它压根不该有读音，
     * 缓存里有没有都不该有 —— 机器上就攒过 `a → アー`（模型在 `(A:` 那种行里
     * 答的），那条「学会的词」会把这条规则整个绕过去。所以这一判最先做。
     */
    if (labelLetter(word, line, token)) return null;
    /*
     * 紧跟在打码符号后面的片段（`ed` 里的 ed）：不标。
     */
    if (censoredBefore(word, line)) return null;
    /*
     * 像打码的重复字母串（后面紧跟着假名，`“XX”してる`）：留白。
     * 缩写成串的（`「YY」` 这种独立的）继续往下走，按字母名读成 ワイワイ。
     */
    if (censorLikeRun(word, line)) return null;
    /*
     * ASCII art / 颜文字 行（`~i.!.|| i !!i !!~`、`( ﾟ∀ﾟ)o彡ﾟ …`）：整行不标 ——
     * 那些字母是画图案用的（见 looksLikeAsciiArt 的说明）。
     */
    if (line && looksLikeAsciiArt(line)) return null;
    /*
     * 整首专属读音（见 SONG_READINGS）：这首歌里这个词就这么读。
     * 排在所有层前面 —— 它是人工核过的（`夢現妄想世界` 的 `ZO` 是 ゾー、
     * `KYO` 是 キョー），连大模型也不该改（来源 `song` 的层序是 -1，在线层不被咨询）。
     */
    if (state.songWords) {
      var songKey = String(word == null ? "" : word).toLowerCase();
      var songKana = own(state.songWords, songKey) ? state.songWords[songKey] : null;
      if (songKana) return { kana: songKana, source: "song", confident: true };
    }
    /*
     * 大写单字母：成串的读字母名（`(A, B)` -> エー / ビー），段标（`A:` / `B:`）留白，
     * 孤零零一个的照旧 —— `A` 是冠词（ア）、`I` 是代词（アイ），
     * 别的（`B`、`C`…）没法判，还是留白（返回 null 表示"这词不标"）。
     */
    /*
     * 颜文字里的那个单字母（`:-b ;-b boy, :-b ;-b` 的 b）：要标，
     * 而且读的是**表情的音**（`b` → ボー），不是字母名 ビー —— 所以先查这张小表。
     * 只在"这一行还有别的西文词"时标（那种行是歌词，不是纯颜文字行）。
     */
    if (
      token &&
      token.emoticon === true &&
      /^[A-Za-z]$/.test(String(word == null ? "" : word)) &&
      line &&
      lineHasOtherWord(word, line)
    ) {
      var emoLow = String(word).toLowerCase();
      var emoKana =
        (own(EMOTICON_LETTER_KANA, emoLow) ? EMOTICON_LETTER_KANA[emoLow] : null) ||
        (typeof WKReading !== "undefined" && WKReading.LETTER_KANA ? WKReading.LETTER_KANA[emoLow] : null);
      if (emoKana) return { kana: emoKana, source: "letters", confident: true };
    }
    /*
     * 字母当假名用：`ズチCゃ` 的 C（读 チ）、`洒ツKゃ` 的 K（读 キ）、`ラR ア` 的 R（读 ラ）
     * —— 混排歌词里作者是拿拉丁字母给前面的假名配罗马字，不是在写英文单词。
     *
     * 两条判据：
     *   ① 字母后面（可以夹空格）紧跟一个小写假名（ゃゅょ / ァィゥェォ）：
     *      贴着的读辅音那一拍（`Cゃ` → チ），隔了空格的读默认音（`R ァ` → ラ）；
     *   ② 字母夹在两个假名中间（`ラR ア`）：同样是当假名用，读默认音。
     *      ② 只在"这一行还另有西文词"且字母至少一侧挨着空格时才认 —— 免得把
     *      `タイプRの車` 这种正常的型号写法读成 ラ。
     */
    if (/^[A-Za-z]$/.test(String(word == null ? "" : word)) && token) {
      var lowLetter = String(word).toLowerCase();
      var around = letterAround(line, token);
      if (around.after && SMALL_KANA.test(around.after)) {
        var kanaForLetter = around.afterSpaced ? LETTER_AS_KANA_DEFAULT[lowLetter] : LETTER_CONSONANT_KANA[lowLetter];
        if (kanaForLetter) return { kana: kanaForLetter, source: "letters", confident: true };
      }
      if (
        around.before &&
        around.after &&
        (around.afterSpaced || around.beforeSpaced) &&
        KANA_CHAR.test(around.before) &&
        KANA_CHAR.test(around.after) &&
        lineHasOtherWord(word, line)
      ) {
        var defaultKana = LETTER_AS_KANA_DEFAULT[lowLetter];
        if (defaultKana) return { kana: defaultKana, source: "letters", confident: true };
      }
    }
    /*
     * 小写单字母 `a` 紧贴日文（`aとaが混ざり合って、`）：那是**字母 A 的名字**，
     * 这里读 エイ —— 不是英文冠词的 ア，也不是字母名表里的 エー。
     */
    if (String(word) === "a" && line && gluedToJapanese(word, line, token)) {
      return { kana: "\u30A8\u30A4", source: "letters", confident: true };
    }
    if (/^[A-Z]$/.test(String(word == null ? "" : word))) {
      /*
       * 呼语 `O`（`O Chrysalis` / `O love`）读 オー。
       *
       * 要标上：歌词里这个 O 是"哦 / 啊"那种呼唤语气（拉丁语、英语、
       * 意大利语都这么写），不是排版噪声；字母名本来也就是 オー，两回事一样的结果。
       */
      if (String(word) === "O") return { kana: "オー", source: "letters", confident: true };
      /*
       * 字母紧跟数字就是单位：`30W` ワット、`100V` ボルト、`5A` アンペア。
       * 案例：`VOX AC30W` 里的 `W` 原来一个注音都没有（孤零零一个单字母，
       * 整行又不算"字母串"，就留白了）。
       */
      if (own(UNIT_SYMBOL, String(word)) && digitBefore(word, line)) {
        return { kana: UNIT_SYMBOL[String(word)], source: "letters", confident: true };
      }
      if (line && lineLetterRun(line)) {
        /*
         * 整串字母都是单位符号（`（V, W, A）`）→ 读单位名（ボルト・ワット・アンペア）。
         * 要这个；`(A, B)` 那种（串里有非单位字母）仍旧读字母名。
         */
        if (own(UNIT_SYMBOL, String(word)) && lineAllUnitSymbols(line)) {
          return { kana: UNIT_SYMBOL[String(word)], source: "letters", confident: true };
        }
        var letterKana =
          typeof WKReading !== "undefined" && WKReading.LETTER_KANA ? WKReading.LETTER_KANA[String(word).toLowerCase()] : null;
        if (letterKana) return { kana: letterKana, source: "letters", confident: true };
      }
      /*
       * 整句专属读音：只有 `Xだけの"人マニア"` 那一句里的 X 读 ツイッター
       * （见 LINE_READINGS）。位置卡在中间：成串的 `(X, Y)` 上面那条已经接走了，
       * 别处的 X（`X線` エックス線、英文句子里的 `X marks the spot`）一律不受影响。
       */
      var lineFix = lineReading(word, line);
      if (lineFix) return { kana: lineFix, source: "dict", confident: true };
      /*
       * 孤零零一个单字母（不成串）时，还有两种看得出"这里要读字母名"的情况：
       *   ① 紧贴日文：`T氏` / `B面` / `X線` —— 日语就是读字母名（ティーし）；
       *   ② 同一行还有别的英文词：`T Is My Everything` / `I love U` ——
       *      那是句子里的字母，不是冠词。
       * 案例：`T氏にすべてを捧げましょう` 和 `T Is My Everything` 里的 T
       * 一个注音都没有。`A` / `I` 在 ② 里仍旧按冠词 / 代词读（`A story` 的 A 是 ア）。
       */
      /*
       * 外语行里不套"字母名"：西班牙语的 `Y me cansé` 里那个 Y 是连词（读 イ），
       * 不是字母 Y（ワイ）。这一行的语种已经认出来了，交给引擎按那门语言读。
       */
      var loneLineLang = line ? lineLang(line) : null;
      if (
        line &&
        !loneLineLang &&
        (gluedToJapanese(word, line, token) ||
          (String(word) !== "A" && String(word) !== "I" && lineHasOtherWord(word, line)))
      ) {
        var loneKana =
          typeof WKReading !== "undefined" && WKReading.LETTER_KANA ? WKReading.LETTER_KANA[String(word).toLowerCase()] : null;
        if (loneKana) return { kana: loneKana, source: "letters", confident: true };
      }
      /*
       * ③ 紧挨着数字：`B4` ビー / `A4` エー / `2B` ビー —— 型号、规格里的字母。
       * 案例 `B4の紙切れに収まる僕の人生を` 的 `B` 原来一个注音都没有。
       * 单位符号挨着数字的走上面那条（`30W` 是 ワット，不是 ダブリュー）。
       */
      if (line && digitAdjacent(word, line)) {
        var numKana =
          typeof WKReading !== "undefined" && WKReading.LETTER_KANA ? WKReading.LETTER_KANA[String(word).toLowerCase()] : null;
        if (numKana) return { kana: numKana, source: "letters", confident: true };
      }
      /*
       * 外语行里别在这里收口：西班牙语的 `Y` 是连词（イ），法语 / 德语的单字母
       * 也可能有词义。语种认出来了就往下走，让那一层的引擎读；没认出来才留白。
       */
      if (String(word) !== "A" && String(word) !== "I" && !loneLineLang) return null;
    }
    /*
     * 记号里的 `&`（`R&B` / `A&B`）：读 アンド。它是唯一有读音的分隔符，
     * 记号拆成一个字母一个词之后 `&` 自己也成了一个词（见 letters.js），
     * 不认它就会在 R 和 B 之间空一格。孤零零的 `&`（`you & me`）不是记号零件、
     * 扫描时根本不会成词，所以不受影响。
     */
    if (String(word) === "&") return { kana: "アンド", source: "letters", confident: true };
    /*
     * 紧贴假名的全大写缩写（`ATフィールド` / `OP映像`）：人工核过的那批按字母名读。
     * 表外的照旧走下面的"标成没把握"那条，交给大模型按整句判 ——
     * `YOU` / `SKY` / `DAY` / `NO` 这些也常写成全大写，那几个要按词读（见 GLUED_ACRONYM 的说明）。
     */
    if (gluedUpperCase(word, line)) {
      var acr = own(GLUED_ACRONYM, String(word).toLowerCase()) ? GLUED_ACRONYM[String(word).toLowerCase()] : null;
      if (acr) return { kana: acr, source: "letters", confident: true };
    }
    /*
     * 孤零零一个希腊字母（不在希腊语行上）：读字母名 —— Ω 按日语习惯读 オーム
     * （电阻单位），小写 ω 读 オメガ（见 GREEK_LETTER_KANA 的说明）。
     *
     * "在不在希腊语行上"不能只看 lineLang：`無限増幅回路（Ω）` 这种纯汉字行
     * 一个假名都没有，detect 会判成希腊语（因为有 Ω），于是 Ω 被希腊引擎读成 オ。
     * 那一行里希腊字母总共就一个，显然不是一句希腊语 —— 整行只有一个希腊字母时，
     * 一律按字母名 / 单位读。
     */
    var rawLetter = String(word == null ? "" : word);
    if (rawLetter.length === 1 && /[\u0370-\u03FF\u1F00-\u1FFF]/.test(rawLetter)) {
      var letterLang = line ? lineLang(line) : null;
      var greekCount = line ? (String(line).match(/[\u0370-\u03FF\u1F00-\u1FFF]/g) || []).length : 1;
      if (letterLang !== "el" || greekCount <= 1) {
        if (rawLetter === "\u03A9" || rawLetter === "\u2126") return { kana: "オーム", source: "letters", confident: true };
        var greekName = GREEK_LETTER_KANA[rawLetter.toLowerCase()];
        if (greekName) return { kana: greekName, source: "letters", confident: true };
      }
    }
    /*
     * 全大写缩写紧贴数字（`AM6:00` / `PM11:30` / `AC30`）：按字母名逐字读（エーエム）。
     * 必须排在词典那一层前面 —— 词典键是小写，`AM` 会被当成英语单词 `am`（アム）。
     * 案例：`AM6:00 目覚まし時計を起こして` 的 AM 就是这么被读成 アム 的。
     */
    if (capsBeforeDigit(word, line, token)) {
      var capsKana = letterNames(word);
      if (capsKana) return { kana: capsKana, source: "letters", confident: true };
    }
    /*
     * 缩写里那几个"日语读法不是字母名"的（`LV` レベル）：排在缩写/字母名前。
     * 大小写都收 —— 歌词里 `LV` / `lv` 都是 level。
     */
    var acronymWord = own(ACRONYM_WORD, String(word == null ? "" : word).toLowerCase())
      ? ACRONYM_WORD[String(word == null ? "" : word).toLowerCase()]
      : null;
    if (acronymWord) return { kana: acronymWord, source: "dict", confident: true };
    // 打码词（`****ed` → ファックド，按被隐去的原词读）与掩码词（`T○itter` → ツイッター）
    var censoredKana = own(CENSORED_WORD_KANA, String(word == null ? "" : word).toLowerCase())
      ? CENSORED_WORD_KANA[String(word == null ? "" : word).toLowerCase()]
      : null;
    var maskedKana = censoredKana || maskedReading(word);
    if (maskedKana) return { kana: maskedKana, source: "dict", confident: true };
    /*
     * 西里尔全大写缩写逐字母读（`СССР` エスエスエスエル）—— 见 CYRILLIC_LETTER_KANA。
     * 排在俄语引擎前面：引擎会按正字法把 `СССР` 的三个 С 并成一个，读成 スル。
     * 单个西里尔字母也走这条（案例 `Я らりぱっぱ…` 里的 Я 一个注音都没有）——
     * 那不是俄语行（行里有假名），按字母名读 ヤー。
     */
    if (cyrillicAcronym(word) || (/^[\u0400-\u04FF]$/.test(String(word == null ? "" : word)) && !(line && lineLang(line) === "ru"))) {
      var cyr = "";
      var cw = String(word).toLowerCase();
      for (var ci = 0; ci < cw.length; ci++) {
        var ck = CYRILLIC_LETTER_KANA[cw.charAt(ci)];
        if (!ck) {
          cyr = null;
          break;
        }
        cyr += ck;
      }
      if (cyr) return { kana: cyr, source: "letters", confident: true };
    }
    /*
     * 被连字符**切断**的片段（`wa-` ウェ / `ar-` ア / `ni-` ネ / `hy-` アイ）：
     * 逐条定的读法。判据是"这个短片段后面（可以夹空格）紧跟着连字符"，
     * 也就是它没写完 —— `hy - hy - hy -` 那种带空格的写法也认。
     *
     * 邻字优先取注音层从 DOM 上现取的（token.after）—— 逐字歌词 / 别的插件拆行时，
     * "整行文本 + 偏移量"对不上（relabel 时更是只有 DOM），那样片段规则会整个落空，
     * 于是 `ar-` 掉回字母名 アール、`wa-` 掉回 ワ、`ni-` 掉回 ニ —— 案例里
     * 那一批就是"注音那一刻是对的，在线答案一回来就变回去"。
     */
    if (token && /^[A-Za-z]{1,3}$/.test(String(word == null ? "" : word))) {
      var afterCh = typeof token.after === "string" ? token.after : "";
      if (!afterCh && line && typeof token.end === "number") {
        afterCh = (String(line).slice(token.end).match(/^\s*([\s\S])/) || ["", ""])[1];
      }
      var cutOff = token.chain === true || DASH_CUT.test(afterCh);
      if (cutOff) {
        var fragLow = String(word).toLowerCase();
        var fragKana = own(DASH_FRAGMENT_KANA, fragLow) ? DASH_FRAGMENT_KANA[fragLow] : null;
        if (fragKana) return { kana: fragKana, source: "dict", confident: true };
      }
    }
    /*
     * 回声片段（`You can't deny, ny ny ny`）：小写片段把**前一个词的尾巴**重复一遍。
     * `ny` 读 ナイ（不是词典里的 NY = ニューヨーク）—— 那三个 ny 是 deny 的
     * 尾音重复，官方中文那行写的就是"你不能抗拒 抗拒"。
     *
     * 判据三条：这个词在表里、行里有个词以同样的字母结尾（deny）、而且它在行里出现了
     * 两次以上（重复片段）。表外的碎片一律不动，免得把正常的短词读歪。
     */
    if (own(ECHO_FRAGMENT_KANA, String(word == null ? "" : word))) {
      if (echoFragment(word, line)) return { kana: ECHO_FRAGMENT_KANA[String(word)], source: "dict", confident: true };
    }
    /*
     * 连字符串里的一段（`Ex-Otogibanashi`、`Looser-Krankheit-Was`）：
     *   ① 罗马音层切得干净就按罗马字读 —— `Ex-Otogibanashi` 的**后半进罗马音**
     *      （`Otogibanashi` → オトギバナシ，规则层会读成 …スヒ）；
     *   ② 切不出来的短片段（`Ex`）逐字母读字母名 → イーエックス。
     * 外语行（德语那种）不插队：那些片段归语种引擎管。
     */
    if (token && token.chain === true) {
      var chainWord = String(word == null ? "" : word);
      var chainLang = lineLang(line);
      // 真正的语种行（德 / 法 / 俄…）不插队：那些片段归语种引擎管；
      // 拉丁语和斯瓦希里语的判定对"罗马字标题"太容易命中，放它们进来
      if (!chainLang || chainLang === "la" || chainLang === "sw") {
        var chainRomaji = null;
        if (typeof WKReading !== "undefined" && WKReading.romajiToKatakana) {
          try {
            var cr = WKReading.romajiToKatakana(chainWord.toLowerCase());
            chainRomaji = cr && (typeof cr === "string" ? cr : cr.kana);
          } catch (e) {
            chainRomaji = null;
          }
        }
        if (chainRomaji) return { kana: chainRomaji, source: "romaji" };
        // 罗马音层切不出来的**短片段**（`Ex` イーエックス）逐字母读；
        // 别把正常的词（`Was`）拼成字母名
        if (/^([A-Za-z]{1,2}|[A-Z]{2,3})$/.test(chainWord)) {
          var chainNames = letterNames(chainWord);
          if (chainNames) return { kana: chainNames, source: "letters", confident: true };
        }
      }
    }
    /*
     * 点号记法里的**罗马字单词**（`K・A・I・S・A・N` = カイサン，标记见 letters.js 的
     * romajiWord）：整串交给罗马音层，不按记号逐字母念字母名。
     */
    if (token && token.romajiWord === true && typeof WKReading !== "undefined" && WKReading.romajiToKatakana) {
      var flatWord = String(word == null ? "" : word).replace(/[^A-Za-z]/g, "").toLowerCase();
      var asRomaji = null;
      try {
        var rr = WKReading.romajiToKatakana(flatWord);
        asRomaji = rr && (typeof rr === "string" ? rr : rr.kana);
      } catch (e) {
        asRomaji = null;
      }
      if (asRomaji) return { kana: asRomaji, source: "romaji" };
    }
    /*
     * 有固定读法的记号（`p.h.` = pH → ペーハー，见 letters.js 的 notationWord）
     */
    if (token && token.notationWord === true) {
      var nwKey = String(word == null ? "" : word).toLowerCase().replace(/[^a-z]/g, "");
      var nw = NOTATION_WORD_KANA[nwKey];
      if (nw) return { kana: nw, source: "dict", confident: true };
    }
    /*
     * 英文行里全大写、2~4 个字母、不在英文常用词表里的词（`KRO` / `NE`）：
     * 它可能是缩写，也可能是**日语罗马字** —— 案例 `Don't I second bet in the KRO NE`
     * 就是 クロネ（官方翻译那行写着「我不在那"KRO NE"里再次押注」）。本地分不出来，
     * 缩写的字母名和罗马字读音都说得通，所以标成**没把握**：先按罗马音（`NE` → ネ）
     * 或字母名（`KRO` → ケーアールオー）顶着，整句交给大模型按整句定。
     * 日语行里的 `SOS` / `QTE` / `BGM` 不在此列：那些就是缩写，照旧逐字母念；
     * 两个字母的英文词（`no` / `me` …）也不在此列，它们在词典里有确定读音。
     */
    if ((!line || !RE_KANA_ANY.test(String(line))) && !(line && lineLooksRomaji(line))) {
      var capsWord = String(word == null ? "" : word);
      if (/^[A-Z]{2,4}$/.test(capsWord) && /[AEIOU]/.test(capsWord) && !own(EN_TWO_LETTER, capsWord.toLowerCase())) {
        var capsLow = capsWord.toLowerCase();
        var enTable = typeof WKEnWords !== "undefined" ? WKEnWords.words : null;
        /*
         * **词典里有的就不猜**：`MORE` / `JUMP` / `BANG` 是老老实实的西文词，
         * 只是没进英文常用词表（WKEnWords 才 3693 条）。判据和 gluedUpperCase 里
         * "别误伤全大写写的真词"同一条：词典或英文常用词表里有它，就不当缩写/罗马字猜。
         *
         * 案例 `(MORE MORE MORE MORE JUMP)`（整行没有假名，走的就是这一支）：
         * MORE 被猜成罗马音 モレ（该 モア），JUMP 连猜都猜不出来（romanji 切不动
         * 结尾的 -mp），于是**整行只有 JUMP 空着**。词典命中就让下面的词典层照常读。
         */
        var capsDict = typeof WKDict !== "undefined" ? WKDict.words : null;
        var dictKnown = !!(capsDict && capsDict[capsLow] !== undefined);
        if (!(enTable && enTable[capsLow]) && !dictKnown) {
          var guessRomaji = null;
          if (typeof WKReading !== "undefined" && WKReading.romajiToKatakana) {
            try {
              var gr = WKReading.romajiToKatakana(capsLow);
              guessRomaji = gr && (typeof gr === "string" ? gr : gr.kana);
            } catch (e) {
              guessRomaji = null;
            }
          }
          var guessKana = guessRomaji;
          if (guessKana) return { kana: guessKana, source: "romaji", confident: false };
          /*
           * 罗马音也读不出来（`KRO`）：先用表里的**本地兜底**顶着（クロ，标成没把握，
           * 大模型仍可改）；表里也没有才空着、只把这个词记进大模型的待问队列。
           */
          var capsKey = capsWord.toLowerCase();
          var fallbackKana = own(UNCERTAIN_FALLBACK, capsKey) ? UNCERTAIN_FALLBACK[capsKey] : null;
          if (fallbackKana) return { kana: fallbackKana, source: "rule", confident: false };
          if (state.llm && state.llm.want) {
            try {
              state.llm.want(capsWord, line);
            } catch (e) {
              /* 记不上不影响注音 */
            }
          }
          return null;
        }
      }
    }
    var r = state.reader ? state.reader.read(word) : null;
    /*
     * 「学会的词」（core/learn.js）：模型在两个不同句子里答过同一个读音 → 沉淀成
     * 离线词条，不再问模型（省钱就在这）。
     *
     * 但它排在人工词典后面：沉淀是模型给的，人工词表优先 —— 和
     * `tools/build-dict.js` 的"人工 > 沉淀 > 大模型"同一个口径。
     * 案例 `Ave`（拉丁语歌里的乐队名）就是这么被带歪的：模型在别的行里答过
     * アヴェ，沉淀成词条之后盖掉了人工核过的 `ave アベ`（"Ave Mujica 官方读 アベ"），
     * 结果同一首歌里两行两个读音。
     */
    if ((!r || !r.kana || r.source !== "dict") && state.learned) {
      var learned = state.learned.get(word);
      if (learned) return { kana: learned, source: "learned", confident: true };
    }
    /*
     * 外语行：拼读猜出来的答案换成那种语言的拼读，词典命中的照旧优先。
     *
     * 为什么放在这里、而不是函数末尾：下面"罗马字行/两可短音节"那两支会先返回
     * （`dans` 这种三字母词就会被它们接走），所以语言判定必须在它们之前判。
     *
     * 什么时候用引擎覆盖本地层：
     *   - 本地层读不出来 —— 西里尔/希腊字母（俄语、希腊语）词典层和罗马音层都读不了，
     *     这两个语种的支持就落在这条上；
     *   - 本地层是罗马音/规则猜的 —— 英文读音对外语词没有意义；
     *   - 这个词是同形异音（plus / son / die / Wind…，见 langs.js 的 HOMOGRAPH）。
     * 借词表命中的排在最前面（那是日语通行写法，等于人工词条）。
     * 规则层的结果一律 confident:false —— 拼写近似，配了 key 交给大模型按整句定。
     */
    var lang = line ? lineLang(line) : null;
    /*
     * 日语行里夹着的俄语 / 希腊语词：按 token 自带的字母表兜一下。
     *
     * `detect()` 的第一条是"有假名就不判外语"，那是为了别让 `無限増幅回路（Ω）`
     * 整行变成希腊语（Ω 该读单位 オーム）。但那条也把 `Отчизну を歌う`、
     * `Θάλασσα の夜` 这种行一起挡了 —— 西里尔/希腊字母在词典层和罗马音层都读不了，
     * 于是那个词一个注音都没有。这两个字母表本身是自明的（词上带着 script），
     * 所以这里只补"判不出语种、但这个词明明是西里尔/希腊字母"这一档。
     * 单字母不经过这里：Ω / Я 在上面已经按字母名 / 单位读掉了。
     */
    if (!lang && token && (token.script === "cyrillic" || token.script === "greek")) {
      lang = token.script === "cyrillic" ? "ru" : "el";
    }
    if (lang && typeof WKLangs !== "undefined" && WKLangs.toKatakana) {
      var loan = WKLangs.word(lang, word);
      if (loan) return { kana: loan, source: "dict", confident: true };
      var langKey = typeof WKMatcher !== "undefined" ? WKMatcher.normalize(word) : String(word == null ? "" : word).toLowerCase();
      var needEngine = !r || !r.kana || r.source === "romaji" || r.source === "rule" || WKLangs.homograph(lang, langKey);
      if (needEngine) {
        var foreign = WKLangs.toKatakana(lang, word);
        if (foreign && foreign.kana) return { kana: foreign.kana, source: "rule", confident: foreign.confident === true };
      }
    }
    if (!r || !r.kana) return null;
    /*
     * 词典是英文词典，`PI` 会被读成 パイ、`ME` 读成 ミー、
     * `PE` 甚至读成 ピーイー（把 "P E" 当字母念）—— 在一首日语歌的罗马字行里
     * 这些全错。这一行的构成已经说明它是罗马字（见 lineLooksRomaji），
     * 所以用罗马音读音覆盖词典读音，但标成没把握：在线层（大模型）
     * 拿到整句语境后可以改回去（英文行不会被读歪），离线时就按罗马音。
     */
    if (line && r.source === "dict") {
      var rom = shortRomajiOf(word);
      if (rom && rom !== r.kana) {
        if (lineLooksRomaji(line)) {
          // 罗马字行：直接按罗马音显示（离线也对：PA PI PU PE PO -> パピプペポ）
          return { kana: rom, source: "romaji", confident: false };
        }
        /*
         * 不是罗马字行，但这个词两可：词典给的是英文读音（`Do` ドゥー、
         * `Re` リー、`MI` ミー、`PE` ピーイー…），而同一串也可能是唱名/罗马音节
         * （ド/レ/ミ/ペ）。光看拼写分不出来（`do`/`re`/`no` 真是英文词），
         * 只能靠整句语境 —— 所以这里保留词典读音先显示，但标成"没把握"，
         * 让在线层（大模型）按那句话决定；离线时就用词典读音，不会被读歪。
         */
        return { kana: r.kana, source: r.source, confident: false };
      }
    }
    // 全大写缩写紧贴假名的（ATフィールド…）：标成没把握，交给大模型按整句判
    if (r.source === "dict" && r.confident !== false && gluedUpperCase(word, line)) {
      return { kana: r.kana, source: r.source, confident: false };
    }
    return r;
  }

  /**
   * 这个词是不是"两可"的短音节：词典给的是英文读音，而这一串同时也能读成
   * 罗马音节（`do` ドゥー/ド、`me` ミー/メ、`pi` パイ/ピ、`no` ノー/ノ…）。
   *
   * 两处用它：
   *   1. 显示时标成"没把握"（confident:false），交给大模型按整句语境判；
   *   2. 不把模型答案沉淀成离线词条 —— 它的正确读音取决于那句话，
   *      钉死一个只会错（这条规矩见 core/learn.js 的说明）。
   */
  function isTwoWayShort(word, dictKana) {
    var rom = shortRomajiOf(word);
    if (!rom) return false;
    var kana = dictKana;
    if (kana === undefined) {
      var d = typeof WKDict !== "undefined" ? WKDict.words : {};
      var key = typeof WKMatcher !== "undefined" ? WKMatcher.normalize(word) : String(word || "").toLowerCase();
      kana = d[key];
    }
    return !!kana && kana !== rom;
  }

  /**
   * 在线层拿回来的答案过不过关（两层共用）。
   *
   * 第一道是纯片假名（由各层自己判），第二道是首音校验：
   * `looksLikeTransliteration` 拦的是"意译 / 拟声词"——案例 `tick` 被回成
   * カチカチ 就是这种。
   *
   * 但那套判据是按英语拼写定的（t→タ行、v→バ行…），外语行上会误伤：
   * 拉丁语的 v 读 ヴ 也读 ワ（`vacuum` → ワクーム 被判掉过，德语 w→ヴ、
   * x→クス 英语里根本没有）。所以外语行整行不做这道校验 —— 那一行的语种
   * 我们已经认出来了，模型也拿得到整句，用英语口径去卡只会把正确答案丢掉。
   * （丢掉的后果特别难查：那条 miss 是永久的、还落盘，那个词就永远停在规则层。）
   */
  function validateAnswer(word, kana, line) {
    if (typeof WKReading === "undefined") return true;
    // 汉字的读音是"从候选里挑一个"，不适用英语首音校验（那套按拉丁拼写定的）
    if (typeof WKCJK !== "undefined" && (WKCJK.hasHan(word) || WKCJK.hasHangul(word))) return true;
    if (line && lineLang(line)) return true;
    return WKReading.looksLikeTransliteration(word, kana);
  }

  function resolveReading(word, line, token) {
    if (!state.reader) return null;
    /*
     * 汉字 / 谚文的读音不走西文那几层（会把 `漢` 拼成乱七八糟的音），由 core/cjk.js 查表。
     * 但多音字要留一条"大模型按整句挑读音"的路：
     *   - 有答案就返回它 —— relabel() 会用这个结果改写已经写上的 ruby；
     *   - 没答案就返回 null —— relabel() 保持原样（离线读音），不会把中文擦掉。
     * 谚文是拼写即读音，没有多音字问题，一直返回 null。
     */
    if (typeof WKCJK !== "undefined" && WKCJK.hasHan(word)) {
      // 日语行里的汉字归振假名管（东京 トウキョウ），不能拿普通话读音去改
      if (lineLooksJapanese(line)) return null;
      return hanziFromLLM(word, line);
    }
    if (typeof WKCJK !== "undefined" && WKCJK.hasHangul(word)) return null;
    // 全角字母折半角（`ＮＯ` -> `NO`）：查表 / 模型键 / 层序都得用同一个形式
    word = foldFullwidthLetters(word);
    if (line != null) line = foldFullwidthLetters(line);
    var r = withLongVowel(word, localReading(word, line, token));
    if (!r || !r.kana) return null;

    var mine = effectiveRank(r); // 没把握的答案按最低层算，在线层可以覆盖它
    for (var i = 0; i < config.layerOrder.length; i++) {
      var id = config.layerOrder[i];
      if (!ASYNC_LAYERS[id]) continue;
      // 排在当前答案后面的在线层不参与：不发请求、也不覆盖
      if (i >= mine) break;
      /*
       * 大模型这一层现在用不了（没配 key / 没开）也要记一笔：
       * 注音层只在注音那一刻走这里一次，不记的话等 key 补上/这一层重新打开时
       * 就没人再问那个词了 —— 页面上看到的正是「这个单词一直是黄的」
       * （`sieh` 就是这么一直黄着的）。记下来之后，这一层一可用就会补问。
       */
      if (id === "llm" && !layerAvailable(id)) {
        if (state.llm.want) {
          try {
            state.llm.want(word, line);
          } catch (e) {
            /* 记不上不影响注音 */
          }
        }
        continue;
      }
      if (!layerAvailable(id)) continue;

      if (id === "llm") {
        if (line !== undefined && line !== null) {
          var llm = state.llm.lookup(word, line);
          if (llm) return { kana: llm, source: "llm" };
        }
        // 这个词还没问到结果：先用在别的句子里拿到的读音，其次用当前这层的读音顶上
        var seen = state.llm.peek(word);
        if (seen) return { kana: seen, source: "llm" };
        return { kana: r.kana, source: r.source };
      }

      // 免费接口（Google）
      var fixed = state.corrector.lookup(word);
      if (fixed) return { kana: fixed, source: "google" };
      return { kana: r.kana, source: r.source };
    }

    // 没有更高优先的在线层可用 —— 当前这层的答案就是最终答案
    return { kana: r.kana, source: r.source };
  }

  /** 只要读音字符串的调用方（控制台 WK.display / 老代码）走这个 */
  function readForDisplay(word, line, token) {
    var got = resolveReading(word, line, token);
    return got ? got.kana : null;
  }

  /**
   * 这个词的读音现在是不是"暂定"的（有比它更优先的在线层还在问）。
   * 注音层靠它在 ruby 上加 `wk-pending` 类 —— 样式淡一点，提示"还不一定"。
   */
  function isProvisional(word, line, token) {
    if (!word || !state.reader) return false;
    /*
     * 汉字里的多音字：离线读音先顶着，同时这句已经进了大模型的队列 ——
     * 答案没回来之前算"暂定"，回来了 relabel() 会改写并摘掉 wk-pending。
     */
    if (typeof WKCJK !== "undefined" && WKCJK.hasHan(word)) {
      if (lineLooksJapanese(line)) return false;
      if (!polyOptions(word) || !llmAvailable() || !state.llm) return false;
      try {
        return !!(state.llm.isWaiting && state.llm.isWaiting(word, line));
      } catch (e) {
        return false;
      }
    }
    word = foldFullwidthLetters(word);
    if (line != null) line = foldFullwidthLetters(line);
    var r = localReading(word, line, token);
    if (!r) return false;
    var mine = effectiveRank(r);
    for (var i = 0; i < config.layerOrder.length; i++) {
      var id = config.layerOrder[i];
      if (!ASYNC_LAYERS[id]) continue;
      if (i >= mine) break; // 这一层不参与，后面的更不参与
      if (!layerAvailable(id)) continue;
      if (id === "llm") {
        if (state.llm.isWaiting && state.llm.isWaiting(word, line)) return true;
      } else if (state.corrector.isWaiting && state.corrector.isWaiting(word)) {
        return true;
      }
      // 这一层已经答过了（或确定给不出）—— 显示的就是最终答案，不是暂定
      return false;
    }
    return false;
  }

  // ------------------------------------------------------------ 就地改读音

  /*
   * 双击歌词里的一个注音，就地弹一个小输入框改读音。
   *
   * 为什么是双击而不是单击：歌词区域单击是"跳到这一句"，抢掉会很难用。
   * 为什么按"整行原文"存：同一个词在不同句子里读音不同，不能做全局词表 ——
   * 改的只是这一句里的这个词（config.furiganaLineFixes[整行] = {词: 假名}）。
   */
  var editingEl = null;

  function closeEditor() {
    if (editingEl && editingEl.parentNode) editingEl.parentNode.removeChild(editingEl);
    editingEl = null;
  }

  function lineTextOf(el) {
    /*
     * 必须和注音层用**同一个口径**：只取原文那层（RNP 的区域里还包着 -romaji / -translated，
     * 整块 textContent 会把它们也算进来）。以前这里是 textOf(区域) 的全文，
     * 于是就地改的读音存进了一个和注音时对不上的键 —— 改完 / 留空都不生效
     * （真机现象：输入 - 之后读音又回来了）。
     */
    try {
      if (el && el.getAttribute && el.getAttribute("data-wk-region") === "1") return regionText(el);
      if (state.annotator && state.annotator.textOf) return state.annotator.textOf(el) || "";
    } catch (e) {
      /* 退回到 textContent */
    }
    return el && el.textContent ? el.textContent : "";
  }

  /** 这个元素所在的"整行"（注音区域；找不到就用它自己） */
  function lineElementOf(el) {
    var p = el;
    while (p && p !== document.body) {
      if (p.getAttribute && p.getAttribute("data-wk-region") === "1") return p;
      p = p.parentNode;
    }
    return el;
  }

  function saveInlineFix(lineText, at, word, kana) {
    if (!lineText || !word) return;
    var map = config.furiganaLineSpans;
    if (!map || typeof map !== "object") map = config.furiganaLineSpans = {};
    var list = map[lineText];
    if (!list || !list.length) list = [];
    /*
     * 按**位置**存：同一个字在一行里出现两次时，用户只想改其中一处
     * （`魂辛辛` 的 辛辛 是 からがら）。以前是按"词"存的，改一处等于整行同字全改。
     */
    var next = [];
    for (var i = 0; i < list.length; i++) {
      var old = list[i];
      if (!old) continue;
      var oldAt = typeof old[0] === "number" ? old[0] : parseInt(old[0], 10);
      var oldLen = String(old[1] == null ? "" : old[1]).length;
      /*
       * 和这一段有重叠的旧条目一律删掉：合并（嘲笑）之后，之前拆开的两条（嘲/笑）
       * 还留在表里的话，注音会按先命中的那条来 —— 屏幕上就是拆不干净 / 合不干净。
       */
      if (oldAt < at + word.length && at < oldAt + oldLen) continue;
      next.push(old);
    }
    /*
     * 三种写法：
     *   有内容   -> 这一处按它读；
     *   空字符串 -> 留空（这一处不注音）；
     *   null     -> 删掉这一条（回到底层读音）。
     */
    if (kana !== null) next.push([at, word, kana || ""]);
    if (next.length) map[lineText] = next;
    else delete map[lineText];
    saveConfig();
    if (typeof WKFurigana !== "undefined" && WKFurigana.clearCache) WKFurigana.clearCache();
    rescan();
  }

  /**
   * 一次写多条按位置的修改（「手动切词」把一个词拆成几段时用）。
   * 覆盖掉 [from, to) 里原有的条目，只重扫一次。
   */
  function saveInlineSpans(lineText, spans, from, to) {
    if (!lineText || !spans || !spans.length) return;
    var map = config.furiganaLineSpans;
    if (!map || typeof map !== "object") map = config.furiganaLineSpans = {};
    var cur = map[lineText];
    if (!cur || !cur.length) cur = [];
    var keep = [];
    for (var i = 0; i < cur.length; i++) {
      var sp = cur[i];
      if (!sp) continue;
      var at0 = typeof sp[0] === "number" ? sp[0] : parseInt(sp[0], 10);
      var len0 = String(sp[1] == null ? "" : sp[1]).length;
      // 和这次拆开的那一段有重叠的旧条目先删掉
      if (at0 < to && from < at0 + len0) continue;
      keep.push(sp);
    }
    for (var j = 0; j < spans.length; j++) keep.push([spans[j].at, spans[j].word, spans[j].kana]);
    keep.sort(function (a, b) {
      return a[0] - b[0];
    });
    if (keep.length) map[lineText] = keep;
    else delete map[lineText];
    saveConfig();
    if (typeof WKFurigana !== "undefined" && WKFurigana.clearCache) WKFurigana.clearCache();
    rescan();
  }

  /**
   * 一个注音在**整行**里的起点（就地编辑按位置存，靠它定位）。
   *
   * 走一遍行内文本节点：`<rt>` / `<rp>` 是注音不是原文，跳过；走到这个 ruby 的
   * 底字节点时累计的长度就是起点。
   */
  function rubyOffset(rubyEl, lineEl) {
    if (!rubyEl || !lineEl) return -1;
    var base = rubyEl.firstChild;
    var total = 0;
    var walker = document.createTreeWalker(lineEl, 4, null, false); // 4 = SHOW_TEXT
    var node;
    while ((node = walker.nextNode())) {
      var p = node.parentNode;
      if (p && p.nodeType === 1) {
        if (p.tagName === "RT" || p.tagName === "RP") continue;
        var cn = typeof p.className === "string" ? p.className : "";
        if (/(^|\s)wk-rt(\s|$)/.test(cn) || /(^|\s)wk-hide(\s|$)/.test(cn)) continue;
      }
      if (node === base) return total;
      // 区域自己的缩进 / 换行不算位置（和 regionText 同一套规矩）
      if (node.parentNode === lineEl && !String(node.nodeValue || "").replace(/\s+/g, "")) continue;
      /*
       * 只数"原文"那层的字：音译 / 翻译层（fontSkipped）和注音（rt）都不算，
       * 否则 RNP 里算出来的起点会多出几十个字符，存的修正对不上任何一行。
       */
      var skippedLayer = false;
      for (var q = p; q && q !== lineEl; q = q.parentNode) {
        if (!q || q.nodeType !== 1) continue;
        var qc = typeof q.className === "string" ? q.className : "";
        // 到了我们自己的 ruby 就停：里面是底字，要算进位置里
        if (/(^|\s)(wk-ruby|kt-ruby|fg-ruby)(\s|$)/.test(qc)) break;
        if (q !== lineEl && fontSkipped(q)) {
          skippedLayer = true;
          break;
        }
      }
      if (skippedLayer) continue;
      total += (node.nodeValue || "").length;
    }
    return -1;
  }

  /** 一个 ruby 的底字 + 读音 */
  function rubyParts(rubyEl) {
    var word = "";
    try {
      word = rubyEl.childNodes[0] ? rubyEl.childNodes[0].nodeValue || "" : "";
    } catch (e) {
      word = "";
    }
    if (!word) word = rubyEl.textContent || "";
    var rt = rubyEl.querySelector(".wk-rt");
    return { word: word, kana: rt ? rt.textContent || "" : "" };
  }

  /** 和这个 ruby 紧挨着的下一个注音（中间只允许空白的文本 / 空的 span） */
  function adjacentRuby(rubyEl, dir) {
    var n = rubyEl ? (dir < 0 ? rubyEl.previousSibling : rubyEl.nextSibling) : null;
    for (var guard = 0; n && guard < 6; guard++) {
      if (n.nodeType === 1) {
        var cn = typeof n.className === "string" ? n.className : "";
        // 留空的壳（wk-blank）也算一个"注音位"，可以和相邻的合并
        if (/(^|\s)(wk-ruby|wk-blank)(\s|$)/.test(cn)) return n;
        if (n.textContent && String(n.textContent).replace(/\s+/g, "")) return null;
      } else if (n.nodeType === 3) {
        if (String(n.nodeValue || "").replace(/\s+/g, "")) return null;
      } else {
        return null;
      }
      n = dir < 0 ? n.previousSibling : n.nextSibling;
    }
    return null;
  }

  function openEditor(rubyEl) {
    if (!rubyEl || !rubyEl.parentNode) return;
    var parts = rubyParts(rubyEl);
    var word = parts.word;
    var current = parts.kana;
    if (!word) return;
    var lineEl = lineElementOf(rubyEl);
    var lineText = lineTextOf(lineEl);
    var startAt = rubyOffset(rubyEl, lineEl);

    /*
     * 要存的"底字 + 起点"。默认就是这一个 ruby；点了「合并」之后变成两个相邻注音
     * 合起来的那一段（`辛` + `辛` → `辛辛` からがら、`日` + `々` → `日々` ひび）。
     */
    var span = { at: startAt, word: word };

    closeEditor();
    var wrap = document.createElement("div");
    wrap.className = "wk-edit-box";
    wrap.setAttribute("data-wk-edit", "1");
    wrap.style.position = "fixed";
    wrap.style.zIndex = "99999";
    wrap.style.background = "rgba(20,24,32,.92)";
    wrap.style.padding = "4px 6px";
    wrap.style.borderRadius = "6px";
    wrap.style.boxShadow = "0 2px 10px rgba(0,0,0,.45)";
    wrap.style.fontSize = "13px";
    wrap.style.display = "flex";
    wrap.style.gap = "4px";
    wrap.style.alignItems = "center";

    var box = document.createElement("input");
    box.type = "text";
    box.className = "wk-edit";
    box.value = current;
    box.placeholder = "回车保存｜清空=恢复默认｜- = 留空｜斜杠=切词（いち/ど/わら/）";
    box.title = "回车保存；清空=恢复词典读音；- = 这一处不注音；斜杠按字切词（例 いち/ど/わら/，空段=并入前一个字）";
    box.style.fontSize = "14px";
    box.style.padding = "2px 6px";
    box.style.width = Math.max(80, (current.length + 4) * 14) + "px";

    // 合并左边 / 合并右边：把相邻的那个注音并进来，底字和读音一起改
    function makeMergeBtn(dir, label) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.fontSize = "12px";
      b.title = dir < 0 ? "和左边那个注音合成一个词" : "和右边那个注音合成一个词";
      b.addEventListener("mousedown", function (ev) {
        ev.preventDefault(); // 别让输入框失焦
        ev.stopPropagation();
        var other = adjacentRuby(rubyEl, dir);
        if (!other) {
          b.disabled = true;
          return;
        }
        var a = dir < 0 ? rubyParts(other) : parts;
        var z = dir < 0 ? parts : rubyParts(other);
        var aAt = rubyOffset(dir < 0 ? other : rubyEl, lineEl);
        var bAt = rubyOffset(dir < 0 ? rubyEl : other, lineEl);
        var at = Math.min(aAt, bAt);
        if (!(at >= 0)) return;
        var joined = lineText.substr(at, a.word.length + z.word.length);
        if (!joined) return;
        span = { at: at, word: joined };
        box.value = a.kana + z.kana;
        box.select();
      });
      return b;
    }
    wrap.appendChild(makeMergeBtn(-1, "←"));
    wrap.appendChild(box);
    wrap.appendChild(makeMergeBtn(1, "→"));


    var resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.textContent = "↺";
    resetBtn.title = "取消合并 / 恢复默认（删掉这一处的修改）";
    resetBtn.style.fontSize = "12px";
    resetBtn.addEventListener("mousedown", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      closeEditor();
      saveInlineFix(lineText, span.at, span.word, null);
    });
    wrap.appendChild(resetBtn);

    try {
      var r = rubyEl.getBoundingClientRect();
      wrap.style.left = Math.max(4, r.left) + "px";
      wrap.style.top = Math.max(4, r.top - 34) + "px";
    } catch (e2) {
      wrap.style.left = "20px";
      wrap.style.top = "20px";
    }
    box.addEventListener("keydown", function (ev) {
      var k = ev.key || "";
      if (k === "Enter") {
        ev.preventDefault();
        ev.stopPropagation();
        var v = String(box.value || "").replace(/^\s+/, "").replace(/\s+$/, "");
        closeEditor();
        /*
         * 回车三种：
         *   有内容 -> 按它读；
         *   清空   -> **恢复默认**（把这一处的修改删掉，回到词典读音）——
         *             以前清空是"留空"，而留空之后这一处没有注音了，双击也就没了目标，
         *             等于这一处再也改不回来（用户报的就是这个）；
         *   减号 - -> 留空（这一处不注音，给 帷帳 とばり 这种当て字用）。
         */
        /*
         * 斜杠语法（手动切词）：把读音按字分成几段，用 / 隔开。
         *   `一度嘲笑` 输 `いち/ど/わら/` → 一=いち / 度=ど / 嘲+笑=わら
         *     （段数 = 字数；某一段空 = 那个字并入前一段组成一个词）
         *   某一段写 `-` = 那个字留空不注音
         */
        if (v.indexOf("/") >= 0) {
          /*
           * 斜杠切词：**段数 = 从这一处往后覆盖的字数**，每段对应一个字。
           *   `嘲笑` 输 `あざ/わら`     → 嘲=あざ / 笑=わら
           *   `嘲笑` 输 `あざ/`        → 笑 并入前一个字 → 嘲笑=あざ
           *   `嘲笑` 输 `-/わら`       → 嘲 留空 / 笑=わら
           *   `一度嘲笑` 输 `いち/ど/わら/` → 一=いち / 度=ど / 嘲笑=わら
           * （所以不一定要先把词合并起来，直接连前后的字一起写也行）
           */
          var segsIn = v.split("/");
          var charsN = segsIn.length;
          var baseWord = lineText.substr(span.at, charsN);
          if (charsN > 1 && baseWord.length === charsN) {
            var built = [];
            for (var ci = 0; ci < charsN; ci++) {
              var partK = String(segsIn[ci] == null ? "" : segsIn[ci]).replace(/\s+/g, "");
              var chOne = baseWord.charAt(ci);
              if (!partK) {
                // 空段：这个字并进前一段，组成一个词
                if (built.length) built[built.length - 1].word += chOne;
                else built.push({ at: span.at + ci, word: chOne, kana: "" });
                continue;
              }
              if (partK === "-" || partK === "\u2212" || partK === "\uFF0D") {
                built.push({ at: span.at + ci, word: chOne, kana: "" });
                continue;
              }
              built.push({ at: span.at + ci, word: chOne, kana: partK });
            }
            if (built.length) saveInlineSpans(lineText, built, span.at, span.at + charsN);
            return;
          }
        }
        if (v === "-" || v === "\u2212" || v === "\uFF0D") {
          saveInlineFix(lineText, span.at, span.word, "");
        } else if (!v) {
          // 清空 = 删掉这一处修改（普通注音回到词典读音；留空处取消留空）
          saveInlineFix(lineText, span.at, span.word, null);
        } else if (v !== current || span.word !== word) {
          saveInlineFix(lineText, span.at, span.word, v);
        }
      } else if (k === "Escape") {
        ev.preventDefault();
        closeEditor();
      }
    });
    // 点到别处就关掉
    box.addEventListener("blur", function () {
      setTimeout(closeEditor, 0);
    });
    (document.body || document.documentElement).appendChild(wrap);
    editingEl = wrap;
    try {
      box.focus();
      box.select();
    } catch (e3) {
      /* 选不中也不影响输入 */
    }
  }

  function installInlineEditor() {
    document.addEventListener(
      "dblclick",
      function (ev) {
        var t = ev.target;
        while (t && t !== document.body) {
          var cn = t && typeof t.className === "string" ? t.className : "";
          // 注音（wk-ruby）和被留空的那一段（wk-blank）都能双击改
          if (/(^|\s)(wk-ruby|wk-blank)(\s|$)/.test(cn)) break;
          t = t.parentNode;
        }
        if (!t || t === document.body) return;
        ev.preventDefault();
        ev.stopPropagation();
        openEditor(t);
      },
      true
    );
  }

  // ------------------------------------------------------------ 扫描调度

  var RE_KANA_ANY = /[\u3041-\u3096\u30A1-\u30FA]/;

  /**
   * 这首歌是不是日语歌：整首歌词里有没有一行含假名。
   *
   * 为什么按整首判、而不是按行：日语歌里常有纯英文行（`I love you` 那种），
   * 按行判会把它们当成"非日语"跳过 —— 那正是要注音的行。
   * 非日语歌（纯英语/法语/中文）一行假名都没有，所以整首判定很稳。
   * 结论按歌词文本缓存：同一首歌每轮扫描都要问一次，没必要每次重算。
   */
  /**
   * 这一行算不算日文行。
   *
   *   - 有假名 -> 是（`きらめく光`）
   *   - 没有假名但明显是中文 -> 不是（`我爱上你`，中文版歌词 / 双语字幕常见）
   *   - 其余纯汉字行（`東京`）按整首判：整首是日语歌就是日文行
   *
   * 振假名和中文读音的分岔就按它走。
   */
  /**
   * 整首歌的语种：日文 / 中文 / 拿不准。
   *
   * 为什么要整首投票：中文歌里总有几行没法光看字面就认出来（`那一些呼喊求助` 这种，
   * 没有简体特有字形、也没有中文标点），逐行判会把它们漏到振假名那档，
   * 于是同一首歌里一半普通话读音、一半日语读音。整首一句假名都没有、又能认出中文行，
   * 那这首就是中文歌 —— 一行都不该走日语读音。
   *
   * 罗马音层 / 翻译层不参与投票（它们是页面自己加的，不代表原文语种）。
   */
  /*
   * 语种投票 / 整首判定的**每轮缓存**。
   *
   * 为什么必须有：这两个函数都要把所有歌词区域扫一遍（每个区域一次 visibleText），
   * 而它们在"一个文本节点注一次音"的路径上被调用（extraTokens -> lineLooksJapanese）。
   * 逐字歌词一行十几个节点时，等于每轮扫描把整首歌词读十几遍 ——
   * CPU 采样里 songKind 一个人就占了 60%，真机表现是歌词滚动卡。
   * 现在每轮 pass 只算一次（songLangGen 每轮 +1），单个节点直接命中缓存。
   */
  var songLangGen = 0;
  var songKindGen = -1;
  var songKindValue = "unknown";
  var songJaGen = -1;
  var songJaValue = true;
  function songKind() {
    if (songKindGen === songLangGen) return songKindValue;
    songKindGen = songLangGen;
    songKindValue = computeSongKind();
    return songKindValue;
  }

  function computeSongKind() {
    if (!state.annotator || !state.annotator.findRegions) return "unknown";
    var regions = [];
    try {
      regions = state.annotator.findRegions("lyrics");
    } catch (e) {
      return "unknown";
    }
    if (!regions || !regions.length) return "unknown";
    var kana = 0;
    var cjk = 0;
    var cn = 0; // 有中文痕迹的纯汉字行（一个中文虚词也算）
    var cnStrong = 0; // 其中"明显是中文"的（中文特有字形 / 语气词 / 中文逗号 / 两个以上虚词）
    for (var i = 0; i < regions.length; i++) {
      if (fontSkipped(regions[i])) continue;
      var t = regionText(regions[i]);
      if (!t) continue;
      if (RE_KANA_ANY.test(t)) kana++;
      else if (/[\u4E00-\u9FFF]/.test(t)) {
        cjk++;
        if (typeof WKCnLine !== "undefined" && WKCnLine.isChineseLine) {
          if (WKCnLine.isChineseLine(t)) {
            cnStrong++;
            cn++;
          } else if (WKCnLine.hasChineseEvidence && WKCnLine.hasChineseEvidence(t)) cn++;
        }
      }
    }
    if (kana === 0) {
      if (cn > 0) return "zh"; // 一句假名都没有、还能认出中文行 = 中文歌
      if (cjk > 0) return "ja"; // 纯汉字没有假名（`東京` 这种）按日文处理
      return "unknown"; // 只有拉丁字母：交给逐行的西文逻辑
    }
    /*
     * 有假名不一定是日语歌：中文歌里可能夹着一两句日语（`ありがとう`、
     * `(ツンデレ・ガール 愛莉)` 这种）。中文味道的行**多于**假名行时按中文歌处理，
     * 那些纯汉字的中文行才不会拿日语读音去注（真机现象：`不用害怕` → ふようがい）。
     * 另外要求至少有一行是"明显中文"，免得一首日文歌里几句纯汉字（碰巧带 在 / 有）就翻过去。
     */
    if (cn >= 2 && cn >= kana && cnStrong >= 1) return "zh";
    return "ja"; // 有假名就是日文歌
  }

  /**
   * 这一行的汉字是不是每个都能用日语读出来（词典覆盖）。
   *
   * 干什么用：中文歌里夹的日语标题行（`(G・U・T・S雫)`）一个字的中文痕迹都没有，
   * 靠这个判 —— 日语词典能把 雫 读成 しずく，中文行 `那一些呼喊求助` 里的 喊 读不出来。
   */
  function japaneseReadable(line) {
    if (typeof WKFurigana === "undefined" || !WKFurigana.tokens) return false;
    if (!WKFurigana.ready || !WKFurigana.ready()) return false;
    var toks = null;
    try {
      toks = WKFurigana.tokens(line);
    } catch (e) {
      toks = null;
    }
    if (!toks || !toks.length) return false;
    var re = /[\u4E00-\u9FFF\u3400-\u4DBF\u3005]+/g;
    var m;
    while ((m = re.exec(line))) {
      var a = m.index;
      var b = a + m[0].length;
      var covered = false;
      for (var i = 0; i < toks.length; i++) {
        if (toks[i].start < b && a < toks[i].end) {
          covered = true;
          break;
        }
      }
      if (!covered) return false; // 有一个汉字读不出来：更像中文行
    }
    return true;
  }

  function lineLooksJapanese(line) {
    if (!line) return songKind() !== "zh" && songLooksJapanese();
    if (RE_KANA_ANY.test(line)) return true;
    if (typeof WKCnLine !== "undefined" && WKCnLine.isChineseLine) {
      /*
       * 没有假名时先看"是不是中文行"。判据见 core/cn-line.js：
       * 中文特有字形 / 语气词 / 中文逗号 / 两个以上中文虚词。
       *
       * 全角冒号那一类**不算**中文证据：`通称：愛情対象年齢` 就是这么被整行注成
       * 普通话读音的（トンチェン / アイチン / ニェンリン）。
       */
      if (WKCnLine.isChineseLine(line)) return false;
    }
    var kind = songKind();
    if (kind === "zh") {
      /*
       * 中文歌里的纯汉字行：有一点中文味道（哪怕只有一个 的 / 不 / 在）就按中文；
       * 一点都没有、而日语词典能把这一行每个汉字都读出来 → 是夹进来的日语标题行
       * （`(G・U・T・S雫)` 的 雫 读 しずく）。
       */
      if (typeof WKCnLine !== "undefined" && WKCnLine.hasChineseEvidence && WKCnLine.hasChineseEvidence(line)) {
        return false;
      }
      return japaneseReadable(line);
    }
    return songLooksJapanese();
  }

  /**
   * 面板「自定义读音」的规则。
   *
   * 一行一条：`原句片段 => 词=读音`
   *   明日も君と歩く => 明日=あした
   *   解けない方程式 => 解=と
   *
   * 为什么必须带"作用范围"：同一个词在不同句子里读音就不一样
   * （解 と / かい / ほど、明日 あした / あす / みょうにち），
   * 所以**不做全局词表映射** —— 规则只在"这一行包含这段原文"时生效。
   */
  function parseFuriganaRules(text) {
    var rules = [];
    var lines = String(text == null ? "" : text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s+/, "").replace(/\s+$/, "");
      if (!line || line.charAt(0) === "#") continue;
      var m = /^(.+?)\s*(?:=\s*>|→|->)\s*(.+)$/.exec(line);
      if (!m) continue; // 没有作用范围的规则直接忽略（免得又变成全局映射）
      var scope = m[1].replace(/\s+$/, "");
      var rest = /^([^=:\uFF1A\t]+)[=:\uFF1A\t]+(.+)$/.exec(m[2]);
      if (!scope || !rest) continue;
      var word = rest[1].replace(/\s+$/, "");
      var kana = rest[2].replace(/^\s+/, "").replace(/\s+$/, "");
      if (!word || !kana) continue;
      rules.push({ scope: scope, word: word, kana: kana });
    }
    return rules;
  }

  /**
   * 这一行按**位置**存的修正（就地编辑器写的）：[[起点, 底字, 读音], ...]
   *
   * 兼容老数据：1.13 之前存键用的是"区域整块文字"（RNP 里夹着罗马音、翻译、缩进），
   * 和现在用的原文对不上。这里退一步按"包含"找一遍，并把起点按前缀长度平移回去 ——
   * 用户改过的读音不该因为一次修 bug 全丢。
   */
  /**
   * 重置**这一首**的读音：清掉这一首各行「就地改的读音」，并清掉振假名缓存重扫。
   *
   * 只动这一首：键是整行原文，所以只删这些行的条目；别的歌、面板里的通用规则、
   * 大模型的缓存都不动（那些清起来要么误伤要么花钱）。
   */
  function resetSongReadings() {
    var regions = [];
    try {
      regions = state.annotator ? state.annotator.findRegions("lyrics") : [];
    } catch (e) {
      regions = [];
    }
    var lines = {};
    for (var i = 0; i < regions.length; i++) {
      var t = regionText(regions[i]);
      if (t) lines[t] = 1;
    }
    var spans = config.furiganaLineSpans || {};
    var fixes = config.furiganaLineFixes || {};
    var removed = 0;
    for (var k in lines) {
      if (!Object.prototype.hasOwnProperty.call(lines, k)) continue;
      if (Object.prototype.hasOwnProperty.call(spans, k)) {
        delete spans[k];
        removed++;
      }
      if (Object.prototype.hasOwnProperty.call(fixes, k)) {
        delete fixes[k];
        removed++;
      }
    }
    saveConfig();
    if (typeof WKFurigana !== "undefined" && WKFurigana.clearCache) WKFurigana.clearCache();
    rescan();
    notifyConfigUI();
    return removed;
  }

  /** 清洗一条 span 列表：空词 / 超长 / 位置对不上的都丢掉（坏数据会把整行弄花） */
  function sanitizeSpans(list, line) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var sp = list[i];
      if (!sp || sp.length < 2) continue;
      var at = typeof sp[0] === "number" ? sp[0] : parseInt(sp[0], 10);
      var word = String(sp[1] == null ? "" : sp[1]);
      var kana = String(sp[2] == null ? "" : sp[2]);
      if (!(at >= 0) || !word) continue;
      if (word.length > 12) continue; // 合并时算歪过就会存下一大段
      if (line.substr(at, word.length) !== word) continue;
      if (kana && !/[\u3041-\u3096\u30A1-\u30FA\u30FC]/.test(kana)) continue;
      out.push([at, word, kana]);
    }
    return out;
  }

  function lineSpans(line) {
    var map = config.furiganaLineSpans;
    if (!map || typeof map !== "object") return null;
    var list = map[line];
    if (list && list.length) {
      var clean = sanitizeSpans(list, line);
      if (clean && clean.length) return clean;
    }
    for (var key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key) || key === line) continue;
      var at0 = key.indexOf(line);
      if (at0 < 0) continue;
      var raw = map[key];
      if (!raw || !raw.length) continue;
      var shifted = [];
      for (var i = 0; i < raw.length; i++) {
        var sp = raw[i];
        if (!sp) continue;
        var at = (typeof sp[0] === "number" ? sp[0] : parseInt(sp[0], 10)) - at0;
        var word = String(sp[1] == null ? "" : sp[1]);
        if (!(at >= 0) || !word) continue;
        if (line.substr(at, word.length) !== word) continue;
        shifted.push([at, word, String(sp[2] == null ? "" : sp[2])]);
      }
      if (shifted.length) return shifted;
    }
    return null;
  }

  /**
   * 老版本的「就地改读音」是按词存的（`furiganaLineFixes[整行] = {词: 读音}`），
   * 改一处等于把这一行里所有同字都改了（真机现象：只想把 辛辛 改 からがら，
   * 结果两个 辛 全变）。启动时把它迁成按位置的写法：每个出现位置各存一条。
   */
  /**
   * 一次性清掉老版本留下的「就地改读音」缓存。
   *
   * 1.13 之前行文本的算法不一样（带罗马音 / 翻译 / 缩进），那些条目现在根本对不上任何一行；
   * 用户看到的是「这里为什么没注音」，而界面上又看不出来是旧数据挡住的。
   * 清一次就好（用 flag 记住），之后的修改一条都不动。
   */
  function purgeStaleInlineFixes() {
    var FLAG = "lyric-ruby.spans.purge2";
    try {
      if (typeof localStorage === "undefined") return;
      if (localStorage.getItem(FLAG)) return;
      localStorage.setItem(FLAG, "1");
    } catch (e) {
      return;
    }
    var had = 0;
    try {
      if (config.furiganaLineSpans && typeof config.furiganaLineSpans === "object") {
        for (var k in config.furiganaLineSpans) {
          if (Object.prototype.hasOwnProperty.call(config.furiganaLineSpans, k)) had++;
        }
      }
      if (config.furiganaLineFixes && typeof config.furiganaLineFixes === "object") {
        for (var k2 in config.furiganaLineFixes) {
          if (Object.prototype.hasOwnProperty.call(config.furiganaLineFixes, k2)) had++;
        }
      }
    } catch (e2) {
      had = 0;
    }
    if (!had) return;
    config.furiganaLineSpans = {};
    config.furiganaLineFixes = {};
    saveConfig();
    if (typeof WKFurigana !== "undefined" && WKFurigana.clearCache) WKFurigana.clearCache();
    log("清掉 " + had + " 条老版本留下的就地读音缓存（算法已经变了，那些条目对不上现在的行）");
  }

  function migrateLineFixes() {
    var old = config.furiganaLineFixes;
    if (!old || typeof old !== "object") return;
    var lines = [];
    for (var line in old) if (Object.prototype.hasOwnProperty.call(old, line)) lines.push(line);
    if (!lines.length) return;
    var spans = config.furiganaLineSpans;
    if (!spans || typeof spans !== "object") spans = config.furiganaLineSpans = {};
    for (var i = 0; i < lines.length; i++) {
      var text = lines[i];
      var words = old[text];
      var list = spans[text] || [];
      for (var w in words) {
        if (!Object.prototype.hasOwnProperty.call(words, w)) continue;
        var kana = String(words[w] == null ? "" : words[w]);
        var from = 0;
        while (w && from <= text.length - w.length) {
          var at = text.indexOf(w, from);
          if (at < 0) break;
          from = at + 1;
          // 空读音 = 留空，也要迁移（以前这里跳过了，老用户的留空全丢了）
          list.push([at, w, kana]);
        }
      }
      if (list.length) spans[text] = list;
    }
    config.furiganaLineFixes = {};
    saveConfig();
    if (typeof WKFurigana !== "undefined" && WKFurigana.clearCache) WKFurigana.clearCache();
  }

  /*
   * 整首的行列表（每轮扫描算一次）。
   *
   * 干什么用：问模型"这个汉字读什么"时，光给它所在的那一句还不够 ——
   * 歌词里一句话常常只是一个短语（`良ん`、`人`），前后句才看得出这是哪首歌、
   * 在念什么。真机上单句问的准确率明显偏低。
   */
  var songLinesCache = { gen: -1, lines: [] };
  function songLines() {
    if (songLinesCache.gen === songLangGen) return songLinesCache.lines;
    var out = [];
    try {
      var regions = state.annotator ? state.annotator.findRegions("lyrics") : [];
      for (var i = 0; i < regions.length; i++) {
        var t = regionText(regions[i]);
        if (t) out.push(t);
      }
    } catch (e) {
      out = [];
    }
    songLinesCache = { gen: songLangGen, lines: out };
    return out;
  }

  /** 这一句的前后各一句（拿不到就空串，提示词里会自动省略） */
  function contextAround(line) {
    var lines = songLines();
    if (!lines.length || !line) return { prev: "", next: "" };
    var idx = lines.indexOf(line);
    if (idx < 0) {
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i];
        if (!t) continue;
        if (t.indexOf(line) >= 0 || line.indexOf(t) >= 0) {
          idx = i;
          break;
        }
      }
    }
    if (idx < 0) return { prev: "", next: "" };
    return { prev: lines[idx - 1] || "", next: lines[idx + 1] || "" };
  }

  /** 这一行该用哪些修正：手填规则（按作用范围匹配） + 模型给过的（按 词+这句 缓存） */
  function furiganaFixes(line, text, host) {
    var fixes = {};
    /*
     * 最高优先级：用户在歌词界面里就地改的（双击注音改的那份）。
     *
     * 两套存法都认：
     *   - `furiganaLineSpans[整行] = [[起点, 底字, 读音], ...]`（现在用的，按位置 ——
     *     同一个字在一行里出现两次时只改点中的那一个）；
     *   - `furiganaLineFixes[整行] = {词: 读音}`（老版本，按词 —— 改一处整行同字全改，
     *     启动时已经迁成上面那套，这里留着只是兜底）。
     */
    var inline = config.furiganaLineFixes;
    if (inline && typeof inline === "object" && Object.prototype.hasOwnProperty.call(inline, line)) {
      var mine = inline[line];
      for (var k0 in mine) if (Object.prototype.hasOwnProperty.call(mine, k0)) fixes[k0] = mine[k0];
    }
    var rules = parseFuriganaRules(config.furiganaOverrides);
    for (var i = 0; i < rules.length; i++) {
      if (line.indexOf(rules[i].scope) < 0) continue;
      fixes[rules[i].word] = rules[i].kana;
    }
    /*
     * 大模型切词（单独开关 llmSegment）：让模型按整句切分并给读音，熟字训优先
     * （帷帳 とばり、今日 きょう）—— kuromoji 会把这类词切碎（帷 + 帳）。
     * 模型给的形状就是「底字 -> 读音」，正好当这一行的修正用：
     * 长词优先、和旧切片重叠的自动让开，注音逻辑一行都不用改。
     * 还没回来的句子这里拿到 null（后台已经在排队），下一轮重扫时补上。
     */
    if (config.llmSegment === true && llmAvailable() && state.llm && state.llm.segment) {
      var segs = null;
      try {
        segs = state.llm.segment(line);
      } catch (e) {
        segs = null;
      }
      for (var q2 = 0; segs && q2 < segs.length; q2++) {
        var pair = segs[q2];
        if (!pair || !pair[0] || !pair[1]) continue;
        // 手填的规则 / 就地改的读音优先于模型
        if (Object.prototype.hasOwnProperty.call(fixes, pair[0])) continue;
        fixes[pair[0]] = pair[1];
      }
    }
    /*
     * 模型的答案不在本地词表里，而是"这句歌词 + 这个词"的缓存 ——
     * 同一句里问过就带上，换一句重新问（读数本来就可能不同）。
     */
    if (llmAvailable() && state.llm && state.llm.lookup && typeof WKFurigana !== "undefined" && WKFurigana.candidates) {
      var list = null;
      try {
        list = WKFurigana.candidates(text, romajiOf(host), {
          kana: config.furiganaKana === "katakana" ? "katakana" : "hiragana",
        });
      } catch (e) {
        list = null;
      }
      var around = contextAround(line);
      var extra = { kind: "ja", romaji: romajiOf(host) || "", prev: around.prev, next: around.next };
      for (var j = 0; list && j < list.length; j++) {
        var word = list[j].text;
        if (Object.prototype.hasOwnProperty.call(fixes, word)) continue; // 手填的优先
        var got = null;
        try {
          got = state.llm.lookup(word, line, null, extra);
        } catch (e2) {
          got = null;
        }
        if (got) {
          fixes[word] = got;
          continue;
        }
        try {
          state.llm.want(word, line, null, extra);
        } catch (e3) {
          /* 记不上不影响注音 */
        }
      }
    }
    return fixes;
  }

  /** 同一条歌词的音译层（RNP / NCM 都可能把罗马音放在兄弟节点里） */
  function romajiOf(host) {
    var box = host && host.parentNode;
    for (var depth = 0; box && depth < 2; depth++) {
      var kids = box.children || [];
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        if (el === host) continue;
        var cn = typeof el.className === "string" ? el.className : "";
        if (/romaji|romanized/i.test(cn)) return el.textContent || "";
      }
      box = box.parentNode;
    }
    return "";
  }

  /**
   * 日语行的振假名 token：汉字片段交给 core/furigana.js（kuromoji + IPADIC）。
   *
   * 词典是懒加载的：这一趟读不到就返回 null，等 onReady 触发重扫时再补上。
   * 面板里关掉之后一条都不产出（现有注音由 rescan 里的 restore 撤掉）。
   */
  function furiganaTokens(s, context, host, offset, lineText) {
    if (config.furigana === false) return null;
    if (typeof WKFurigana === "undefined") return null;
    /*
     * 用哪段文字当"整行"：优先注音层算好的 __wkLineText（只含原文、不含翻译层），
     * 它比 context 可靠 —— 逐字歌词里 context 可能就退化成一个字。
     */
    /*
     * 整行文本：优先用注音层算好的 __wkLineText（只含原文），
     * 它就算和这一段一样长也要用它 —— 退到 context 的话，RNP 里那串
     * "原文 + 罗马音 + 翻译"会被当成整行，偏移量全对不上，整行反而注不出来。
     */
    var line = "";
    if (lineText && lineText.length >= s.length) line = lineText;
    else if (context && context.length > s.length) line = context;
    if (!line) line = s;
    var fixes = furiganaFixes(line, s, host);
    var spans = lineSpans(line);
    /*
     * 逐字歌词：一行被拆成"一个字一个节点"，这个节点的起点是 offset。
     * 按整行分词，再把**词的第一个字**对回这个节点 —— 只注一次，读音是整词的
     * （物語 ものがたり，而不是 物 モノ + 語 ゴ）。
     */
    if (typeof offset === "number" && line && line.length > s.length) {
      var whole = WKFurigana.tokens(line, {
        kana: config.furiganaKana === "katakana" ? "katakana" : "hiragana",
        fixes: fixes,
        spans: spans,
      });
      if (!whole || !whole.length) return null;
      var mine = [];
      for (var i = 0; i < whole.length; i++) {
        var tk = whole[i];
        if (tk.start < offset || tk.start >= offset + s.length) continue; // 只认"起点落在这个节点里"的词
        var localStart = tk.start - offset;
        var localEnd = Math.min(localStart + (tk.end - tk.start), s.length);
        var piece = s.slice(localStart, localEnd);
        if (!piece) continue;
        /*
         * 对齐校验：这个词的第一个字必须正好是这个节点里的这个字。
         * 节点偏移量在"注音完一遍之后"可能因为空文本节点/我们插的节点算歪一格，
         * 歪了就会把 帳 注成 帷 的读音（とばり）。对不上就宁可不注。
         */
        if (piece.charAt(0) !== tk.text.charAt(0)) continue;
        mine.push({ text: piece, start: localStart, end: localEnd, kana: tk.kana, kind: tk.kind, hide: tk.hide });
      }
      return mine.length ? mine : null;
    }
    var out = WKFurigana.tokens(s, {
      kana: config.furiganaKana === "katakana" ? "katakana" : "hiragana",
      fixes: fixes,
      spans: spans,
    });
    return out && out.length ? out : null;
  }

  /**
   * 汉字 / 谚文的注音 token（core/cjk.js 扫出来，读音已经定好）。
   *
   * 两道闸门，缺一不可：
   *   1. 这一行有假名 -> 是日语行，一个字都不碰（`東京` 要读 トウキョウ，不是 ドンジン）；
   *   2. 整首是日语歌 -> 同理，歌里夹的纯汉字行也不碰。
   * 非日语歌整首跳过那一档（annotateNonJapanese = false）在 pass() 里就返回了，到不了这里。
   */
  function cjkTokens(text, context) {
    var han = config.annotateHanzi === true;
    var hangul = config.annotateHangul === true;
    if (!han && !hangul) return null;
    if (typeof WKCJK === "undefined") return null;
    var s = String(text == null ? "" : text);
    if (!s) return null;
    var hasHan = han && WKCJK.hasHan(s);
    var hasHangul = hangul && WKCJK.hasHangul(s);
    if (!hasHan && !hasHangul) return null;
    if (RE_KANA_ANY.test(s)) return null;
    /*
     * 这里不再按"整首是不是日语歌"拦：分流已经在 extraTokens 里按行做完了
     * （日语歌里夹的中文行要能走到这里，按普通话读音注）。
     */
    var out = WKCJK.scan(s, { han: hasHan, hangul: hasHangul });
    if (!out || !out.length) return null;
    /*
     * 多音字：离线表只给"最常见的那一档"，所以再问一次大模型，由它按这一句挑候选读音。
     *
     *   - 已经有答案：直接用（source 记 llm，"按来源着色"能看出来）
     *   - 还没问过：先用离线读音顶着、标成暂定（wk-pending），同时把这句记进队列；
     *     答案回来后 relabel() 会走 resolveReading 拿到它并改写
     *   - 这一层没开 / 没配 key：什么都不做，就用离线读音
     */
    var line = context || s;
    for (var i = 0; i < out.length; i++) {
      var tk = out[i];
      if (tk.kind !== "han") continue;
      var opts = polyOptions(tk.text);
      if (!opts) continue;
      var fixed = hanziFromLLM(tk.text, line);
      if (fixed) {
        tk.kana = fixed.kana;
        tk.source = "llm";
      } else if (llmAvailable() && state.llm) {
        try {
          state.llm.want(tk.text, line, opts);
        } catch (e) {
          /* 记不上不影响注音 */
        }
      }
    }
    return out;
  }

  /**
   * 注音层的 extraTokens：按"这一段文字是不是日文"分岔。
   *
   *   - 日文 -> 振假名（汉字标读音，平/片假名看配置）
   *   - 中文 / 朝鲜语 -> core/cjk.js，逐字
   *
   * **判语种看这一段自己的文字（s），不看整块的 context**：真机上"极简歌词"那种卡面
   * 把 原文 + 罗马音 + 中文翻译 塞进同一个元素，拿 context 去判会读到同一块里的中文翻译，
   * 于是日文原文被当成中文、逐字注上普通话读音（真机现象：`妄想感傷代償連盟` 上面是 ワンシャン…）。
   */
  function extraTokens(text, context, host, offset, lineText) {
    var s = String(text == null ? "" : text);
    if (!s) return null;
    if (nodeLooksJapanese(s, lineText, context, offset)) return furiganaTokens(s, context, host, offset, lineText);
    return cjkTokens(s, context);
  }

  /**
   * 这一小段该按日文注吗。
   *
   * 逐字歌词把一行拆成"一个字一个节点"，单看一个字根本分不出语种：
   *   `莉` / `雫` 在 `(ツンデレ・ガール 愛莉)` / `(G・U・T・S雫)` 里是日文
   *   （り / しずく），在中文歌里就是中文（真机现象：莉 被注成 リ、雫 被注成 ナ，
   *   都是按普通话读音来的）。
   *
   * 所以"这一小段自己没假名、又短得看不出语种"时，借**整行原文**
   * （注音层算好的 __wkLineText，只含原文、不含翻译层）来判。
   * 仍然守住原来的底线：整块 context 可能混着中文翻译，只在最后才退到它。
   */
  function nodeLooksJapanese(s, lineText, context, offset) {
    if (RE_KANA_ANY.test(s)) return true;
    /*
     * 逐字歌词：这几个字的语种由**整行**决定，不单独判。
     * 单独判会走"这一行没有中文痕迹、日语词典又读得出 → 当日语"那条（见 lineLooksJapanese），
     * 于是中文行里的 `害` 会被读成 がい。
     */
    if (typeof offset === "number" && s.length <= 4) {
      /*
       * 优先用注音层算好的整行原文（\`__wkLineText\`，只含原文）；
       * 只有它拿不到时才退到 context —— context 可能是"原文 + 罗马音 + 翻译"
       * 混在一起的容器，拿它判语种会被翻译里的中文带偏（真机现象：RNP 的
       * 「今夜、」被按普通话注成 ジンイェ）。
       */
      var line = lineText || context || "";
      if (line && line.length > s.length) return lineLooksJapanese(line);
    }
    return lineLooksJapanese(s);
  }

  /** 这个汉字是不是多音字；是就返回它构建期算好的候选读音 */
  function polyOptions(ch) {
    if (typeof WKHanzi === "undefined" || !WKHanzi.vary) return null;
    if (!Object.prototype.hasOwnProperty.call(WKHanzi.vary, ch)) return null;
    var list = WKHanzi.vary[ch];
    return list && list.length > 1 ? list : null;
  }

  /** 大模型对这个多音字在这句里的答案（没有 / 不在候选里都返回 null） */
  function hanziFromLLM(ch, line) {
    if (!llmAvailable() || !state.llm) return null;
    var opts = polyOptions(ch);
    if (!opts) return null;
    var got = null;
    try {
      got = state.llm.lookup(ch, line, opts);
    } catch (e) {
      got = null;
    }
    if (!got || typeof got !== "string") return null;
    // 只认候选里的那一个（模型自己造的读音不用，理由见 core/llm.js 的提示词）
    if (opts.indexOf(got) < 0) return null;
    return { kana: got, source: "llm" };
  }

  /** 整首专属读音（见 SONG_READINGS）的缓存：同一首歌不必每轮重算 */
  var songScopeCache = { key: null, words: null };
  /**
   * 一个区域的"可见原文"（不含任何注音）。
   *
   * 判"这首歌是不是日语歌"、判整首语种、匹配整首专属读音都必须用它，不能直接用
   * textContent —— 注音之后 textContent 里全是片假名，会被当成"这行有假名"：
   * 第一行注完之后整首就被判成日语歌，后面几行不再注音（中文 / 朝鲜语那档
   * 在真机上就只标了当前一句）。
   */
  function regionText(region) {
    try {
      if (!region) return "";
      /*
       * 一律用我们自己的 walker（originalText）：它只跳过 <rt> / 隐藏的括号注音 /
       * 音译翻译层，**保留 ruby 的底字**。
       * 以前这里先用 textOf()（annotator 的 visibleText），它会连底字一起跳过 ——
       * 于是 `(aha) 唸る 808` 这种行算出来的行文本是 `() 唸る 808`，
       * 就地改读音存的键和注音时对不上，改了不生效（用户报的 808 就是这样）。
       */
      /*
       * RNP 的一个区域是 \`div.rnp-lyrics-line\`，里面装着 -original / -romaji / -translated 三层。
       * 整块取文字会把**罗马音和中文翻译**也算成这一行的原文 ——
       * 于是「今夜、」这种纯汉字日语行的判据里混进了中文翻译，整首被投票成中文歌，
       * 行也被按普通话注成 ジンイェ（真机现象）。
       * 这里和注音层用同一套"跳过哪些子层"的判据，只取原文。
       */
      return originalText(region);
    } catch (e) {
      return "";
    }
  }

  /** 区域里"原文"那部分（跳过音译 / 翻译层和注音本身） */
  function originalText(region) {
    var out = "";
    try {
      var walker = document.createTreeWalker(region, 4, null, false); // 4 = SHOW_TEXT
      var node;
      while ((node = walker.nextNode())) {
        var p = node.parentNode;
        var skipped = false;
        for (var q = p; q && q !== region.parentNode; q = q.parentNode) {
          if (!q || q.nodeType !== 1) continue;
          if (q.tagName === "RT" || q.tagName === "RP") {
            skipped = true;
            break;
          }
          var cn = typeof q.className === "string" ? q.className : "";
          // 只跳过注音（wk-rt）；wk-hide 是作词者写的括号读音，属于原文，要算进行文本
          if (/(^|\s)wk-rt(\s|$)/.test(cn)) {
            skipped = true;
            break;
          }
          /*
           * 到了我们自己的 ruby 就停：里面是**底字**（原文），要算进来。
           * 不特判的话会踩到下面 fontSkipped 的坑 —— ruby 的来源 class 可能是
           * `wk-src-romaji`，而那个判据里有 romaji 字样，整块底字就被当成音译层跳过了
           * （真机现象：`(aha) 唸る 808` 的行文本变成 `() 唸る 808`，就地改读音对不上）。
           */
          if (/(^|\s)(wk-ruby|kt-ruby|fg-ruby)(\s|$)/.test(cn)) break;
          if (q !== region && fontSkipped(q)) {
            skipped = true;
            break;
          }
        }
        if (skipped) continue;
        if (node.parentNode === region && !String(node.nodeValue || "").replace(/\s+/g, "")) continue;
        out += node.nodeValue || "";
      }
    } catch (e) {
      return out;
    }
    return out;
  }

  function songLooksJapanese() {
    if (songJaGen === songLangGen) return songJaValue;
    songJaGen = songLangGen;
    songJaValue = computeSongLooksJapanese();
    return songJaValue;
  }

  function computeSongLooksJapanese() {
    if (!state.annotator || !state.annotator.findRegions) return true;
    var regions = [];
    try {
      regions = state.annotator.findRegions("lyrics");
    } catch (e) {
      return true;
    }
    if (!regions || !regions.length) return true; // 歌词还没加载出来：先别下结论
    for (var i = 0; i < regions.length; i++) {
      if (RE_KANA_ANY.test(regionText(regions[i]))) return true;
    }
    return false;
  }

  function pass() {
    if (!config.enabled || !state.annotator) return;
    /*
     * 新一轮扫描：语种投票 / 整首判定要重算一次（见 songKind 上面的说明）。
     * 只在这一处加一，这样一轮 pass 里几百个节点共用同一个结论。
     */
    songLangGen++;
    if (emergencyOff()) {
      warn("检测到紧急开关，停用插件");
      disable();
      return;
    }
    /*
     * 设置里关掉「非日语歌也注音」时：整首跳过（连播放栏标题一起），
     * 并把之前已经注上的撤掉 —— 否则换歌之后还留着上一首的注音。
     */
    if (config.annotateNonJapanese === false && !songLooksJapanese()) {
      try {
        if (state.annotator.injectedCount && state.annotator.injectedCount() > 0) state.annotator.restoreAll();
      } catch (e0) {
        /* 还原失败不影响下面 */
      }
      state.lastResult = { scanned: 0, changed: 0, restored: 0, skipped: 0, unstable: 0, nonJapanese: true };
      return;
    }
    var t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      /*
       * 先定"整首专属读音"是哪一张（见 SONG_READINGS）：换歌之后这一句会重算，
       * 之后注音层查到的 `state.songWords` 就是这首歌的。
       */
      updateSongScope();
      updateJapaneseFont();
      var regions = null;
      if (config.scope === "lyrics") regions = state.annotator.findRegions("lyrics");
      else if (config.scope === "titles") regions = state.annotator.findRegions("titles");
      else if (config.scope === "custom") {
        regions = state.annotator.customRegions(config.customSelector);
        if (!regions.length) regions = state.annotator.findRegions("safe");
      } else if (!config.annotateAll) {
        regions = state.annotator.findRegions("lyrics");
      }
      state.lastResult = state.annotator.pass(regions);
      // 行距用 pass 交回来的"原文行"，不再自己查一遍 DOM（见 updateLineHeight 的说明）
      updateLineHeight(state.lastResult && state.lastResult.lyricRegions);
      /*
       * "扫到了歌词区域，却一个注音都没加上"是最常见的那种故障（"这首歌整页都没
       * 注音"）。原因（图案行 / 署名行 / 无译文 / 认输期）只写在控制台的 skips 里，
       * 界面上看不到 —— 顺手写进轨迹，下次直接读轨迹就知道是哪一条吃掉的。
       * 只在"确实扫到了区域但一个都没改"时记，平时不占轨迹。
       */
      if (state.lastResult && state.lastResult.scanned > 0 && state.lastResult.changed === 0) {
        trace(
          "blank",
          "regions=" +
            state.lastResult.scanned +
            " " +
            ((state.lastResult.skips && state.lastResult.skips.join(" | ")) || "（没有跳过记录）")
        );
      }
      /*
       * 这一轮有节点因为「文本在动」（换歌/滚动把手抖的那几轮）或「认输期」被跳过时，
       * 注音层会告诉我们过多久可以重试。必须自己排下一次扫描：
       * 换歌之后如果页面不再变动（最典型的是歌处于暂停，歌词渲染一次就不动了），
       * 就再也没有事件来触发下一轮 —— 那一行会一直空着，看着就像插件坏了。
       */
      if (state.lastResult && state.lastResult.retryInMs > 0) {
        schedule(state.lastResult.retryInMs);
      }
    } catch (e) {
      state.error = (e && e.message) || String(e);
      warn("扫描异常", e);
    } finally {
      // MutationObserver 的回调在本轮同步任务之后才跑，光靠标志位挡不住
      // 我们自己造成的变更；把记录队列清空，否则会自激成死循环。
      if (state.observer) state.observer.takeRecords();
      state.lastPassMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
      state.lastPassAt = Date.now();
    }
  }

  /**
   * 合并短时间内的多次触发，最多排一个待执行的 pass。
   *
   * delay=0 表示「观测到 DOM 变了，要立刻补注音」：必须赶在下一帧绘制之前
   * 跑完，否则那一帧画出来就是没有注音的样子 —— 肉眼就是一闪。
   */
  var MIN_PASS_GAP_MS = 40;
  function schedule(delay) {
    if (state.timer) return;
    var d = delay == null ? 250 : delay;
    if (d > 0) {
      state.timer = setTimeout(function () {
        state.timer = null;
        pass();
      }, d);
      return;
    }
    var since = Date.now() - (state.lastPassAt || 0);
    var wait = since < MIN_PASS_GAP_MS ? MIN_PASS_GAP_MS - since : 0;
    var run = function () {
      state.timer = null;
      state.timerIsRaf = false;
      pass();
    };
    if (wait > 0) {
      state.timer = setTimeout(run, wait);
      return;
    }
    if (typeof requestAnimationFrame === "function") {
      state.timer = requestAnimationFrame(run);
      state.timerIsRaf = true;
    } else {
      state.timer = setTimeout(run, 0);
    }
  }

  function startObserver() {
    if (state.observer) return;
    var observer = new MutationObserver(function (records) {
      try {
        var relevant = false;
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          if (r.type === "characterData" || r.type === "childList") {
            relevant = true;
            break;
          }
        }
        if (relevant) schedule(0);
      } catch (e) {
        warn("MutationObserver 回调异常", e);
      }
    });
    state.observer = observer;
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // 兜底：observer 可能漏掉（React 换了元素、或我们自己在 pass 里清了记录）。
    state.tickTimer = setInterval(function () {
      if (!config.enabled || !state.annotator) return;
      schedule(0);
    }, 1500);
    if (state.tickTimer && typeof state.tickTimer.unref === "function") state.tickTimer.unref();
  }

  // ------------------------------------------------------------ 启用/禁用

  function enable() {
    if (!state.annotator) return;
    if (!state.applied) {
      state.applied = true;
      startObserver();
    }
    // 停用时把 <style> 一并摘掉了，启用时要补回来
    updateStyles();
    schedule(0);
  }

  function disable() {
    state.applied = false;
    if (state.timer) {
      clearTimeout(state.timer);
      if (state.timerIsRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(state.timer);
      state.timer = null;
      state.timerIsRaf = false;
    }
    if (state.annotator) state.annotator.restoreAll();
    // 内联行高是我们写的，停用时要一起收走（DOM 还原测试会逐字节比对）
    clearLineHeights();
    if (typeof WKAnnotate !== "undefined" && WKAnnotate.removeStyles) {
      WKAnnotate.removeStyles(document);
    }
  }

  function rescan() {
    if (state.annotator) state.annotator.restoreAll();
    if (state.corrector) state.corrector.retryMisses();
    schedule(0);
  }

  /*
   * 大模型切词（llmSegment）的结果回来了：把这些行**重扫一遍**。
   *
   * 为什么不能只 relabel()：新切分常常把两个已经注好的 ruby 合成一个词
   * （帷 とばり + 帳 ちょう → 帷帳 とばり），relabel 只会改写已有 ruby 的读音，
   * 合不成一个，旧的错切分会一直留在屏幕上。
   * 一批 6 句、一首歌七八批，所以攒一下再扫（每批都整块重扫会看着在闪）。
   */
  var segRescanPending = {};
  var segRescanTimer = null;
  function scheduleSegRescan(lines) {
    for (var i = 0; lines && i < lines.length; i++) segRescanPending[lines[i]] = 1;
    if (segRescanTimer) return;
    segRescanTimer = setTimeout(function () {
      segRescanTimer = null;
      var want = segRescanPending;
      segRescanPending = {};
      if (!config.enabled || !state.annotator || !state.annotator.rescanRegions) return;
      var regions = [];
      try {
        regions = state.annotator.findRegions("lyrics");
      } catch (e) {
        return;
      }
      /*
       * 按"包含"匹配就够了：调用方给的可能是宿主可见原文（RNP 里带罗马音 / 翻译），
       * 和区域原文不是逐字节相等。宁可多重扫一行，也别漏掉那一行。
       */
      var hit = [];
      for (var j = 0; j < regions.length; j++) {
        var t = regionText(regions[j]);
        if (!t) continue;
        for (var k2 in want) {
          if (!Object.prototype.hasOwnProperty.call(want, k2)) continue;
          if (!k2) continue;
          if (t.indexOf(k2) >= 0 || k2.indexOf(t) >= 0) {
            hit.push(regions[j]);
            break;
          }
        }
      }
      if (!hit.length) return;
      try {
        state.annotator.rescanRegions(hit);
      } catch (e2) {
        /* 重扫失败不影响别处 */
      }
      notifyConfigUI();
    }, 400);
  }

  /**
   * 日语歌的歌词字体。
   *
   * 两条腿一起走，为什么：
   *   - 样式表（<head> 里那条规则）覆盖面广，但真机上**不生效** —— 播放页的歌词
   *     NCM 自己用更高优先级的规则（或内联样式）钉死了 font-family，我们的 !important
   *     照样输。面板里的预览用的是内联样式，所以预览有效、歌词没效，就是这个原因。
   *   - 所以真正起作用的是**内联样式**：给注音层已经标过的区域（[data-wk-region]）逐个
   *     写 `style="font-family: … !important"`，只有它压得过页面自己的规则。
   *     每个元素只写一次（值相同就跳过），关掉时按印记 data-wk-font 撤掉。
   *
   * 样式表留着当兜底：还没注过音的行（第一轮之前）先按它渲染，不至于闪一下。
   */
  var jpFontCss = null;

  /** 罗马音 / 翻译 / 占位那一类行：注音层不碰，字体也不许换（换了中文翻译行会变日文字形） */
  var RE_FONT_SKIP = /rnp-lyrics-(?:overview-)?line-(?:romaji|translated|translation|placeholder)|lyricSubLine|lyricSubText|lyricTrans|(?:^|[\s_-])(?:romaji|romanized|translated|translation|transLine|transText)(?:[\s_-]|$)/i;

  function fontSkipped(el) {
    var cn = el && typeof el.className === "string" ? el.className : "";
    return RE_FONT_SKIP.test(cn);
  }

  /**
   * 这一行该不该换日文字体。
   *
   * 判据看这一行**自己的直接文本**长什么样，不按选择器猜：
   *   - 直接文本里有假名 -> 日文原文行，换
   *   - 罗马音 / 中文翻译那一类（class 已经是这几种）-> 不换
   *   - 直接文本里没有汉字（纯拉丁 = 罗马音行）-> 不换
   *   - 有汉字但明显是中文（core/cn-line.js 判）-> 不换
   *   - 其余（纯汉字日文行，比如 `東京`）-> 换
   */
  function ownText(el) {
    var t = "";
    try {
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) t += n.nodeValue || "";
      }
    } catch (e) {
      return "";
    }
    return t;
  }

  function wantsJapaneseFont(el, text) {
    var t = typeof text === "string" ? text : ownText(el);
    if (!t) return false;
    if (RE_KANA_ANY.test(t)) return true;
    if (fontSkipped(el)) return false;
    if (!/[\u4E00-\u9FFF]/.test(t)) return false;
    /*
     * 和注音层用同一套「这一行是不是日文」的判据。
     * 以前这里只问 isChineseLine，中文歌里那些"没有中文特有字形"的纯汉字行
     * （`不用害怕` / `毫不得意`）就全被换成了日文字形（真机现象：中文歌词显示成日文字体）。
     */
    if (typeof WKCnLine !== "undefined" && WKCnLine.isChineseLine && WKCnLine.isChineseLine(t)) return false;
    return lineLooksJapanese(t);
  }

  /**
   * 找出"真的要换字体"的最内层元素。
   *
   * 为什么不能直接给区域容器写字体：真机上"极简歌词"那种一行的三行排版是把
   * 原文 / 罗马音 / 中文翻译塞进**同一个容器**的，给容器写 font-family，三行一起变 ——
   * 中文和罗马字按日文字形渲染，很丑。所以往下钻，只认"自己的直接文本里有假名"的那一层。
   */
  function fontTargets(root) {
    var out = [];
    function walk(el) {
      if (!el || el.nodeType !== 1) return;
      var own = ownText(el);
      if (own && wantsJapaneseFont(el, own)) {
        out.push(el);
        return; // 这一层就是原文行，不再往下
      }
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) walk(c);
    }
    walk(root);
    return out;
  }

  /**
   * 找出"每一行原文"的最内层元素（行距写在这上面）。
   *
   * 为什么不能直接写在**区域**上：RNP 一个区域是 `div.rnp-lyrics-line`，
   * 里面装着 `-original` / `-romaji` / `-translated` 三层 —— 给区域写 line-height，
   * 罗马音和翻译那两行也会跟着变（真机现象：音译/翻译行的行距也被改了）。
   * 所以往下钻到"自己有直接文本、又不是音译/翻译层"的那一层。
   */
  function lineTargets(root) {
    var out = [];
    function walk(el) {
      if (!el || el.nodeType !== 1) return;
      if (fontSkipped(el)) return; // -romaji / -translated / 占位行
      var own = ownText(el);
      // 只有空白（换行 / 缩进）不算"这一层是原文行"，继续往下钻
      if (own && own.replace(/\s+/g, "")) {
        out.push(el);
        return; // 这一层就是一行原文，不再往下
      }
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) walk(c);
    }
    walk(root);
    return out;
  }

  /**
   * 把字体写进目标元素的内联样式；family 为空 = 撤掉我们写过的那些。
   *
   * 真机上只有内联样式压得过播放页自己的规则（面板预览也是内联，所以预览一直有效）。
   */
  function applyJapaneseFontInline(family) {
    var targets = [];
    var seen = [];
    function add(el) {
      if (!el || el.nodeType !== 1 || !el.style) return;
      if (seen.indexOf(el) >= 0) return;
      seen.push(el);
      targets.push(el);
    }
    function scan(root) {
      var list = fontTargets(root);
      for (var i = 0; i < list.length; i++) add(list[i]);
    }
    try {
      var tagged = document.querySelectorAll("[data-wk-region]");
      for (var i = 0; i < tagged.length; i++) scan(tagged[i]);
    } catch (e) {
      /* 查不到就算了 */
    }
    try {
      if (state.annotator && state.annotator.findRegions) {
        var regions = state.annotator.findRegions("lyrics");
        for (var j = 0; j < regions.length; j++) scan(regions[j]);
      }
    } catch (e2) {
      /* 同上 */
    }
    /*
     * 以前写过、现在不该写的元素也要能撤掉（换行 / 语言变了 / 关掉开关）。
     * 这些元素上一定留着 data-wk-font 印记，直接按它找。
     */
    try {
      var marked = document.querySelectorAll("[data-wk-font]");
      for (var m = 0; m < marked.length; m++) {
        var old = marked[m];
        if (targets.indexOf(old) >= 0) continue;
        if (family && wantsJapaneseFont(old)) add(old);
        else {
          try {
            old.style.removeProperty("font-family");
            old.removeAttribute("data-wk-font");
          } catch (eOld) {
            /* 撤不掉就算 */
          }
        }
      }
    } catch (e3) {
      /* 同上 */
    }
    for (var k = 0; k < targets.length; k++) {
      var el = targets[k];
      try {
        if (family) {
          var now = el.style.getPropertyValue("font-family");
          var pri = el.style.getPropertyPriority("font-family");
          if (now !== family || pri !== "important") el.style.setProperty("font-family", family, "important");
          if (el.getAttribute("data-wk-font") !== "1") el.setAttribute("data-wk-font", "1");
        } else if (el.getAttribute("data-wk-font") === "1") {
          el.style.removeProperty("font-family");
          el.removeAttribute("data-wk-font");
        }
      } catch (e4) {
        /* 单个元素写不进去不影响其它行 */
      }
    }
  }

  function updateJapaneseFont() {
    var want = config.jpnFont === true && songLooksJapanese();
    if (want) applyJapaneseFontInline(fontStack(config.jpnFontFamily));
    else applyJapaneseFontInline("");
    /*
     * 样式表整个不用了：它只能按选择器命中，而真机上"原文 / 罗马音 / 翻译"常常在同一个
     * 容器里（或者都匹配同一批选择器），写成 `SEL, SEL *` 会连子节点一起换。
     * 真正起作用的一直是内联样式（面板预览也是内联），这里只负责把老版本留下的样式表收走。
     */
    try {
      var el = document.getElementById("lyric-ruby-font");
      if (el && el.parentNode) el.parentNode.removeChild(el);
    } catch (e) {
      /* 没有就算了 */
    }
    jpFontCss = want ? "inline" : "";
  }

  /**
   * 统一行距。
   *
   * 有注音的行会被 <rt> 撑高一点，于是"唱到那行时整块歌词往上跳"。
   * 只靠 rt 的 line-height 归零不够（不同歌词插件对行高的写法不一样），
   * 干脆给**每一行原文**一个固定的 line-height：有注音、没注音一样高。
   *
   * 只碰原文行，**不碰音译 / 翻译**：以前写的是一条 CSS 规则
   * （`ul.lyric li p` + `[data-wk-region]`），而网易云默认页一行是
   * `li.line > p × 2`（第一个 p 原文、第二个 p 中文翻译）—— 选择器把翻译那一行
   * 也一起改了行高（真机现象：音译/翻译行忽宽忽窄，和原文对不上）。
   * 现在改成**逐元素内联样式**，作用的正是注音层认下的那些"原文行"
   * （findRegions("lyrics") 已经把翻译层和 RNP 的 -romaji / -translated 踢掉了）。
   */
  var lhEls = [];
  /** 撤掉所有内联行高（停用 / 关掉开关时用） */
  function clearLineHeights() {
    for (var i = 0; i < lhEls.length; i++) {
      try {
        if (lhEls[i] && lhEls[i].style) lhEls[i].style.removeProperty("line-height");
      } catch (e) {
        /* 元素已经丢了就算了 */
      }
    }
    lhEls = [];
  }
  /**
   * @param {Array<Element>} [regions] 这次要覆盖的"原文行"，由 annotate 的 pass() 交回来。
   *        不给时自己查一遍（改设置、面板预览这种一次性调用）。
   *
   * 性能上必须做到两件事，否则歌词滚动会发涩（真机报过"卡"）：
   *   1. 不要自己再调 findRegions("lyrics") —— 那是 11 个选择器 + 逐元素可见性判断，
   *      每轮扫描多查一遍 DOM，代价比注音本身还大；
   *   2. 已经写过同一个值的元素**一个字都别再写** —— 写 style 会触发样式重算，
   *      每轮给几十行写一遍就是稳定掉帧。
   */
  function updateLineHeight(regions) {
    var want = config.uniformLineHeight !== false;
    var lh = Number(config.lineHeight);
    if (!(lh >= 1.1 && lh <= 3)) lh = 1.6;
    var v = String(lh);
    var list = regions;
    if (!list && want && state.annotator && state.annotator.findRegions) {
      try {
        list = state.annotator.findRegions("lyrics");
      } catch (e) {
        list = [];
      }
    }
    if (!list) list = [];
    /*
     * 区域 -> 真正的"原文行"那一层（RNP 的区域包着 romaji / translated 三层，
     * 写在这上面那两行也会跟着变）。这一步只是往下钻一层，很便宜。
     */
    if (list.length) {
      var leaves = [];
      for (var li0 = 0; li0 < list.length; li0++) {
        var sub = lineTargets(list[li0]);
        if (!sub.length) continue;
        for (var sj = 0; sj < sub.length; sj++) leaves.push(sub[sj]);
      }
      list = leaves;
    }
    if (!want) {
      // 关掉开关：把写过的内联行高全撤掉，然后什么都不加
      clearLineHeights();
      try {
        var css0 = document.getElementById("lyric-ruby-lineheight");
        if (css0 && css0.parentNode) css0.parentNode.removeChild(css0);
      } catch (e6) {
        /* 没有就算了 */
      }
      return;
    }
    // 稳态：这一批元素身上已经都是这个值 → 直接返回（这条是滚动流畅的关键）
    if (want && list.length === lhEls.length) {
      var same = true;
      for (var s = 0; s < list.length; s++) {
        var el0 = list[s];
        if (el0 !== lhEls[s] || !el0 || !el0.style) {
          same = false;
          break;
        }
        try {
          if (el0.style.getPropertyValue("line-height") !== v) {
            same = false;
            break;
          }
        } catch (e0) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    // 撤掉已经不在这一批里的（换歌 / 关掉开关）
    for (var i = lhEls.length - 1; i >= 0; i--) {
      var old = lhEls[i];
      if (list.indexOf(old) >= 0) continue;
      lhEls.splice(i, 1);
      try {
        if (old && old.style) old.style.removeProperty("line-height");
      } catch (e2) {
        /* 元素已经被丢掉就算了 */
      }
    }
    if (want) {
      for (var k = 0; k < list.length; k++) {
        var el = list[k];
        if (!el || !el.style) continue;
        var cur = "";
        try {
          cur = el.style.getPropertyValue("line-height");
        } catch (e3) {
          cur = "";
        }
        if (cur !== v) {
          try {
            el.style.setProperty("line-height", v, "important");
          } catch (e4) {
            continue;
          }
        }
        if (lhEls.indexOf(el) < 0) lhEls.push(el);
      }
    }
    // 1.8.0 之前写的是样式表，留在这里会连翻译行一起改，收走
    try {
      var css = document.getElementById("lyric-ruby-lineheight");
      if (css && css.parentNode) css.parentNode.removeChild(css);
    } catch (e5) {
      /* 没有就算了 */
    }
  }

  function updateStyles() {
    if (typeof WKAnnotate !== "undefined" && WKAnnotate.applyStyles) {
      WKAnnotate.applyStyles(document, {
        rtSize: config.rtSize,
        rtOpacity: config.rtOpacity,
        colorBySource: !!config.colorBySource,
      });
    }
  }

  // ------------------------------------------------------------ 设置面板

  var REPO = REPO_URL;

  function buildConfigUI() {
    var root = document.createElement("div");
    root.id = "lyric-ruby-config";
    root.innerHTML =
      "<style>" +
      "#lyric-ruby-config { font-size: 14px; line-height: 1.9; }" +
      "#lyric-ruby-config h3 { margin: 12px 0 4px; font-size: 15px; }" +
      "#lyric-ruby-config .wk-row { margin: 3px 0; }" +
      "#lyric-ruby-config .wk-hint { opacity: .65; font-size: 12px; line-height: 1.5; }" +
      "#lyric-ruby-config input[type=text], #lyric-ruby-config input[type=password] { width: 300px; padding: 2px 6px; }" +
      "#lyric-ruby-config textarea { width: 320px; padding: 4px 6px; font-family: inherit; font-size: 13px; line-height: 1.5; vertical-align: top; }" +
      "#lyric-ruby-config .wk-preview { padding: 8px 10px; border: 1px solid rgba(128,128,128,.35); border-radius: 6px; font-size: 18px; }" +
      "#lyric-ruby-config .wk-preview-trans { margin-top: 2px; font-size: 14px; opacity: .6; }" +
      "#lyric-ruby-config .wk-preview { background: linear-gradient(darkslategray 0%, midnightblue 100%); color: #fff; }" +
      "#lyric-ruby-config .wk-pv-line { font-size: 22px; line-height: 2.3; }" +
      "#lyric-ruby-config .wk-pv-line.wk-pv-dim { font-size: 17px; line-height: 2.5; }" +
      "#lyric-ruby-config .wk-preview rt.wk-rt { font-size: 55%; line-height: 1.1; }" +
      "#lyric-ruby-config .wk-pv-bold { font-weight: bold; }" +
      "#lyric-ruby-config .wk-pv-dim { font-size: 18px; opacity: .75; }" +
      "#lyric-ruby-config .wk-llm-state { margin: 2px 0; }" +
      "#lyric-ruby-config .wk-layer { display: flex; align-items: center; gap: 6px; line-height: 1.8; }" +
      "#lyric-ruby-config .wk-layer-name { min-width: 110px; }" +
      "#lyric-ruby-config .wk-layer-note { opacity: .6; font-size: 12px; flex: 1; }" +
      "#lyric-ruby-config .wk-layer-btn { min-width: 26px; }" +
      "#lyric-ruby-config .wk-layer-btn[disabled] { opacity: .35; }" +
      "#lyric-ruby-config .wk-layer-warn { color: #e8a33d; margin-top: 4px; }" +
      "#lyric-ruby-config .wk-warn { color: #e8a33d; }" +
      "#lyric-ruby-config .wk-links { margin-bottom: 4px; }" +
      "#lyric-ruby-config .wk-links a { margin-right: 14px; }" +
      // 高级设置整块折叠：面板默认只有"开关 / 大模型 / 预览"三块，其余收起来
      "#lyric-ruby-config details.wk-adv { margin-top: 12px; border-top: 1px solid rgba(128,128,128,.25); padding-top: 6px; }" +
      "#lyric-ruby-config details.wk-adv > summary { cursor: pointer; opacity: .8; }" +
      "#lyric-ruby-config details.wk-adv > summary:hover { opacity: 1; }" +
      "</style>" +
      '<div class="wk-links">' +
      '<a href="#" data-open="' + REPO + '">源码仓库</a>' +
      '<a href="#" data-open="' + REPO + '/issues">反馈问题</a>' +
      "</div>" +
      /*
       * 主面板只放"天天会动的开关"。其余（接口 / 外观细节 / 范围 / 读音顺序 / 用量 / 操作）
       * 全部收进下面那个「高级设置」折叠里 —— 原来两家的设置项按"用户还是要调得到"合并进来：
       * 振假名写法、日文字体（含字体名）、字号，一样不少，只是不再占着主面板。
       */
      '<div class="wk-row"><label><input type="checkbox" data-k="enabled"> <b>启用注音</b></label></div>' +
      "<h3>日语歌词</h3>" +
      '<div class="wk-row"><label><input type="checkbox" data-k="furigana"> 标振假名</label> ' +
      '<select data-k="furiganaKana"><option value="hiragana">平假名</option><option value="katakana">片假名</option></select></div>' +
      '<div class="wk-row"><label><input type="checkbox" data-k="jpnFont"> 日语歌词用日文字体</label></div>' +
      "<h3>其它语言</h3>" +
      '<div class="wk-row"><label><input type="checkbox" data-k="annotateLatin"> 西文歌词标片假名</label></div>' +
      '<div class="wk-row"><label><input type="checkbox" data-k="annotateHanzi"> 中文歌词标普通话读音</label></div>' +
      '<div class="wk-row"><label><input type="checkbox" data-k="annotateHangul"> 朝鲜语歌词标朝鲜语读音</label></div>' +
      "<h3>大模型校正</h3>" +
      '<div class="wk-row"><label><input type="checkbox" data-k="llmEnabled"> 用大模型校正读音</label></div>' +
      '<div class="wk-row"><input type="password" data-k="llmKey" placeholder="大模型 API Key（留空则不用）"> ' +
      '<button data-a="llmTest">测试</button> <span data-v="llmTest"></span></div>' +
      // 切词单独一个开关：它每句发一次请求，比"只问个别词"重得多，默认关
      '<div class="wk-row"><label><input type="checkbox" data-k="llmSegment"> 大模型切词（熟字训优先）</label></div>' +
      '<div class="wk-llm-state wk-hint"></div>' +
      "<h3>预览</h3>" +
      '<div class="wk-preview"></div>' +
      '<details class="wk-adv"><summary>高级设置</summary>' +
      "<h3>外观</h3>" +
      '<div class="wk-row"><label>注音字号 <input type="range" data-k="rtSize" min="30" max="120" step="1"> <span data-v="rtSize"></span></label></div>' +
      '<div class="wk-row"><label>注音不透明度 <input type="range" data-k="rtOpacity" min="10" max="100" step="1"> <span data-v="rtOpacity"></span></label></div>' +
      '<div class="wk-row"><label><input type="checkbox" data-k="uniformLineHeight"> 统一行距（有注音/没注音一样高）</label></div>' +
      '<div class="wk-row"><label>行高 <input type="range" data-k="lineHeight" min="1.2" max="2.6" step="0.1"> <span data-v="lineHeight"></span></label></div>' +
      '<div class="wk-row"><label>日文字体 <input type="text" data-k="jpnFontFamily"></label> ' +
      '<button data-a="fontReset">重置</button> <span data-v="fontReset"></span></div>' +
      '<div class="wk-hint">填字体名（逗号分隔多个），只对日语歌生效；清空 = 用默认</div>' +
      '<div class="wk-row"><label><input type="checkbox" data-k="colorBySource"> 按读音来源给注音上色 (排障)</label></div>' +
      '<div class="wk-hint">' +
      '<span style="color:#46d17e">■ 词典</span>　' +
      '<span style="color:#2fae7a">■ 学会的词</span>　' +
      '<span style="color:#3fb6d8">■ 记号/字母名</span>　' +
      '<span style="color:#6f8ff0">■ 罗马音</span>　' +
      '<span style="color:#e8a33d">■ 英文规则</span>　' +
      '<span style="color:#c07ce8">■ 大模型</span>　' +
      '<span style="color:#e0629a">■ 免费接口</span>　淡显 = 暂定值</div>' +
      "<h3>自定义读音</h3>" +
      '<div class="wk-row"><label>一行一条 <code>原句片段 =&gt; 词=读音</code>（按句生效，同一个词换个句子可以填不同的）<br>' +
      '<textarea data-k="furiganaOverrides" rows="5" spellcheck="false" ' +
      'placeholder="明日も君と歩く => 明日=あした\n解けない方程式 => 解=と"></textarea></label></div>' +
      '<div class="wk-row"><button data-a="ovClear">清空</button> <span data-v="ovState"></span></div>' +
      '<div class="wk-hint">只对日语歌词的振假名生效；命中的词整条替换，优先级高于词典和分词。<br>' +
      '平假名 / 片假名写法都可以，会跟着面板上的「振假名写法」自动转换</div>' +
      "<h3>范围</h3>" +
      '<div class="wk-row"><label>标注范围 <select data-k="scope">' +
      '<option value="all">歌词 + 播放栏 (默认)</option>' +
      '<option value="lyrics">只标歌词</option>' +
      '<option value="titles">只标播放栏</option>' +
      '<option value="custom">自定义选择器</option>' +
      "</select></label></div>" +
      '<div class="wk-row"><label>自定义选择器 <input type="text" data-k="customSelector" placeholder="例如 ul.lyric > li"></label></div>' +
      '<div class="wk-row"><label><input type="checkbox" data-k="annotateAll"> 也标播放栏的歌名 / 歌手</label></div>' +
      '<div class="wk-row"><label><input type="checkbox" data-k="annotateNonJapanese"> 非日语歌也注音 (纯英文 / 西文各语种 / 中文歌)</label></div>' +
      '<div class="wk-row"><label><input type="checkbox" data-k="online"> 规则没把握时联网校正 (免费接口)</label></div>' +
      '<div class="wk-hint">关掉「非日语歌也注音」= 只标日语歌: 整首歌词一个假名都没有的整首跳过; ' +
      "判据看整首, 所以日语歌里的纯英文行照旧注音</div>" +
      "<h3>接口</h3>" +
      '<div class="wk-row"><label>接口地址 <input type="text" data-k="llmEndpoint"></label></div>' +
      '<div class="wk-row"><label>模型 <input type="text" data-k="llmModel"></label></div>' +
      '<div class="wk-hint">Key 只存本机 localStorage, 不会进仓库; 粘文档里的 <code>base_url</code> 也行, 会自动补成 <code>/chat/completions</code></div>' +
      "<h3>读音来源顺序</h3>" +
      '<div class="wk-hint">越靠上越优先; 把<b>英文音译规则</b>提到在线层前面 = 一个请求都不发 (纯离线)<br>' +
      "记号 / 缩写 / 字母名 (<code>D/N/A</code>、<code>I'll</code>、<code>LDK</code>) 不参与排序, 永远最先判</div>" +
      '<div class="wk-layers"></div>' +
      '<div class="wk-row"><button data-a="layersReset">恢复默认顺序</button> <span data-v="layersReset"></span></div>' +
      "<h3>API 用量</h3>" +
      '<div class="wk-usage"></div>' +
      '<div class="wk-row"><label>输入单价 <input type="number" data-k="usagePriceIn" min="0" step="0.01" style="width:80px"> 元/百万 token　' +
      '输出单价 <input type="number" data-k="usagePriceOut" min="0" step="0.01" style="width:80px"> 元/百万 token</label></div>' +
      '<div class="wk-row">' +
      '<button data-a="usageReset" data-scope="session">清零本次</button> ' +
      '<button data-a="usageReset" data-scope="today">清零今天</button> ' +
      '<button data-a="usageReset" data-scope="all">清零累计</button>' +
      "</div>" +
      "<h3>操作</h3>" +
      '<div class="wk-row">' +
      '<button data-a="rescan">重新扫描</button> ' +
      '<button data-a="resetSong">重置本首读音</button> ' +
      '<button data-a="retry">重试没结果的词</button> ' +
      '<button data-a="exportWords">导出词库素材</button> ' +
      '<button data-a="clearCache">清除校正缓存</button>' +
      "</div>" +
      '<div class="wk-row"><span data-v="learned"></span> ' +
      '<button data-a="learnClear">清空已学会的词</button></div>' +
      "</details>";


    function fmt(key) {
      return config[key] + "%";
    }

    var preview = root.querySelector(".wk-preview");
    var layersBox = root.querySelector(".wk-layers");
    var usageBox = root.querySelector(".wk-usage");
    var llmStateBox = root.querySelector(".wk-llm-state");

    /** 每一层右边那句小字：一眼看出这层现在能不能用 */
    function layerNote(id) {
      if (id === "dict") return "(" + (typeof WKDict !== "undefined" ? WKDict.count : "?") + " 条, 纯离线)";
      if (id === "romaji") return "(歌词里的日式罗马字, 纯离线)";
      if (id === "rule") return "(拼写音译, 永远给得出结果)";
      if (id === "llm") return llmAvailable() ? "(已启用)" : "(没启用 / 没填 key)";
      if (id === "google") return googleAvailable() ? "(已开启)" : "(已关闭)";
      return "";
    }

    function refreshLayers() {
      if (!layersBox) return;
      layersBox.innerHTML = "";
      for (var i = 0; i < config.layerOrder.length; i++) {
        (function (index) {
          var id = config.layerOrder[index];
          var row = document.createElement("div");
          row.className = "wk-layer";

          var name = document.createElement("span");
          name.className = "wk-layer-name";
          name.textContent = (index + 1) + ". " + (LAYER_NAMES[id] || id);
          row.appendChild(name);

          var note = document.createElement("span");
          note.className = "wk-layer-note";
          note.textContent = layerNote(id);
          row.appendChild(note);

          row.appendChild(mkMoveBtn(index, id, -1, "↑"));
          row.appendChild(mkMoveBtn(index, id, 1, "↓"));
          layersBox.appendChild(row);
        })(i);
      }
      /*
       * 挡路提醒：「英文音译规则」对每个词都给得出答案（它就是拼写猜测），
       * 所以排在它下面的同步层永远轮不到 —— 实际就是这么踩的：
       * 把词典往下拖了几格，于是 `the` -> 规则层的 セ、`this` 变黄（也是规则层）、
       * `I'll` 被拆成「イ + ル」= イル，而且大模型也不再被咨询（规则先答了）。
       * 面板里的 ↑↓ 已经不让这么换；这里兜住"手改配置 / 老配置"的情况。
       */
      var blocked = ruleBlocksSync();
      if (blocked.length) {
        var warnEl = document.createElement("div");
        warnEl.className = "wk-hint wk-layer-warn";
        warnEl.textContent =
          "⚠ " + blocked.join(" / ") + " 排在「英文音译规则」下面: 规则对每个词都会给答案, " +
          "这几层 (还有它下面的在线层) 就永远用不上 —— the 会变成规则猜的 セ" +
          "; 点「恢复默认顺序」即可";
        layersBox.appendChild(warnEl);
      } else if (
        config.layerOrder.indexOf("romaji") >= 0 &&
        config.layerOrder.indexOf("romaji") < config.layerOrder.indexOf("dict")
      ) {
        /*
         * 罗马音排在词典前面 —— 它同样"能切成音节就收"，英文词也会被按罗马音读：
         * Shoo→ショオ、Gimme→ギッメ、more→モレ、Do→ド、Re→レ。
         * 罗马字歌多的库这么排确实有道理（能切的都按罗马音），但要知道这个代价；
         * 不改也能用：罗马音行我们本来就会按罗马音读（lineLooksRomaji）。
         */
        var warn2 = document.createElement("div");
        warn2.className = "wk-hint wk-layer-warn";
        warn2.textContent =
          "⚠ 「日式罗马音」排在「离线词典」前面: 它同样是「能切成音节就收」, " +
          "英文词也会被按罗马音读 (Shoo→ショオ、more→モレ、Do→ド); 除非你就是想要这样, " +
          "否则点「恢复默认顺序」更稳";
        layersBox.appendChild(warn2);
      }
    }

    /**
     * 这一对层能不能互换。
     *
     * 「英文音译规则」对每个词都给得出答案（它就是拼写猜测），一旦排到
     * 离线词典 / 日式罗马音前面，那两层就永远轮不到 —— 实际就是这么踩的：
     * 把词典往下拖了几格，于是 `the` -> セ、`this` 变黄（规则层）、
     * `I'll` 被拆成「イ + ル」= イル，而且大模型也不再被咨询（规则先答了）。
     * 所以面板里直接不让这么换；真要"只用规则"就走控制台
     * `WK.layers(['rule','dict',...])`（文档里有）。
     */
    function canSwap(index, delta) {
      var to = index + delta;
      if (to < 0 || to >= config.layerOrder.length) return false;
      var a = config.layerOrder[index];
      var b = config.layerOrder[to];
      var sync = function (x) {
        return x === "dict" || x === "romaji";
      };
      if ((a === "rule" && sync(b)) || (b === "rule" && sync(a))) return false;
      return true;
    }

    function mkMoveBtn(index, id, delta, label) {
      var b = document.createElement("button");
      b.className = "wk-layer-btn";
      b.textContent = label;
      b.setAttribute("data-layer", id);
      b.setAttribute("data-dir", delta < 0 ? "up" : "down");
      var allowed = canSwap(index, delta);
      b.disabled = !allowed;
      if (!allowed) {
        b.title = "「英文音译规则」不能排到「离线词典 / 日式罗马音」前面: 它会给每个词都出答案, 那两层就永远用不上";
      }
      b.addEventListener("click", function () {
        moveLayer(id, delta);
      });
      return b;
    }

    /**
     * 上下调一层。改完顺序必须重扫：已经注过音的词可能要换一个来源，
     * rescan() 会先整篇还原再按新顺序重注（relabel 只管"暂定 -> 最终"）。
     */
    function moveLayer(id, delta) {
      var from = config.layerOrder.indexOf(id);
      var to = from + delta;
      if (from < 0 || to < 0 || to >= config.layerOrder.length) return;
      config.layerOrder[from] = config.layerOrder[to];
      config.layerOrder[to] = id;
      saveConfig();
      applyLayerOrder();
      rescan();
      refreshAll();
    }

    /** 用量区块：把 usage 模块的账本渲染成几行 */
    /*
     * 「学会的词」那一行：模型答案沉淀成的离线词条。
     *
     * 它要做的正是这个 —— 让模型答过的词自动进词库、以后不再花钱问。
     * 这里只说数量：具体哪些词用 `WK.learn.list()` 看（面板塞不下一长串）。
     */
    function refreshLearned() {
      var box = root.querySelector('[data-v="learned"]');
      if (!box) return;
      if (!state.learned) {
        box.textContent = "学会的词: 不可用 (core/learn.js 没注入)";
        return;
      }
      var s = state.learned.stats();
      box.textContent =
        "学会的词: " +
        s.count +
        " 个" +
        (s.pending ? " (还有 " + s.pending + " 个只听过一次, 再听一句就收)" : "") +
        (s.usedSession ? "; 本次用上 " + s.usedSession + " 个 (省下同样多次提问)" : "");
    }

    function refreshUsage() {
      if (!usageBox) return;
      usageBox.innerHTML = "";
      if (!state.usage) {
        usageBox.textContent = "用量统计不可用 (core/usage.js 没注入)";
        return;
      }
      var snap = state.usage.snapshot();
      var priceIn = Number(config.usagePriceIn) || 0;
      var priceOut = Number(config.usagePriceOut) || 0;
      var rows = [
        { label: "本次", bucket: snap.session },
        { label: "今天", bucket: snap.today },
        { label: "累计", bucket: snap.total },
      ];
      for (var i = 0; i < rows.length; i++) {
        var line = document.createElement("div");
        line.className = "wk-usage-row";
        line.textContent = rows[i].label + "：" + usageLine(rows[i].bucket, priceIn, priceOut);
        usageBox.appendChild(line);
      }
      var saved = document.createElement("div");
      saved.className = "wk-hint";
      var llmStats = state.llm ? state.llm.stats() : null;
      var savedHits = (llmStats ? llmStats.cacheHits : 0) + (state.corrector ? state.corrector.stats().memoryHits : 0);
      saved.textContent =
        "缓存命中 " + savedHits + " 次 (这些没发请求)" +
        (priceIn || priceOut ? "" : "; 填了单价才会算花费");
      usageBox.appendChild(saved);
    }

    /** 一个桶一行字：请求/成功/失败/词/字符/token */
    function usageLine(bucket, priceIn, priceOut) {
      var parts = [];
      for (var k = 0; k < USAGE_KINDS.length; k++) {
        var kind = USAGE_KINDS[k];
        var b = bucket[kind];
        if (!b || (!b.requests && !b.failures)) continue;
        var seg = (kind === "llm" ? "大模型 " : "免费接口 ") + b.requests + " 次请求";
        if (b.failures) seg += " (成功 " + b.ok + " / 失败 " + b.failures + ")";
        if (b.words) seg += "・" + b.words + " 词";
        if (b.chars) seg += "・" + b.chars + " 字符";
        // 只有大模型那层有 token（Google 那两个接口不回 usage）；免费接口就算被
        // 灌了 token 也不显示，免得账本看着像是两种计费混在一起
        if (kind === "llm" && (b.promptTokens || b.completionTokens)) {
          seg += "・输入 " + b.promptTokens + " / 输出 " + b.completionTokens + " tok";
        }
        parts.push(seg);
      }
      if (!parts.length) return "还没发过请求";
      var text = parts.join("　|　");
      var money = state.usage.cost(bucket, priceIn, priceOut);
      if (money > 0) text += "　≈ " + money.toFixed(4) + " 元";
      return text;
    }

    /** 从 usage 模块拿两层 id（别在 main.js 里写死一份） */
    var USAGE_KINDS = typeof WKUsage !== "undefined" ? WKUsage.KINDS : ["llm", "google"];

    /**
     * 预览：照 JapaneseFonts 的样子 —— 一个深色框里几行日语示例，汉字带振假名，第二行加粗。
     *
     * 比原来那句英文示例更贴近现在的场景（日语歌），而且字号 / 不透明度 / 振假名写法 /
     * 日文字体 一改，这里马上能看到效果 —— 相当于把两家的预览合成一个。
     * 第三行留一个西文词，提醒"西文字母也照旧注片假名"。
     */
    /**
     * 预览里的英文句子：逐个词取读音（只走本地那几层：词典 -> 字母名 -> 规则）。
     *
     * 为什么不在预览里写死几个词：用户看到的是「预览标不全」，而实际歌词是全的 ——
     * 预览应该和真机一致。这里只取同步层，不会因为打开面板就去问模型。
     */
    function previewEnglishRubies(text) {
      var out = [];
      var re = /[A-Za-z][A-Za-z'\u2019-]*/g;
      var m;
      while ((m = re.exec(text))) {
        var word = m[0];
        var kana = null;
        try {
          var r0 = state.reader ? state.reader.read(word) : null;
          if (r0 && r0.kana) kana = r0.kana;
        } catch (e) {
          kana = null;
        }
        if (!kana) continue;
        out.push([word, kana]);
      }
      return out;
    }

    function refreshPreview() {
      preview.innerHTML = "";
      var kata = config.furiganaKana === "katakana";
      // 每个 ruby 的底字在整行里的位置；写法跟着面板上的「平假名 / 片假名」走
      var lines = [
        {
          text: "天気が良いから",
          rubies: [
            ["天気", kata ? "テンキ" : "てんき"],
            ["良", kata ? "イ" : "い"],
          ],
          bold: false,
        },
        {
          text: "散歩しましょう",
          rubies: [["散歩", kata ? "サンポ" : "さんぽ"]],
          bold: true,
        },
        {
          // 第三、四行：英文句子 —— 读音按真实引擎现算（词典 / 字母名 / 规则），
          // 不是手写一小撮，否则看起来「标不全」。
          text: "Excuse me. Can you tell me how much the shirt is?",
          rubies: previewEnglishRubies("Excuse me. Can you tell me how much the shirt is?"),
          bold: false,
          dim: true,
        },
        {
          text: "Yes, it's nine fifteen.",
          rubies: previewEnglishRubies("Yes, it's nine fifteen."),
          bold: false,
          dim: true,
        },
      ];
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var row = document.createElement("div");
        row.className = "wk-pv-line" + (line.bold ? " wk-pv-bold" : "") + (line.dim ? " wk-pv-dim" : "");
        var pos = 0;
        /*
           * 按 rubies 给的顺序（就是文本顺序）依次定位。
           *
           * 以前是「按 indexOf 排序，然后从 pos 往后找」：同一句里出现两次 `me` 时，
           * 两次的 indexOf 都指向第一个 me，第二次找不到位置就被跳过，后面的词跟着乱/丢
           * （用户看到的就是「预览标不全」）。现在严格按 pos 往后找一个，重复词也不会丢。
           */
        var pieces = line.rubies.slice();
        for (var j = 0; j < pieces.length; j++) {
          var base = pieces[j][0];
          var reading = pieces[j][1];
          var at = line.text.indexOf(base, pos);
          if (at < 0) continue;
          if (at > pos) row.appendChild(document.createTextNode(line.text.slice(pos, at)));
          var ruby = document.createElement("ruby");
          ruby.className = "wk-ruby";
          ruby.appendChild(document.createTextNode(base));
          var rt = document.createElement("rt");
          rt.className = "wk-rt";
          rt.textContent = reading;
          ruby.appendChild(rt);
          row.appendChild(ruby);
          pos = at + base.length;
        }
        if (pos < line.text.length) row.appendChild(document.createTextNode(line.text.slice(pos)));
        preview.appendChild(row);
      }
      /*
       * 字体：日文字体开着时，预览跟着用那套字体 —— 这正是"换日文字体"要看的东西
       * （中文黑体里的日文汉字笔画是中文写法）。
       */
      try {
        preview.style.fontFamily = config.jpnFont === true ? String(config.jpnFontFamily || "") : "";
      } catch (e) {
        /* 样式挂不上不影响预览内容 */
      }
    }

    /**
     * 大模型这一层的当前状态（不用开 dev 模式也能看到的告警）。
     *
     * 「读音全都没矫正」是最容易让人以为插件坏了的症状：本地读音照旧、模型一条都没改。
     * 原因无非四种 —— 没配 key / 在失败退避里 / 请求全失败 / 队列还没轮上。
     * 这块把话说清，并给一个「立刻重试」。
     */
    function refreshLlmState() {
      if (!llmStateBox) return;
      llmStateBox.innerHTML = "";
      if (!state.llm) {
        llmStateBox.textContent = "大模型层没加载 (core/llm.js 没注入)";
        return;
      }
      var s = state.llm.stats();
      function say(text, cls) {
        var el = document.createElement("div");
        el.className = "wk-hint" + (cls ? " " + cls : "");
        el.textContent = text;
        llmStateBox.appendChild(el);
      }
      function sayBtn(label, action) {
        var b = document.createElement("button");
        b.textContent = label;
        b.setAttribute("data-a", action);
        b.addEventListener("click", function () {
          if (action === "llmRetryNow" && state.llm && state.llm.retryNow) {
            state.llm.retryNow();
            rescan();
          } else if (action === "layersReset") {
            config.layerOrder = normalizeLayerOrder(DEFAULTS.layerOrder);
            saveConfig();
            applyLayerOrder();
            rescan();
          }
          refreshAll();
        });
        llmStateBox.appendChild(b);
      }
      var blockedHere = ruleBlocksSync();
      if (blockedHere.length) {
        // 这条要放在最前面：层序错了的话，下面所有解释都是白搭
        say(
          "⚠ 「英文音译规则」排在 " + blockedHere.join(" / ") + " 前面 —— 规则对每个词都会给答案, " +
            "所以词典和模型都用不上 (the 变 セ、this 变黄、I'll 变 イル 都是这个原因); " +
            "点「恢复默认顺序」, 再把「大模型」往上提",
          "wk-warn"
        );
        sayBtn("恢复默认顺序", "layersReset");
        return;
      }
      if (!s.enabled) {
        say("这一层没启用 —— 所有词都用本地读音, 不会被矫正");
      } else if (!s.hasKey) {
        say("没填 API Key —— 所有词都用本地读音, 不会被矫正");
      } else if (s.cooldownMs > 0) {
        say(
          "⚠ 请求失败后退避中, 还要等 " + Math.round(s.cooldownMs / 1000) + " 秒; " +
            "这段时间里读音不会矫正" + (s.lastError ? "; 最近错误: " + s.lastError : ""),
          "wk-warn"
        );
        sayBtn("立刻重试", "llmRetryNow");
      } else if (s.failedSinceHit >= 2) {
        say(
          "⚠ 最近几次请求都没成功, 读音不会矫正" + (s.lastError ? "; 最近错误: " + s.lastError : ""),
          "wk-warn"
        );
        sayBtn("立刻重试", "llmRetryNow");
      } else if (s.pending > 0) {
        var bs = s.batchSize || 40;
        var batches = Math.ceil(s.pending / bs);
        say(
          "队列里还有 " + s.pending + " 个词在等" +
            (s.inflight ? " (正在请求)" : ", 还要发 " + batches + " 次请求, 本分钟还剩 " + s.roomThisMinute + " 次额度") +
            " —— 矫正会一批批补上, 不用管它"
        );
        if (s.pending > bs * 2) {
          say(
            "一次排这么多是因为「大模型」排在「离线词典」前面 —— 那样每个词都要问一遍; " +
              "把「离线词典」放回最上面就没这么多请求了"
          );
        }
      } else if (s.missesCached > 0) {
        say(
          "有 " + s.missesCached + " 条「问过但没收下」(不会再自动重问), 其中首音校验判掉 " +
            s.rejected + " 次 —— 想再问一次就点「重试没结果的词」"
        );
      } else if (s.hits > 0) {
        say("✓ 已生效: 命中 " + s.hits + " 次 (本次会话)");
      } else {
        say("还没问过任何词 —— 说明歌词里的拉丁词都在离线词典里, 这层没活干");
      }
    }

    function refreshAll() {
      refreshLayers();
      refreshPreview();
      refreshUsage();
      refreshLearned();
      refreshLlmState();
    }

    /*
     * 面板开着的时候每秒轻量刷一下数字（不重跑预览和状态那种重活）。
     *
     * 为什么需要：这些数字是快照，而模型层是在持续干活的 —— 面板上看到
     * 「队列里还有 184 个词在等」时，其实可能下一秒就排完了；反过来，
     * 队列真的卡住时也需要看得出来。不刷新的话，那种"额度满着、
     * 队列一大坨"会像卡死了。面板一关就自己停（isConnected 检查）。
     */
    var liveTimer = setInterval(function () {
      if (!root.isConnected) {
        clearInterval(liveTimer);
        return;
      }
      refreshUsage();
      refreshLlmState();
      refreshLearned();
    }, 1000);

    var NEEDS_RESCAN = ["annotateAll", "scope", "customSelector", "annotateNonJapanese", "annotateHanzi", "annotateHangul", "annotateLatin", "furigana", "furiganaKana", "furiganaOverrides"];
    // 字体只影响渲染，不用重扫：清掉缓存值让它下一轮重算一遍样式表
    var NEEDS_FONT = ["jpnFont", "jpnFontFamily"];
    var NEEDS_LINEHEIGHT = ["uniformLineHeight", "lineHeight"];
    var NEEDS_RESTYLE = ["rtSize", "rtOpacity"];

    var inputs = root.querySelectorAll("[data-k]");
    for (var i = 0; i < inputs.length; i++) {
      (function (el) {
        var key = el.dataset.k;
        if (el.type === "checkbox") el.checked = !!config[key];
        else el.value = config[key];

        var commit = function () {
          if (el.type === "checkbox") config[key] = el.checked;
          else if (el.type === "range" || el.type === "number") config[key] = Number(el.value);
          else config[key] = el.value;
          /*
           * 接口地址当场纠正：多数人粘的是文档里的 base_url
           * （`https://api.deepseek.com` 或 `…/v1`），那样 POST 过去是 404。
           * 纠正后的值写回输入框，免得每次都得记住补 `/chat/completions`。
           */
          if (key === "llmEndpoint" && typeof WKLLM !== "undefined" && WKLLM.normalizeEndpoint) {
            var fixed = WKLLM.normalizeEndpoint(config.llmEndpoint);
            if (fixed !== config.llmEndpoint) {
              config.llmEndpoint = fixed;
              el.value = fixed;
            }
          }
          /*
           * key 也当场洗一遍：从网页上复制 key 很容易带上引号、空格，甚至整个
           * "Bearer xxx"。这些都会让请求 401（看到的就是"大模型请求全失败"），
           * 洗完之后写回输入框，免得每次都要自己盯着看有没有多余字符。
           */
          if (key === "llmKey" && typeof WKLLM !== "undefined" && WKLLM.normalizeKey) {
            var clean = WKLLM.normalizeKey(config.llmKey);
            if (clean !== config.llmKey) {
              config.llmKey = clean;
              el.value = clean;
            }
          }
          saveConfig();
          var out = root.querySelector('[data-v="' + key + '"]');
          if (out) out.textContent = fmt(key);
          updateStyles();
          if (key === "enabled") {
            config.enabled ? enable() : disable();
          } else if (key === "online") {
            if (state.corrector) state.corrector.setOnline(config.online);
            if (config.online) rescan();
          } else if (key.indexOf("llm") === 0) {
            // 接口地址 / 模型 / key 变了，把新配置推给客户端再重扫：
            // 关掉或清空 key 时，已经命中缓存的那些词也要退回去，所以必须重扫
            if (state.llm) {
              state.llm.configure({
                enabled: config.llmEnabled !== false,
                endpoint: config.llmEndpoint,
                model: config.llmModel,
                key: config.llmKey,
              });
            }
            rescan();
          } else if (NEEDS_RESCAN.indexOf(key) >= 0) {
            // 自定义读音改了要先灌进振假名层，再重扫才会用新读音
            if (key === "furiganaOverrides") {
              if (typeof WKFurigana !== "undefined" && WKFurigana.clearCache) WKFurigana.clearCache();
              var cnt = parseFuriganaRules(config.furiganaOverrides).length;
              var state0 = root.querySelector('[data-v="ovState"]');
              if (state0) state0.textContent = cnt ? "已生效 " + cnt + " 条" : "没有规则";
            }
            rescan();
          } else if (NEEDS_LINEHEIGHT.indexOf(key) >= 0) {
            updateLineHeight();
          } else if (NEEDS_FONT.indexOf(key) >= 0) {
            // 字体只改渲染：清掉缓存值，下一轮 pass 重算一次样式表
            jpFontCss = null;
            updateJapaneseFont();
          } else if (NEEDS_RESTYLE.indexOf(key) >= 0) {
            if (state.annotator) state.annotator.restoreAll();
            schedule(0);
          }
          refreshAll();
        };
        el.addEventListener("change", commit);
        if (el.type === "range") el.addEventListener("input", commit);

        var out0 = root.querySelector('[data-v="' + key + '"]');
        if (out0) out0.textContent = fmt(key);
      })(inputs[i]);
    }

    // 外链交给系统浏览器，直接跳会把网易云本身导航走
    var links = root.querySelectorAll("[data-open]");
    for (var li = 0; li < links.length; li++) {
      (function (a) {
        a.addEventListener("click", function (e) {
          e.preventDefault();
          try {
            betterncm.ncm.openUrl(a.dataset.open);
          } catch (err) {
            warn("打开链接失败", err);
          }
        });
      })(links[li]);
    }

    var actions = root.querySelectorAll("[data-a]");
    for (var ai = 0; ai < actions.length; ai++) {
      (function (b) {
        b.addEventListener("click", function () {
          var what = b.dataset.a;
          if (what === "rescan") {
            rescan();
          } else if (what === "resetSong") {
            // 清掉这一首里"就地改过的读音"（面板里的通用规则 / 模型缓存都不动）
            var n0 = resetSongReadings();
            b.textContent = n0 ? "已重置 " + n0 + " 条" : "没有改动";
            setTimeout(function () {
              b.textContent = "重置本首读音";
            }, 1500);          } else if (what === "fontReset") {
            /*
             * 恢复默认日文字体栈。字体名是串 CSS，改坏了（多写了竖线 / 拼错）就会静默失效 ——
             * 留一个一键回到默认的口子，不用自己去翻默认值。
             */
            config.jpnFontFamily = JP_FONT_DEFAULT;
            var input = root.querySelector('[data-k="jpnFontFamily"]');
            if (input) input.value = JP_FONT_DEFAULT;
            jpFontCss = null;
            updateJapaneseFont();
            saveConfig();
            b.textContent = "已恢复默认";
            setTimeout(function () {
              b.textContent = "重置";
            }, 1500);
          } else if (what === "ovClear") {
            config.furiganaOverrides = "";
            var ta = root.querySelector('[data-k="furiganaOverrides"]');
            if (ta) ta.value = "";
            saveConfig();
            if (typeof WKFurigana !== "undefined" && WKFurigana.clearCache) WKFurigana.clearCache();
            var st = root.querySelector('[data-v="ovState"]');
            if (st) st.textContent = "已清空";
            rescan();
          } else if (what === "retry") {
            // 两层一起清：免费接口那些"查过、没有"的，和模型那些"问过但没收下"的
            var n = state.corrector ? state.corrector.retryMisses() : 0;
            var m = state.llm && state.llm.retryMisses ? state.llm.retryMisses() : 0;
            rescan();
            b.textContent = "已重新排队 " + n + " + " + m + " 个";
            setTimeout(function () {
              b.textContent = "重试没结果的词";
            }, 1500);
          } else if (what === "exportWords") {
            /*
             * 导出「可以沉淀进离线词典」的素材（已学会的词 + 两层缓存命中）。
             * 面板里没有文件系统可用，所以：打一份到控制台 + 尽量复制到剪贴板，
             * 存成 data/learned.json 之后跑 npm run promote:learned。
             */
            var payload = collectWordExport();
            var json = JSON.stringify(payload, null, 2);
            var count = payload.learned.length + payload.llm.length + payload.google.length;
            var copied = false;
            try {
              var ta = root.ownerDocument.createElement("textarea");
              ta.value = json;
              ta.style.position = "fixed";
              ta.style.opacity = "0";
              root.ownerDocument.body.appendChild(ta);
              ta.select();
              copied = root.ownerDocument.execCommand && root.ownerDocument.execCommand("copy");
              root.ownerDocument.body.removeChild(ta);
            } catch (eCopy) {
              copied = false;
            }
            try {
              console.log("[lyric-ruby] 词库素材（" + count + " 条）：", json);
            } catch (eLog) {
              /* 控制台打不出来就算了 */
            }
            b.textContent = copied ? "已复制 " + count + " 条" : "已打印到控制台 " + count + " 条";
            setTimeout(function () {
              b.textContent = "导出词库素材";
            }, 2500);
          } else if (what === "clearCache") {
            if (state.corrector) state.corrector.clearCache();
            if (state.llm) state.llm.clearCache();
            rescan();
            b.textContent = "已清空";
            setTimeout(function () {
              b.textContent = "清除校正缓存";
            }, 1500);
          } else if (what === "learnClear") {
            if (state.learned) {
              var gone = state.learned.clear();
              rescan();
              b.textContent = "已清掉 " + gone + " 个";
              setTimeout(function () {
                b.textContent = "清空已学会的词";
              }, 1500);
            }
          } else if (what === "usageReset") {
            var scope = b.dataset.scope || "session";
            if (state.usage) state.usage.reset(scope);
          } else if (what === "layersReset") {
            config.layerOrder = normalizeLayerOrder(DEFAULTS.layerOrder);
            saveConfig();
            applyLayerOrder();
            rescan();
          } else if (what === "llmTest") {
            var out = root.querySelector('[data-v="llmTest"]');
            if (!state.llm) {
              if (out) out.textContent = "核心模块未加载";
            } else {
              if (out) out.textContent = "测试中…";
              state.llm.test().then(function (r) {
                if (out) out.textContent = (r.ok ? "✅ " : "❌ ") + r.message;
                refreshAll();
              });
            }
          }
          refreshAll();
        });
      })(actions[ai]);
    }

    refreshAll();
    return root;
  }

  /**
   * 收集「可以沉淀进离线词典」的素材：已学会的词 + 两层缓存的命中。
   * 只收集，不筛选 —— 筛选在构建期（tools/promote-learned.js），
   * 那里能看到完整词典、黑名单，也能调阈值。
   */
  function collectWordExport() {
    var learned = state.learned ? state.learned.list() : [];
    var llm = state.llm && state.llm.exportWords ? state.llm.exportWords() : [];
    var google = state.corrector && state.corrector.exportWords ? state.corrector.exportWords() : [];
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      learned: learned.map(function (x) {
        return { word: x.word, kana: x.kana, at: x.at };
      }),
      llm: llm,
      google: google,
    };
  }

  function notifyConfigUI() {
    try {
      if (typeof plugin !== "undefined" && plugin.onConfig && !state.configRoot) {
        state.configRoot = buildConfigUI();
      }
      if (state.configRoot && state.configRoot.isConnected === false) {
        // 面板被关掉过，下次 onConfig 会重建
        state.configRoot = null;
      }
    } catch (e) {
      /* 面板只是显示用，不能因为它把插件搞崩 */
    }
  }

  // ------------------------------------------------------------ 生命周期

  if (emergencyOff()) {
    try {
      console.log(LOG, "检测到紧急开关，插件不启动");
    } catch (e) {
      /* ignore */
    }
    return;
  }

  plugin.onConfig(function () {
    return buildConfigUI();
  });

  plugin.onLoad(function () {
    trace("boot", "onLoad 开始 off=" + emergencyOff() + " enabled=" + config.enabled +
      " scope=" + config.scope + " annotateAll=" + config.annotateAll +
      " 模块 matcher=" + typeof WKMatcher + " reading=" + typeof WKReading +
      " dict=" + typeof WKDict + " annotate=" + typeof WKAnnotate);

    if (typeof WKMatcher === "undefined" || typeof WKReading === "undefined" ||
        typeof WKAnnotate === "undefined" || typeof WKDict === "undefined") {
      warn("核心模块未注入，检查 manifest.json 的 injects 顺序");
      return;
    }
    // 语言层是可选的：没注入时只剩英语/罗马音（老行为），注音照常工作
    if (typeof WKLangs === "undefined") warn("core/langs.js 没注入：法语 / 德语 / 拉丁语等西文语种不生效");

    try {
      betterncm.app.getBetterNCMVersion().then(
        function (v) {
          state.betterncmVersion = v;
        },
        function () {
          /* 只是给状态区看的，拿不到就算了 */
        }
      );
    } catch (e) {
      /* ignore */
    }

    try {
      updateStyles();
      /*
       * 用量统计（本次 / 今天 / 累计）。core/usage.js 没注入时整块功能缺席，
       * 但注音本身照常工作 —— 统计是附属品，不能拖累主流程。
       */
      if (typeof WKUsage !== "undefined") {
        state.usage = WKUsage.createUsage();
      }
      state.corrector = WKCorrect.createCorrector({
        online: config.online,
        // 纯片假名还不够：还要像这个词的音译（tick 不能被回成 カチカチ）
        validate: validateAnswer,
        // 免费接口没有 token 概念，用请求数 + 字符数记账
        onUsage: function (fields) {
          if (state.usage) state.usage.add("google", fields);
        },
        log: function () {
          if (config.verbose) console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
        },
        onStatus: function (msg) {
          log(msg);
          notifyConfigUI();
        },
        onUpdate: function () {
          /*
           * 在线结果回来了 → 就地改写已有注音，不要 restoreAll。
           *
           * restoreAll 会把所有注音先撤掉再重注，而重注时那些"还没拿到结果"的词
           * 给不出读音（在线优先、规则垫底），于是整行会变空、过一会儿才补回来 ——
           * "全英文行标注后有概率消失"就是这个。
           */
          if (!config.enabled) return;
          if (state.annotator && state.annotator.relabel) state.annotator.relabel();
          schedule(0); // 顺手把这一轮新拿到结果的词补上（已注的音一个都不动）
          notifyConfigUI();
        },
      });
      state.reader = WKReading.createReader({
        dict: WKDict.words,
        // 英文常用词表：罗马音层靠它判断"这看着像英文词"，判出来就交给在线层仲裁
        enWords: typeof WKEnWords !== "undefined" ? WKEnWords.words : null,
        // 同步层按配置的层序（异步层由 readForDisplay 处理，见那里）
        order: syncLayerOrder(),
        log: function () {
          if (config.verbose) console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
        },
      });
      applyLayerOrder();
      /*
       * 「学会的词」：把模型答过两次、而且纠正了本地读音的词沉淀成离线词条
       * （见 core/learn.js）。它压在最前面、按离线词典的名次参与层序 ——
       * 这些词以后不会再问模型，"自动沉淀进词典"就是这个。
       */
      if (typeof WKLearn !== "undefined") {
        state.learned = WKLearn.createLearned({
          normalize: function (word) {
            return typeof WKMatcher !== "undefined" ? WKMatcher.normalize(word) : String(word == null ? "" : word).toLowerCase();
          },
        });
      }
      // 大模型校正：没填 key 就整层不工作（lookup 一律返回 null），自动退回上面的 Google 路子
      if (typeof WKLLM !== "undefined") {
        state.llm = WKLLM.createClient({          enabled: config.llmEnabled !== false,
          endpoint: config.llmEndpoint,
          model: config.llmModel,
          key: config.llmKey,
          // 用量：token 数由接口响应里的 usage 给（没给就只记次数）
          onUsage: function (fields) {
            if (state.usage) state.usage.add("llm", fields);
          },
          /*
           * 收下了一个模型答案 -> 试着沉淀成离线词条。
           * 规矩（宁缺毋滥，理由见 core/learn.js）：
           *   - 本地层本来就对的不学（学了也没用）；
           *   - "两可"的短音节不学（读音取决于那句话）；
           *   - 要在两个不同的句子里答出同一个读音才收（learn.js 记账）。
           */
          onAnswer: function (word, kana, line) {
            if (!state.learned) return;
            /*
             * 单字母不沉淀：它的读音取决于语境（冠词 `a` ア、字母名
             * `(A, B)` エー、段标 `(A:` 不标），词级词条钉死一个必然出错 ——
             * 机器上那条 `a → アー` 就是这么来的（模型在 `(A:` 的行里答的），
             * 结果拉丁语歌词里的段标一直带着 アー。和"两可短音节不收"同一个道理。
             */
            if (/^[A-Za-z]$/.test(word)) return;
            /*
             * 汉字 / 谚文也不沉淀：多音字的读音取决于那一句（行 ハン / シン），
             * 钉成词级词条之后别的句子一定会读错。它们本来就是"每句问一次"。
             */
            if (typeof WKCJK !== "undefined" && (WKCJK.hasHan(word) || WKCJK.hasHangul(word))) {
              /*
               * 日语歌词里汉字的振假名答案：同样不沉淀成词级词条（同一个词不同句读法不同），
               * 但要让这一屏重扫一次 —— 答案在「词 + 这句」的缓存里，重扫时会用上。
               */
              /*
               * 只重扫那一行。为什么不能只 schedule(0)：这个词所在的文本节点
               * 可能已经因为"同行别的词注上了"而有了记录，增量 pass 会整条跳过它 ——
               * 模型刚给的读音永远上不了屏（真机现象：霽 / 掻 一直空着）。
               */
              if (RE_KANA_ANY.test(line || "") || songLooksJapanese()) scheduleSegRescan([line]);
              return;
            }
            var local = state.reader ? state.reader.read(word) : null;
            if (!local || !local.kana) return;
            if (isTwoWayShort(word, local.kana)) return;
            var r = state.learned.note(word, kana, line, local.kana);
            if (r === "learned" || r === "drop") {
              log(
                (r === "learned" ? "学会一个词：" : "撤销一个学会的词（模型改口）：") +
                  word +
                  " -> " +
                  kana +
                  "（已学会 " +
                  state.learned.stats().count +
                  " 个）"
              );
              // 让页面立刻用上这个读音，并把面板上的数字刷新
              if (state.annotator && state.annotator.relabel) state.annotator.relabel();
              schedule(0);
              notifyConfigUI();
            }
          },
          // 同上：拦住"意译/拟声词"（案例 tick -> カチカチ）
          validate: validateAnswer,
          /*
           * 整句切词回来了（llmSegment 那一档）：把这些行拆回纯文本再重注 ——
           * 新切分可能把两个已经注好的 ruby 合成一个词（见 scheduleSegRescan）。
           */
          onSegmented: function (lines) {
            if (!config.enabled || !config.llmSegment) return;
            scheduleSegRescan(lines);
          },
          log: function () {
            trace("llm", Array.prototype.join.call(arguments, " "));
            if (config.verbose) console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
          },
          onStatus: function (msg) {
            log(msg);
            notifyConfigUI();
          },
          onUpdate: function () {
            // 大模型的结果回来了：就地改写已有注音（见上面正确器那段的说明），
            // 再排一次扫描把新拿到结果的词补上
            if (!config.enabled) return;
            if (state.annotator && state.annotator.relabel) state.annotator.relabel();
            schedule(0);
            notifyConfigUI();
          },
        });
      }
      /*
     * 振假名词典（kuromoji + IPADIC，17 MB）是懒加载的：这里只登记"读完要重扫"，
     * 真正读盘发生在第一行日语歌词出现时。读完重扫一次，屏幕上已经渲染出来的
     * 汉字行就能补上注音，不用等下一次歌词滚动。
     */
    if (typeof WKFurigana !== "undefined" && WKFurigana.configure) {
      WKFurigana.configure({
        onReady: function () {
          try {
            rescan();
          } catch (e) {
            /* 还没进主循环时忽略 */
          }
        },
      });
      // 自定义读音是按行匹配的，不用在这里灌；清一次缓存即可
      if (WKFurigana.clearCache) WKFurigana.clearCache();
    }

    purgeStaleInlineFixes();
    migrateLineFixes();
    installInlineEditor();

    state.annotator = WKAnnotate.createAnnotator({
        // 返回 { kana, source }：source 用来给"按来源着色"的排障功能打标
        // 第三个参数是这个词的 token（段标 `M:` 那类判断要看 token 的位置，不能只看整行）
        lookup: function (word, line, token) {
          return resolveReading(word, line, token);
        },
        // 暂定读音（在线那层还在问）会在注音上打一个淡一点的标记
        pending: function (word, line, token) {
          return isProvisional(word, line, token);
        },
        // 排障用：这段文字里有没有被判成"打码"的重复字母串
        censoredRun: function (text) {
          return looksCensoredRun(text);
        },
        // 振假名 / 汉字 / 谚文：读音在切的时候就定了，注音层只负责包成 ruby（见 extraTokens）
        extraTokens: function (text, context, host, offset, lineText) {
          return extraTokens(text, context, host, offset, lineText);
        },
        annotateAll: config.annotateAll !== false,
        annotateLatin: config.annotateLatin !== false,
        log: function () {
          trace("annotate", Array.prototype.join.call(arguments, " "));
        },
      });
    } catch (e) {
      state.error = (e && e.message) || String(e);
      warn("初始化失败", e);
      return;
    }

    /*
     * 钩子：装了共存补丁的 jp-furigana 重建完一行后会直接调 window.__ktRepairLine，
     * 让我们在同一个任务里把注音补回去（等下一帧就是可见的一闪）。
     *
     * 这里必须链上去而不是覆盖：另一个片假名注音插件可能已经挂了一个同名钩子，
     * 直接赋值会把它顶掉，那边立刻开始闪。两个插件都要被叫到。
     */
    try {
      var prevHook = typeof window.__ktRepairLine === "function" ? window.__ktRepairLine : null;
      window.__ktRepairLine = function (lineEl) {
        var mine = false;
        try {
          if (config.enabled && state.annotator && state.annotator.repairLine) {
            if (state.observer) state.observer.takeRecords();
            mine = state.annotator.repairLine(lineEl);
          }
        } catch (e) {
          /* ignore */
        }
        // 再去叫前一个（可能是另一个片假名注音插件）
        if (prevHook) {
          try {
            prevHook(lineEl);
          } catch (e) {
            /* ignore */
          }
        }
        return mine;
      };
    } catch (e) {
      /* 挂不上就算了，还有 MutationObserver 那条路 */
    }

    if (config.enabled) enable();
    else state.annotator.restoreAll();

    trace("boot", "初始化完成，annotator=" + !!state.annotator + " reader=" + !!state.reader);

    window.WesternKatakana = {
      config: config,
      state: state,
      set: function (key, value) {
        config[key] = value;
        if (key === "layerOrder") config.layerOrder = normalizeLayerOrder(config.layerOrder);
        saveConfig();
        applyLayerOrder();
        updateStyles();
        if (key === "enabled") config.enabled ? enable() : disable();
        else rescan();
        return config[key];
      },
      /*
       * 读音来源顺序：WK.layers() 看当前顺序，WK.layers(['llm','dict',...]) 直接改。
       * 设置面板里那对 ↑↓ 按钮走的就是同一条路（改完同样会重扫）。
       */
      layers: function (order) {
        if (order === undefined) return config.layerOrder.slice();
        config.layerOrder = normalizeLayerOrder(order);
        saveConfig();
        applyLayerOrder();
        rescan();
        return config.layerOrder.slice();
      },
      /*
       * API 用量：WK.usage() 看账本（本次/今天/累计，两层分开），
       * WK.usageReset('session'|'today'|'all') 清零。设置面板里那几个按钮走同一条路。
       */
      usage: function () {
        return state.usage ? state.usage.snapshot() : null;
      },
      usageReset: function (scope) {
        if (state.usage) state.usage.reset(scope || "session");
        return state.usage ? state.usage.snapshot() : null;
      },
      read: function (word) {
        // 本地那几层的读音（不含大模型/联网校正）—— 看 source 就知道是谁给的
        return state.reader ? state.reader.read(word) : null;
      },
      /*
       * 「学会的词」：模型答过两次、且纠正了本地读音的词，已经沉淀成离线词条
       * （它们不再走模型，省钱就在这里）。面板上那一行显示的就是这份东西。
       *   WK.learn.list()        看学会了哪些（按最近用到的排前面）
       *   WK.learn.stats()       数量 / 待定数量 / 本次用上几个
       *   WK.learn.forget('xxx') 忘掉一个（读音不对时用）
       *   WK.learn.clear()       全清（等于回到"每次都得问模型"）
       */
      /*
       * 「把常用词沉淀进离线词典」的素材导出。
       *
       * 运行期写不进仓库里的 src/core/dict.js（那是构建产物），所以流程是：
       *   面板「操作 → 导出词库素材」或控制台 WK.exportWords()
       *   → 得到一段 JSON（已学会的词 + 大模型缓存命中 + 免费接口缓存命中）
       *   → 存成 data/learned.json
       *   → `npm run promote:learned` 筛选后写进 tools/seed-words-learned.js
       *   → `npm run build:dict` 合并进词典
       * 筛选（一致性、纯片假名、与现有词典冲突、黑名单）都在构建期做，
       * 见 tools/promote-learned.js。
       */
      exportWords: function () {
        return collectWordExport();
      },
      exportWordsJson: function () {
        return JSON.stringify(collectWordExport(), null, 2);
      },
      learn: {
        list: function () {
          return state.learned ? state.learned.list() : [];
        },
        stats: function () {
          return state.learned ? state.learned.stats() : null;
        },
        forget: function (word) {
          return state.learned ? state.learned.forget(word) : false;
        },
        clear: function () {
          var n = state.learned ? state.learned.clear() : 0;
          rescan();
          return n;
        },
        flush: function () {
          if (state.learned) state.learned.flush();
        },
      },
      learned: function () {
        // 短别名：WK.learned() 直接看列表
        return state.learned ? state.learned.list() : [];
      },
      display: function (word) {
        /*
         * 页面上实际用的那个读音：按配置的层序取（默认
         * 词典 -> 罗马音 -> 大模型 -> Google -> 规则）。
         * 判断"某个词到底是谁给的读音"就用它：和 WK.read() 比一下，
         * 不一样就说明被大模型（或联网）换过了。
         */
        return readForDisplay(word);
      },
      /*
       * 排障：按读音来源上色。WK.colorize(true) 开、WK.colorize(false) 关、
       * 不带参数就是看当前状态。只改 CSS（wk-src-* 类名一直挂在注音节点上），
       * 所以不用重扫，开了立刻就变。
       */
      colorize: function (on) {
        if (on !== undefined) {
          config.colorBySource = !!on;
          saveConfig();
          updateStyles();
        }
        return !!config.colorBySource;
      },
      dict: function () {
        return typeof WKDict !== "undefined" ? WKDict.words : {};
      },
      /*
       * 借词表（core/loan.js）：哪些词"日语里就是这么写的"。
       * WK.loan() 看条数，WK.loan('de') 看德语那张表。
       */
      loan: function (langId) {
        if (typeof WKLoan === "undefined") return null;
        if (!langId) return { count: WKLoan.count, langs: Object.keys(WKLoan.tables) };
        return WKLoan.get(langId);
      },
      /*
       * 语言判定：WK.lang('这一行歌词') 看它被判成什么语言。
       * 插件支持法语 / 德语 / 拉丁语 / 葡萄牙语 / 荷兰语 / 斯瓦希里语 /
       * 汉语拼音 / 俄语 / 希腊语，判不出来返回 null（那就走词典/罗马音/英文规则）。
       */
      lang: function (text) {
        if (typeof WKLangs === "undefined") return null;
        var id = text === undefined || text === null ? null : WKLangs.detect(String(text));
        return { id: id, label: id ? WKLangs.label(id) : "（没判出来）" };
      },
      stats: function () {
        return {
          layers: config.layerOrder.slice(), // 当前层序（WK.layers() 改的就是它）
          lastPass: state.lastResult || null, // 含 skips：这一轮"为什么有行没注音"
          reading: state.reader ? state.reader.stats() : null,
          correct: state.corrector ? state.corrector.stats() : null,
          llm: state.llm ? state.llm.stats() : null,
          learned: state.learned ? state.learned.stats() : null,
        };
      },
      llm: {
        stats: function () {
          return state.llm ? state.llm.stats() : null;
        },
        /*
         * 「大模型到底生效了没有」——一句话回答。
         * 最常要回答的就是这个，而裸 stats() 的数字要自己解读：
         * requests=0 既可能是"没配 key"，也可能是"歌词里的词全在词典里、这层没活干"。
         * 这里把两种都分开说清楚。
         */
        check: function () {
          if (!state.llm) return "大模型层没加载（core/llm.js 没注入？）";
          var s = state.llm.stats();
          var lines = [];
          lines.push("启用：" + (s.enabled ? "是" : "否"));
          lines.push("API Key：" + (s.hasKey ? "已填" : "没填"));
          if (s.hasKey) {
            /*
             * Key 体检：真机上"请求全失败"最常见的原因不是服务端，而是粘进来的 key
             * 不干净（带引号 / 前后空格 / 整个 "Bearer xxx"）。这三样我们在配置阶段
             * 就收拾掉了，顺手在这里说清楚 —— 否则只能看到一句 401。
             */
            var odd = [];
            if (s.keyShape !== "sk-") odd.push("形状不像（一般以 sk- 开头）");
            if (s.keyLength < 20) odd.push("太短（只有 " + s.keyLength + " 个字符）");
            lines.push("Key 体检：" + (odd.length ? "⚠ " + odd.join("；") : "✓ 长度 " + s.keyLength));
            if (s.keyCleaned) lines.push("　（粘进去时带了引号/空格/Bearer，已自动去掉）");
          }
          lines.push("接口：" + s.endpoint + "　模型：" + s.model);
          lines.push(
            "请求 " + s.requests + " 次，命中 " + s.hits + "，模型没给 " + s.misses + "，失败 " + s.failures
          );
          lines.push("缓存 " + s.cached + " 条，队列 " + s.pending + " 个词" + (s.inflight ? "（正在请求）" : ""));
          if (s.missesCached) {
            lines.push(
              "问过但没收下（不会再自动重问）：" + s.missesCached + " 条，其中首音校验判掉 " + s.rejected + " 次"
            );
            lines.push("→ 想再问一次：点设置里的「重试没结果的词」；想查模型当时说了什么：WK.llm.rejects()");
          }
          if (typeof s.roomThisMinute === "number") lines.push("本分钟还剩 " + s.roomThisMinute + " 次请求额度");
          if (s.cooldownMs > 0) lines.push("退避中：还要等 " + Math.round(s.cooldownMs / 1000) + " 秒");
          if (s.lastError) lines.push("最后一次错误：" + s.lastError);
          if (!s.enabled) lines.push("→ 设置面板里把「用大模型校正」打开");
          else if (!s.hasKey) lines.push("→ 设置面板里填 API Key，然后点「测试连接」");
          else if (s.failures > 0 && s.hits === 0) {
            lines.push("→ 请求都没成功，照上面的错误信息对号入座：");
            lines.push("　 401/403 = key 不对；402 = 余额用完；429 = 被限流；404 = 地址少了 /chat/completions；400 = 模型名不对");
            lines.push("　 没有状态码的那句（Failed to fetch 之类）= 网络不通，或被跨域拦住（服务商得允许 music.163.com 这个来源）");
          } else if (s.hits > 0) lines.push("→ 已经生效 ✓（想看某个词是谁给的：WK.display('词') 对比 WK.read('词')）");
          else if (s.requests > 0) lines.push("→ 请求发出去了但一个都没命中，看上面「模型没给 / 失败」的数字");
          else
            lines.push(
              "→ 还没问过任何词：说明到目前为止歌词里的拉丁词**全在离线词典里**（" +
                (typeof WKDict !== "undefined" ? WKDict.count : "?") +
                " 条），这一层没活干。想立刻验证：点设置里的「测试连接」，或找一首带生僻词/英文人名的歌"
            );
          return lines.join("\n");
        },
        test: function () {
          return state.llm ? state.llm.test() : Promise.resolve({ ok: false, message: "核心模块未加载" });
        },
        flush: function () {
          return state.llm ? state.llm.flush() : Promise.resolve(null);
        },
        /*
         * 「模型当时到底回了什么、为什么没收下」—— 排障用。
         * 出现「某个词一直不矫正」时，这里通常一眼就能看出原因
         * （首音校验误伤 / 回的不是片假名 / 服务商没给）。
         */
        rejects: function (limit) {
          if (!state.llm || !state.llm.rejects) return [];
          return state.llm.rejects(limit);
        },
        retryMisses: function () {
          return state.llm && state.llm.retryMisses ? state.llm.retryMisses() : 0;
        },
        /*
         * 手动把「大模型矫正」这根管子接回去：清掉退避，并把"要过但还没结论"的词
         * （包括注音那一刻这一层不可用、根本没问上的）立刻重新排一次。
         */
        retry: function () {
          return state.llm && state.llm.retryNow ? state.llm.retryNow() : null;
        },
        clearCache: function () {
          if (state.llm) state.llm.clearCache();
          rescan();
        },
        configure: function (next) {
          if (!state.llm) return null;
          state.llm.configure(next || {});
          if (next && next.key !== undefined) {
            config.llmKey = String(next.key || "");
            saveConfig();
          }
          if (next && next.enabled !== undefined) {
            config.llmEnabled = !!next.enabled;
            saveConfig();
          }
          rescan();
          return state.llm.stats();
        },
      },
      scan: function (text) {
        return WKMatcher.scan(text);
      },
      pass: pass,
      rescan: rescan,
      enable: enable,
      disable: disable,
      clearCache: function () {
        if (state.corrector) state.corrector.clearCache();
        rescan();
      },
      rubyLayout: function () {
        return WKAnnotate.hasRubyLayout(document);
      },
      repairLine: function (lineEl) {
        return state.annotator && state.annotator.repairLine ? state.annotator.repairLine(lineEl) : false;
      },
    };

    /*
     * 四个名字都挂着：
     *   window.WesternKatakana  长名（插件现在的身份）
     *   window.WK               短名，控制台里敲的就是它（文档里写的 WK.stats() / WK.lang()）
     *   window.LK               改名前的短名 ┐老文档 / 老脚本里是它们，各留一行别名不至于失效
     *   window.LatinKatakana    改名前的长名 ┘
     */
    window.WK = window.WesternKatakana;
    window.LK = window.WesternKatakana;
    window.LatinKatakana = window.WesternKatakana;

    log(
      "已加载" +
        (DEV ? "（开发模式）" : "") +
        "，控制台可用 WK.stats() 看统计、WK.llm.check() 看大模型有没有生效、" +
        "WK.display('light') 看某个词实际用的读音、WK.scan('light と clover') 看分词"
    );
    notifyConfigUI();
  });
})();
