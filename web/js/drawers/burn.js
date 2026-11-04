  // ---- Burn-up da janela de 5h ----------------------------------------------
  // Linha cheia: % usado ao longo da janela. Tracejada: ritmo atual até o reset (ou até 100%).
  // only: 'claude' ou 'codex' desenha só essa IA (gaveta de uso); sem ele, as duas
  function burnChart(s, only) {
    var box = $('burn');
    if (!box) return;
    var W = box.clientWidth, H = box.clientHeight, names = only ? [only] : ['claude', 'codex'], i, j;
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
      svg += '<polyline points="' + pts + '" fill="none" stroke="' + COLORS[names[i] === 'codex' ? 1 : 0] + '" stroke-width="3" stroke-linejoin="round"/>';
      var tEnd = d.runsOutIn != null ? now + d.runsOutIn : d.end, pEnd = d.runsOutIn != null ? 100 : d.projected;
      if (pEnd != null) {
        svg += '<line x1="' + X(now) + '" y1="' + Y(d.used) + '" x2="' + X(tEnd) + '" y2="' + Y(pEnd) + '" stroke="' + COLORS[names[i] === 'codex' ? 1 : 0] + '" stroke-width="2" stroke-dasharray="6 5" opacity=".8"/>';
        if (d.runsOutIn != null) svg += '<circle cx="' + X(tEnd) + '" cy="' + Y(100) + '" r="5" fill="#e87070"/>';
      }
      svg += '<circle cx="' + X(Math.min(now, d.end)) + '" cy="' + Y(d.used) + '" r="4" fill="' + COLORS[names[i] === 'codex' ? 1 : 0] + '"/>';
    }
    box.innerHTML = svg + '</svg>';
    $('burnAxis').innerHTML = '<span>' + hm(x0) + '</span><span>agora ' + hm(now) + '</span><span>' + hm(x1) + '</span>';
  }

