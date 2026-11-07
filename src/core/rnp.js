/*
 * RefinedNowPlayingNext 播放页设置菜单里的「注音」一栏。
 *
 * 为什么要单独一个模块：RNP 的设置菜单是它自己渲染的一组 `.rnp-group`（按 tab 分栏），
 * 只有等它被点开、真的插进 DOM 之后才能往里加东西。这个模块只做一件事：
 * 盯着 `.rnp-settings-menu`，一出现就在「歌词」那一栏后面补一个「注音」栏，
 * 复用 RNP 自己的按钮 / 开关样式。**不修改 RNP 的任何文件**，它没装或改版了
 * 就什么都不做（设置仍然在 BetterNCM 的插件设置页里）。
 *
 * 挂到 globalThis.WKRnpPanel。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKRnpPanel = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var TAB = "lyric-ruby";
  var STYLE_ID = "lyric-ruby-rnp-style";

  function install(api, doc) {
    doc = doc || document;
    var win = doc.defaultView || window;
    var menus = [];
    var stopped = false;

    function ensureStyle() {
      if (doc.getElementById(STYLE_ID)) return;
      var style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent =
        '.rnp-group[data-tab="' + TAB + '"] .wk-rnp-note{opacity:.65;font-size:13px;line-height:1.5;margin:0 0 14px;white-space:pre-wrap;overflow-wrap:anywhere;}' +
        '.rnp-group[data-tab="' + TAB + '"] .wk-rnp-row{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px;}' +
        '.rnp-group[data-tab="' + TAB + '"] .wk-rnp-row button{flex:1 1 120px;min-width:0;}' +
        '.rnp-group[data-tab="' + TAB + '"] .wk-rnp-hint{opacity:.6;font-size:12px;line-height:1.4;margin:0 0 10px;}';
      (doc.head || doc.documentElement).appendChild(style);
    }

    function checkbox(group, key, label) {
      var wrap = doc.createElement("div");
      wrap.className = "rnp-checkbox-wrapper";
      var input = doc.createElement("input");
      input.type = "checkbox";
      input.className = "rnp-checkbox";
      input.dataset.key = key;
      input.id = "wk-rnp-" + key;
      var lb = doc.createElement("label");
      lb.className = "rnp-checkbox-label";
      lb.setAttribute("for", input.id);
      lb.textContent = label;
      wrap.appendChild(input);
      wrap.appendChild(lb);
      group.appendChild(wrap);
      return input;
    }

    function choice(group, key, label, options) {
      var wrap = doc.createElement("div");
      wrap.className = "rnp-select-group-wrapper";
      var title = doc.createElement("div");
      title.className = "rnp-select-group-label";
      title.textContent = label;
      var box = doc.createElement("div");
      box.className = "rnp-select-group";
      box.dataset.choice = key;
      for (var i = 0; i < options.length; i++) {
        var b = doc.createElement("button");
        b.type = "button";
        b.className = "rnp-select-group-btn";
        b.dataset.value = options[i][0];
        b.textContent = options[i][1];
        box.appendChild(b);
      }
      wrap.appendChild(title);
      wrap.appendChild(box);
      group.appendChild(wrap);
      return box;
    }

    function buildGroup() {
      var group = doc.createElement("div");
      group.className = "rnp-group";
      group.dataset.tab = TAB;
      var heading = doc.createElement("div");
      heading.className = "rnp-group-title";
      heading.textContent = "注音";
      group.appendChild(heading);

      var enabled = checkbox(group, "enabled", "振假名注音");
      var furigana = checkbox(group, "furigana", "歌词标振假名");
      var source = choice(group, "source", "读音来源", [
        ["dict", "离线词典"],
        ["external", "外部网站"],
      ]);
      var provider = choice(group, "provider", "查询哪家", [
        ["auto", "自动"],
        ["utaten", "UtaTen"],
        ["utanet", "Uta-net"],
      ]);
      var actions = doc.createElement("div");
      actions.className = "wk-rnp-row";
      var retry = doc.createElement("button");
      retry.type = "button";
      retry.className = "rnp-select-group-btn";
      retry.textContent = "重新获取本首";
      var open = doc.createElement("button");
      open.type = "button";
      open.className = "rnp-select-group-btn";
      open.textContent = "查看来源网页";
      actions.appendChild(retry);
      actions.appendChild(open);
      group.appendChild(actions);

      var status = doc.createElement("p");
      status.className = "wk-rnp-note";
      status.setAttribute("role", "status");
      group.appendChild(status);

      function refresh() {
        var cfg = api.config();
        var info = api.status();
        enabled.checked = !!cfg.enabled;
        furigana.checked = !!cfg.furigana;
        var boxes = [source, provider];
        for (var i = 0; i < boxes.length; i++) {
          var key = boxes[i].dataset.choice;
          var want = key === "source" ? (cfg.external ? "external" : "dict") : cfg.provider;
          for (var j = 0; j < boxes[i].children.length; j++) {
            var b = boxes[i].children[j];
            var on = b.dataset.value === want;
            b.classList.toggle("selected", on);
            b.setAttribute("aria-pressed", String(on));
          }
        }
        provider.parentNode.hidden = !cfg.external;
        var text = info && info.text ? String(info.text) : "";
        if (status.textContent !== text) status.textContent = text;
        retry.disabled = !(info && info.canRetry);
        open.disabled = !(info && info.canOpen);
      }

      enabled.addEventListener("change", function () {
        api.set("enabled", enabled.checked);
        refresh();
      });
      furigana.addEventListener("change", function () {
        api.set("furigana", furigana.checked);
        refresh();
      });
      group.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest("button") : null;
        if (!btn || btn.disabled) return;
        var box = btn.parentElement && btn.parentElement.dataset ? btn.parentElement.dataset.choice : "";
        if (box === "source") {
          api.set("external", btn.dataset.value === "external");
          refresh();
        } else if (box === "provider") {
          api.set("externalProvider", btn.dataset.value);
          refresh();
        } else if (btn === retry) {
          api.retry();
          refresh();
        } else if (btn === open) {
          api.openSource();
        }
      });

      return { group: group, refresh: refresh };
    }

    function mount(menu) {
      if (!menu || !menu.querySelector) return;
      if (menu.querySelector('[data-tab="' + TAB + '"]')) return;
      var tabs = menu.querySelector(".rnp-settings-menu-tabs");
      var inner = menu.querySelector(".rnp-settings-menu-inner");
      var lyricTab = tabs && tabs.querySelector('[data-tab="lyric"]');
      var lyricGroup = inner && inner.querySelector('.rnp-group[data-tab="lyric"]');
      // 改版 / 结构不同就什么都不做（设置仍在 BetterNCM 插件设置页）
      if (!lyricTab || !lyricGroup) return;
      ensureStyle();

      var tab = doc.createElement("div");
      tab.className = "rnp-settings-menu-tab";
      tab.dataset.tab = TAB;
      tab.textContent = "注音";
      tab.tabIndex = 0;
      tab.setAttribute("role", "button");
      var built = buildGroup();
      if (lyricTab.parentNode) lyricTab.parentNode.insertBefore(tab, lyricTab.nextSibling);
      if (lyricGroup.parentNode) lyricGroup.parentNode.insertBefore(built.group, lyricGroup.nextSibling);

      function go() {
        try {
          inner.scrollTo({ top: built.group.offsetTop + 5, behavior: "smooth" });
        } catch (e) {
          inner.scrollTop = built.group.offsetTop || 0;
        }
      }
      tab.addEventListener("click", go);
      tab.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });

      menus.push({ menu: menu, tab: tab, entry: built });
      built.refresh();
    }

    function scan() {
      if (stopped) return;
      for (var i = menus.length - 1; i >= 0; i--) {
        var m = menus[i];
        if (!m.menu.isConnected || !m.entry.group.isConnected || !m.tab.isConnected) {
          if (m.entry.group.parentNode) m.entry.group.parentNode.removeChild(m.entry.group);
          if (m.tab.parentNode) m.tab.parentNode.removeChild(m.tab);
          menus.splice(i, 1);
        }
      }
      var found = doc.querySelectorAll(".rnp-settings-menu");
      for (var j = 0; j < found.length; j++) mount(found[j]);
    }

    var observer = new win.MutationObserver(function (records) {
      var selector = ".rnp-settings-menu,.rnp-settings-menu-tabs,.rnp-settings-menu-inner";
      var relevant = false;
      for (var i = 0; i < records.length && !relevant; i++) {
        var nodes = records[i].addedNodes;
        for (var k = 0; k < nodes.length; k++) {
          var n = nodes[k];
          if (n.nodeType !== 1) continue;
          if ((n.matches && n.matches(selector)) || (n.querySelector && n.querySelector(selector))) {
            relevant = true;
            break;
          }
        }
      }
      for (var q = 0; q < menus.length && !relevant; q++) {
        if (!menus[q].entry.group.isConnected) relevant = true;
      }
      if (relevant) scan();
    });
    observer.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
    scan();

    return {
      scan: scan,
      refresh: function () {
        for (var i = 0; i < menus.length; i++) menus[i].entry.refresh();
      },
      destroy: function () {
        stopped = true;
        observer.disconnect();
        for (var i = 0; i < menus.length; i++) {
          if (menus[i].entry.group.parentNode) menus[i].entry.group.parentNode.removeChild(menus[i].entry.group);
          if (menus[i].tab.parentNode) menus[i].tab.parentNode.removeChild(menus[i].tab);
        }
        menus = [];
      },
    };
  }

  return { install: install };
});
