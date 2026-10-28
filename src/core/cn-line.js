/*
 * 判断"这一行是中文而不是日文"。
 *
 * 为什么要这个：日语歌里偶尔会夹中文行（同名曲的中文版、翻唱字幕、双语歌词），
 * 整首有假名不代表这一行是日语。以前只看整首，于是纯汉字的中文行也被当成日语、
 * 拿去查日语读音 —— 读不出来就整行留白。
 *
 * 判据（都没有假名时才算）：
 *   1. 出现"只有中文才写"的字（简体特有的 爱 / 时 / 说 / 们 / 这 …，日文里不写这些字形）；
 *   2. 出现中文标点（，。？！：；、""''）或中文特有的语气词（吗 / 呢 / 吧 / 啊）；
 *   3. 中文高频虚词出现两个以上（的 / 了 / 是 / 我 / 你 / 在 / 就 …）。
 *
 * 只做"是不是中文"的判断，**不转换文本**：中文行按中文读音注，日文行按日语读音注，
 * 各自的字形原样显示。
 *
 * 挂到 globalThis.WKCnLine。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKCnLine = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /*
   * 只在中文里出现的字形（简体特有写法 + 少数日文不用的字）。
   * 取自「简体 -> 日标汉字」的对应表：表里那些"简体一侧"的字，日文正文里不写。
   *
   * 收表时剔掉了"日文也在用"的那几个：里（里山 / 万里）、机（机上）、
   * 后（皇后）、丑（丑三つ時）、剥（剥がす）、云（云々）、筑（筑後）。
   * 它们留在表里会把纯汉字的日文行判成中文 —— 真机现象：`通称：愛情対象年齢`
   * 这种行被按普通话注成了 トンチェン / アイチン。
   */
  var CHINESE_ONLY =
    "爱为异伟汇违维遗纬员阴饮韵亩运咏卫园烟远铅冈亿忆华货涡过祸个课贺饿开阶块溃谐贝盖该较阁确获吓额辖贯唤换间闲汉惯监缓还馆环简韩舰顽颜愿纪轨记规几挥贵弃毁辉骑义仪拟议级纠宫给穷许鱼渔协况胁强桥矫镜竞响惊业极仅紧锦谨银训军计启倾庆鲸剧决结杰洁见轩坚绢宪贤谦键茧悬现减库夸顾语误护红贡绞项沟构纲兴钢讲购刚狱驹顷垦恳诈锁灾细债载际财栅错册杀产伞斩暂师纸视词试诗资饲挚赐时饵识轴执质车谢肿种树终习众袭缩术纯顺润书绪诸绍讼胜伤详赏偿场锭饰织职针绅进诊审亲阵寻肾须帅锤势圣诚请责积绩设节羡铣迁选荐鲜渐组诉础仓扫创丧层赠则侧测贼孙损逊贷队态题诺浊达夺谁绽诞锻谈坛耻冲驻贮长帐张钓顶鸟胀贴肠调惩沉陈赁镇坠鹤贞订侦缔适敌彻电涂赌东冻岛讨栋汤统头誊腾动铜导顿贪钝谜锅软难认热纳农浓马骂败辈买赔缚罚阀贩饭烦颁范盘飞费罢备笔评标贫宾频负妇肤赋谱风复纷喷坟愤奋闻并闭币饼别编补访报饱缝纺贸谋颊扑脉务无梦雾铭鸣灭绵网门纹问约跃输邮涌犹游诱忧优预扬叶阳窑养拥罗络滥蓝栏离陆侣虏虑凉领疗粮伦轮临类铃丽连练吕赂笼论话贿";

  /*
   * 中文标点。**只留中文逗号**：全角的 ：；？！。（）、【】《》 和弯引号
   * 日文里一样在用，拿它们当"这是中文"的证据会误伤纯汉字的日文行 ——
   * 真机现象：`通称：愛情対象年齢` 因为那个全角冒号被判成中文行，
   * 整行注上了普通话读音（トンチェン / アイチン / ニェンリン）。
   */
  var CHINESE_PUNCT = /\uFF0C/;
  var PARTICLE = /[\u5417\u5462\u5427\u554A\u54C7\u561B\u5566\u55EF\u54DF]/; // 吗呢吧啊哇嘛啦嗯哟
  // 中文高频虚词（出现两个以上就基本能定）
  var CN_WORDS = "的了是我你他她它们这那么在就有不没会能要想说看听走来去给让把被和与从对因为所以但是如果还是也是都很太更最只再又已经过着地得";
  var HAS_KANA = /[\u3041-\u3096\u30A1-\u30FA\u30FC]/;
  var HAS_CJK = /[\u4E00-\u9FFF]/;

  var chineseOnly = null;
  function onlySet() {
    if (chineseOnly) return chineseOnly;
    chineseOnly = {};
    for (var i = 0; i < CHINESE_ONLY.length; i++) chineseOnly[CHINESE_ONLY.charAt(i)] = 1;
    return chineseOnly;
  }

  /**
   * @param {string} text 一行原文（调用方保证没有假名，有假名时这里直接返回 false）
   * @returns {boolean}
   */
  function isChineseLine(text) {
    var s = String(text == null ? "" : text);
    if (!s) return false;
    if (HAS_KANA.test(s)) return false; // 有假名就是日文行，不抢
    if (!HAS_CJK.test(s)) return false;
    if (CHINESE_PUNCT.test(s)) return true;
    if (PARTICLE.test(s)) return true;
    var only = onlySet();
    var words = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (Object.prototype.hasOwnProperty.call(only, c)) return true; // 简体特有字形，日文里不会出现
      if (CN_WORDS.indexOf(c) >= 0) words++;
    }
    return words >= 2;
  }

  /**
   * 这一行有没有**任何**中文痕迹（比 isChineseLine 宽：一个中文虚词也算）。
   *
   * 干什么用：整首歌判成中文歌之后，纯汉字行要先排除"有一点中文味道"的，
   * 剩下的才按日语词典的可读性去认日语标题行（`(G・U・T・S雫)`）。
   * `毫不得意` 只有那个 `不`，按 isChineseLine 不算中文行（虚词要两个），
   * 但它显然不是日文 —— 这一档就是给它用的。
   */
  function hasChineseEvidence(text) {
    var s = String(text == null ? "" : text);
    if (!s) return false;
    if (HAS_KANA.test(s)) return false;
    if (CHINESE_PUNCT.test(s)) return true;
    if (PARTICLE.test(s)) return true;
    var only = onlySet();
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (Object.prototype.hasOwnProperty.call(only, c)) return true;
      if (CN_WORDS.indexOf(c) >= 0) return true;
    }
    return false;
  }

  return {
    isChineseLine: isChineseLine,
    hasChineseEvidence: hasChineseEvidence,
    /** 判据里那张"只在中文里出现"的字表有多大（调试用） */
    size: function () {
      return CHINESE_ONLY.length;
    },
  };
});
