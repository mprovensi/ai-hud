  // ---- AI Workspace leve (somente leitura + Dream) em ES5 puro para iPad mini 1 e celular ----
  var wsState = { idx: null, sync: null, entityId: '', tab: 'cards', stageFilter: 'all', memFile: 'MEMORY.md', doc: null };

  var WS_BOARD_COLS = [
    { id: 'idea', title: 'Ideia', color: '#7b8498' },
    { id: 'spec', title: 'Spec / Plano', color: '#7d9bf0' },
    { id: 'in-progress', title: 'Em andamento', color: '#5fb8a4' },
    { id: 'review', title: 'Revisão', color: '#d9a441' },
    { id: 'done', title: 'Concluído', color: '#5ea87e' }
  ];

  function wsAssetHref(id, rel) {
    var isHtml = /\.html?$/i.test(String(rel || ''));
    return '/api/workspace/entity/asset?id=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(rel) +
      (!isHtml && token ? '&t=' + encodeURIComponent(token) : '');
  }

  function wsCanFullDesktop() {
    return typeof Promise !== 'undefined' && typeof fetch !== 'undefined' && typeof Symbol !== 'undefined';
  }

  function wsMd(text) {
    return typeof renderMd === 'function' ? renderMd(text) : '<div class="md-p">' + esc(text) + '</div>';
  }

  function wsPriorityLabel(p) {
    var v = String(p || '').toLowerCase();
    if (v === 'high' || v === 'alta' || v === 'urgent') return { text: 'Alta', cls: 'ws-prio-hi' };
    if (v === 'medium' || v === 'media' || v === 'média') return { text: 'Média', cls: 'ws-prio-md' };
    if (v === 'low' || v === 'baixa') return { text: 'Baixa', cls: 'ws-prio-lo' };
    return v ? { text: p, cls: '' } : null;
  }

  function renderWorkspaceDrawer() {
    var h = head('AI Workspace', 'projetos, cards e memória');
    h += '<div class="row ws-bar">';
    if (wsCanFullDesktop()) {
      h += '<a class="btn ws-desk-btn" href="/workspace' + (token ? '?t=' + encodeURIComponent(token) : '') + '">Abrir Desktop</a>';
    }
    h += '<span class="grow"></span><span class="ws-sync-lbl" id="wsSyncLbl"></span></div>';
    h += '<div id="wsBody"><div class="panel"><p class="muted">Carregando AI Workspace…</p></div></div>';
    setOverlay(h);

    request('GET', '/api/workspace/sync', function (err, st) {
      wsState.sync = err ? null : st;
      var el = $('wsSyncLbl');
      if (!el || !st) return;
      if (!st.isRepo) el.textContent = 'Sync local';
      else if (st.conflicts && st.conflicts.length) el.textContent = 'Conflito Git (' + st.conflicts.length + ')';
      else if (st.dirty || st.ahead || st.behind) el.textContent = 'Sync pendente';
      else el.textContent = 'Sync OK · ' + (st.branch || 'main');
    });

    request('GET', '/api/workspace/index', function (err, idx) {
      if (view !== 'workspace') return;
      if (err) {
        if ($('wsBody')) $('wsBody').innerHTML = '<div class="panel"><p class="empty">' + esc(err.message) + '</p></div>';
        return;
      }
      wsState.idx = idx || { entities: [], groups: [], groupMeta: {}, context: [], knowledge: [], skills: [], handoffs: [] };
      if (wsState.doc) renderWsDoc(wsState.doc.area, wsState.doc.name);
      else if (wsState.entityId) renderWsEntity(wsState.entityId);
      else renderWsHome();
    });
  }

  function renderWsHome() {
    wsState.entityId = '';
    wsState.doc = null;
    wsState.stageFilter = 'all';
    var idx = wsState.idx || { entities: [], groups: [], groupMeta: {} };
    var allEnts = idx.entities || [], groupMeta = idx.groupMeta || {}, ents = [], i, e, h = '';

    for (i = 0; i < allEnts.length; i++) {
      e = allEnts[i];
      if (!e || e.hidden) continue;
      var gn = e.group || 'Geral';
      if (groupMeta[gn] && groupMeta[gn].hidden) continue;
      ents.push(e);
    }

    h += '<div class="panel ws-panel"><div class="row ws-sec-head"><h2 class="grow">Projetos</h2><span class="ws-count">' + ents.length + '</span></div>';
    if (!ents.length) {
      h += '<p class="empty">Nenhum projeto visível no AI Workspace.</p>';
    } else {
      var byGroup = {}, groupOrder = [], gName, savedGroups = idx.groups || [];
      for (i = 0; i < savedGroups.length; i++) {
        gName = savedGroups[i];
        if (!gName || (groupMeta[gName] && groupMeta[gName].hidden)) continue;
        if (!byGroup[gName]) { byGroup[gName] = []; groupOrder.push(gName); }
      }
      for (i = 0; i < ents.length; i++) {
        gName = ents[i].group || 'Geral';
        if (!byGroup[gName]) { byGroup[gName] = []; groupOrder.push(gName); }
        byGroup[gName].push(ents[i]);
      }
      var activeGroups = [];
      for (i = 0; i < groupOrder.length; i++) {
        if (byGroup[groupOrder[i]] && byGroup[groupOrder[i]].length) activeGroups.push(groupOrder[i]);
      }
      var showGroupHeaders = activeGroups.length > 1 || (activeGroups.length === 1 && activeGroups[0] !== 'Geral');
      for (var gi = 0; gi < activeGroups.length; gi++) {
        gName = activeGroups[gi];
        var grpList = byGroup[gName];
        if (showGroupHeaders) {
          h += '<div class="ws-grp-head' + (gi > 0 ? ' ws-grp-sep' : '') + '">' +
            '<span class="ws-grp-name">' + esc(gName) + '</span>' +
            '<span class="ws-grp-cnt">' + grpList.length + '</span></div>';
        }
        h += '<div class="' + (showGroupHeaders ? 'ws-grp-list' : '') + '">';
        for (var ei = 0; ei < grpList.length; ei++) {
          e = grpList[ei];
          h += '<div class="row ws-item" data-ws-ent="' + esc(e.id) + '" role="button" tabindex="0">' +
            '<div class="grow ell">' +
              '<div class="ws-item-title ell">' + (e.pinned ? '<span class="ws-pin">★</span> ' : '') + esc(e.title || e.id) + '</div>' +
              (e.description ? '<div class="ws-item-desc ell">' + esc(e.description) + '</div>' : '') +
            '</div><span class="chev">›</span></div>';
        }
        h += '</div>';
      }
    }
    h += '</div>';

    var areas = [
      { key: 'context', label: 'Contexto global' },
      { key: 'knowledge', label: 'Conhecimento' },
      { key: 'skills', label: 'Skills' },
      { key: 'handoffs', label: 'Handoffs' }
    ];
    var docsHtml = '';
    for (i = 0; i < areas.length; i++) {
      var list = idx[areas[i].key] || [];
      if (!list.length) continue;
      docsHtml += '<div class="ws-doc-grp"><div class="ws-doc-lbl">' + esc(areas[i].label) + ' <span class="muted">(' + list.length + ')</span></div>';
      for (var j = 0; j < list.length && j < 10; j++) {
        docsHtml += '<div class="row ws-item ws-doc-row" data-ws-area="' + esc(areas[i].key) + '" data-ws-doc="' + esc(list[j].name) + '" role="button" tabindex="0">' +
          '<span class="grow ell">' + esc(list[j].name) + '</span><span class="chev">›</span></div>';
      }
      docsHtml += '</div>';
    }
    if (docsHtml) {
      h += '<div class="panel ws-panel"><h2 style="margin-bottom:8px">Documentos globais</h2>' + docsHtml + '</div>';
    }

    if (!$('wsBody')) return;
    $('wsBody').innerHTML = h;
    bindWsListClicks();
  }

  function bindWsListClicks() {
    var box = $('wsBody');
    if (!box) return;
    box.onclick = function (ev) {
      var el = ev.target;
      while (el && el !== box) {
        if (el.getAttribute && el.getAttribute('data-ws-ent')) {
          wsState.tab = 'cards';
          wsState.stageFilter = 'all';
          renderWsEntity(el.getAttribute('data-ws-ent'));
          return;
        }
        if (el.getAttribute && el.getAttribute('data-ws-doc')) {
          renderWsDoc(el.getAttribute('data-ws-area'), el.getAttribute('data-ws-doc'));
          return;
        }
        el = el.parentNode;
      }
    };
  }

  function renderWsDoc(area, name) {
    wsState.doc = { area: area, name: name };
    wsState.entityId = '';
    var box = $('wsBody');
    if (!box) return;
    box.innerHTML = '<div class="row ws-nav"><button type="button" class="btn ws-back" id="wsBackHome">‹ Projetos</button><span class="ws-nav-title grow ell">' + esc(name) + '</span></div>' +
      '<div class="panel"><p class="muted">Carregando documento…</p></div>';
    $('wsBackHome').onclick = renderWsHome;

    request('GET', '/api/workspace/doc?area=' + encodeURIComponent(area) + '&name=' + encodeURIComponent(name), function (err, r) {
      if (!wsState.doc || wsState.doc.name !== name || !$('wsBody')) return;
      if (err) {
        box.innerHTML = '<div class="row ws-nav"><button type="button" class="btn ws-back" id="wsBackHome">‹ Projetos</button></div><div class="panel"><p class="empty">' + esc(err.message) + '</p></div>';
        $('wsBackHome').onclick = renderWsHome;
        return;
      }
      box.innerHTML = '<div class="row ws-nav"><button type="button" class="btn ws-back" id="wsBackHome">‹ Projetos</button><span class="ws-nav-title grow ell">' + esc(name) + '</span></div>' +
        '<div class="panel md ws-md">' + wsMd(r.content || '') + '</div>';
      $('wsBackHome').onclick = renderWsHome;
    });
  }

  function findWsEntity(id) {
    var ents = (wsState.idx && wsState.idx.entities) || [], i;
    for (i = 0; i < ents.length; i++) if (ents[i].id === id) return ents[i];
    return null;
  }

  function renderWsEntity(id) {
    wsState.entityId = id;
    wsState.doc = null;
    var ent = findWsEntity(id);
    if (!ent) return renderWsHome();
    var box = $('wsBody');
    if (!box) return;

    var tab = wsState.tab === 'memory' ? 'memory' : 'cards';
    wsState.tab = tab;
    var h = '<div class="row ws-nav">' +
        '<button type="button" class="btn ws-back" id="wsBackHome">‹ Projetos</button>' +
        '<div class="grow ell"><div class="ws-ent-title ell">' + esc(ent.title || ent.id) + '</div>' +
          (ent.group ? '<div class="ws-ent-grp ell">' + esc(ent.group) + '</div>' : '') +
        '</div></div>' +
      '<div class="dtabs row" role="tablist">' +
        '<button type="button" class="dtab' + (tab === 'cards' ? ' active' : '') + '" id="wsTabCards">Cards</button>' +
        '<button type="button" class="dtab' + (tab === 'memory' ? ' active' : '') + '" id="wsTabMem">Memória</button>' +
      '</div>' +
      '<div id="wsEntPane"><div class="panel"><p class="muted">Carregando…</p></div></div>';
    box.innerHTML = h;
    $('wsBackHome').onclick = renderWsHome;
    $('wsTabCards').onclick = function () { wsState.tab = 'cards'; renderWsEntity(id); };
    $('wsTabMem').onclick = function () { wsState.tab = 'memory'; renderWsEntity(id); };

    if (tab === 'cards') loadWsCards(ent);
    else loadWsMemory(ent);
  }

  function wsFindCardFile(ent) {
    var steps = ent.steps || [], i;
    for (i = 0; i < steps.length; i++) {
      if (steps[i].file && /\.card\.json$/i.test(steps[i].file)) return steps[i].file;
    }
    return 'overview.card.json';
  }

  function loadWsCards(ent) {
    var hasBinding = !!(ent.projectBindings && ent.projectBindings.length && ent.projectBindings[0] && ent.projectBindings[0].cwd);
    var cardFile = wsFindCardFile(ent);

    function onLoaded(err, r) {
      var pane = $('wsEntPane');
      if (!pane || wsState.entityId !== ent.id || wsState.tab !== 'cards') return;
      if (err || !r || !r.content) {
        pane.innerHTML = '<div class="panel"><p class="empty">' + esc(err ? err.message : 'Nenhum card registrado neste projeto.') + '</p></div>';
        return;
      }
      var doc = r.content;
      if (typeof doc === 'string') {
        try { doc = JSON.parse(doc); } catch (e) { doc = null; }
      }
      if (!doc || typeof doc !== 'object') {
        pane.innerHTML = '<div class="panel"><p class="empty">Formato de cards inválido.</p></div>';
        return;
      }
      renderWsCardBoard(pane, ent.id, doc, cardFile);
    }

    if (hasBinding) {
      request('GET', '/api/workspace/project/board?entityId=' + encodeURIComponent(ent.id), function (err, r) {
        if (!err && r && r.content) return onLoaded(null, r);
        request('GET', '/api/workspace/entity/file?id=' + encodeURIComponent(ent.id) + '&path=' + encodeURIComponent(cardFile), onLoaded);
      });
    } else {
      request('GET', '/api/workspace/entity/file?id=' + encodeURIComponent(ent.id) + '&path=' + encodeURIComponent(cardFile), onLoaded);
    }
  }

  function renderWsCardBoard(pane, entId, doc, cardFile) {
    var rawItems = doc.items || [], items = [], i, j;
    for (i = 0; i < rawItems.length; i++) {
      if (rawItems[i] && !rawItems[i].archived) items.push(rawItems[i]);
    }
    if (!items.length) {
      pane.innerHTML = '<div class="panel"><p class="empty">Nenhum card ativo neste projeto.</p></div>';
      return;
    }

    var isBoard = !doc.template || doc.template === 'board';
    if (!isBoard) {
      var listHtml = '<div class="panel ws-panel"><div class="row ws-sec-head"><h2 class="grow">' + esc(doc.title || cardFile) + '</h2><span class="ws-count">' + items.length + '</span></div>';
      for (i = 0; i < items.length; i++) listHtml += renderWsCardItem(entId, items[i], '#5fb8a4');
      pane.innerHTML = listHtml + '</div>';
      bindWsCardExpand(pane);
      return;
    }

    var cols = (doc.columns && doc.columns.length) ? doc.columns : WS_BOARD_COLS;
    var colColor = {};
    for (i = 0; i < WS_BOARD_COLS.length; i++) colColor[WS_BOARD_COLS[i].id] = WS_BOARD_COLS[i].color;

    var buckets = {}, colOrder = [];
    for (i = 0; i < cols.length; i++) {
      var cid = cols[i].id;
      buckets[cid] = { id: cid, title: cols[i].title || cid, color: cols[i].color || colColor[cid] || '#7b8498', list: [] };
      colOrder.push(cid);
    }
    for (i = 0; i < items.length; i++) {
      var st = items[i].status || items[i].column || colOrder[0];
      if (!buckets[st]) st = colOrder[0];
      buckets[st].list.push(items[i]);
    }

    var filter = wsState.stageFilter || 'all';
    if (filter !== 'all' && (!buckets[filter] || !buckets[filter].list.length)) filter = 'all';

    var html = '<div class="ws-stage-bar">';
    html += '<button type="button" class="ws-st-pill' + (filter === 'all' ? ' on' : '') + '" data-st="all">Todas <span class="ws-st-n">' + items.length + '</span></button>';
    for (i = 0; i < colOrder.length; i++) {
      var b = buckets[colOrder[i]];
      if (!b.list.length) continue;
      html += '<button type="button" class="ws-st-pill' + (filter === b.id ? ' on' : '') + '" data-st="' + esc(b.id) + '">' +
        '<span class="ws-st-dot" style="background:' + b.color + '"></span>' +
        esc(b.title) + ' <span class="ws-st-n">' + b.list.length + '</span></button>';
    }
    html += '</div>';

    for (i = 0; i < colOrder.length; i++) {
      var col = buckets[colOrder[i]];
      if (!col.list.length) continue;
      if (filter !== 'all' && filter !== col.id) continue;
      html += '<div class="panel ws-stage-panel">' +
        '<div class="row ws-stage-head">' +
          '<span class="ws-st-dot" style="background:' + col.color + '"></span>' +
          '<h2 class="grow">' + esc(col.title) + '</h2>' +
          '<span class="ws-count">' + col.list.length + '</span>' +
        '</div>';
      for (j = 0; j < col.list.length; j++) html += renderWsCardItem(entId, col.list[j], col.color);
      html += '</div>';
    }

    pane.innerHTML = html;
    var pills = pane.querySelectorAll('.ws-st-pill');
    for (i = 0; i < pills.length; i++) {
      pills[i].onclick = function () {
        wsState.stageFilter = this.getAttribute('data-st') || 'all';
        renderWsCardBoard(pane, entId, doc, cardFile);
      };
    }
    bindWsCardExpand(pane);
  }

  function renderWsCardItem(entId, it, accentColor) {
    var prio = wsPriorityLabel(it.priority);
    var bodyRaw = String(it.summary || it.body || it.notes || '').replace(/^\s+|\s+$/g, '');
    var isLong = bodyRaw.length > 260;
    var h = '<div class="ws-card' + (isLong ? ' ws-card-long' : '') + '" style="border-left-color:' + (accentColor || '#5fb8a4') + '">' +
      '<div class="row ws-card-top">' +
        '<div class="ws-card-title grow">' + esc(it.title || 'Sem título') + '</div>' +
        (prio ? '<span class="ws-prio ' + prio.cls + '">' + esc(prio.text) + '</span>' : '') +
      '</div>';
    if (bodyRaw) {
      h += '<div class="md ws-card-txt">' + wsMd(bodyRaw.slice(0, 1200)) + '</div>';
      if (isLong) h += '<button type="button" class="ws-card-more">Ver mais</button>';
    }
    if (it.image) {
      h += '<div class="ws-card-img"><img src="' + esc(wsAssetHref(entId, it.image)) + '" alt=""></div>';
    }
    if (it.tags && it.tags.length) {
      h += '<div class="ws-tags">';
      for (var t = 0; t < it.tags.length; t++) {
        h += '<span class="ws-tag">' + esc(it.tags[t]) + '</span>';
      }
      h += '</div>';
    }
    return h + '</div>';
  }

  function bindWsCardExpand(pane) {
    var btns = pane.querySelectorAll('.ws-card-more');
    for (var i = 0; i < btns.length; i++) {
      btns[i].onclick = function () {
        var card = this.parentNode;
        if (!card) return;
        var open = card.className.indexOf(' open') !== -1;
        card.className = open ? card.className.replace(' open', '') : card.className + ' open';
        this.textContent = open ? 'Ver mais' : 'Ver menos';
      };
    }
  }

  function loadWsMemory(ent) {
    var binding = (ent.projectBindings && ent.projectBindings[0]) || null;
    var proj = (binding && binding.cwd ? binding.cwd.split(/[\\/]/).filter(Boolean).pop() : '') || ent.title || ent.id;
    var q = '/api/memory?project=' + encodeURIComponent(proj) + (binding && binding.cwd ? '&cwd=' + encodeURIComponent(binding.cwd) : '');
    request('GET', q, function (err, m) {
      var pane = $('wsEntPane');
      if (!pane || wsState.entityId !== ent.id || wsState.tab !== 'memory') return;
      if (err) {
        pane.innerHTML = '<div class="panel"><p class="empty">' + esc(err.message) + '</p></div>';
        return;
      }
      var files = ['MEMORY.md', 'pinned.md', 'current-state.md', 'decisions.md', 'pitfalls.md'];
      var cur = wsState.memFile || 'MEMORY.md', i;
      var btns = '<div class="row ws-mfiles">';
      for (i = 0; i < files.length; i++) {
        btns += '<button type="button" class="btn ws-mf' + (cur === files[i] ? ' on' : '') + '" data-mf="' + esc(files[i]) + '">' + esc(files[i].replace(/\.md$/, '')) + '</button>';
      }
      btns += '<button type="button" class="btn ws-dream-btn" id="wsDreamBtn">Dream</button></div>';
      var content = (m && m.files && m.files[cur] && m.files[cur].content) || '';
      pane.innerHTML = '<div class="panel ws-panel">' + btns +
        (content ? '<div class="md ws-md">' + wsMd(content) + '</div>' : '<p class="empty">Arquivo vazio (' + esc(cur) + ').</p>') +
        '</div>';
      var allBtns = pane.querySelectorAll('.ws-mf');
      for (i = 0; i < allBtns.length; i++) {
        allBtns[i].onclick = function () {
          wsState.memFile = this.getAttribute('data-mf');
          loadWsMemory(ent);
        };
      }
      if ($('wsDreamBtn')) {
        $('wsDreamBtn').onclick = function () {
          var b = this;
          b.disabled = true;
          b.textContent = 'Consolidando…';
          request('POST', '/api/memory/dream', function (dErr, dr) {
            b.disabled = false;
            b.textContent = 'Dream';
            if (dErr) return flash('Dreaming falhou: ' + dErr.message, false);
            flash(dr && dr.skipped ? ('Dreaming pulado: ' + dr.reason) : 'Memória consolidada!');
            loadWsMemory(ent);
          }, { project: proj, cwd: binding && binding.cwd ? binding.cwd : '', force: true });
        };
      }
    });
  }
