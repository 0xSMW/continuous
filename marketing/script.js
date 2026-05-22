(() => {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ─── nav: toggle .scrolled past threshold ─────────────────
  {
    const nav = document.querySelector('.nav');
    if (nav) {
      const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 40);
      onScroll();
      window.addEventListener('scroll', onScroll, { passive: true });
    }
  }

  // ─── hero ─────────────────────────────────────────────────
  buildHeroNetwork();
  morphHeroDemoCard();
  driveHeroEventStream();
  driveHeroLedgerTile();
  driveHeroTileNetwork();
  animateHeroBudgetTiles();

  // ─── worker trio: live activity ticker ────────────────────
  driveWorkerStreams();

  // ─── cross-company scene: playback ────────────────────────
  driveScene();

  // ─── platform budgets: animate in on scroll ───────────────
  observeAndAnimateBudgets();

  // ─── autonomy bar: animate in on scroll ────────────────────
  observeAndAnimateAutonomy();

  // ════════════════════════════════════════════════════════════
  //  HERO NETWORK — dense, named SMB-flavored business graph
  // ════════════════════════════════════════════════════════════
  function buildHeroNetwork() {
    const svg = document.querySelector('.hero-bg .network');
    if (!svg) return;

    // x/y on a 1400x820 viewBox
    const nodes = [
      { id: 'pipe-dreams',     x: 700, y: 410, type: 'you',      label: 'pipe-dreams-plumbing', desc: 'service smb · seattle' },
      { id: 'locke-key',       x: 1080, y: 250, type: 'customer', label: 'locke-&-key-properties', desc: 'property mgmt · 120 units' },
      { id: 'numbers-mcgee',   x: 280,  y: 290, type: 'partner',  label: 'numbers-mcgee-cpa', desc: 'accountant · 30 clients' },
      { id: 'pipe-whisperer',  x: 700,  y: 130, type: 'partner',  label: 'pipe-whisperer-supply', desc: 'parts vendor' },
      { id: 'hammer-time',     x: 380,  y: 530, type: 'partner',  label: 'hammer-time-construction', desc: 'subcontractor' },
      { id: 'doughnut',        x: 1020, y: 600, type: 'customer', label: 'doughnut-disturb-bakery', desc: 'food smb · maintenance' },
      { id: 'hairy-pawter',    x: 380,  y: 130, type: 'customer', label: 'hairy-pawter-vet', desc: 'pet hospital · regulated' },
      { id: 'slice-slice',     x: 700,  y: 680, type: 'customer', label: 'slice-slice-baby-pizza', desc: 'restaurant · monthly inspect' },
      { id: 'mow-drama',       x: 1140, y: 460, type: 'customer', label: 'mow-drama-landscaping', desc: 'peer smb · referrals' },
      { id: 'sweat-equity',    x: 280,  y: 600, type: 'customer', label: 'sweat-equity-gym', desc: 'fitness · scheduling' },
      { id: 'wa-license',      x: 1260, y: 340, type: 'agency',   label: 'wa.state.license', desc: 'agency · permits' },
      { id: 'stripe',          x: 1290, y: 550, type: 'system',   label: 'stripe.payments', desc: 'payments · ach' },
      { id: 'gmail',           x: 130,  y: 420, type: 'system',   label: 'gmail.inbox', desc: 'comms · leads' },
      { id: 'quickbooks',      x: 1200, y: 700, type: 'system',   label: 'quickbooks.ledger', desc: 'accounting · sync' },
    ];

    const edges = [
      ['pipe-dreams', 'locke-key', true],
      ['pipe-dreams', 'numbers-mcgee', true],
      ['pipe-dreams', 'pipe-whisperer', true],
      ['pipe-dreams', 'hammer-time', true],
      ['pipe-dreams', 'doughnut', true],
      ['pipe-dreams', 'hairy-pawter', true],
      ['pipe-dreams', 'slice-slice', true],
      ['pipe-dreams', 'mow-drama', false],
      ['pipe-dreams', 'sweat-equity', true],
      ['pipe-dreams', 'wa-license', false],
      ['pipe-dreams', 'stripe', true],
      ['pipe-dreams', 'gmail', true],
      ['pipe-dreams', 'quickbooks', true],
      ['numbers-mcgee', 'quickbooks', true],
      ['numbers-mcgee', 'stripe', false],
      ['locke-key', 'gmail', false],
      ['hammer-time', 'pipe-whisperer', false],
      ['mow-drama', 'numbers-mcgee', false],
      ['doughnut', 'numbers-mcgee', false],
      ['hairy-pawter', 'wa-license', false],
    ];

    const edgesG = svg.querySelector('.network-edges');
    const flowsG = svg.querySelector('.network-flows');
    const labelsG = svg.querySelector('.network-labels');
    const nodesG = svg.querySelector('.network-nodes');
    const lookup = Object.fromEntries(nodes.map(n => [n.id, n]));

    // edges
    edges.forEach(([a, b, live], i) => {
      const A = lookup[a], B = lookup[b];
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', A.x);
      line.setAttribute('y1', A.y);
      line.setAttribute('x2', B.x);
      line.setAttribute('y2', B.y);
      line.dataset.a = a; line.dataset.b = b;
      if (live) {
        line.setAttribute('class', 'live');
        line.style.animationDelay = `${(i * 0.5) % 3}s`;
      }
      edgesG.appendChild(line);
    });

    // nodes
    nodes.forEach(n => {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', `node${n.type === 'you' ? ' you' : ''}`);
      g.setAttribute('data-type', n.type);
      g.setAttribute('data-id', n.id);
      g.setAttribute('transform', `translate(${n.x} ${n.y})`);

      const w = Math.max(80, n.label.length * 6.4 + 22);
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', -w / 2);
      rect.setAttribute('y', -12);
      rect.setAttribute('width', w);
      rect.setAttribute('height', 24);
      rect.setAttribute('rx', 5);

      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('class', 'node-dot');
      dot.setAttribute('cx', -w / 2 + 9);
      dot.setAttribute('cy', 0);
      dot.setAttribute('r', 2.5);

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('x', 5);
      text.setAttribute('y', 3.5);
      text.textContent = n.label;

      g.appendChild(rect);
      g.appendChild(dot);
      g.appendChild(text);
      nodesG.appendChild(g);

      // hover detail label
      g.addEventListener('mouseenter', () => {
        highlightNeighbors(n.id, edges, edgesG, true);
        showNodeLabel(n, labelsG);
      });
      g.addEventListener('mouseleave', () => {
        highlightNeighbors(n.id, edges, edgesG, false);
        hideNodeLabel(labelsG);
      });
    });

    if (prefersReducedMotion) return;

    const liveEdges = edges.filter(e => e[2]);
    liveEdges.forEach((e, i) => setTimeout(() => animateFlow(e[0], e[1], lookup, flowsG), 200 + i * 320));
  }

  function animateFlow(aId, bId, lookup, flowsG) {
    const A = lookup[aId], B = lookup[bId];
    if (!A || !B) return;
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', 2.6);
    dot.setAttribute('fill', '#60a5fa');
    dot.setAttribute('cx', A.x);
    dot.setAttribute('cy', A.y);
    flowsG.appendChild(dot);

    const duration = 2200 + Math.random() * 1600;
    const start = performance.now();
    const flip = Math.random() < 0.4;
    const [sx, sy, ex, ey] = flip ? [B.x, B.y, A.x, A.y] : [A.x, A.y, B.x, B.y];

    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = t * t * (3 - 2 * t);
      dot.setAttribute('cx', sx + (ex - sx) * eased);
      dot.setAttribute('cy', sy + (ey - sy) * eased);
      dot.setAttribute('opacity', t < 0.1 ? t * 10 : (t > 0.9 ? (1 - t) * 10 : 1));
      if (t < 1) requestAnimationFrame(step);
      else {
        flowsG.removeChild(dot);
        if (!document.hidden) {
          setTimeout(() => animateFlow(aId, bId, lookup, flowsG), 400 + Math.random() * 1800);
        }
      }
    }
    requestAnimationFrame(step);
  }

  function highlightNeighbors(id, edges, edgesG, on) {
    edgesG.querySelectorAll('line').forEach(line => {
      const isMine = line.dataset.a === id || line.dataset.b === id;
      line.style.strokeOpacity = on ? (isMine ? '0.85' : '0.06') : '';
      line.style.stroke = on && isMine ? 'var(--accent)' : '';
    });
  }

  function showNodeLabel(n, labelsG) {
    labelsG.innerHTML = '';
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'show');
    const w = Math.max(170, n.desc.length * 5.4);
    const x = n.x + 18, y = n.y - 28;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x); rect.setAttribute('y', y);
    rect.setAttribute('width', w); rect.setAttribute('height', 32);
    rect.setAttribute('rx', 4);
    const t1 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t1.setAttribute('x', x + 8); t1.setAttribute('y', y + 13);
    t1.textContent = n.label;
    const t2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t2.setAttribute('x', x + 8); t2.setAttribute('y', y + 25);
    t2.setAttribute('fill', '#8a8b90');
    t2.textContent = n.desc;
    g.appendChild(rect); g.appendChild(t1); g.appendChild(t2);
    labelsG.appendChild(g);
  }
  function hideNodeLabel(labelsG) { labelsG.innerHTML = ''; }

  // ════════════════════════════════════════════════════════════
  //  HERO FLOATING DEMO CARD — morphs across worker kinds
  // ════════════════════════════════════════════════════════════
  function morphHeroDemoCard() {
    const card = document.getElementById('demoCard');
    if (!card) return;

    const variants = [
      { kind: 'synthetic', name: 'Continuous Revenue Worker', id: 'worker:ai:revenue-ops-default', glyph: '◆',
        action: 'drafted quote · $1,840 · Locke & Key Properties' },
      { kind: 'human', name: 'Marisol Rivera — Owner', id: 'worker:human:marisol-rivera-001', glyph: '●',
        action: 'approved quote · $1,840 · sent to customer' },
      { kind: 'robot', name: 'Optimus Gen 4 — Humanoid', id: 'worker:robot:optimus-gen-4', glyph: '▣',
        action: 'site inspection complete · 14 photos · Hairy Pawter Vet' },
      { kind: 'synthetic', name: 'Finance Worker', id: 'worker:ai:finance-default', glyph: '◆',
        action: 'reconciled deposit · $920 · stripe ch_3p9hAk' },
    ];
    let i = 0;
    function tick() {
      i = (i + 1) % variants.length;
      const v = variants[i];
      card.style.opacity = '0.3';
      setTimeout(() => {
        card.querySelector('[data-kind-label]').textContent = v.kind;
        card.querySelector('[data-kind-name]').textContent = v.name;
        card.querySelector('[data-kind-id]').textContent = v.id;
        card.querySelector('[data-kind-glyph]').textContent = v.glyph;
        card.querySelector('[data-kind-action]').textContent = v.action;
        card.dataset.kind = v.kind;
        const g = card.querySelector('[data-kind-glyph]');
        if (v.kind === 'human') g.style.color = '#e4e4e7';
        else if (v.kind === 'robot') g.style.color = '#facc15';
        else g.style.color = 'var(--accent-2)';
        card.style.opacity = '1';
      }, 240);
    }
    if (!prefersReducedMotion) setInterval(tick, 3600);
  }

  // ════════════════════════════════════════════════════════════
  //  HERO EVENT STREAM — right-column live ledger
  // ════════════════════════════════════════════════════════════
  function driveHeroEventStream() {
    const host = document.getElementById('heroEvents');
    if (!host) return;
    const pool = [
      ['14:19', 'payment.received', '$920 · Locke & Key'],
      ['14:11', 'quote.sent', '$1,840 · Locke & Key'],
      ['14:04', 'quote.drafted', 'leak repair · urgent'],
      ['13:58', 'follow-up.sent', 'Mow Drama · inv #4128'],
      ['13:33', 'site.inspection', 'Hairy Pawter · 14 photos'],
      ['13:18', 'reminder.sent', 'Sweat Equity · renewal'],
      ['12:50', 'invoice.paid', '$2,140 · Doughnut Disturb'],
      ['12:18', 'safety.log', '3 jobs · all clear'],
      ['11:50', 'escalation', '$420 refund · Slice Slice Baby'],
      ['11:42', 'lead.classified', 'Hammer Time referral · hot'],
      ['11:14', 'coi.requested', 'Locke & Key · Q3'],
      ['10:38', 'po.sent', 'Pipe Whisperer · $342'],
    ];
    let head = 0;
    function render() {
      const rows = [];
      for (let i = 0; i < 5; i++) {
        const item = pool[(head + i) % pool.length];
        rows.push(item);
      }
      host.innerHTML = rows.map(([t, k, v], i) => `
        <div class="he-row ${i === 0 ? 'fresh' : ''}" style="animation-delay:${i * 50}ms">
          <span class="he-time">${t}</span>
          <span>${k}</span>
          <span class="he-val">${v}</span>
        </div>
      `).join('');
    }
    render();
    if (!prefersReducedMotion) setInterval(() => { head = (head + 1) % pool.length; render(); }, 2600);
  }

  // ════════════════════════════════════════════════════════════
  //  HERO LEDGER TILE — scrolling task stream
  // ════════════════════════════════════════════════════════════
  function driveHeroLedgerTile() {
    const host = document.getElementById('heroLedgerStream');
    if (!host) return;
    const events = [
      ['14:19', 'payment.received', '$920 · Locke & Key'],
      ['14:11', 'quote.sent', '$1,840 · Locke & Key'],
      ['14:04', 'quote.drafted', 'leak repair · urgent'],
      ['13:58', 'follow-up.sent', 'Mow Drama · inv #4128'],
      ['13:33', 'site.scan', 'Hairy Pawter · 14 photos'],
      ['13:18', 'reminder.sent', 'Sweat Equity · renewal'],
      ['12:50', 'invoice.paid', '$2,140 · Doughnut Disturb'],
      ['12:18', 'safety.log', '3 jobs reviewed · all clear'],
      ['11:50', 'escalation', '$420 refund · Slice Slice Baby'],
      ['11:42', 'lead.classified', 'Hammer Time referral · hot'],
    ];
    let idx = 0;
    function render() {
      // show last 4
      const start = idx % events.length;
      const slice = [];
      for (let i = 0; i < 4; i++) slice.push(events[(start + i) % events.length]);
      host.innerHTML = slice.map(([t, k, v], i) => `
        <div class="tl-stream-row" style="animation-delay:${i * 60}ms">
          <span class="mono-time">${t}</span>${k}<span class="mono-val">· ${v}</span>
        </div>
      `).join('');
    }
    render();
    if (!prefersReducedMotion) setInterval(() => { idx++; render(); }, 2800);
  }

  // ════════════════════════════════════════════════════════════
  //  HERO NETWORK TILE — mini flow dots
  // ════════════════════════════════════════════════════════════
  function driveHeroTileNetwork() {
    const svg = document.getElementById('heroTileNetwork');
    if (!svg || prefersReducedMotion) return;
    const flow = svg.querySelector('.ttn-flow');
    const edges = [
      [110, 60, 30, 25],
      [110, 60, 195, 22],
      [110, 60, 25, 100],
      [110, 60, 170, 60],
    ];
    function spawn() {
      const e = edges[Math.floor(Math.random() * edges.length)];
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('r', '1.8');
      c.setAttribute('fill', '#60a5fa');
      c.setAttribute('cx', e[0]);
      c.setAttribute('cy', e[1]);
      flow.appendChild(c);
      const start = performance.now();
      const dur = 1400;
      function step(now) {
        const t = Math.min(1, (now - start) / dur);
        c.setAttribute('cx', e[0] + (e[2] - e[0]) * t);
        c.setAttribute('cy', e[1] + (e[3] - e[1]) * t);
        c.setAttribute('opacity', t < 0.1 ? t * 10 : (t > 0.9 ? (1 - t) * 10 : 1));
        if (t < 1) requestAnimationFrame(step);
        else flow.removeChild(c);
      }
      requestAnimationFrame(step);
    }
    setInterval(spawn, 600);
  }

  // ════════════════════════════════════════════════════════════
  //  HERO BUDGET TILE — fill bars in on load + on hover bump
  // ════════════════════════════════════════════════════════════
  function animateHeroBudgetTiles() {
    document.querySelectorAll('.tile-budgets .tb-fill').forEach((bar, i) => {
      const target = bar.dataset.w + '%';
      setTimeout(() => { bar.style.width = target; }, 400 + i * 140);
    });
  }

  // ════════════════════════════════════════════════════════════
  //  WORKER TRIO — live activity stream tickers
  // ════════════════════════════════════════════════════════════
  function driveWorkerStreams() {
    document.querySelectorAll('.wc-stream').forEach(stream => {
      const rows = Array.from(stream.querySelectorAll('.wcs-row'));
      if (!rows.length || prefersReducedMotion) return;

      let idx = 0;
      const card = stream.closest('.worker-card');
      let paused = false;
      card.addEventListener('mouseenter', () => paused = true);
      card.addEventListener('mouseleave', () => paused = false);

      function flash() {
        if (paused) return;
        rows.forEach(r => r.classList.remove('flash'));
        rows[idx].classList.add('flash');
        const tick = stream.querySelector('.wcs-tick');
        if (tick) tick.textContent = idx === 0 ? 'just now' : `${idx * 12}s ago`;
        idx = (idx + 1) % rows.length;
      }
      setTimeout(() => { flash(); setInterval(flash, 3200); }, 800 + Math.random() * 800);
    });
  }

  // ════════════════════════════════════════════════════════════
  //  CROSS-COMPANY SCENE — playable timeline
  // ════════════════════════════════════════════════════════════
  function driveScene() {
    const stage = document.querySelector('.scene-stage');
    if (!stage) return;
    const STEP_MS = 1300;

    const SCENES = {
      'lead-to-cash': {
        total: 11,
        labels: [
          'idle',
          'lead.received · via gmail',
          'lead.classified · urgent leak repair',
          'quote.drafted · $1,840',
          'approval.requested · Marisol',
          'approval.granted · Marisol',
          'quote.sent · to Locke & Key',
          'vendor.matched · by Procurement',
          'approval.requested · Jordan',
          'deposit.paid · $920 via stripe',
          'commitment.opened · Locke & Key',
          'invoice.sent · $920 net 7',
        ],
      },
      'delivery': {
        total: 11,
        labels: [
          'idle',
          'job.booked · Locke & Key install',
          'materials.checked · 2 parts needed',
          'stock.shortage · local stock empty',
          'po.drafted · $342',
          'approval.requested · Marisol',
          'po.sent · to Pipe Whisperer',
          'inventory.matched · 2 of 2 in stock',
          'hank.approves · parts shipped',
          'parts.received · Optimus Gen 4',
          'crew.dispatched · to Locke & Key',
          'install.complete · closeout sent',
        ],
      },
      'compliance': {
        total: 11,
        labels: [
          'idle',
          'coi.requested · from Locke & Key',
          'request.classified · additional insured',
          'evidence.required · GL + WC + AI',
          'packet.drafted · 3 docs',
          'approval.requested · Marisol',
          'request.sent · to Cascade Mutual',
          'client.matched · policy #CM-44129',
          'pat.approves · AI endorsement',
          'coi.generated · #COI-88-pdh',
          'validation.complete · all required',
          'coi.forwarded · to Locke & Key',
        ],
      },
      'hire': {
        total: 11,
        labels: [
          'idle',
          'capacity.shortfall · 3-day install',
          'vendor.matched · Hammer Time',
          'engagement.drafted · $4,800 · 3d',
          'compliance.required · COI + license',
          'approval.requested · Marisol',
          'sow.sent · to Hammer Time',
          'sow.classified · by Revenue Worker',
          'tony.approves · engagement',
          'docs.delivered · COI + WA #88-1234',
          'compliance.validates · all current',
          'commitment.opened · work mon',
        ],
      },
      'payroll': {
        total: 11,
        labels: [
          'idle',
          'payroll.preview · biweekly pp03',
          'time.locked · 4 employees · 312 hrs',
          'calc.complete · $14,840 / $11,920',
          'blockers.check · all clear',
          'approval.requested · Marisol',
          'marisol.approves · dual control',
          'ach.batch.sent · to Cascade Bank',
          'compliance.review · ofac + nacha',
          'funding.confirmed · settles t+1',
          'paystubs.published · employee portal',
          'settlement.posted · gl reconciled',
        ],
      },
      'close': {
        total: 11,
        labels: [
          'idle',
          'close.initiated · 30 clients · q3',
          'books.synced · from Pipe Dreams',
          'anomaly.detected · variance $1,240',
          'evidence.requested · paystub trace',
          'approval.requested · Pam',
          'query.sent · to Pipe Dreams',
          'evidence.assembled · paystub + retro',
          'marisol.confirms · q2 retro entry',
          'evidence.delivered · to Numbers McGee',
          'reconciliation.complete · resolved',
          'close.delivered · + tax estimate',
        ],
      },
    };

    let activeId = 'lead-to-cash';
    let step = 0;
    let playing = !prefersReducedMotion;
    let lastTick = performance.now();

    const playBtn = document.getElementById('scenePlay');
    const fwdBtn = document.getElementById('sceneFwd');
    const backBtn = document.getElementById('sceneBack');
    const tabs = stage.querySelectorAll('.scene-tabs .tab');

    function activeFrame() {
      return stage.querySelector(`.scene-frame[data-scene-id="${activeId}"]`);
    }

    function render() {
      const frame = activeFrame();
      if (!frame) return;
      const total = SCENES[activeId].total;

      frame.querySelectorAll('.ledger-row').forEach(row => {
        const s = parseInt(row.dataset.step, 10);
        row.classList.toggle('active', s <= step && s > step - 6);
      });
      frame.querySelectorAll('.channel-events li').forEach(li => {
        const s = parseInt(li.dataset.step, 10);
        li.classList.toggle('active', s === step);
      });
      // payload dot removed — active event card carries the visual signal
      const stepEl = frame.querySelector('.channel-step strong');
      const descEl = frame.querySelector('.channel-step > .mono.muted:last-child');
      if (stepEl) stepEl.textContent = `${step} / ${total}`;
      if (descEl) descEl.textContent = SCENES[activeId].labels[step] || '';
      if (playBtn) playBtn.textContent = playing ? '⏸' : '▶';
    }

    function switchScene(id) {
      if (!SCENES[id]) return;
      activeId = id;
      stage.querySelectorAll('.scene-frame').forEach(f => {
        f.classList.toggle('active', f.dataset.sceneId === id);
      });
      tabs.forEach(t => t.classList.toggle('active', t.dataset.scene === id));
      step = 0;
      lastTick = performance.now();
      render();
    }

    function loop(now) {
      if (playing && now - lastTick > STEP_MS) {
        const total = SCENES[activeId].total;
        step = (step % total) + 1;
        render();
        lastTick = now;
      }
      requestAnimationFrame(loop);
    }

    if (playBtn) playBtn.addEventListener('click', () => { playing = !playing; render(); });
    if (fwdBtn) fwdBtn.addEventListener('click', () => {
      const total = SCENES[activeId].total;
      step = (step % total) + 1; render(); lastTick = performance.now();
    });
    if (backBtn) backBtn.addEventListener('click', () => {
      const total = SCENES[activeId].total;
      step = step <= 1 ? total : step - 1; render(); lastTick = performance.now();
    });

    tabs.forEach(tab => {
      tab.addEventListener('click', () => switchScene(tab.dataset.scene));
    });

    // hover pause-on-hover behavior
    let autoPaused = false;
    stage.addEventListener('mouseenter', () => { if (playing) { playing = false; autoPaused = true; render(); } });
    stage.addEventListener('mouseleave', () => { if (autoPaused) { playing = true; autoPaused = false; render(); } });

    render();
    requestAnimationFrame(loop);
  }

  // ════════════════════════════════════════════════════════════
  //  PLATFORM BUDGETS — animate in on view
  // ════════════════════════════════════════════════════════════
  function observeAndAnimateAutonomy() {
    const bar = document.querySelector('.autonomy-bar .ab-fill');
    if (!bar) return;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const target = (bar.dataset.target || '38') + '%';
          setTimeout(() => { bar.style.width = target; }, 100);
          observer.disconnect();
        }
      });
    }, { threshold: 0.3 });
    observer.observe(bar);
  }

  function observeAndAnimateBudgets() {
    const bars = document.querySelectorAll('.quad-budgets .bb-fill');
    if (!bars.length) return;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          bars.forEach((b, i) => {
            const target = (b.dataset.target || '50') + '%';
            setTimeout(() => { b.style.width = target; }, i * 140);
          });
          observer.disconnect();
        }
      });
    }, { threshold: 0.3 });
    const quad = document.querySelector('.quad-budgets');
    if (quad) observer.observe(quad);
  }
})();
