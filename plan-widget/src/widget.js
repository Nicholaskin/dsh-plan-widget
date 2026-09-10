// widget.js — dsh-plan-widget 浏览器端计划面板（经典脚本，非 module，纯 DOM 零框架）
// 由 DSH Web 面板 /plan-widget/widget.js 提供；fetch /plan-widget/api/plan 与 /api/session 轮询。
// class 前缀 __kp_ 防冲突；颜色用 DSH Web GUI 主题 CSS 变量（带兜底值）。

(function () {
  'use strict';

  // ---- 布局参数（集中配置：改此处数值即可调整空气墙/尺寸，无需改动逻辑） ----
  var LAYOUT = {
    edge: 8,          // 距视口边缘最小间距（px）
    minVisibleH: 56,  // 底部至少保留可见高度（px），保证把手永远可抓
    minW: 240,        // 最小宽度（px）
    minH: 160,        // 最小高度（px）
    defaultW: 300,    // 默认宽度（px）
    defaultH: 420,    // 默认高度（px）
  };

  var PREFIX = '__kp_';
  var POLL_MS = 3000;
  var card = null;
  var head = null;
  var statusEl = null;
  var bannerEl = null;
  var tabsEl = null;
  var bodyEl = null;
  var todoEl = null;
  var warnEl = null;
  var syncEl = null;
  var resizeEl = null;
  var guideEl = null;
  var collapseBtn = null;
  var state = { plan: null, session: null, tab: 'daily', collapsed: false, lsKey: 'kp_layout_v1', progress: null, syncStatus: 'loading' };
  var doneSet = {};
  var pendingOptimistic = false;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function statusMeta(s) {
    var map = {
      working: { color: 'var(--dsw-alias-state-business-primary, #2fa24c)', label: '工作中' },
      idle:    { color: 'var(--dsw-alias-label-primary, #909399)', label: '空闲' },
      done:    { color: 'var(--dsw-alias-state-business-primary, #3b82f6)', label: '已完成' },
      waiting: { color: 'var(--dsw-alias-state-business-primary, #e6a23c)', label: '等待指示' }
    };
    if (s === null || s === undefined || s === '') return { color: map.idle.color, label: '无主会话' };
    return map[s] || { color: map.idle.color, label: s };
  }

  function todoKey(date) { return 'kp_todo_v1_' + date; }

  function persist() {
    try {
      localStorage.setItem(state.lsKey, JSON.stringify({ left: card.style.left || '', top: card.style.top || '', width: card.style.width || '', height: card.style.height || '', collapsed: state.collapsed }));
    } catch (e) { /* localStorage 不可用则忽略 */ }
  }
  function restore() {
    try {
      var raw = localStorage.getItem(state.lsKey);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && typeof o.left === 'string' && o.left) card.style.left = o.left;
        if (o && typeof o.top === 'string' && o.top) card.style.top = o.top;
        if (o && typeof o.width === 'string' && o.width) {
          var w = parseInt(o.width, 10);
          if (w >= LAYOUT.minW) card.style.width = w + 'px';
        }
        if (o && typeof o.height === 'string' && o.height) {
          var h = parseInt(o.height, 10);
          if (h >= LAYOUT.minH) card.style.height = h + 'px';
        }
        state.collapsed = !!(o && o.collapsed);
      }
    } catch (e) { /* 忽略损坏值 */ }
  }

  function applyCollapse() {
    if (state.collapsed) { card.classList.add(PREFIX + 'collapsed'); collapseBtn.textContent = '▢'; }
    else { card.classList.remove(PREFIX + 'collapsed'); collapseBtn.textContent = '—'; }
  }

  // 空气墙：把卡片限制在视口安全范围内（四周 edge 间距、底部至少 minVisibleH 可见），
  // 拖拽/缩放/恢复/窗口变化时统一调用，防止被拖进浏览器 chrome 区域后"再也拖不回来"。
  function clampCard() {
    var w = card.offsetWidth || LAYOUT.defaultW;
    var r = card.getBoundingClientRect();
    var maxLeft = Math.max(LAYOUT.edge, window.innerWidth - w - LAYOUT.edge);
    var maxTop = Math.max(LAYOUT.edge, window.innerHeight - LAYOUT.minVisibleH);
    var left = Math.min(Math.max(r.left, LAYOUT.edge), maxLeft);
    var top = Math.min(Math.max(r.top, LAYOUT.edge), maxTop);
    if (Math.abs(left - r.left) > 0.5 || Math.abs(top - r.top) > 0.5) {
      card.style.left = left + 'px';
      card.style.top = top + 'px';
      card.style.right = 'auto';
      card.style.bottom = 'auto';
    }
  }

  // 布局变化统一入口：当前=空气墙校正；将来「极简模式」在此加尺寸判定即可，
  // 无需改动拖拽/resize/持久化逻辑（避免重复开发）。
  function layoutChanged() {
    clampCard();
    // TODO(极简模式示例): if (card.offsetHeight < 220) card.classList.add(PREFIX + 'mini'); else card.classList.remove(PREFIX + 'mini');
  }

  // 双击把手：回到右下角默认位置 + 默认尺寸（兜底防呆）。
  function resetLayout() {
    card.style.left = 'auto'; card.style.top = 'auto';
    card.style.right = '16px'; card.style.bottom = '16px';
    card.style.width = LAYOUT.defaultW + 'px';
    card.style.height = LAYOUT.defaultH + 'px';
    state.collapsed = false;
    applyCollapse();
    layoutChanged();
    persist();
    render();
  }

  function makeDraggable(elm, handle) {
    var startX = 0, startY = 0, origLeft = 0, origTop = 0, dragging = false;
    handle.addEventListener('mousedown', function (e) {
      if (e.target === collapseBtn) return;
      dragging = true; startX = e.clientX; startY = e.clientY;
      var r = elm.getBoundingClientRect(); origLeft = r.left; origTop = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      elm.style.left = (origLeft + e.clientX - startX) + 'px';
      elm.style.top = (origTop + e.clientY - startY) + 'px';
      elm.style.right = 'auto'; elm.style.bottom = 'auto';
      layoutChanged(); // 空气墙：拖动过程实时卡边界
    });
    document.addEventListener('mouseup', function () { if (dragging) { dragging = false; layoutChanged(); persist(); } });
  }

  // 右下角把手调整尺寸：min=LAYOUT.minW/minH，max=视口-边距；折叠态禁用。
  function makeResizable(elm) {
    var startW = 0, startH = 0, startX = 0, startY = 0, resizing = false;
    resizeEl.addEventListener('mousedown', function (e) {
      if (state.collapsed) return;
      resizing = true; startW = elm.offsetWidth; startH = elm.offsetHeight;
      startX = e.clientX; startY = e.clientY;
      // 首次调整：由 right/bottom 定位转为 left/top 定位（否则改尺寸会反向扩张）。
      var r = elm.getBoundingClientRect();
      elm.style.left = r.left + 'px';
      elm.style.top = r.top + 'px';
      elm.style.right = 'auto'; elm.style.bottom = 'auto';
      e.preventDefault(); e.stopPropagation();
      document.body.style.cursor = 'nwse-resize';
    });
    document.addEventListener('mousemove', function (e) {
      if (!resizing) return;
      var rect = elm.getBoundingClientRect();
      var maxW = Math.max(LAYOUT.minW, window.innerWidth - rect.left - LAYOUT.edge);
      var maxH = Math.max(LAYOUT.minH, window.innerHeight - rect.top - LAYOUT.edge);
      var w = Math.min(Math.max(startW + e.clientX - startX, LAYOUT.minW), maxW);
      var h = Math.min(Math.max(startH + e.clientY - startY, LAYOUT.minH), maxH);
      elm.style.width = w + 'px';
      elm.style.height = h + 'px';
    });
    document.addEventListener('mouseup', function () {
      if (resizing) { resizing = false; document.body.style.cursor = ''; layoutChanged(); persist(); }
    });
  }

  function injectStyle() {
    if (document.querySelector('style[data-plugin-css="dsh-plan-widget"]')) return;
    var s = document.createElement('style');
    s.setAttribute('data-plugin-css', 'dsh-plan-widget');
    s.textContent = [
      '.' + PREFIX + 'card{position:fixed;right:16px;bottom:16px;width:300px;height:420px;max-height:calc(100vh - 32px);display:flex;flex-direction:column;z-index:9999;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.28);font:13px/1.5 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;color:var(--dsw-alias-label-primary,#1c1c1c);background:var(--dsw-alias-bg-layer-3,#ffffff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));overflow:hidden;}',
      '.' + PREFIX + 'head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));cursor:move;user-select:none;}',
      '.' + PREFIX + 'title{font-weight:700;font-size:14px;flex:0 0 auto;}',
      '.' + PREFIX + 'status{display:flex;align-items:center;gap:6px;font-size:12px;flex:1;justify-content:flex-end;overflow:hidden;}',
      '.' + PREFIX + 'dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;}',
      '.' + PREFIX + 'statustext{color:var(--dsw-alias-label-primary,#1c1c1c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.' + PREFIX + 'collapse{border:none;background:transparent;cursor:pointer;font-size:14px;line-height:1;padding:2px 6px;color:inherit;}',
      '.' + PREFIX + 'resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;z-index:10;}',
      '.' + PREFIX + 'resize::after{content:"";position:absolute;right:4px;bottom:4px;width:0;height:0;border-left:6px solid transparent;border-top:6px solid var(--dsw-alias-border-l2,rgba(0,0,0,.35));}',
      '.' + PREFIX + 'banner{padding:8px 12px;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));color:var(--dsw-alias-state-business-primary,#3b82f6);}',
      '.' + PREFIX + 'tabs{display:flex;gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));}',
      '.' + PREFIX + 'tab{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px;color:inherit;}',
      '.' + PREFIX + 'tab.active{background:var(--dsw-alias-state-business-primary,#3b82f6);color:#fff;border-color:transparent;}',
      '.' + PREFIX + 'body{flex:1;overflow:auto;padding:8px 12px;display:none;}',
      '.' + PREFIX + 'taskrow{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:8px;margin-bottom:6px;background:var(--dsw-alias-bg-layer-3,#f6f7f9);}',
      '.' + PREFIX + 'taskrow.now{border:1px solid var(--dsw-alias-state-business-primary,#3b82f6);}',
      '.' + PREFIX + 'taskrow .kp_task{font-size:13px;font-weight:600;}',
      '.' + PREFIX + 'taskrow .kp_time{font-size:11px;color:var(--dsw-alias-label-primary,#909399);}',
      '.' + PREFIX + 'taskrow.prev .kp_task{color:var(--dsw-alias-label-primary,#909399);text-decoration:line-through;}',
      '.' + PREFIX + 'taskrow.next{opacity:.6;}',
      '.' + PREFIX + 'taskrow.done{opacity:.6;}',
      '.' + PREFIX + 'taskrow.done .kp_task{color:var(--dsw-alias-label-primary,#909399);text-decoration:line-through;}',
      '.' + PREFIX + 'grouphead{font-weight:700;font-size:12px;margin:8px 2px 4px;color:var(--dsw-alias-state-business-primary,#3b82f6);}',
      '.' + PREFIX + 'banner-sub{opacity:.72;font-size:11px;margin-left:4px;}',
      '.' + PREFIX + 'todo{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));max-height:120px;overflow:auto;display:none;}',
      '.' + PREFIX + 'todo h4{margin:0 0 6px;font-size:12px;color:var(--dsw-alias-label-primary,#909399);}',
      '.' + PREFIX + 'todoitem{display:flex;align-items:flex-start;gap:6px;padding:2px 0;font-size:12px;}',
      '.' + PREFIX + 'goals{font-size:11px;color:var(--dsw-alias-label-primary,#909399);margin-top:4px;display:none;}',
      '.' + PREFIX + 'warn{font-size:11px;color:#b8860b;padding:4px 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));display:none;}',
      '.' + PREFIX + 'sync{font-size:10px;color:var(--dsw-alias-label-primary,#909399);padding:2px 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06));text-align:right;opacity:.75;display:none;}',
      '.' + PREFIX + 'guide{font-size:12px;color:#fff;background:var(--dsw-alias-state-business-primary,#3b82f6);padding:8px 12px;display:none;line-height:1.5;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));}',
      '.' + PREFIX + 'card.' + PREFIX + 'collapsed{width:36px;height:auto;min-height:36px;}',
      '.' + PREFIX + 'card.' + PREFIX + 'collapsed .' + PREFIX + 'banner,' + '.' + PREFIX + 'card.' + PREFIX + 'collapsed .' + PREFIX + 'tabs,' + '.' + PREFIX + 'card.' + PREFIX + 'collapsed .' + PREFIX + 'body,' + '.' + PREFIX + 'card.' + PREFIX + 'collapsed .' + PREFIX + 'todo,' + '.' + PREFIX + 'card.' + PREFIX + 'collapsed .' + PREFIX + 'warn{display:none!important;}',
      '.' + PREFIX + 'card.' + PREFIX + 'collapsed .' + PREFIX + 'title,' + '.' + PREFIX + 'card.' + PREFIX + 'collapsed .' + PREFIX + 'status{display:none;}'
    ].join('');
    document.head.appendChild(s);
  }

  function renderStatus() {
    var m = statusMeta(state.session && state.session.main ? state.session.main.state : null);
    statusEl.textContent = '';
    var dot = el('span', PREFIX + 'dot'); dot.style.background = m.color;
    var txt = el('span', PREFIX + 'statustext', m.label);
    statusEl.appendChild(dot); statusEl.appendChild(txt);
  }
  // 顶部横幅：显示当前 tab 层级（state.tab）的可读标题（lv.title + 周期 + 文件名）。
  // 每周/总览：lv.title 优先 → 文件名回退 → 周期；文件名为悬停 title；周期（period.from~to 或 current.period）作副行。
  // 每日页保持原样（当前时段 + 当前任务）。
  function renderBanner() {
    var lvKey = state.tab;
    var lv = (state.plan && state.plan.levels && state.plan.levels[lvKey]) || null;
    var cur = lv && lv.current ? lv.current : null;
    var title = (lv && lv.title) ? lv.title : '';
    var file = (lv && lv.file) ? lv.file : '';
    var period = (lv && lv.period && lv.period.from) ? lv.period.from + (lv.period.to ? ' ~ ' + lv.period.to : '') : '';
    if (!period && cur && cur.period) period = cur.period;
    var nowTask = (cur && cur.task && cur.task.now) ? cur.task.now : '';
    var def = lvKey === 'daily' ? '今日计划' : (lvKey === 'weekly' ? '本周' : '总览');
    bannerEl.textContent = '';
    var main;
    if (lvKey === 'daily') {
      main = (cur && cur.period) ? cur.period : (title || file || def);
    } else {
      main = title || file || period || def;
    }
    bannerEl.appendChild(el('span', PREFIX + 'banner-main', main));
    if (lvKey === 'daily') {
      if (nowTask) bannerEl.appendChild(el('span', PREFIX + 'banner-sub', ' · ' + nowTask));
    } else {
      if (period && period !== main) bannerEl.appendChild(el('span', PREFIX + 'banner-sub', ' · ' + period));
      if (nowTask) bannerEl.appendChild(el('span', PREFIX + 'banner-sub', ' · ' + nowTask));
    }
    bannerEl.title = file || '';
  }
  function taskRow(kind, task, time) {
    var row = el('div', PREFIX + 'taskrow' + (kind ? ' ' + kind : ''));
    row.appendChild(el('div', 'kp_task', task || '(无)'));
    if (time) row.appendChild(el('div', 'kp_time', time));
    return row;
  }
  function renderBody() {
    bodyEl.textContent = '';
    if (!state.plan) { bodyEl.appendChild(el('div', null, '计划数据不可用')); return; }
    var lvKey = state.tab;
    var lv = state.plan.levels && state.plan.levels[lvKey];
    if (!lv) { bodyEl.appendChild(el('div', null, '无该层级计划')); return; }
    var c = lv.current || null;
    var nowTask = (c && c.task && c.task.now) ? c.task.now : null;

    // weekly/total：若带 groups/tasks → 全列表只读渲染（见 renderFullList）；body overflow:auto 可滚动（CSS 已设）。
    if (lvKey !== 'daily' && ((Array.isArray(lv.tasks) && lv.tasks.length > 0) || (Array.isArray(lv.groups) && lv.groups.length > 0))) {
      renderFullList(bodyEl, lv, nowTask);
      return;
    }

    // 回退（fragment/lv 为空）/ 每日页：旧三行片段。
    if (!lv.current) { bodyEl.appendChild(el('div', null, '无该层级计划')); return; }
    var t = c.task || {};
    bodyEl.appendChild(taskRow('prev', t.prev, ''));
    bodyEl.appendChild(taskRow('now', t.now, c.period || ''));
    bodyEl.appendChild(taskRow('next', t.next, ''));
  }

  // 全列表渲染（只读，绝不产生勾选/onchange，绝不 POST progress）：按 groups 顺序渲染分组标题 + 任务行。
  // done=灰显+✓；当前项（与 current.task.now 匹配）高亮；pending/unknown 正常。
  function renderFullList(container, lv, nowTask) {
    var groups = (Array.isArray(lv.groups) && lv.groups.length > 0) ? lv.groups : null;
    var tasks = Array.isArray(lv.tasks) ? lv.tasks : [];
    var rows = [];
    if (groups) {
      for (var gi = 0; gi < groups.length; gi++) {
        var g = groups[gi];
        var gName = (g && g.heading) ? g.heading : '';
        var gTasks = (g && Array.isArray(g.tasks)) ? g.tasks : [];
        if (gName) rows.push({ kind: 'group', text: gName });
        for (var ti = 0; ti < gTasks.length; ti++) rows.push({ kind: 'task', t: gTasks[ti], group: gName });
      }
    }
    // 无 groups 但有展平 tasks（task.group 标注组名）→ 直接平铺
    if (rows.length === 0 && tasks.length) {
      for (var t3 = 0; t3 < tasks.length; t3++) rows.push({ kind: 'task', t: tasks[t3], group: (tasks[t3].group || '') });
    }
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.kind === 'group') { container.appendChild(el('div', PREFIX + 'grouphead', row.text)); continue; }
      container.appendChild(listTaskRow(row.t, row.group, nowTask));
    }
  }

  // 当前项判断：双向模糊匹配（先去空白再互含），防止 data 侧 current.task.now 与任务文本存在格式差异（时间前缀/空格）时漏高亮。
  function isNowMatch(text, now) {
    if (!now || !text) return false;
    var a = String(text).replace(/\s+/g, '');
    var b = String(now).replace(/\s+/g, '');
    if (!a || !b) return false;
    return a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
  }

  // 单条列表任务行（只读）：status done → 灰显+✓（text-decoration:line-through）；匹配 current.task.now → 高亮；pending/unknown → 正常。
  function listTaskRow(it, group, nowTask) {
    var text = (it && it.text) ? it.text : '(无)';
    var time = (it && it.time) ? it.time : '';
    var status = (it && it.status) ? it.status : 'pending';
    var isNow = isNowMatch(text, nowTask);
    var cls = PREFIX + 'taskrow';
    if (status === 'done') cls += ' done';
    if (isNow) cls += ' now';
    var r = el('div', cls);
    var label = status === 'done' ? '✓ ' + text : (isNow ? '▶ ' + text : text);
    r.appendChild(el('div', 'kp_task', label));
    var meta = time ? time : '';
    if (group) meta = (meta ? meta + ' · ' : '') + group;
    if (meta) r.appendChild(el('div', 'kp_time', meta));
    return r;
  }
  // taskId = <text>|<time>（0 长度 time 用 text）——与桌面端 TodoItem.Id 完全同源，跨端同步的核心。
  function taskIdOf(it) {
    return it.text + (it.time ? '|' + it.time : '');
  }

  // 底部同步状态小字。
  function setSyncText() {
    var m = { loading: '同步中…', syncing: '同步中', synced: '已同步', cloudError: '本地兜底' };
    if (syncEl) { syncEl.textContent = m[state.syncStatus] || '已同步'; syncEl.style.display = ''; }
  }

  // 勾选/取消：乐观更新 UI + POST 服务端；失败则回滚 + localStorage 兜底（下次重试）。
  function toggleTask(date, tid, desired) {
    var prev = !!doneSet[tid];
    if (desired === prev) return;
    doneSet[tid] = desired;
    try { localStorage.setItem(todoKey(date), JSON.stringify(doneSet)); } catch (e) {}
    state.syncStatus = 'syncing'; setSyncText();
    pendingOptimistic = true;
    fetch('/plan-widget/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: date, taskId: tid, done: desired })
    }).then(function (r) { return r.json(); }).then(function (d) {
      pendingOptimistic = false;
      if (d && d.ok) { state.syncStatus = 'synced'; }
      else {
        state.syncStatus = 'cloudError'; doneSet[tid] = prev;
        try { localStorage.setItem(todoKey(date), JSON.stringify(doneSet)); } catch (e) {}
      }
      setSyncText(); render();
    }).catch(function () {
      pendingOptimistic = false;
      state.syncStatus = 'cloudError'; doneSet[tid] = prev;
      try { localStorage.setItem(todoKey(date), JSON.stringify(doneSet)); } catch (e) {}
      setSyncText(); render();
    });
  }

  // 加载进度：先取服务端（真源，成功覆盖本地）；失败→localStorage 兜底。
  function loadProgress(date) {
    fetch('/plan-widget/api/progress').then(function (r) { return r.json(); }).then(function (d) {
      if (pendingOptimistic) return; // 不打断 in-flight 乐观更新
      if (d && d.ok) {
        state.progress = d.data;
        var arr = (d.data && d.data.buckets && d.data.buckets[date]) || [];
        doneSet = {};
        for (var i = 0; i < arr.length; i++) doneSet[arr[i]] = true;
        try { localStorage.setItem(todoKey(date), JSON.stringify(doneSet)); } catch (e) {}
        state.syncStatus = 'synced';
      } else {
        try { doneSet = JSON.parse(localStorage.getItem(todoKey(date)) || '{}'); } catch (e) { doneSet = {}; }
        state.syncStatus = 'cloudError';
      }
      setSyncText(); render();
    }).catch(function () {
      if (pendingOptimistic) return;
      try { doneSet = JSON.parse(localStorage.getItem(todoKey(date)) || '{}'); } catch (e) { doneSet = {}; }
      state.syncStatus = 'cloudError';
      setSyncText(); render();
    });
  }

  function renderTodo() {
    todoEl.textContent = '';
    if (!state.plan || !state.plan.today) return;
    var today = state.plan.today;
    var date = today.date || '';
    todoEl.appendChild(el('h4', null, '今日待办'));
    var tasks = today.tasks || [];
    for (var i = 0; i < tasks.length; i++) {
      (function (it) {
        var row = el('label', PREFIX + 'todoitem');
        var cb = document.createElement('input'); cb.type = 'checkbox';
        var tid = taskIdOf(it);
        cb.checked = !!doneSet[tid];
        cb.onchange = function () { toggleTask(date, tid, cb.checked); };
        row.appendChild(cb);
        row.appendChild(document.createTextNode(it.text + (it.time ? ' · ' + it.time : '')));
        todoEl.appendChild(row);
      })(tasks[i]);
    }
    var goals = today.goals || [];
    if (goals.length) {
      var g = el('div', PREFIX + 'goals'); g.style.display = '';
      g.textContent = '今日目标：' + goals.join('；');
      todoEl.appendChild(g);
    }
  }
  // 计划是否可用（有今日任务）。未配置/无任务 → 显示首访引导条。
  function planUsable() {
    return !!(state.plan && state.plan.today && Array.isArray(state.plan.today.tasks) && state.plan.today.tasks.length > 0);
  }
  function renderGuide() {
    if (!guideEl) return;
    if (planUsable()) { guideEl.style.display = 'none'; }
    else {
      guideEl.textContent = '尚未配置计划：在 DSH 会话说「帮我配置计划」即可';
      guideEl.style.display = '';
    }
  }
  function renderWarn() {
    var w = state.plan && state.plan.warnings ? state.plan.warnings : [];
    if (w.length) { warnEl.textContent = w.join('；'); warnEl.style.display = ''; }
    else { warnEl.style.display = 'none'; }
  }
  function render() {
    renderStatus(); renderBanner(); renderGuide(); renderBody(); renderTodo(); renderWarn();
    bodyEl.style.display = state.collapsed ? 'none' : 'block';
    todoEl.style.display = state.collapsed ? 'none' : 'block';
    var tabs = tabsEl.querySelectorAll('[data-tab]');
    for (var i = 0; i < tabs.length; i++) {
      var b = tabs[i];
      if (b.getAttribute('data-tab') === state.tab) b.classList.add('active'); else b.classList.remove('active');
    }
  }

  function fetchJson(url, cb) {
    fetch(url).then(function (r) { return r.json(); }).then(function (d) { state.err = null; cb(d); }).catch(function () { state.err = url; cb(null); });
  }
  function poll() {
    fetchJson('/plan-widget/api/plan', function (d) {
      if (d && d.ok) { state.plan = d.data; } else { state.plan = null; }
      if (state.plan && state.plan.today && state.plan.today.date) { loadProgress(state.plan.today.date); }
      render();
    });
    fetchJson('/plan-widget/api/session', function (d) { if (d && d.ok) { state.session = d.data; } else { state.session = null; } render(); });
  }

  function init() {
    injectStyle();
    card = el('div', PREFIX + 'card');
    head = el('div', PREFIX + 'head');
    head.appendChild(el('div', PREFIX + 'title', '计划悬浮窗'));
    statusEl = el('div', PREFIX + 'status');
    collapseBtn = el('button', PREFIX + 'collapse', '—');
    collapseBtn.type = 'button';
    head.appendChild(statusEl); head.appendChild(collapseBtn);
    card.appendChild(head);
    bannerEl = el('div', PREFIX + 'banner'); card.appendChild(bannerEl);
    guideEl = el('div', PREFIX + 'guide'); card.appendChild(guideEl);
    tabsEl = el('div', PREFIX + 'tabs');
    var defs = [['daily', '今日'], ['weekly', '本周'], ['total', '总览']];
    for (var i = 0; i < defs.length; i++) (function (def) {
      var b = el('button', PREFIX + 'tab', def[1]);
      b.setAttribute('data-tab', def[0]); b.type = 'button';
      b.onclick = function () { state.tab = def[0]; render(); };
      tabsEl.appendChild(b);
    })(defs[i]);
    card.appendChild(tabsEl);
    bodyEl = el('div', PREFIX + 'body'); card.appendChild(bodyEl);
    todoEl = el('div', PREFIX + 'todo'); card.appendChild(todoEl);
    warnEl = el('div', PREFIX + 'warn'); card.appendChild(warnEl);
    syncEl = el('div', PREFIX + 'sync'); card.appendChild(syncEl);
    resizeEl = el('div', PREFIX + 'resize');
    resizeEl.title = '拖动调整大小';
    card.appendChild(resizeEl);
    document.body.appendChild(card);
    collapseBtn.onclick = function () { state.collapsed = !state.collapsed; persist(); applyCollapse(); render(); };
    makeDraggable(card, head);
    makeResizable(card);
    // 双击把手：重置位置与尺寸（排除折叠按钮，避免误触）。
    head.addEventListener('dblclick', function (e) { if (e.target === collapseBtn) return; resetLayout(); });
    // 浏览器窗口尺寸变化时自动校正（防止小窗口把卡片锁到视口外）。
    window.addEventListener('resize', function () { layoutChanged(); });
    restore();
    layoutChanged(); // 恢复后立即空气墙校正（历史越界数据自动回到安全位置）
    applyCollapse();
    setSyncText();
    poll();
    setInterval(poll, POLL_MS);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else document.addEventListener('DOMContentLoaded', init);
}());
