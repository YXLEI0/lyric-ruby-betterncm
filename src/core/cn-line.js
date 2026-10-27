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
   */
  var CHINESE_ONLY =
    "爱为异伟汇违维遗纬员阴饮韵亩运云咏卫园烟远铅冈亿忆华货涡过祸个课贺饿开阶块溃谐贝盖该较阁确获吓额辖贯唤换间闲汉惯监缓还馆环简韩舰顽颜愿纪轨记规几挥贵弃毁辉机骑义仪拟议级纠宫给穷许鱼渔协况胁强桥矫镜竞响惊业极仅紧锦谨银训军计启倾庆鲸剧决结杰洁见轩坚绢宪贤谦键茧悬现减库夸顾后语误护红贡绞项沟构纲兴钢讲购刚狱驹顷垦恳诈锁灾细债载际财栅错册杀产伞斩暂师纸视词试诗资饲挚赐时饵识轴执质车谢肿种树终习众丑袭缩术纯顺润书绪诸绍讼胜伤详赏偿场锭饰织职针绅进诊审亲阵寻肾须帅锤势圣诚请责积绩设节羡铣迁选荐鲜渐组诉础仓扫创丧层赠则侧测贼孙损逊贷队态题诺浊达夺谁绽诞锻谈坛耻筑冲驻贮长帐张钓顶鸟胀贴肠调惩沉陈赁镇坠鹤贞订侦缔适敌彻电涂赌东冻岛讨栋汤统头誊腾动铜导顿贪钝谜锅软难认热纳农浓马骂败辈买赔剥缚罚阀贩饭烦颁范盘飞费罢备笔评标贫宾频负妇肤赋谱风复纷喷坟愤奋闻并闭币饼别编补访报饱缝纺贸谋颊扑脉务无梦雾铭鸣灭绵网门纹问约跃输邮涌犹游诱忧优预扬叶阳窑养拥罗络滥蓝栏里离陆侣虏虑凉领疗粮伦轮临类铃丽连练吕赂笼论话贿";

  var CHINESE_PUNCT = /[\uFF0C\u3002\uFF1F\uFF01\uFF1A\uFF1B\u3001\u201C\u201D\u2018\u2019\uFF08\uFF09\u3010\u3011\u300A\u300B]/;
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

  return {
    isChineseLine: isChineseLine,
    /** 判据里那张"只在中文里出现"的字表有多大（调试用） */
    size: function () {
      return CHINESE_ONLY.length;
    },
  };
});
