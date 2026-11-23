  // ---- Nova sessão de IA (gaveta #nova: escolhe máquina, IA, modelo, pasta e mensagem inicial) ----
  var newCaps = null, newBusy = false;
  var newSel = { machine: '', tool: '', model: '', cwd: '', customCwd: '' };
  var pendingNewId = '', pendingNewUntil = 0;

  function machineToolList(m) {
    var out = [], order = ['Claude Code', 'Codex', 'Gemini', 'Ollama'], i;
    if (!m || !m.online || !m.tools) return out;
    for (i = 0; i < order.length; i++) if (m.tools[order[i]]) out.push(order[i]);
    return out;
  }

  function findMachine(name) {
    if (!newCaps || !newCaps.machines) return null;
    for (var i = 0; i < newCaps.machines.length; i++) if (newCaps.machines[i].name === name) return newCaps.machines[i];
    return null;
  }

  function ensureNewSelection() {
    var list = (newCaps && newCaps.machines) || [], i, chosen = findMachine(newSel.machine);
    if (!chosen || !machineToolList(chosen).length) {
      chosen = null;
      var savedM = store('hud.newMachine');
      if (savedM) {
        var sm = findMachine(savedM);
        if (sm && machineToolList(sm).length) chosen = sm;
      }
      for (i = 0; i < list.length && !chosen; i++) if (machineToolList(list[i]).length) chosen = list[i];
      newSel.machine = chosen ? chosen.name : '';
    }
    var tools = machineToolList(chosen);
    if (!tools.length) { newSel.tool = ''; newSel.model = ''; newSel.cwd = ''; return; }
    if (tools.indexOf(newSel.tool) < 0) {
      var savedT = store('hud.newTool');
      newSel.tool = savedT && tools.indexOf(savedT) >= 0 ? savedT : tools[0];
    }
    var models = (chosen.tools[newSel.tool] && chosen.tools[newSel.tool].models) || [], hasModel = false;
    for (i = 0; i < models.length; i++) if (models[i].id === newSel.model) hasModel = true;
    if (!hasModel) newSel.model = models.length ? models[0].id : '';
    var cwds = chosen.cwds || [];
    if (newSel.cwd !== '__custom__' && newSel.cwd && cwds.indexOf(newSel.cwd) < 0) {
      newSel.cwd = cwds.length ? cwds[0] : '';
    } else if (!newSel.cwd && newSel.cwd !== '__custom__' && cwds.length && !newSel._cwdTouched) {
      newSel.cwd = cwds[0];
    }
  }

  function openNewSession() {
    newBusy = false;
    setOverlay(head('Nova sessão', 'carregando máquinas e modelos…') +
      '<div class="panel"><span class="sk sk-line" style="width:45%;margin-top:0"></span>' +
      '<div class="row" style="margin:10px 0"><span class="sk sk-pill" style="width:6.5em;height:2.4em;margin-right:8px"></span><span class="sk sk-pill" style="width:6.5em;height:2.4em"></span></div>' +
      '<span class="sk sk-line" style="width:35%"></span><span class="sk sk-input" style="margin-top:8px"></span>' +
      '<span class="sk sk-input" style="height:4.5em;margin-top:12px"></span></div>');
    request('GET', '/api/capabilities', function (err, data) {
      if (view !== 'new') return;
      if (err || !data || !data.machines) {
        return setOverlay(head('Nova sessão') + '<div class="panel"><p class="empty">Não foi possível consultar as máquinas disponíveis: ' + esc(err ? err.message : 'sem dados') + '</p></div>');
      }
      newCaps = data;
      newSel._cwdTouched = false;
      ensureNewSelection();
      renderNewSession();
    });
  }

  function isPinnedCwd(m, cwd) {
    if (!m || !m.pinned || !cwd) return false;
    var win = m.platform === 'win32', needle = win ? String(cwd).toLowerCase() : String(cwd);
    for (var i = 0; i < m.pinned.length; i++) {
      var cur = win ? String(m.pinned[i]).toLowerCase() : String(m.pinned[i]);
      if (cur === needle) return true;
    }
    return false;
  }

  function renderNewSession() {
    if (!newCaps) return;
    ensureNewSelection();
    var list = newCaps.machines || [], chosen = findMachine(newSel.machine), tools = machineToolList(chosen), i;
    var html = head('Nova sessão', 'inicie uma conversa direto pelo AI HUD');
    html += '<div class="panel nform">';

    // 1. Máquina
    html += '<div class="nlabel">Máquina</div><div class="npick">';
    for (i = 0; i < list.length; i++) {
      var m = list[i], mt = machineToolList(m), avail = mt.length > 0, active = chosen && chosen.name === m.name;
      var note = !m.online ? ' (offline)' : !avail ? ' (sem IAs)' : '';
      html += '<button type="button" class="npill' + (active ? ' on' : '') + (!avail ? ' off' : '') + '" data-nm="' + esc(m.name) + '"' +
        (!avail ? ' disabled' : ' aria-pressed="' + (active ? 'true' : 'false') + '"') + '>' +
        '🖥 ' + esc(m.name) + (note ? '<small>' + note + '</small>' : '') + '</button>';
    }
    html += '</div>';

    if (!chosen || !tools.length) {
      html += '<p class="empty">Nenhuma máquina online possui CLI de IA ou Ollama disponível no momento.</p></div>';
      setOverlay(html);
      return;
    }

    // 2. IA
    html += '<div class="nlabel">IA</div><div class="npick">';
    for (i = 0; i < tools.length; i++) {
      var tname = tools[i], tActive = newSel.tool === tname, idx = toolIndex(tname);
      html += '<button type="button" class="npill' + (tActive ? ' on' : '') + '" data-nt="' + esc(tname) + '" aria-pressed="' + (tActive ? 'true' : 'false') + '">' +
        toolIcon(idx) + esc(tname === 'Claude Code' ? 'Claude' : tname) + '</button>';
    }
    html += '</div>';

    // 3. Modelo
    var models = (chosen.tools[newSel.tool] && chosen.tools[newSel.tool].models) || [];
    html += '<label class="nlabel" for="newModel">Modelo</label><select class="nsel" id="newModel">';
    for (i = 0; i < models.length; i++) {
      html += '<option value="' + esc(models[i].id) + '"' + (models[i].id === newSel.model ? ' selected' : '') + '>' + esc(models[i].label || models[i].id) + '</option>';
    }
    html += '</select>';

    // 4. Pasta / Projeto (não usado pelo Ollama)
    if (newSel.tool !== 'Ollama') {
      var cwds = chosen.cwds || [], isPin = isPinnedCwd(chosen, newSel.cwd);
      var canPin = !!newSel.cwd && newSel.cwd !== '__custom__';
      html += '<label class="nlabel" for="newCwd">Pasta / Projeto</label><div class="row cwd-row"><select class="nsel grow" id="newCwd">';
      for (i = 0; i < cwds.length; i++) {
        var star = isPinnedCwd(chosen, cwds[i]) ? '★ ' : '';
        html += '<option value="' + esc(cwds[i]) + '"' + (newSel.cwd === cwds[i] ? ' selected' : '') + '>' + star + esc(cwds[i]) + '</option>';
      }
      html += '<option value=""' + (newSel.cwd === '' ? ' selected' : '') + '>Pasta pessoal (' + esc(chosen.home || 'padrão') + ')</option>';
      if (!chosen.strictRemoteCwd) {
        html += '<option value="__custom__"' + (newSel.cwd === '__custom__' ? ' selected' : '') + '>Outro caminho…</option>';
      }
      html += '</select>' +
        '<button type="button" class="pinbtn' + (isPin ? ' on' : '') + '" id="pinCwdBtn"' +
        (canPin ? '' : ' disabled') + ' title="' + (isPin ? 'Desfixar pasta favorita' : 'Fixar pasta nos favoritos') + '">' +
        (isPin ? '★' : '☆') + '</button></div>';
      if (newSel.cwd === '__custom__' && !chosen.strictRemoteCwd) {
        html += '<input type="text" class="nsel" id="newCustomCwd" placeholder="Caminho completo da pasta…" value="' + esc(newSel.customCwd || '') + '">';
      }
      if (chosen.strictRemoteCwd) {
        html += '<div class="nlock">🔒 Acesso remoto restrito às pastas autorizadas desta máquina</div>';
      }
      html += '<div class="nperm">⚡ Todas as permissões ativadas (execução autônoma)</div>';
    }

    // 5. Mensagem inicial
    var prevPrompt = $('newPrompt') ? $('newPrompt').value : '';
    html += '<label class="nlabel" for="newPrompt">Mensagem inicial</label>' +
      '<textarea id="newPrompt" class="ntext" rows="3" placeholder="Escreva o que a IA deve fazer…">' + esc(prevPrompt) + '</textarea>' +
      '<div class="row nactions"><button type="button" class="pbtn allow" id="startNewSess"' + (newBusy ? ' disabled' : '') + '>' +
      (newBusy ? 'Iniciando…' : 'Iniciar sessão') + '</button></div>';
    html += '</div>';

    setOverlay(html);

    var btns = $('overlayBody').getElementsByTagName('button');
    for (i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-nm')) {
        btns[i].onclick = function () {
          newSel.machine = this.getAttribute('data-nm');
          newSel.cwd = '';
          newSel._cwdTouched = false;
          renderNewSession();
        };
      } else if (btns[i].getAttribute('data-nt')) {
        btns[i].onclick = function () {
          newSel.tool = this.getAttribute('data-nt');
          newSel.model = '';
          renderNewSession();
        };
      }
    }
    if ($('newModel')) $('newModel').onchange = function () { newSel.model = this.value; };
    if ($('newCwd')) $('newCwd').onchange = function () {
      newSel.cwd = this.value;
      newSel._cwdTouched = true;
      renderNewSession();
    };
    if ($('pinCwdBtn')) $('pinCwdBtn').onclick = function () {
      if (!newSel.cwd || newSel.cwd === '__custom__' || !chosen) return;
      var nextPin = !isPinnedCwd(chosen, newSel.cwd), b = this, targetCwd = newSel.cwd;
      b.disabled = true;
      request('POST', '/api/projects/pin', function (err, r) {
        b.disabled = false;
        if (err) return flash('Falhou: ' + err.message, false);
        chosen.pinned = (r && r.pinned) || [];
        // Reordena favoritos no topo sem perder pastas recentes
        var rest = [], k;
        for (k = 0; k < (chosen.cwds || []).length; k++) {
          if (!isPinnedCwd(chosen, chosen.cwds[k])) rest.push(chosen.cwds[k]);
        }
        chosen.cwds = chosen.pinned.concat(rest);
        flash(nextPin ? 'Pasta fixada nos favoritos.' : 'Pasta removida dos favoritos.');
        renderNewSession();
      }, { machine: chosen.name, cwd: targetCwd, pinned: nextPin });
    };
    if ($('newCustomCwd')) $('newCustomCwd').oninput = function () { newSel.customCwd = this.value; };
    if ($('startNewSess')) $('startNewSess').onclick = function () {
      var prompt = $('newPrompt') ? $('newPrompt').value.replace(/^\s+|\s+$/g, '') : '';
      if (!prompt) { flash('Escreva uma mensagem inicial.', false); if ($('newPrompt')) $('newPrompt').focus(); return; }
      var cwd = newSel.tool === 'Ollama' ? '' : (newSel.cwd === '__custom__' ? String(newSel.customCwd || '').replace(/^\s+|\s+$/g, '') : newSel.cwd);
      if (newSel.tool !== 'Ollama' && newSel.cwd === '__custom__' && !cwd) {
        flash('Informe o caminho da pasta.', false); if ($('newCustomCwd')) $('newCustomCwd').focus(); return;
      }
      store('hud.newMachine', newSel.machine);
      store('hud.newTool', newSel.tool);
      newBusy = true;
      $('startNewSess').disabled = true;
      $('startNewSess').textContent = 'Iniciando…';
      request('POST', '/api/new', function (err, r) {
        newBusy = false;
        if (err) {
          if ($('startNewSess')) { $('startNewSess').disabled = false; $('startNewSess').textContent = 'Iniciar sessão'; }
          return flash('Falhou: ' + err.message, false);
        }
        poll();
        if (r && r.id) {
          pendingNewId = r.id;
          pendingNewUntil = new Date().getTime() + 15000;
          var nextHash = '#s=' + encodeURIComponent(r.id);
          // Substitui #nova no histórico para fechar a gaveta de criação (✕ / Voltar vai direto para a tela inicial)
          if (history && history.replaceState) {
            history.replaceState(null, '', nextHash);
            syncHash();
          } else if (location.replace) {
            location.replace(nextHash);
          } else {
            location.hash = nextHash;
          }
        } else {
          closeOverlay();
          flash('Sessão iniciada — aparece na lista em instantes.');
        }
      }, { machine: newSel.machine, tool: newSel.tool, model: newSel.model, cwd: cwd, prompt: prompt });
    };
  }
