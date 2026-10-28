(function () {
  var TOOLS = ['Claude Code', 'Codex', 'Antigravity', 'Ollama'];
  var COLORS = ['#e08a66', '#5fb8a4', '#7d9bf0', '#b39ddb'];
  var token = (/[?&]t=([a-f0-9]+)/.exec(location.search) || [])[1] || '';
  var lastOk = 0, snap = null, view = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function hm(t) { var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function when(t) {
    var d = new Date(t), n = new Date();
    if (d.toDateString() === n.toDateString()) return 'às ' + hm(t);
    n.setDate(n.getDate() - 1);
    return (d.toDateString() === n.toDateString() ? 'ontem ' : pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ') + hm(t);
  }
  function k(n) { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : '' + n; }
  function dur(ms) {
    var m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return m + 'min';
    var h = Math.floor(m / 60);
    return h < 24 ? h + 'h' + pad(m % 60) : Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }
  function levelColor(p) { return p >= 80 ? '#e87070' : p >= 50 ? '#e0b45a' : '#5fb8a4'; }
  // Preferências do aparelho; localStorage pode falhar (aba privada no iOS)
  function store(key, val) { try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (e) {} }
  function toolIndex(t) { for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i] === t) return i; return 0; }

  // ---- Cotas ---------------------------------------------------------------
  function paceText(w, now) {
    var p = w.pace;
    if (w.used >= 100) return '<span class="hi">esgotada · volta em ' + dur(w.resetsAt - now) + '</span>';
    if (!p) return '';
    if (p.runsOutIn != null) return '<span class="hi">▲ acaba em ' + dur(p.runsOutIn) + '</span>';
    if (p.projected != null) return '<span class="' + (p.projected >= 80 ? 'warn' : 'lo') + '">~' + p.projected + '% no reset</span>';
    return '';
  }

  function gauge(label, w, now) {
    if (!w) return '';
    var used = Math.max(0, Math.min(100, w.used)), mark = w.pace ? w.pace.expected : null;
    return '<div class="gauge"><div class="row"><span class="lbl grow">' + label + '</span><span class="pct">' + Math.round(w.used) + '%</span></div>' +
      '<div class="track"><div class="fill" style="width:' + used + '%;background:' + levelColor(used) + '"></div>' +
      (mark != null ? '<div class="mark" style="left:' + Math.min(99, mark) + '%"></div>' : '') + '</div>' +
      '<div class="foot row"><span class="muted grow">reset em ' + dur(w.resetsAt - now) + '</span>' + paceText(w, now) + '</div></div>';
  }

  // Ícones das extensões do VS Code, servidos pelo HUD já na cor de referência de cada IA
  // Ícone do app do Ollama (servido pelo HUD, pintado de lilás por filtro); se o PC principal não tiver
  // o app instalado, a imagem falha e é escondida
  function ollamaIcon() {
    return '<img class="brand ollama-ico" src="/brand-ollama.png" alt="" onerror="this.style.display=&quot;none&quot;">';
  }
  function toolIcon(idx) {
    if (idx === 3) return ollamaIcon();
    return idx < 2 ? brandIcon(idx) : '<span class="dot c2"></span>';
  }
  function brandIcon(idx) {
    return '<img class="brand" src="/brand-' + (idx ? 'codex' : 'claude') + '.svg" alt="">';
  }

  function quotaPanel(id, name, idx, q, now, used) {
    var html = '<div class="qhead row">' + brandIcon(idx) + '<span class="name">' + name + '</span><small>' + esc(q && q.plan || '') + '</small>' +
      '<span class="grow"></span><span class="tokens">' + k(used) + ' <small>tokens hoje</small></span></div>';
    if (!q) html += '<div class="empty">lendo…</div>';
    else {
      var w = q.windows || {};
      if (w.five_hour || w.seven_day) html += gauge('Janela de 5 horas', w.five_hour, now) + gauge('Semana', w.seven_day, now);
      else if (!q.error) html += '<div class="empty">sem cota de plano</div>';
      if (q.error) html += '<div class="qerr">⚠ ' + esc(q.error) + '</div>';
    }
    $(id).innerHTML = html;
  }

  // ---- Sessões -------------------------------------------------------------
  function badge(x, now) {
    if (x.state === 'permission') return '<span class="badge perm">🔐 permissão · ' + esc(x.permission.tool) + '</span>';
    if (x.state === 'working') return '<span class="badge working"><span class="pulse">●</span> ' + esc(x.lastTool || 'trabalhando') + '</span>';
    if (x.state === 'waiting') return '<span class="badge waiting">sua vez · ' + dur(now - x.end) + '</span>';
    if (x.state === 'idle') return '<span class="badge idle">parada ' + dur(now - x.end) + '</span>';
    return '<span class="badge closed">' + when(x.end) + '</span>';
  }

  function sessRow(x, now) {
    var i = toolIndex(x.tool), meta = [], bar = '';
    if (x.context && x.contextWindow) {
      var pct = Math.min(100, x.context / x.contextWindow * 100);
      bar = '<div class="ctx"><div style="width:' + pct + '%;background:' + levelColor(pct) + '"></div></div>';
      meta.push('contexto ' + Math.round(pct) + '%');
    }
    meta.push(x.tool === 'Antigravity' || x.tool === 'Ollama' ? x.prompts + ' pedidos' : k(x.tokens) + ' tokens');
    meta.push(dur(now - x.start));
    return '<button class="sess b' + i + '" data-id="' + esc(x.id) + '">' +
      '<div class="row"><span class="proj ell">' + esc(x.project) + '</span><span class="tool">' + esc(x.tool) + '</span>' +
      '<span class="grow"></span>' + badge(x, now) + '<span class="chev">›</span></div>' +
      (x.title ? '<div class="ttl ell">' + esc(x.title) + '</div>' : '') +
      '<div class="l3 row">' + (bar || '<span class="grow"></span>') + '<span>' + meta.join(' · ') + '</span></div></button>';
  }

  // Cartão da grade principal (a lista de Recentes na gaveta continua em linhas)
  function sessCard(x, now) {
    var i = toolIndex(x.tool), meta = [], bar = '';
    if (x.context && x.contextWindow) {
      var pct = Math.min(100, x.context / x.contextWindow * 100);
      bar = '<div class="ctx"><div style="width:' + pct + '%;background:' + levelColor(pct) + '"></div></div>';
      meta.push('ctx ' + Math.round(pct) + '%');
    }
    meta.push(x.tool === 'Antigravity' || x.tool === 'Ollama' ? x.prompts + ' pedidos' : k(x.tokens));
    meta.push(dur(now - x.start));
    var ping = pings[x.id] && now - pings[x.id] < 60e3 ? ' ping' : '';
    return '<button class="card t' + i + (x.state === 'waiting' ? ' waiting-card' : x.state === 'permission' ? ' perm-card' : x.state === 'closed' ? ' old-card' : '') + ping + '" data-id="' + esc(x.id) + '"><div class="in">' +
      // Ícone da IA antes do nome da sessão; na linha de baixo, o PC onde ela roda
      '<div class="row">' + toolIcon(i) + '<span class="proj ell grow">' + esc(x.project) + '</span><span class="chev">›</span></div>' +
      '<div class="sub row">' + badge(x, now) + '<span class="tool ell grow">' + (x.machine ? '🖥 ' + esc(x.machine) : esc(x.tool)) + '</span>' +
      // Só o símbolo, para sobrar espaço para o nome do PC: ✉ resposta na fila, ↩ dá para responder ao vivo
      (x.queued ? '<span class="rflag queued" title="Resposta na fila">✉</span>' : x.listening ? '<span class="rflag" title="Pode responder ao vivo">↩</span>' : '') + '</div>' +
      (x.title ? '<div class="ttl ell">' + esc(x.title) + '</div>' : '') +
      (x.lastPrompt && x.lastPrompt.toLowerCase() !== String(x.title).toLowerCase() ?'<div class="ask">' + esc(x.lastPrompt) + '</div>' : '') +
      '<div class="foot">' + bar + '<div class="meta">' + meta.join(' · ') + '</div></div></div></button>';
  }

  // ---- Burn-up da janela de 5h ----------------------------------------------
  // Linha cheia: % usado ao longo da janela. Tracejada: ritmo atual até o reset (ou até 100%).
  function burnChart(s) {
    var box = $('burn');
    if (!box) return;
    var W = box.clientWidth, H = box.clientHeight, names = ['claude', 'codex'], i, j;
    var b = s.burn || {}, x0 = Infinity, x1 = -Infinity;
    for (i = 0; i < names.length; i++) if (b[names[i]]) { x0 = Math.min(x0, b[names[i]].start); x1 = Math.max(x1, b[names[i]].end); }
    if (x0 === Infinity || !W || !H) { box.innerHTML = '<div class="empty">sem dados da janela</div>'; $('burnAxis').innerHTML = ''; return; }
    var L = 40, T = 8, R = 6, B = 6, now = s.now;
    function X(t) { return (L + (t - x0) / (x1 - x0) * (W - L - R)).toFixed(1); }
    function Y(p) { return (T + (1 - Math.min(100, p) / 100) * (H - T - B)).toFixed(1); }
    var svg = '<svg width="' + W + '" height="' + H + '">';
    var grid = [[0, '0%'], [50, '50%'], [100, '100%']];
    for (i = 0; i < grid.length; i++) {
      svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(grid[i][0]) + '" y2="' + Y(grid[i][0]) + '" stroke="' + (grid[i][0] === 100 ? '#6b3a3a' : '#2c2c29') + '" stroke-width="1"' + (grid[i][0] === 100 ? ' stroke-dasharray="4 4"' : '') + '/>' +
        '<text x="' + (L - 6) + '" y="' + (+Y(grid[i][0]) + 5) + '" text-anchor="end">' + grid[i][1] + '</text>';
    }
    svg += '<line x1="' + X(now) + '" x2="' + X(now) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="#5c5c57" stroke-dasharray="3 4"/>';
    for (i = 0; i < names.length; i++) {
      var d = b[names[i]];
      if (!d) continue;
      var pts = '';
      for (j = 0; j < d.points.length; j++) pts += X(d.points[j][0]) + ',' + Y(d.points[j][1]) + ' ';
      svg += '<polyline points="' + pts + '" fill="none" stroke="' + COLORS[i] + '" stroke-width="3" stroke-linejoin="round"/>';
      var tEnd = d.runsOutIn != null ? now + d.runsOutIn : d.end, pEnd = d.runsOutIn != null ? 100 : d.projected;
      if (pEnd != null) {
        svg += '<line x1="' + X(now) + '" y1="' + Y(d.used) + '" x2="' + X(tEnd) + '" y2="' + Y(pEnd) + '" stroke="' + COLORS[i] + '" stroke-width="2" stroke-dasharray="6 5" opacity=".8"/>';
        if (d.runsOutIn != null) svg += '<circle cx="' + X(tEnd) + '" cy="' + Y(100) + '" r="5" fill="#e87070"/>';
      }
      svg += '<circle cx="' + X(Math.min(now, d.end)) + '" cy="' + Y(d.used) + '" r="4" fill="' + COLORS[i] + '"/>';
    }
    box.innerHTML = svg + '</svg>';
    $('burnAxis').innerHTML = '<span>' + hm(x0) + '</span><span>agora ' + hm(now) + '</span><span>' + hm(x1) + '</span>';
  }

  // ---- Estatísticas (gaveta #estatisticas) ---------------------------------
  // Barras empilhadas Claude/Codex; `label` põe o total em cima de cada barra
  function bars(rows, label) {
    var max = 1, html = '', j;
    for (j = 0; j < rows.length; j++) max = Math.max(max, rows[j]['Claude Code'] + rows[j].Codex);
    var scale = label ? 82 : 100; // espaço para o rótulo
    for (j = 0; j < rows.length; j++) {
      var a = rows[j]['Claude Code'], b = rows[j].Codex;
      html += '<div class="bar">' +
        (a ? '<div style="height:' + (a / max * scale) + '%;background:' + COLORS[0] + '"></div>' : '') +
        (b ? '<div style="height:' + (b / max * scale) + '%;background:' + COLORS[1] + '"></div>' : '') +
        (label && a + b ? '<div class="val">' + k(a + b) + '</div>' : '') + '</div>';
    }
    return { html: html, max: max };
  }

  function renderStats() {
    if (!snap) return;
    var s = snap, names = ['Claude Code', 'Codex'], i, html = head('Estatísticas');
    html += '<div class="panel"><h2>Janela de 5h · uso e projeção</h2><div class="burnbox" id="burn"></div><div class="axis" id="burnAxis"></div>' +
      '<div class="legend"><span><span class="dot c0"></span>Claude</span><span><span class="dot c1"></span>Codex</span>' +
      '<span>━ real</span><span>╌ ritmo atual</span><span style="color:#e87070">● cota acaba</span></div></div>';
    html += '<div class="panel"><h2>Hoje · tokens novos</h2><div class="today">';
    for (i = 0; i < names.length; i++) {
      html += '<div class="tday"><span class="dot c' + i + '"></span>' + (i ? 'Codex' : 'Claude') +
        '<div class="big">' + k(s.today[names[i]].fresh) + '</div><small>+ ' + k(s.today[names[i]].cacheRead) + ' do cache · ' +
        s.sessionsToday[names[i]] + (s.sessionsToday[names[i]] === 1 ? ' sessão' : ' sessões') + '</small></div>';
    }
    var h = bars(s.hours, false);
    html += '</div><div class="chart">' + h.html + '</div><div class="axis"><span>24h atrás</span><span>pico ' + k(h.max) + '/h</span><span>agora</span></div></div>';
    var d = bars(s.days, true), wd = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'], labels = '';
    for (i = 0; i < s.days.length; i++) labels += '<span style="-webkit-flex:1;flex:1;text-align:center">' + (i === s.days.length - 1 ? 'hoje' : wd[new Date(s.days[i].t).getDay()]) + '</span>';
    html += '<div class="panel"><h2>Últimos 7 dias · tokens novos</h2><div class="chart days">' + d.html + '</div><div class="axis">' + labels + '</div></div>';
    setOverlay(html);
    burnChart(s);
  }

  // ---- Alertas: bipe + aviso quando uma sessão passa a esperar por você ou a cota de 5h está acabando ----
  var prevStates = null, prevCompleted = null, pings = {}, quotaAlerted = {}, audio = null;
  var soundOn = store('hud.sound') !== '0';

  // O iOS só libera áudio depois de um toque do usuário: o primeiro toque cria o contexto
  function unlockAudio() {
    if (audio) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audio = new Ctx();
    var b = audio.createBuffer(1, 1, 22050), src = audio.createBufferSource();
    src.buffer = b; src.connect(audio.destination);
    if (src.start) src.start(0); else src.noteOn(0);
  }
  document.addEventListener('touchend', unlockAudio, false);
  document.addEventListener('click', unlockAudio, false);

  function beep() {
    if (!soundOn || !audio) return;
    var notes = [880, 1175];
    for (var i = 0; i < notes.length; i++) {
      var o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + i * 0.18;
      o.frequency.value = notes[i];
      o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.25, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      if (o.start) { o.start(t); o.stop(t + 0.17); } else { o.noteOn(t); o.noteOff(t + 0.17); }
    }
  }

  function checkAlerts(s) {
    var msgs = [], states = {}, completed = {}, i;
    for (i = 0; i < s.active.length; i++) {
      var x = s.active[i];
      states[x.id] = x.state;
      completed[x.id] = x.completedAt || 0;
      // Um turno curto pode começar e terminar entre consultas, sem mostrar "working".
      // A primeira leitura só estabelece a referência, sem avisar sobre respostas antigas.
      var newReply = prevCompleted && completed[x.id] > (prevCompleted[x.id] || 0);
      if (prevStates && x.state === 'waiting' && (prevStates[x.id] !== 'waiting' || newReply)) {
        pings[x.id] = s.now;
        msgs.push(x.project + ' (' + x.tool + ') espera você');
      }
      if (prevStates && x.state === 'permission' && prevStates[x.id] !== 'permission') {
        pings[x.id] = s.now;
        msgs.push(x.project + ' pede permissão: ' + x.permission.tool);
      }
    }
    prevStates = states;
    prevCompleted = completed;
    var names = [['claude', 'Claude'], ['codex', 'Codex']];
    for (i = 0; i < names.length; i++) {
      var q = s.quotas[names[i][0]], w = q && q.windows && q.windows.five_hour;
      if (!w || !w.pace) continue;
      var key = names[i][0] + w.resetsAt;
      var soon = w.used >= 90 || (w.pace.runsOutIn != null && w.pace.runsOutIn < 30 * 60e3);
      if (soon && !quotaAlerted[key]) {
        quotaAlerted[key] = true;
        msgs.push('Cota de 5h do ' + names[i][1] + (w.used >= 90 ? ' em ' + Math.round(w.used) + '%' : ' acaba em ' + dur(w.pace.runsOutIn)));
      }
    }
    if (msgs.length) { beep(); flash(msgs.join(' · ')); }
  }

  function setRemoteBtn(on) {
    $('remote').className = 'btn' + (on ? ' on' : '');
    $('remote').innerHTML = '🛰<span class="lbl"> ' + (on ? 'Remoto ligado' : 'Remoto') + '</span>';
  }

  function setSound(on) {
    soundOn = on;
    store('hud.sound', on ? '1' : '0');
    $('sound').innerHTML = on ? '🔔' : '🔕';
  }

  // ---- Ollama: cartão de status na linha das cotas (meia largura) -----------
  // As conversas do app do Ollama aparecem na grade como sessões normais; aqui fica só o estado
  // do servidor de cada PC: online, modelos carregados, instalados e GPU. Toque abre os detalhes.
  function gb(bytes) { return (bytes / 1073741824).toFixed(1) + ' GB'; }

  function ollamaPanel(s) {
    var el = $('q-ollama'), list = s.ollamas || [], html = '', i, j;
    if (!el) return;
    el.style.display = list.length ? '' : 'none';
    if (!list.length) return;
    var multi = s.machines && s.machines.length > 1;
    html += '<div class="qhead row">' + ollamaIcon() + '<span class="name">Ollama</span><span class="grow"></span><span class="chev">›</span></div>';
    // Só o essencial: está no ar? qual modelo está carregado? (o resto fica na gaveta)
    for (i = 0; i < list.length; i++) {
      var o = list[i];
      html += '<div class="ostat">' + (multi && o.machine ? '<div class="omach">🖥 ' + esc(o.machine) + '</div>' : '') +
        (o.online ? '<span class="lo">● online</span>' : '<span class="hi">● fora do ar</span>');
      if (o.online && !o.models.length) html += '<div class="muted omodel">ocioso</div>';
      for (j = 0; o.online && j < o.models.length; j++) {
        var m = o.models[j];
        // % na GPU (velocidade) e até quando fica carregado
        html += '<div class="omodel ell"><b>' + esc(m.name) + '</b></div>' +
          '<div class="osmall2 muted">' + m.gpuPct + '% GPU' + (m.expiresAt ? ' · até ' + hm(m.expiresAt) : '') + '</div>';
      }
      // Uso: sessões do Ollama ativas neste PC (app ou terminal) e a última atividade
      var act = 0, last = 0, all = s.active.concat(s.recent), k2;
      for (k2 = 0; k2 < all.length; k2++) {
        var x = all[k2];
        if (x.tool !== 'Ollama' || (o.machine && x.machine && x.machine !== o.machine)) continue;
        if (x.state !== 'closed') act++;
        if (x.end > last) last = x.end;
      }
      var use = [];
      if (act) use.push(act + (act === 1 ? ' sessão ativa' : ' sessões ativas'));
      if (last) use.push('último uso ' + when(last).replace(/^às /, ''));
      if (use.length) html += '<div class="osmall2 muted ouse">' + use.join(' · ') + '</div>';
      html += '</div>';
    }
    el.innerHTML = html;
  }

  // Gaveta #ollama: detalhes de cada PC com Ollama
  function renderOllama() {
    if (!snap) return;
    var list = snap.ollamas || [], html = head(ollamaIcon() + 'Ollama'), i, j;
    if (!list.length) html += '<p class="empty">Nenhum PC com Ollama.</p>';
    for (i = 0; i < list.length; i++) {
      var o = list[i], g = o.gpu;
      html += '<div class="panel"><h2>🖥 ' + esc(o.machine || '') + '</h2>' +
        '<div class="dl"><span>Estado</span><span>' + (o.online ? '<span class="lo">● online</span>' : '<span class="hi">● fora do ar</span>') + '</span></div>' +
        '<div class="dl"><span>Versão</span><span>' + esc(o.version || '—') + '</span></div>' +
        '<div class="dl"><span>Modelos instalados</span><span>' + (o.installed != null ? o.installed : '—') + '</span></div>' +
        (g ? '<div class="dl"><span>GPU</span><span>' + esc(g.name) + '</span></div>' +
          '<div class="dl"><span>Uso · temperatura</span><span>' + g.util + '% · ' + g.temp + '°C</span></div>' +
          '<div class="dl"><span>VRAM</span><span>' + (g.memUsed / 1024).toFixed(1) + ' / ' + (g.memTotal / 1024).toFixed(0) + ' GB</span></div>' : '') +
        '<h2 style="margin-top:12px">Modelos carregados</h2>';
      if (!o.models.length) html += '<div class="empty">Nenhum agora (o Ollama descarrega ~5 min após o último uso).</div>';
      for (j = 0; j < o.models.length; j++) {
        var m = o.models[j];
        html += '<div class="dl" style="border:0;padding-bottom:0"><span><b>' + esc(m.name) + '</b></span><span>' + gb(m.size) + '</span></div>' +
          '<div class="hbar"><div style="width:' + m.gpuPct + '%;background:#b39ddb"></div></div>' +
          '<div class="dl"><span class="muted">' + esc([m.params, m.quant].filter(Boolean).join(' · ')) + '</span><span class="muted">' +
          m.gpuPct + '% na GPU' + (m.expiresAt ? ' · até ' + hm(m.expiresAt) : '') + '</span></div>';
      }
      html += '</div>';
    }
    setOverlay(html);
  }

  var GRID_MIN = 6; // 2 linhas de 3 cartões

  function render(s) {
    setRemoteBtn(s.remoteMode);
    quotaPanel('q-claude', 'Claude', 0, s.quotas.claude, s.now, s.today['Claude Code'].fresh);
    quotaPanel('q-codex', 'Codex', 1, s.quotas.codex, s.now, s.today.Codex.fresh);
    ollamaPanel(s);
    // O servidor prioriza permissões e sessões esperando o usuário, inclusive no hub.
    // Se sobrar espaço nas duas primeiras linhas, completa com as últimas sessões inativas.
    var active = s.active.slice();
    var used = active.length;
    var fill = s.recent.slice(0, Math.max(0, GRID_MIN - used));
    var html = '', waiting = 0, i;
    for (i = 0; i < active.length; i++) {
      html += sessCard(active[i], s.now);
      if (active[i].state === 'waiting') waiting++;
    }
    for (i = 0; i < fill.length; i++) html += sessCard(fill[i], s.now);
    $('sessList').innerHTML = html || '<div class="empty">Nenhuma sessão recente.</div>';
    var down = '';
    for (i = 0; s.machines && i < s.machines.length; i++) if (!s.machines[i].ok) down += ' · <span class="hi">🖥 ' + esc(s.machines[i].name) + ' fora do ar</span>';
    $('sessTitle').innerHTML = 'Últimas sessões · ' + active.length + (active.length === 1 ? ' ativa' : ' ativas') +
      (waiting ? ' · <span style="color:#b3c6ff">' + waiting + ' esperando você</span>' : '') + down;
    if (view === 'recent') renderRecent();
    if (view === 'stats') renderStats();
    if (view === 'ollama') renderOllama();
  }

  // ---- Sobreposições: #s=<id> (detalhe) e #recentes ------------------------
  function stat(v, label) { return '<div class="stat"><div class="v">' + v + '</div><div class="k">' + label + '</div></div>'; }
  // Cabeçalho comum das gavetas: título à esquerda, ✕ redondo à direita
  function head(title, sub) {
    return '<div class="dtop row"><div class="grow"><div class="dtitle ell">' + title + '</div>' +
      (sub ? '<div class="dsub ell">' + sub + '</div>' : '') + '</div>' +
      '<button class="close" id="back" aria-label="Fechar">✕</button></div>';
  }
  function sessHead(x) {
    var idx = toolIndex(x.tool);
    // Claude e Codex com o ícone da página inicial; Antigravity (sem ícone) continua com a bolinha
    return head(toolIcon(idx) + esc(x.project) + ' <small class="muted">' + esc(x.tool) + machineTag(x) + '</small>',
      x.title ? esc(x.title) : '');
  }

  // Nome do PC da sessão: só aparece quando o hub junta mais de um PC
  function machineTag(x) {
    return snap && snap.machines && snap.machines.length > 1 && x.machine ? ' · 🖥 ' + esc(x.machine) : '';
  }

  // Gaveta da sessão, em ordem de uso: quem é → Abrir no PC → última resposta → Responder → mais detalhes (fechado)
  var moreOpen = store('hud.moreOpen') !== '0'; // aberto por padrão; lembra se o usuário fechar

  function renderDetail(d) {
    var now = d.now, html = '';
    var pct = d.contextWindow ? Math.round(d.context / d.contextWindow * 100) : 0;
    var st = d.permission ? '<span class="badge perm">🔐 aguardando permissão</span>'
      : d.state === 'working' ?'<span class="badge working"><span class="pulse">●</span> trabalhando' + (d.lastTool ? ' · ' + esc(d.lastTool) : '') + '</span>'
      : d.state === 'waiting' ? '<span class="badge waiting">sua vez há ' + dur(now - d.end) + '</span>'
      : d.state === 'idle' ? '<span class="badge idle">parada há ' + dur(now - d.end) + '</span>'
      : '<span class="badge closed">encerrada ' + when(d.end) + '</span>';
    html += sessHead(d);
    html += '<div class="dstate">' + st + '<span class="muted">' + (pct ? 'contexto ' + pct + '% · ' : '') + dur(d.end - d.start) + ' de sessão</span></div>';
    // Pedido de permissão (modo remoto) vem antes de tudo: a sessão está parada esperando isso
    if (d.permission) {
      html += '<div class="panel permbox"><h2>🔐 Pedido de permissão · ' + esc(d.permission.tool) + '</h2>' +
        '<div class="permcmd">' + esc(d.permission.summary) + '</div><div class="row">' +
        '<button class="pbtn allow" id="permAllow">Permitir</button><button class="pbtn deny" id="permDeny">Negar</button></div></div>';
    }
    var places = { vscode: 'no VS Code', terminal: 'no terminal', 'claude-desktop': 'no app do Claude', 'ollama-app': 'no app do Ollama', 'ollama-run': 'no terminal' };
    if (places[d.where]) {
      html += '<button class="pcaction" id="focusPc">🖥 Abrir no PC <small>' + places[d.where] + '</small></button>';
    }
    // Ler e responder sem rolar: última resposta (com rolagem própria) logo acima de Responder
    if (d.lastReply) html += '<div class="panel"><h2>Última resposta</h2><div class="quote lastreply" id="lastReply">' + esc(d.lastReply) + '</div></div>';
    // ollama run no terminal: não há como escrever na conversa
    if (d.tool !== 'Antigravity' && d.where !== 'ollama-run') html += replyBox(d);
    if (d.where === 'ollama-run') html += '<div class="panel"><div class="muted" style="font-size:.85em">Conversa no terminal (ollama run): o Ollama não grava essas conversas, então não dá para ler as respostas nem responder por aqui. Use Abrir no PC.</div></div>';

    html += '<div class="panel more' + (moreOpen ? ' open' : '') + '" id="more"><button class="mhead row" id="moreToggle">' +
      '<h2 class="grow">Mais detalhes</h2><span class="arrow">▸</span></button><div class="mbody">';
    if (d.lastPrompt) html += '<h2>Seu último pedido</h2><div class="quote" style="margin-bottom:12px">' + esc(d.lastPrompt) + '</div>';
    html += '<div class="stats">' +
      stat(k(d.input + d.output + d.cacheWrite), 'tokens novos') + stat(k(d.output), 'saída') +
      stat(k(d.cacheRead), 'lidos do cache') + stat(k(d.cacheWrite), 'gravados no cache') +
      stat(d.context ? k(d.context) + (pct ? ' <small class="muted">' + pct + '%</small>' : '') : '—', 'contexto atual') +
      stat(d.prompts, 'pedidos seus') + stat(d.toolCalls, 'ferramentas usadas') +
      stat(d.subagents ? d.subagents + ' <small class="muted">' + k(d.subTokens) + '</small>' : '0', 'subagentes') +
      '</div>' + (pct ? '<div class="ctx" style="margin-bottom:12px"><div style="width:' + Math.min(100, pct) + '%;background:' + levelColor(pct) + '"></div></div>' : '');
    if (d.tools.length) {
      html += '<h2>Ferramentas mais usadas</h2>';
      for (var t = 0; t < d.tools.length; t++) {
        html += '<div class="dl" style="border:0;padding-bottom:0"><span>' + esc(d.tools[t][0]) + '</span><span>' + d.tools[t][1] + '</span></div>' +
          '<div class="hbar"><div style="width:' + (d.tools[t][1] / d.tools[0][1] * 100) + '%"></div></div>';
      }
    }
    if (d.turns.length) {
      html += '<h2 style="margin-top:12px">Últimas chamadas</h2>';
      for (var j = 0; j < d.turns.length; j++) {
        html += '<div class="dl"><span>' + hm(d.turns[j].t) + '</span><span>' + k(d.turns[j].fresh) + ' novos · ' + k(d.turns[j].cacheRead) + ' cache</span></div>';
      }
    }
    html += '<div class="dl" style="margin-top:12px"><span>Modelo</span><span>' + esc(d.models.join(', ') || '—') + '</span></div>' +
      '<div class="path" style="margin-top:8px">' + esc(d.cwd) + '</div>';
    html += '</div></div>';
    setOverlay(html);
    bindReply(d);
    if (d.permission) {
      var decide = function (decision) {
        $('permAllow').disabled = $('permDeny').disabled = true;
        request('POST', '/api/permission', function (err) {
          if (err) { flash(err.message, false); } else { flash(decision === 'allow' ? 'Permitido.' : 'Negado.'); }
          d.permission = null;
          if (d.state === 'permission') d.state = 'working';
          renderDetail(d);
        }, { id: d.permission.id, decision: decision, session: d.id });
      };
      $('permAllow').onclick = function () { decide('allow'); };
      $('permDeny').onclick = function () { decide('deny'); };
    }
    $('moreToggle').onclick = function () {
      moreOpen = !moreOpen;
      store('hud.moreOpen', moreOpen ? '1' : '0');
      $('more').className = 'panel more' + (moreOpen ? ' open' : '');
    };
    if ($('focusPc')) $('focusPc').onclick = function () {
      var b = this;
      b.disabled = true;
      request('POST', '/api/focus', function (err, r) {
        b.disabled = false;
        flash(err ? 'Falhou: ' + err.message : r.message, !err && r.ok);
      }, { id: d.id });
    };
  }

  // ---- Resposta rápida (hook-stop.js entrega à sessão parada) ----------------
  var QUICK = ['Continue', 'Sim, implemente', 'Resuma', 'Não, pare aqui', 'Faça o commit', 'Rode os testes', 'Explique melhor'];

  function replyBox(d) {
    // Um status curto: chega na hora (hook ouvindo, ou Codex livre) ou espera a sessão parar
    var live = d.tool === 'Codex' || d.tool === 'Ollama' ? d.state !== 'working' : !!d.listening;
    var html = '<div class="panel reply"><div class="row rhead"><h2 class="grow">Responder</h2>' +
      (live ? '<span class="rtag lo">● ao vivo</span>' : '<span class="rtag">vai para a fila</span>') + '</div>';
    if (d.tool === 'Ollama') html += '<div class="rnote">A resposta é gerada no Ollama e fica no HUD; não aparece no app do Ollama.</div>';
    if (d.queued) html += '<div class="rqueued">Na fila: “' + esc(d.queued) + '” <button class="link" id="cancelReply">cancelar</button></div>';
    html += '<div class="chips">';
    for (var i = 0; i < QUICK.length; i++) html += '<button class="chip" data-chip="' + esc(QUICK[i]) + '">' + esc(QUICK[i]) + '</button>';
    return html + '</div><div class="row rform"><textarea id="replyText" rows="2" placeholder="Escreva uma resposta…"></textarea>' +
      '<button class="send" id="sendReply">Enviar</button></div></div>';
  }

  function sendReply(d, text) {
    $('sendReply').disabled = true;
    request('POST', '/api/reply', function (err, r) {
      if (err) { $('sendReply').disabled = false; return alert('Não enviado: ' + err.message); }
      $('replyText').value = '';
      $('replyText').blur();
      if (r.sent) { $('sendReply').disabled = false; return flash(d.tool === 'Ollama' ? 'Enviado: o Ollama está gerando a resposta.' : 'Enviado ao Codex.'); }
      d.queued = r.queued;
      d.listening = r.listening;
      renderDetail(d);
      if (r.queued) flash(r.listening ? 'Enviado: a sessão continua em instantes.' : 'Na fila: entra quando a sessão parar.');
    }, { key: d.key, text: text, tool: d.tool, id: d.id }); // id: o hub repassa ao PC dono da sessão
  }

  function bindReply(d) {
    if (!$('replyText')) return;
    var chips = $('overlayBody').getElementsByTagName('button');
    for (var i = 0; i < chips.length; i++) {
      if (!chips[i].getAttribute('data-chip')) continue;
      chips[i].onclick = function () { $('replyText').value = this.getAttribute('data-chip'); };
    }
    $('sendReply').onclick = function () {
      var text = $('replyText').value.replace(/^\s+|\s+$/g, '');
      if (text) sendReply(d, text);
    };
    if ($('cancelReply')) $('cancelReply').onclick = function () { sendReply(d, ''); };
  }

  function flash(msg, ok) {
    var el = $('rflash');
    if (!el) { el = document.createElement('div'); el.id = 'rflash'; document.body.appendChild(el); }
    el.innerHTML = esc(msg);
    el.className = ok === false ? 'show err' : 'show';
    setTimeout(function () { el.className = ''; }, 3000);
  }

  // Não redesenha a gaveta enquanto o usuário escreve (apagaria o texto e fecharia o teclado)
  function typing() { var t = $('replyText'); return t && (t.value || document.activeElement === t); }

  function renderRecent() {
    if (!snap) return;
    var html = head('Sessões'), i, all = snap.active.concat(snap.recent);
    html += '<div class="panel">';
    for (i = 0; i < all.length; i++) html += sessRow(all[i], snap.now);
    setOverlay(html + '</div>');
  }

  function setOverlay(html) { $('overlayBody').innerHTML = html; $('back').onclick = closeOverlay; }

  // Abre na hora com o que o snapshot já tem; os números completos chegam em seguida
  var detailCache = {};
  function quickDetail(id) {
    if (detailCache[id]) return renderDetail(detailCache[id]);
    var all = snap ? snap.active.concat(snap.recent) : [], x = null, i;
    for (i = 0; i < all.length; i++) if (all[i].id === id) x = all[i];
    if (!x) return setOverlay(head('Sessão') + '<p class="empty">carregando…</p>');
    setOverlay(sessHead(x) + '<div class="dstate">' + badge(x, snap.now) + '</div>' +
      (x.lastPrompt ? '<div class="panel"><h2>Seu último pedido</h2><div class="quote">' + esc(x.lastPrompt) + '</div></div>' : '') +
      '<p class="empty">carregando detalhes…</p>');
  }

  function loadDetail() {
    var m = /^#s=(.+)$/.exec(location.hash);
    if (!m) return;
    var id = decodeURIComponent(m[1]);
    request('GET', '/api/session?id=' + encodeURIComponent(id), function (err, d) {
      if (location.hash !== '#s=' + encodeURIComponent(id)) return;
      if (err) return setOverlay(head('Sessão') + '<p class="empty">' + esc(err.message) + '</p>');
      // Só redesenha se algo mudou ("now" sempre muda), preservando a rolagem da última resposta
      var sig = JSON.stringify(d).replace(/"now":\d+/, '');
      var prev = detailCache[id] && JSON.stringify(detailCache[id]).replace(/"now":\d+/, '');
      // Mantém no cache o detalhe exibido; uma atualização adiada precisa ser desenhada depois.
      if (typing()) return;
      detailCache[id] = d;
      if (sig === prev) return;
      var box = $('lastReply'), top = box ? box.scrollTop : 0;
      renderDetail(d);
      if ($('lastReply')) $('lastReply').scrollTop = top;
    });
  }

  // A tela sobreposta fica no #hash: o botão Voltar do Android fecha
  function syncHash() {
    var h = location.hash;
    view = /^#s=/.test(h) ? 'detail' : h === '#recentes' ? 'recent' : h === '#estatisticas' ? 'stats' : h === '#ollama' ? 'ollama' : null;
    $('overlay').className = $('backdrop').className = view ? 'show' : '';
    if (view) $('overlay').scrollTop = 0;
    else if (snap) render(snap); // o fundo não é redesenhado com a gaveta aberta
    if (view === 'detail') { quickDetail(decodeURIComponent(h.slice(3))); loadDetail(); }
    if (view === 'recent') renderRecent();
    // A gaveta precisa estar visível para o gráfico medir a própria largura
    if (view === 'stats') setTimeout(renderStats, 30);
    if (view === 'ollama') renderOllama();
  }
  function closeOverlay() { if (location.hash) history.back(); else syncHash(); }

  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.getAttribute && el.getAttribute('data-id')) { location.hash = 's=' + encodeURIComponent(el.getAttribute('data-id')); return; }
      el = el.parentNode;
    }
  });
  window.addEventListener('hashchange', syncHash);
  $('openRecent').onclick = function () { location.hash = 'recentes'; };
  $('openStats').onclick = function () { location.hash = 'estatisticas'; };
  $('q-ollama').onclick = function () { location.hash = 'ollama'; };
  $('backdrop').onclick = closeOverlay;

  // ---- Rede ----------------------------------------------------------------
  function request(method, url, done, body, timeout) {
    var x = new XMLHttpRequest();
    x.open(method, url + (token ? (url.indexOf('?') < 0 ? '?' : '&') + 't=' + token : ''), true);
    x.timeout = timeout || 60000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (x.status === 200) { try { done(null, JSON.parse(x.responseText), x.responseText); } catch (e) { done(e); } return; }
      var err = new Error(x.status === 401 ? 'token inválido' : x.status === 404 ? 'sessão não encontrada' : x.status === 429 ? 'aguarde 30s' : x.status >= 400 && x.responseText ? x.responseText : 'sem conexão');
      err.offline = x.status === 0; // sem resposta nenhuma: servidor fora ou rede bloqueada
      done(err);
    };
    if (body) x.setRequestHeader('Content-Type', 'application/json');
    x.send(body ? JSON.stringify(body) : null);
  }

  // O iPad mini 1 é lento para redesenhar: só quando os dados mudaram, e não com a gaveta aberta
  var lastText = '';
  function apply(err, s, text) {
    if (err && err.offline) {
      // Wi-Fi instável (iPad antigo) perde um pedido de vez em quando: só mostra a tela de
      // desconectado na 2ª falha seguida; na 1ª, tenta de novo em ~3 s sem alarde
      failures++;
      if (failures >= 2) return setOffline(true);
      lastAttempt = new Date().getTime() - (offline ? RETRY_MS : POLL_MS) + 3000;
      return;
    }
    if (err) { $('status').innerHTML = '<span class="hi">● ' + esc(err.message) + '</span>'; return; }
    failures = 0;
    setOffline(false);
    lastOk = new Date().getTime();
    text = (text || '').replace(/^\{"now":\d+/, ''); // "now" muda sempre; o resto diz se algo mudou
    if (text && text === lastText) return;
    lastText = text;
    var first = !snap;
    snap = s;
    checkAlerts(s);
    if (first || !view) return render(s); // a primeira vez desenha o fundo mesmo com gaveta aberta
    if (view === 'stats') renderStats();
    if (view === 'ollama') renderOllama();
    if (view === 'recent') renderRecent();
  }

  // ---- Desconectado: tela própria e nova tentativa a cada 5 s (conectado: a cada 10 s) ----
  var offline = false, inFlight = false, lastAttempt = 0, failures = 0;
  var POLL_MS = 10000, RETRY_MS = 5000;

  function setOffline(on) {
    if (on === offline) return;
    offline = on;
    $('offline').className = on ? 'show' : '';
    if (on) $('olast').innerHTML = lastOk ? 'Últimos dados recebidos às ' + hm(lastOk) + '.' : '';
  }

  function poll() {
    if (inFlight) return;
    inFlight = true;
    lastAttempt = new Date().getTime();
    // Prazo curto: com o servidor fora, a tela de desconectado aparece em segundos
    request('GET', '/api/snapshot', function (err, s, text) { inFlight = false; apply(err, s, text); }, null, 8000);
    if (view === 'detail' && !offline) loadDetail();
  }

  // Relógio, status e agenda das consultas, a cada segundo
  function tick() {
    var now = new Date(), t = now.getTime();
    $('clock').innerHTML = hm(now);
    if (lastOk) {
      var ago = Math.round((t - lastOk) / 1000);
      $('status').innerHTML = ago > 40 ? '<span class="hi">● sem atualização há ' + ago + 's</span>' : '<span class="lo">●</span><span class="stxt"> ao vivo</span>';
    }
    var wait = (offline ? RETRY_MS : POLL_MS) - (t - lastAttempt);
    if (wait <= 0) poll();
    if (offline) {
      $('oretry').innerHTML = inFlight ? '<span class="pulse">●</span> Tentando reconectar…'
        : 'Nova tentativa em ' + Math.max(1, Math.ceil(wait / 1000)) + 's';
    }
  }

  setSound(soundOn);

  // App instalado no Android que abriu sem tela cheia (o Chrome às vezes ignora o "fullscreen" do
  // manifest): o primeiro toque pede tela cheia. Não vale no navegador nem no iPad (sem display-mode).
  var installed = window.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: minimal-ui)').matches);
  var rootEl = document.documentElement, enterFs = rootEl.requestFullscreen || rootEl.webkitRequestFullscreen;
  if (installed && enterFs) {
    var goFull = function () {
      document.removeEventListener('touchend', goFull, false);
      try { var p = enterFs.call(rootEl); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    };
    document.addEventListener('touchend', goFull, false);
  }  // Modo remoto: pedidos de permissão do Claude esperam Permitir/Negar aqui em vez de aparecer no PC
  $('remote').onclick = function () {
    var on = !(snap && snap.remoteMode);
    if (on && !confirm('Ligar o modo remoto?\n\nPedidos de permissão do Claude vão esperar sua resposta aqui (até 10 min) em vez de aparecer no PC. Use quando estiver longe do computador.')) return;
    request('POST', '/api/remote', function (err, r) {
      if (err) return flash('Falhou: ' + err.message, false);
      if (snap) snap.remoteMode = r.remoteMode;
      setRemoteBtn(r.remoteMode);
      flash(r.remoteMode ? 'Modo remoto ligado.' : 'Modo remoto desligado: permissões voltam para o PC.');
    }, { on: on });
  };
  $('sound').onclick = function () { unlockAudio(); setSound(!soundOn); if (soundOn) beep(); };

  $('refresh').onclick = function () {
    $('status').innerHTML = 'lendo cotas…';
    request('POST', '/api/refresh', apply);
  };

  window.addEventListener('resize', function () { if (snap) burnChart(snap); });
  $('oretryNow').onclick = function () { poll(); tick(); };
  syncHash(); poll(); tick();
  setInterval(tick, 1000);
  // Ao voltar do bloqueio de tela o iOS congela timers; atualiza na hora
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  // PWA: só em HTTPS/localhost (Chrome no Android via Tailscale); o iOS 9 não tem service worker
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
})();
