'use strict';

(function () {
  const state = {
    catalog: null,
    activeTab: 'classify',
    classify: {
      presetId: 'vqfn-24-hotrod',
      imageMeta: null,
      uploadedImageElement: null,
      result: null,
      selectedPinNumber: null,
      hoveredEvidenceId: null,
      verifiedPins: new Set()
    },
    select: { result: null },
    size: {
      familyId: 'bcd-hotrod-buck',
      mode: 'currentToArea',
      plotScale: 'linear',
      customSamples: [],
      result: null
    },
    lastDossierMarkdown: ''
  };

  // High-contrast, readable TI-style functional colors on light background
  const PIN_COLORS = {
    POWER_IN: '#cc0000',
    POWER_OUT: '#cc0000',
    SWITCH: '#d97706',
    GND_PWR: '#15803d',
    THERMAL_PAD: '#15803d',
    SENSE: '#6d28d9',
    GND_ANA: '#6d28d9',
    GATE_DRV: '#0284c7',
    CONTROL: '#0284c7',
    CLOCK: '#0284c7',
    ANALOG: '#0284c7',
    BIAS: '#0284c7',
    STATUS: '#0284c7'
  };

  async function init() {
    bindTabNavigation();
    bindClassifyEvents();
    bindSelectEvents();
    bindSizeEvents();
    bindGlobalActions();

    const res = await fetch('/api/catalog');
    state.catalog = await res.json();
    populateCatalogControls(state.catalog);

    await Promise.all([
      runClassifyWorkflow(),
      runSelectWorkflow(),
      runSizeWorkflow()
    ]);
  }

  function populateCatalogControls(catalog) {
    const presetSel = document.getElementById('classifyPresetSelect');
    presetSel.innerHTML = '';
    catalog.presets.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.pinCount} pins, ${p.ratedCurrentA}A)`;
      presetSel.appendChild(opt);
    });

    const topoSel = document.getElementById('selTopology');
    catalog.topologies.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      topoSel.appendChild(opt);
    });
    topoSel.value = 'Synchronous Buck';

    const interSel = document.getElementById('selInterconnect');
    catalog.interconnects.forEach((ic) => {
      const opt = document.createElement('option');
      opt.value = ic;
      opt.textContent = ic;
      interSel.appendChild(opt);
    });
    interSel.value = 'Flip-Chip Cu-Pillar (HotRod)';

    const famSel = document.getElementById('sizeFamilySelect');
    famSel.innerHTML = '';
    catalog.families.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = `${f.name}`;
      famSel.appendChild(opt);
    });
  }

  function bindTabNavigation() {
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-tab');
        state.activeTab = target;
        document.querySelectorAll('.nav-tab').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-tab') === target);
        });
        document.querySelectorAll('.workflow-panel').forEach((p) => {
          p.classList.toggle('active', p.id === `panel-${target}`);
        });
        if (target === 'classify' && state.classify.result) drawFootprintCanvas(state.classify.result);
        if (target === 'size' && state.size.result) {
          drawSizingCurveCanvas(state.size.result);
          drawDieFloorplanCanvas(state.size.result);
        }
      });
    });
  }

  function bindClassifyEvents() {
    const presetSel = document.getElementById('classifyPresetSelect');
    presetSel.addEventListener('change', () => {
      state.classify.presetId = presetSel.value;
      state.classify.imageMeta = null;
      state.classify.uploadedImageElement = null;
      state.classify.verifiedPins.clear();
      document.getElementById('uploadedFilePill').classList.add('hidden');
      const preset = state.catalog?.presets.find((p) => p.id === presetSel.value);
      if (preset) {
        document.getElementById('clsLengthMm').value = preset.bodyLengthMm;
        document.getElementById('clsWidthMm').value = preset.bodyWidthMm;
        document.getElementById('clsPitchMm').value = preset.pitchMm;
        document.getElementById('clsCurrentA').value = preset.ratedCurrentA;
      }
      runClassifyWorkflow();
    });

    document.getElementById('btnRunClassify').addEventListener('click', runClassifyWorkflow);
    document.getElementById('toggleEvidenceBoxes').addEventListener('change', () => {
      if (state.classify.result) drawFootprintCanvas(state.classify.result);
    });
    document.getElementById('toggleHotLoop').addEventListener('change', () => {
      if (state.classify.result) drawFootprintCanvas(state.classify.result);
    });

    const dropZone = document.getElementById('imageDropZone');
    const fileInput = document.getElementById('packageImageInput');
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => e.preventDefault());
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleUploadedPackageImage(e.dataTransfer.files[0]);
      }
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        handleUploadedPackageImage(fileInput.files[0]);
      }
    });

    document.getElementById('btnVerifyAllPins').addEventListener('click', () => {
      (state.classify.result?.pins || []).forEach((p) => state.classify.verifiedPins.add(p.pin));
      renderClassifyPinTable(state.classify.result);
    });
    document.getElementById('btnExportPinsCsv').addEventListener('click', () => {
      const data = state.classify.result;
      if (!data) return;
      const rows = [['Pin', 'Name', 'Side', 'Type', 'Voltage_V', 'Current_A', 'Verified']];
      data.pins.forEach((p) => {
        rows.push([p.pin, p.name, p.side, p.type, p.voltageV, p.currentA, state.classify.verifiedPins.has(p.pin) ? 'YES' : 'NO']);
      });
      downloadTextFile(`${data.presetId}-pinout.csv`, rows.map((r) => r.join(',')).join('\n'), 'text/csv');
    });
  }

  function handleUploadedPackageImage(file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        state.classify.uploadedImageElement = img;
        state.classify.imageMeta = {
          fileName: file.name,
          width: img.width || 600,
          height: img.height || 600,
          contrastScore: 0.95,
          edgeDensity: 0.92
        };
        const pill = document.getElementById('uploadedFilePill');
        pill.textContent = `Loaded: ${file.name} (${img.width || 600}×${img.height || 600}px)`;
        pill.classList.remove('hidden');
        runClassifyWorkflow();
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }

  async function runClassifyWorkflow() {
    const payload = {
      presetId: document.getElementById('classifyPresetSelect').value || state.classify.presetId,
      imageMeta: state.classify.imageMeta,
      overrides: {
        bodyLengthMm: Number(document.getElementById('clsLengthMm').value),
        bodyWidthMm: Number(document.getElementById('clsWidthMm').value),
        pitchMm: Number(document.getElementById('clsPitchMm').value),
        ratedCurrentA: Number(document.getElementById('clsCurrentA').value)
      }
    };
    const res = await fetch('/api/classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    state.classify.result = data;
    renderClassifyView(data);
  }

  function renderClassifyView(data) {
    document.getElementById('clsPackageTitle').textContent = data.name;
    document.getElementById('clsPackageSubtitle').textContent = `${data.partReference} • ${data.interconnect} • ${data.topology}`;
    document.getElementById('clsConfidenceVal').textContent = `${(data.overallConfidence * 100).toFixed(1)}%`;
    document.getElementById('clsLoopIndVal').textContent = `${data.electrical.estimatedLoopInductanceNh} nH`;
    document.getElementById('clsDatasheetLink').href = data.datasheetUrl;
    document.getElementById('clsPackageDesc').textContent = data.description;

    const drcList = document.getElementById('clsDrcList');
    document.getElementById('drcCountBadge').textContent = `${data.drcFindings.length} items`;
    drcList.innerHTML = data.drcFindings.map((f) => `<li>• <strong>${f.code}:</strong> ${f.message}</li>`).join('');

    const evList = document.getElementById('clsEvidenceList');
    document.getElementById('clsEvidenceCount').textContent = `${data.evidence.length} items`;
    evList.innerHTML = '';
    data.evidence.forEach((ev) => {
      const card = document.createElement('div');
      card.className = 'evidence-card';
      card.innerHTML = `
        <div class="ev-top"><span class="ev-cat">${ev.category}</span><span class="ev-conf">${(ev.confidence * 100).toFixed(0)}% match</span></div>
        <div class="ev-title">${ev.title}</div>
        <div class="ev-metric">${ev.metric}</div>
        <div class="ev-rationale">${ev.rationale}</div>
      `;
      card.addEventListener('mouseenter', () => {
        state.classify.hoveredEvidenceId = ev.id;
        drawFootprintCanvas(data);
      });
      card.addEventListener('mouseleave', () => {
        state.classify.hoveredEvidenceId = null;
        drawFootprintCanvas(data);
      });
      evList.appendChild(card);
    });

    renderClassifyPinTable(data);
    drawFootprintCanvas(data);
  }

  function renderClassifyPinTable(data) {
    const tbody = document.getElementById('classifyPinTableBody');
    tbody.innerHTML = '';
    const verifiedCount = data.pins.filter((p) => state.classify.verifiedPins.has(p.pin)).length;
    document.getElementById('pinVerifyCounter').textContent = `${verifiedCount} / ${data.pins.length} Verified`;

    data.pins.forEach((pin) => {
      const tr = document.createElement('tr');
      if (state.classify.selectedPinNumber === pin.pin) tr.classList.add('selected-row');
      const isVerified = state.classify.verifiedPins.has(pin.pin);
      const color = PIN_COLORS[pin.type] || '#0284c7';
      tr.innerHTML = `
        <td><input type="checkbox" class="pin-verify-cb" ${isVerified ? 'checked' : ''} /></td>
        <td class="mono"><strong>${pin.pin}</strong></td>
        <td class="mono" style="color:${color}; font-weight:700;">${pin.name}</td>
        <td class="mono">${pin.side.toUpperCase()}</td>
        <td><span class="tag-neutral" style="color:${color}; border-color:${color}44;">${pin.type}</span></td>
        <td class="mono">${pin.voltageV} V</td>
        <td class="mono">${pin.currentA} A</td>
        <td>${pin.notes}</td>
      `;
      tr.addEventListener('click', (e) => {
        if (e.target.classList.contains('pin-verify-cb')) return;
        state.classify.selectedPinNumber = state.classify.selectedPinNumber === pin.pin ? null : pin.pin;
        renderClassifyPinTable(data);
        drawFootprintCanvas(data);
      });
      tr.querySelector('.pin-verify-cb').addEventListener('change', (e) => {
        if (e.target.checked) state.classify.verifiedPins.add(pin.pin);
        else state.classify.verifiedPins.delete(pin.pin);
        renderClassifyPinTable(data);
      });
      tbody.appendChild(tr);
    });
  }

  // Clean TI Datasheet Style Light Footprint Drawing
  function drawFootprintCanvas(data) {
    const canvas = document.getElementById('footprintCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Subtle light engineering grid
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 24) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    if (state.classify.uploadedImageElement) {
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.drawImage(state.classify.uploadedImageElement, 60, 20, W - 120, H - 40);
      ctx.restore();
    }

    const pkgW = 230;
    const pkgH = 230;
    const pkgX = (W - pkgW) / 2;
    const pkgY = (H - pkgH) / 2;

    // Package outline
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2;
    ctx.fillRect(pkgX, pkgY, pkgW, pkgH);
    ctx.strokeRect(pkgX, pkgY, pkgW, pkgH);

    // Pin 1 index dot
    ctx.fillStyle = '#cc0000';
    ctx.beginPath();
    ctx.arc(pkgX + 16, pkgY + 16, 4.5, 0, Math.PI * 2);
    ctx.fill();

    // Exposed thermal pad
    if (data.exposedPad && data.exposedPad.present) {
      const epW = 132;
      const epH = 124;
      const epX = (W - epW) / 2;
      const epY = (H - epH) / 2;
      ctx.fillStyle = '#dcfce7';
      ctx.strokeStyle = '#15803d';
      ctx.lineWidth = 1.5;
      ctx.fillRect(epX, epY, epW, epH);
      ctx.strokeRect(epX, epY, epW, epH);

      ctx.fillStyle = '#14532d';
      ctx.font = 'bold 11px SFMono-Regular, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`EPAD (${data.exposedPad.net})`, W / 2, H / 2);
      ctx.font = '10px SFMono-Regular, monospace';
      ctx.fillText(`${data.exposedPad.lengthMm}×${data.exposedPad.widthMm} mm`, W / 2, H / 2 + 14);
    }

    const sides = { left: [], right: [], top: [], bottom: [], grid: [] };
    data.pins.forEach((p) => { if (sides[p.side]) sides[p.side].push(p); });
    const pinCoords = new Map();

    function drawPad(pin, x, y, w, h, lx, ly, align) {
      const color = PIN_COLORS[pin.type] || '#0284c7';
      const sel = state.classify.selectedPinNumber === pin.pin;
      ctx.fillStyle = sel ? '#0f172a' : color;
      ctx.fillRect(x, y, w, h);

      ctx.fillStyle = sel ? '#cc0000' : '#1e293b';
      ctx.font = `${sel ? 'bold ' : ''}10px SFMono-Regular, monospace`;
      ctx.textAlign = align;
      ctx.fillText(`${pin.pin}:${pin.name}`, lx, ly);
      pinCoords.set(pin.pin, { x: x + w / 2, y: y + h / 2 });
    }

    sides.left.forEach((p, i) => {
      const cy = pkgY + ((i + 1) / (sides.left.length + 1)) * pkgH;
      drawPad(p, pkgX - 10, cy - 5, 18, 10, pkgX - 15, cy + 3, 'right');
    });
    sides.right.forEach((p, i) => {
      const cy = pkgY + ((i + 1) / (sides.right.length + 1)) * pkgH;
      drawPad(p, pkgX + pkgW - 8, cy - 5, 18, 10, pkgX + pkgW + 15, cy + 3, 'left');
    });
    sides.bottom.forEach((p, i) => {
      const cx = pkgX + ((i + 1) / (sides.bottom.length + 1)) * pkgW;
      drawPad(p, cx - 5, pkgY + pkgH - 8, 10, 18, cx, pkgY + pkgH + 22, 'center');
    });
    sides.top.forEach((p, i) => {
      const cx = pkgX + ((i + 1) / (sides.top.length + 1)) * pkgW;
      drawPad(p, cx - 5, pkgY - 10, 10, 18, cx, pkgY - 15, 'center');
    });

    if (sides.grid.length > 0) {
      const nGrid = Math.ceil(Math.sqrt(sides.grid.length));
      sides.grid.forEach((p, idx) => {
        const r = Math.floor(idx / nGrid);
        const c = idx % nGrid;
        const gx = pkgX + ((c + 1) / (nGrid + 1)) * pkgW;
        const gy = pkgY + ((r + 1) / (nGrid + 1)) * pkgH;
        ctx.fillStyle = PIN_COLORS[p.type] || '#0284c7';
        ctx.beginPath();
        ctx.arc(gx, gy, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(p.pin, gx, gy + 3);
      });
    }

    // High-di/dt Switching Loop
    if (document.getElementById('toggleHotLoop').checked) {
      const vin = data.pins.find((p) => p.type === 'POWER_IN');
      const sw = data.pins.find((p) => p.type === 'SWITCH');
      const gnd = data.pins.find((p) => p.type === 'GND_PWR');
      if (vin && sw && gnd && pinCoords.get(vin.pin) && pinCoords.get(sw.pin) && pinCoords.get(gnd.pin)) {
        const p1 = pinCoords.get(vin.pin), p2 = pinCoords.get(sw.pin), p3 = pinCoords.get(gnd.pin);
        ctx.save();
        ctx.strokeStyle = '#cc0000';
        ctx.fillStyle = 'rgba(204, 0, 0, 0.08)';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    // Evidence Bounding Boxes
    if (document.getElementById('toggleEvidenceBoxes').checked) {
      data.evidence.forEach((ev) => {
        const isHov = state.classify.hoveredEvidenceId === ev.id;
        ctx.save();
        ctx.strokeStyle = isHov ? '#cc0000' : 'rgba(100, 116, 139, 0.45)';
        ctx.lineWidth = isHov ? 2.2 : 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(pkgX + ev.bbox.x * pkgW, pkgY + ev.bbox.y * pkgH, ev.bbox.w * pkgW, ev.bbox.h * pkgH);
        ctx.restore();
      });
    }
  }

  function bindSelectEvents() {
    document.getElementById('btnRunSelect').addEventListener('click', runSelectWorkflow);
    ['selTopology', 'selInterconnect', 'selIncludeFallback'].forEach((id) => {
      document.getElementById(id).addEventListener('change', runSelectWorkflow);
    });
  }

  async function runSelectWorkflow() {
    const payload = {
      topology: document.getElementById('selTopology').value,
      interconnect: document.getElementById('selInterconnect').value,
      currentA: Number(document.getElementById('selCurrentA').value),
      pinCount: Number(document.getElementById('selPinCount').value),
      lengthMm: Number(document.getElementById('selLengthMm').value),
      widthMm: Number(document.getElementById('selWidthMm').value),
      pitchMm: Number(document.getElementById('selPitchMm').value),
      includeFallbackCandidates: document.getElementById('selIncludeFallback').checked
    };
    const res = await fetch('/api/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    state.select.result = data;

    document.getElementById('selFilterStatusText').textContent =
      `Filter Mode: ${data.filterMode.replace(/_/g, ' ')} • Priority: 54% Current + Pinout`;
    document.getElementById('selPoolBadge').textContent = `${data.matchedPoolSize} of ${data.totalCatalogSize} layouts`;

    document.getElementById('selectCardsContainer').innerHTML = data.recommendations.map((rec, i) => `
      <div class="candidate-card">
        <div class="cand-top">
          <div>
            <span class="cand-rank">#${i + 1} • ${rec.id}</span>
            <h4 style="margin-top:6px; font-size:15px; color:#0f172a;">${rec.name}</h4>
            <div class="card-subtitle">${rec.partNumber} • ${rec.organization}</div>
          </div>
          <div class="cand-score">${rec.matchScore.toFixed(1)}%</div>
        </div>
        <div class="cand-specs">
          <div class="spec-cell"><span class="spec-lbl">Current</span><span class="spec-val">${rec.currentA} A</span></div>
          <div class="spec-cell"><span class="spec-lbl">Package</span><span class="spec-val">${rec.packageCode}</span></div>
          <div class="spec-cell"><span class="spec-lbl">Size</span><span class="spec-val">${rec.lengthMm}×${rec.widthMm}mm</span></div>
          <div class="spec-cell"><span class="spec-lbl">Stackup</span><span class="spec-val">${rec.pcbLayers}L ${rec.copperWeightOz}oz</span></div>
        </div>
        <ul class="cand-adaptations">${rec.adaptations.map((a) => `<li>• ${a}</li>`).join('')}</ul>
      </div>
    `).join('');

    document.getElementById('selectMatrixBody').innerHTML = data.recommendations.map((rec, i) => {
      const geom = (rec.weightedContributions.area + rec.weightedContributions.pitch + rec.weightedContributions.geometry).toFixed(3);
      return `
        <tr>
          <td class="mono"><strong>#${i + 1}</strong></td>
          <td><strong>${rec.id}</strong> (${rec.partNumber})</td>
          <td>${rec.topology} • ${rec.interconnect}</td>
          <td class="mono">${rec.currentA} A</td>
          <td class="mono">${rec.pinCount}p (${rec.pitchMm}mm)</td>
          <td class="mono">${rec.lengthMm}×${rec.widthMm} mm</td>
          <td class="mono">${rec.weightedContributions.current.toFixed(3)}</td>
          <td class="mono">${rec.weightedContributions.pinCount.toFixed(3)}</td>
          <td class="mono">${geom}</td>
          <td class="mono"><span class="tag-success">${rec.matchScore.toFixed(1)}%</span></td>
        </tr>
      `;
    }).join('');
  }

  function bindSizeEvents() {
    document.getElementById('sizeFamilySelect').addEventListener('change', (e) => {
      state.size.familyId = e.target.value;
      state.size.customSamples = [];
      runSizeWorkflow();
    });
    document.getElementById('sizeSolverMode').addEventListener('change', (e) => {
      const isArea = e.target.value === 'areaToCurrent';
      document.getElementById('sizeCurrentInputGroup').classList.toggle('hidden', isArea);
      document.getElementById('sizeAreaInputGroup').classList.toggle('hidden', !isArea);
      runSizeWorkflow();
    });
    const currSlider = document.getElementById('sizeCurrentSlider');
    const currInput = document.getElementById('sizeTargetCurrentA');
    currSlider.addEventListener('input', () => { currInput.value = currSlider.value; runSizeWorkflow(); });
    currInput.addEventListener('change', () => { currSlider.value = currInput.value; runSizeWorkflow(); });
    document.getElementById('btnRunSize').addEventListener('click', runSizeWorkflow);
    document.getElementById('btnPlotLinear').addEventListener('click', () => {
      state.size.plotScale = 'linear';
      document.getElementById('btnPlotLinear').classList.add('active');
      document.getElementById('btnPlotLog').classList.remove('active');
      if (state.size.result) drawSizingCurveCanvas(state.size.result);
    });
    document.getElementById('btnPlotLog').addEventListener('click', () => {
      state.size.plotScale = 'log';
      document.getElementById('btnPlotLog').classList.add('active');
      document.getElementById('btnPlotLinear').classList.remove('active');
      if (state.size.result) drawSizingCurveCanvas(state.size.result);
    });
    document.getElementById('btnAddCalibration').addEventListener('click', () => {
      const areaMm2 = Number(document.getElementById('calAreaMm2').value);
      const currentA = Number(document.getElementById('calCurrentA').value);
      if (areaMm2 > 0 && currentA > 0) {
        state.size.customSamples.push({ project: `CAL-${state.size.customSamples.length + 1}`, pkg: 'Custom', areaMm2, currentA });
        runSizeWorkflow();
      }
    });
    document.getElementById('btnResetCalibration').addEventListener('click', () => {
      state.size.customSamples = [];
      runSizeWorkflow();
    });
  }

  async function runSizeWorkflow() {
    const payload = {
      familyId: document.getElementById('sizeFamilySelect').value || state.size.familyId,
      mode: document.getElementById('sizeSolverMode').value,
      targetCurrentA: Number(document.getElementById('sizeTargetCurrentA').value),
      targetAreaMm2: Number(document.getElementById('sizeTargetAreaMm2').value),
      aspectRatio: Number(document.getElementById('sizeAspectRatio').value),
      ambientTempC: Number(document.getElementById('sizeAmbientC').value),
      customSamples: state.size.customSamples
    };
    const res = await fetch('/api/size', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    state.size.result = data;
    const { regression, estimate } = data;

    document.getElementById('sizeFormulaVal').textContent = regression.formulaText;
    document.getElementById('sizeR2Val').textContent = `R² = ${regression.rSquared.toFixed(4)} (${regression.sampleCount} reference dies)`;
    document.getElementById('sizeTotalAreaVal').textContent = `${estimate.totalDieAreaMm2.toFixed(2)} mm² (${estimate.dieLengthMm}×${estimate.dieWidthMm} mm)`;
    document.getElementById('sizeActiveBreakdownVal').textContent = `Active FET: ${estimate.activeFetAreaMm2.toFixed(2)} mm² | Pad Ring: ${estimate.padRingOverheadMm2.toFixed(2)} mm²`;
    document.getElementById('sizeRonVal').textContent = `${estimate.estimatedRonMohm.toFixed(2)} mΩ @ ${estimate.targetCurrentA} A`;
    document.getElementById('sizePowerLossVal').textContent = `Est. Power Loss: ${estimate.totalPowerLossW.toFixed(2)} W`;
    document.getElementById('sizeTjVal').textContent = `T_j = ${estimate.estimatedTjC.toFixed(1)} °C (Max ${estimate.maxTjC} °C)`;
    document.getElementById('sizeGdpwVal').textContent = `${estimate.grossDiePerWafer.toLocaleString()} dies / ${estimate.waferDiameterMm}mm wafer`;
    document.getElementById('sizeProcessSubtitle').textContent = `${data.familyName} • ${data.processNode}`;

    document.getElementById('sizeSamplesTableBody').innerHTML = regression.samplesWithFit.map((s) => `
      <tr>
        <td><strong>${s.project}</strong></td>
        <td class="mono">${s.pkg || 'Ref'}</td>
        <td class="mono">${Number(s.areaMm2).toFixed(2)}</td>
        <td class="mono">${Number(s.currentA).toFixed(1)} A</td>
        <td class="mono">${s.predictedCurrentA.toFixed(2)} A</td>
        <td class="mono">${s.errorPct >= 0 ? '+' : ''}${s.errorPct.toFixed(1)}%</td>
      </tr>
    `).join('');

    document.getElementById('sizeCrossFamilyBody').innerHTML = data.crossFamilyComparison.map((cf) => `
      <tr>
        <td><strong>${cf.name.split('(')[0]}</strong></td>
        <td class="mono">${cf.voltageClassV} V</td>
        <td class="mono">${cf.b.toFixed(3)}</td>
        <td class="mono"><strong>${cf.requiredAreaMm2.toFixed(2)} mm²</strong></td>
        <td class="mono">${cf.estimatedRonMohm.toFixed(2)} mΩ</td>
        <td class="mono">${cf.gdpw.toLocaleString()}</td>
      </tr>
    `).join('');

    drawSizingCurveCanvas(data);
    drawDieFloorplanCanvas(data);
  }

  function drawSizingCurveCanvas(data) {
    const canvas = document.getElementById('sizingCurveCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const padL = 52, padR = 24, padT = 24, padB = 38;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const isLog = state.size.plotScale === 'log';
    const tx = (a) => (isLog ? Math.log10(Math.max(0.1, a)) : a);
    const ty = (c) => (isLog ? Math.log10(Math.max(0.1, c)) : c);

    const pts = data.curvePoints;
    const minX = isLog ? Math.min(...pts.map((p) => tx(p.areaMm2))) : 0;
    const maxX = Math.max(...pts.map((p) => tx(p.areaMm2)));
    const minY = isLog ? Math.min(...pts.map((p) => ty(p.lowerBandA))) : 0;
    const maxY = Math.max(...pts.map((p) => ty(p.upperBandA))) * 1.06;

    const toX = (a) => padL + ((tx(a) - minX) / Math.max(1e-6, maxX - minX)) * plotW;
    const toY = (c) => padT + plotH - ((ty(c) - minY) / Math.max(1e-6, maxY - minY)) * plotH;

    // Clean light grid lines
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const gy = padT + (i / 4) * plotH;
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + plotW, gy); ctx.stroke();
      const gx = padL + (i / 4) * plotW;
      ctx.beginPath(); ctx.moveTo(gx, padT); ctx.lineTo(gx, padT + plotH); ctx.stroke();
    }

    // Fitted curve (TI Red)
    ctx.strokeStyle = '#cc0000';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    pts.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(toX(p.areaMm2), toY(p.currentA));
      else ctx.lineTo(toX(p.areaMm2), toY(p.currentA));
    });
    ctx.stroke();

    // Empirical sample points
    data.regression.samplesWithFit.forEach((s) => {
      const sx = toX(s.areaMm2), sy = toY(s.currentA);
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#475569';
      ctx.font = '10px SFMono-Regular, monospace';
      ctx.fillText(s.project.split('-')[0], sx + 6, sy - 4);
    });

    // Target Point
    const est = data.estimate;
    const txPx = toX(est.totalDieAreaMm2), tyPx = toY(est.targetCurrentA);
    ctx.fillStyle = '#15803d';
    ctx.beginPath();
    ctx.arc(txPx, tyPx, 6.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 11px SFMono-Regular, monospace';
    ctx.fillText(`Target: ${est.targetCurrentA}A → ${est.totalDieAreaMm2.toFixed(2)} mm²`, Math.min(W - 190, txPx + 8), Math.max(24, tyPx - 8));

    ctx.fillStyle = '#475569';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(isLog ? 'log10(Die Area [mm²])' : 'Die Area (mm²)', padL + plotW / 2, H - 10);
  }

  function drawDieFloorplanCanvas(data) {
    const canvas = document.getElementById('dieFloorplanCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const est = data.estimate;

    const dx = 65, dy = 35, dw = 170, dh = 170;
    ctx.fillStyle = '#f1f5f9';
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2;
    ctx.fillRect(dx, dy, dw, dh);
    ctx.strokeRect(dx, dy, dw, dh);

    ctx.fillStyle = '#fef2f2';
    ctx.strokeStyle = '#cc0000';
    ctx.lineWidth = 1.5;
    ctx.fillRect(dx + 18, dy + 18, dw - 36, dh - 36);
    ctx.strokeRect(dx + 18, dy + 18, dw - 36, dh - 36);

    ctx.fillStyle = '#991b1b';
    ctx.font = 'bold 11px SFMono-Regular, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`Active FET (${est.activeAreaPct}%)`, W / 2, dy + dh / 2);
    ctx.fillStyle = '#0f172a';
    ctx.fillText(`${est.dieLengthMm} × ${est.dieWidthMm} mm (${est.totalDieAreaMm2.toFixed(2)} mm²)`, W / 2, dy + dh + 30);
    ctx.fillStyle = '#475569';
    ctx.fillText(`R_DS(on): ${est.estimatedRonMohm} mΩ | T_j: ${est.estimatedTjC}°C`, W / 2, dy + dh + 50);
  }

  function bindGlobalActions() {
    document.getElementById('btnSyncPipeline').addEventListener('click', async () => {
      const cls = state.classify.result;
      if (!cls) return;
      document.getElementById('selTopology').value = cls.topology;
      document.getElementById('selInterconnect').value = cls.interconnect;
      document.getElementById('selCurrentA').value = cls.electrical.ratedCurrentA;
      document.getElementById('selPinCount').value = cls.dimensions.pinCount;
      document.getElementById('sizeTargetCurrentA').value = cls.electrical.ratedCurrentA;
      await Promise.all([runSelectWorkflow(), runSizeWorkflow()]);
      document.getElementById('apiStatusBadge').textContent = `Synced ${cls.packageFamily}`;
    });

    document.getElementById('btnExportDossier').addEventListener('click', async () => {
      const res = await fetch('/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const report = await res.json();
      state.lastDossierMarkdown = report.markdown;
      document.getElementById('dossierMarkdownPreview').textContent = report.markdown;
      document.getElementById('dossierModal').classList.remove('hidden');
    });

    document.getElementById('btnCloseModal').addEventListener('click', () => {
      document.getElementById('dossierModal').classList.add('hidden');
    });
    document.getElementById('btnDownloadMarkdown').addEventListener('click', () => {
      if (state.lastDossierMarkdown) downloadTextFile('pinscope-signoff-dossier.md', state.lastDossierMarkdown, 'text/markdown');
    });
  }

  function downloadTextFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  window.addEventListener('DOMContentLoaded', init);
})();
