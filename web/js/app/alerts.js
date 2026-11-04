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
      if (prevStates && x.state === 'waiting' && !isSeen(x) && (prevStates[x.id] !== 'waiting' || newReply)) {
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
    $('remote').innerHTML = icon('remote') + '<span class="lbl"> ' + (on ? 'Remoto ligado' : 'Remoto') + '</span>';
  }

  function setSound(on) {
    soundOn = on;
    store('hud.sound', on ? '1' : '0');
    $('sound').innerHTML = icon(on ? 'bell' : 'bellOff');
  }

