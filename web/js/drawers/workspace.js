  // ---- AI Workspace leve (somente leitura + Dream) em ES5 puro para iPad mini 1 e celular ----
  var wsState = { idx: null, sync: null, entityId: '', tab: 'cards', memFile: 'MEMORY.md', doc: null };

  function wsAssetHref(id, rel) {
    return '/api/workspace/entity/asset?id=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(rel) +
      (token ? '&t=' + encodeURIComponent(token) : '');
  }

  function wsCanFullDesktop() {
    return typeof Promise !== 'undefined' && typeof fetch !== 'undefined' && typeof Symbol !== 'undefined';
  }

  function renderWorkspaceDrawer() {
    var sub = 'leitura rápida · projetos, cards e memória';
    var h = head('AI Workspace', sub);
    if (wsCanFullDesktop()) {
      h += '<div class="row ws-bar"><a class="btn" href="/workspace' + (token ? '?t=' + encodeURIComponent(token) : '') + '">⊞ Abrir versão Desktop completa</a><span class="grow"></span><span class="muted" id="wsSyncLbl"></span></div>';
    } else {
      h += '<div class="row ws-bar"><span class="muted" id="wsSyncLbl"></span></div>';
    }
    h += '<div id="wsBody"><div class="panel"><p class="muted">Carregando AI Workspace…</p></div></div>';
    setOverlay(h);

    request('GET', '/api/workspace/sync', function (err, st) {
      wsState.sync = err ? null : st;
      var el = $('wsSyncLbl');
      if (!el || !st) return;
      if (!st.isRepo) el.textContent = 'Git Sync não configurado';
      else if (st.conflicts && st.conflicts.length) el.textContent = '⚠ Conflito Git (' + st.conflicts.length + ')';
      else if (st.dirty || st.ahead || st.behind) el.textContent = 'Sync pendente (' + (st.dirty || 0) + 'Δ)';
      else el.textContent = '✓ Sync OK (' + (st.branch || 'main') + ')';
    });

    request('GET', '/api/workspace/index', function (err, idx) {
      if (view !== 'workspace') return;
      if (err) {
        if ($('wsBody')) $('wsBody').innerHTML = '<div class="panel"><p class="empty">' + esc(err.message) + '</p></div>';
        return;
      }
      wsState.idx = idx || { entities: [], context: [], knowledge: [], skills: [], handoffs: [] };
      if (wsState.doc) renderWsDoc(wsState.doc.area, wsState.doc.name);
      else if (wsState.entityId) renderWsEntity(wsState.entityId);
      else renderWsHome();
    });
  }

  function renderWsHome() {
    wsState.entityId = '';
    wsState.doc = null;
    var idx = wsState.idx || { entities: [] };
    var ents = idx.entities || [], i, e, h = '';

    h += '<div class="panel"><h2>Projetos (' + ents.length + ')</h2>';
    if (!ents.length) {
      h += '<p class="muted">Nenhum projeto no AI Workspace ainda.</p>';
    } else {
      for (i = 0; i < ents.length; i++) {
        e = ents[i];
        h += '<div class="row ws-item" data-ws-ent="' + esc(e.id) + '" role="button" tabindex="0">' +
          '<div class="grow ell"><b>' + (e.pinned ? '★ ' : '') + esc(e.title || e.id) + '</b>' +
          (e.description ? '<div class="muted ws-sub ell">' + esc(e.description) + '</div>' : '') +
          '</div><span class="chev">›</span></div>';
      }
    }
    h += '</div>';

    var areas = [
      { key: 'context', label: 'Contexto global' },
      { key: 'knowledge', label: 'Base de conhecimento' },
      { key: 'skills', label: 'Skills' },
      { key: 'handoffs', label: 'Handoffs recentes' },
    ];
    for (i = 0; i < areas.length; i++) {
      var list = idx[areas[i].key] || [];
      if (!list.length) continue;
      h += '<div class="panel"><h2>' + esc(areas[i].label) + ' (' + list.length + ')</h2>';
      for (var j = 0; j < list.length && j < 15; j++) {
        h += '<div class="row ws-item" data-ws-area="' + esc(areas[i].key) + '" data-ws-doc="' + esc(list[j].name) + '" role="button" tabindex="0">' +
          '<span class="grow ell">' + esc(list[j].name) + '</span><span class="chev">›</span></div>';
      }
      h += '</div>';
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
    box.innerHTML = '<div class="row ws-nav"><button type="button" class="btn" id="wsBackHome">‹ Voltar aos projetos</button><span class="muted grow ell">' + esc(area + '/' + name) + '</span></div>' +
      '<div class="panel"><p class="muted">Carregando documento…</p></div>';
    $('wsBackHome').onclick = renderWsHome;

    request('GET', '/api/workspace/doc?area=' + encodeURIComponent(area) + '&name=' + encodeURIComponent(name), function (err, r) {
      if (!wsState.doc || wsState.doc.name !== name || !$('wsBody')) return;
      if (err) {
        box.innerHTML = '<div class="row ws-nav"><button type="button" class="btn" id="wsBackHome">‹ Voltar</button></div><div class="panel"><p class="empty">' + esc(err.message) + '</p></div>';
        $('wsBackHome').onclick = renderWsHome;
        return;
      }
      box.innerHTML = '<div class="row ws-nav"><button type="button" class="btn" id="wsBackHome">‹ Voltar</button><span class="muted grow ell">' + esc(area + '/' + name) + '</span></div>' +
        '<div class="panel ws-md">' + md(r.content || '') + '</div>';
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

    var tab = wsState.tab || 'cards';
    var h = '<div class="row ws-nav"><button type="button" class="btn" id="wsBackHome">‹ Projetos</button><b class="grow ell">' + esc(ent.title || ent.id) + '</b></div>' +
      '<div class="dtabs row" role="tablist">' +
        '<button type="button" class="dtab' + (tab === 'cards' ? ' active' : '') + '" id="wsTabCards">Cards</button>' +
        '<button type="button" class="dtab' + (tab === 'memory' ? ' active' : '') + '" id="wsTabMem">Memória</button>' +
        '<button type="button" class="dtab' + (tab === 'notes' ? ' active' : '') + '" id="wsTabNotes">Notas</button>' +
      '</div>' +
      '<div id="wsEntPane"><div class="panel"><p class="muted">Carregando…</p></div></div>';
    box.innerHTML = h;
    $('wsBackHome').onclick = renderWsHome;
    $('wsTabCards').onclick = function () { wsState.tab = 'cards'; renderWsEntity(id); };
    $('wsTabMem').onclick = function () { wsState.tab = 'memory'; renderWsEntity(id); };
    $('wsTabNotes').onclick = function () { wsState.tab = 'notes'; renderWsEntity(id); };

    if (tab === 'cards') loadWsCards(ent);
    else if (tab === 'memory') loadWsMemory(ent);
    else loadWsNotes(ent);
  }

  function loadWsCards(ent) {
    var steps = ent.steps || [], cardFile = '', i;
    for (i = 0; i < steps.length; i++) {
      if (steps[i].file && /\.card\.json$/i.test(steps[i].file)) { cardFile = steps[i].file; break; }
    }
    if (!cardFile) cardFile = 'overview.card.json';
    request('GET', '/api/workspace/entity/file?id=' + encodeURIComponent(ent.id) + '&path=' + encodeURIComponent(cardFile), function (err, r) {
      var pane = $('wsEntPane');
      if (!pane || wsState.entityId !== ent.id || wsState.tab !== 'cards') return;
      if (err || !r || !r.content) {
        pane.innerHTML = '<div class="panel"><p class="empty">' + esc(err ? err.message : 'Sem cards nesta entidade.') + '</p></div>';
        return;
      }
      var doc = r.content, items = doc.items || [], cols = doc.columns || [], html = '';
      if (doc.template === 'board' && cols.length) {
        for (i = 0; i < cols.length; i++) {
          var col = cols[i], list = [], j;
          for (j = 0; j < items.length; j++) if ((items[j].column || items[j].status) === col.id) list.push(items[j]);
          html += '<div class="panel"><h2>' + esc(col.title || col.id) + ' (' + list.length + ')</h2>';
          if (!list.length) html += '<p class="muted">—</p>';
          for (j = 0; j < list.length; j++) html += renderWsCardItem(ent.id, list[j]);
          html += '</div>';
        }
      } else {
        html += '<div class="panel"><h2>' + esc(doc.title || cardFile) + ' (' + items.length + ')</h2>';
        if (!items.length) html += '<p class="muted">Nenhum item ainda.</p>';
        for (i = 0; i < items.length; i++) html += renderWsCardItem(ent.id, items[i]);
        html += '</div>';
      }
      pane.innerHTML = html;
    });
  }

  function renderWsCardItem(entId, it) {
    var h = '<div class="ws-card-it"><div class="row"><b class="grow">' + esc(it.title || 'Sem título') + '</b>' +
      (it.priority ? '<span class="pill">' + esc(it.priority) + '</span>' : '') + '</div>';
    if (it.summary || it.body || it.notes) {
      h += '<div class="ws-card-txt">' + md(String(it.summary || it.body || it.notes).slice(0, 600)) + '</div>';
    }
    if (it.image) {
      h += '<div class="ws-card-img"><img src="' + esc(wsAssetHref(entId, it.image)) + '" alt="" style="max-width:100%;border-radius:6px;margin-top:6px"></div>';
    }
    if (it.tags && it.tags.length) {
      h += '<div class="muted ws-sub">#' + esc(it.tags.join(' #')) + '</div>';
    }
    return h + '</div>';
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
      btns += '<button type="button" class="btn" id="wsDreamBtn">🌙 Dream</button></div>';
      var content = (m && m.files && m.files[cur] && m.files[cur].content) || '';
      pane.innerHTML = '<div class="panel">' + btns +
        (content ? '<div class="ws-md">' + md(content) + '</div>' : '<p class="muted">Arquivo vazio (' + esc(cur) + ').</p>') +
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
          b.textContent = '🌙 Consolidando…';
          request('POST', '/api/memory/dream', function (dErr, dr) {
            b.disabled = false;
            b.textContent = '🌙 Dream';
            if (dErr) return flash('Dreaming falhou: ' + dErr.message, false);
            flash(dr && dr.skipped ? ('Dreaming pulado: ' + dr.reason) : 'Memória consolidada!');
            loadWsMemory(ent);
          }, { project: proj, cwd: binding && binding.cwd ? binding.cwd : '', force: true });
        };
      }
    });
  }

  function loadWsNotes(ent) {
    var steps = ent.steps || [], i, mdFiles = [], reports = [];
    for (i = 0; i < steps.length; i++) {
      if (!steps[i].file) continue;
      if (/\.html?$/i.test(steps[i].file)) reports.push(steps[i]);
      else if (/\.md$/i.test(steps[i].file)) mdFiles.push(steps[i]);
    }
    var target = (mdFiles[0] && mdFiles[0].file) || 'notes.md';
    request('GET', '/api/workspace/entity/file?id=' + encodeURIComponent(ent.id) + '&path=' + encodeURIComponent(target), function (err, r) {
      var pane = $('wsEntPane');
      if (!pane || wsState.entityId !== ent.id || wsState.tab !== 'notes') return;
      var html = '';
      if (reports.length) {
        html += '<div class="panel"><h2>Relatórios HTML</h2>';
        for (i = 0; i < reports.length; i++) {
          html += '<div class="row ws-item"><a class="grow" target="_blank" rel="noopener" href="' + esc(wsAssetHref(ent.id, reports[i].file)) + '">📄 ' + esc(reports[i].title || reports[i].file) + '</a></div>';
        }
        html += '</div>';
      }
      html += '<div class="panel"><h2>' + esc(target) + '</h2>' +
        (err || !r ? '<p class="muted">Sem notas registradas.</p>' : '<div class="ws-md">' + md(r.content || '') + '</div>') +
        '</div>';
      pane.innerHTML = html;
    });
  }
