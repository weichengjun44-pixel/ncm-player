/* 手机端没有 DevTools，出问题只能靠"把错误传回来"。
   这个脚本必须最先加载（普通 script，不是 module，且放在所有模块之前），
   这样连"模块加载失败"这种最致命的错也能抓到 —— 那正是最容易卡在加载界面的原因。

   三个作用：
   1. 捕获 error / unhandledrejection / 资源加载失败 → 显示在屏幕上（不自动隐藏，留给用户截图）+ POST 回服务器
   2. 记录启动进度（stage），12 秒还没完成就报告卡在哪一步
   3. 提供 window.NEBULA_BOOT 给各模块打点 */
(function () {
  var T0 = Date.now();
  var stage = 'boot.js 已加载';
  var bar = null;
  var sent = {};

  function ensureBar() {
    if (bar && document.body && document.body.contains(bar)) return bar;
    if (!document.body) return null;
    bar = document.createElement('div');
    bar.className = 'errbar';           // 复用已有的错误条样式
    bar.id = 'bootbar';
    bar.style.zIndex = '99999';
    bar.addEventListener('click', function () { if (bar) { bar.remove(); bar = null; } });
    document.body.appendChild(bar);
    return bar;
  }

  function send(kind, msg, extra) {
    try {
      // 同一种错误只报一次，避免刷屏
      var key = kind + '|' + String(msg).slice(0, 120);
      if (sent[key]) return;
      sent[key] = 1;
      var gl2 = false;
      try { gl2 = !!document.createElement('canvas').getContext('webgl2'); } catch (e) {}
      fetch('/__boot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: kind, msg: String(msg).slice(0, 800), stage: stage,
          t: Date.now() - T0, ua: navigator.userAgent,
          screen: screen.width + 'x' + screen.height,
          dpr: window.devicePixelRatio, gl2: gl2, extra: extra || null
        }),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  function show(kind, msg) {
    var b = ensureBar();
    if (!b) { setTimeout(function () { show(kind, msg); }, 200); return; }
    b.textContent = '⚠ ' + msg + '   （点击关闭）';
    b.dataset.kind = kind;
    b.style.display = 'block';
  }

  window.NEBULA_BOOT = {
    stage: function (s) { stage = s; },                       // 只记在本地，报告时才带上
    audio: function (info) { send('audio', JSON.stringify(info), info); },
    fail: function (kind, msg, extra) { show(kind, msg); send(kind, msg, extra); },
    ready: function (info) { stage = 'ready'; send('ready', '启动完成', info); },
    getStage: function () { return stage; }
  };

  window.addEventListener('error', function (e) {
    if (e && e.message) {
      var f = e.filename ? e.filename.split('/').pop() + ':' + e.lineno + ':' + e.colno : '';
      window.NEBULA_BOOT.fail('error', e.message + '  ' + f);
    } else if (e && e.target && (e.target.src || e.target.href)) {
      window.NEBULA_BOOT.fail('resource', '资源加载失败: ' + (e.target.src || e.target.href));
    }
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    window.NEBULA_BOOT.fail('reject', '异步异常: ' + ((r && (r.message || r)) || 'unknown'));
  });

  // 卡住检测：12 秒还没 ready，就把当前卡点报回去（服务端日志里能看到）
  setTimeout(function () {
    if (stage !== 'ready') window.NEBULA_BOOT.fail('hang', '启动卡住，停在：' + stage);
  }, 12000);
})();
