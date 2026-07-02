/**
 * GPU Monitor for AI Workloads — Dashboard Renderer
 * Unified multi-source GPU telemetry dashboard.
 */

console.log('[Renderer] GPU Monitor loading...');

let sources = [];
let refreshInterval = 2000;
let pollTimer = null;
let pollCount = 0;
let activeFilter = 'all';
let gpuOrder = [];       // persistent card order (array of unique gpu keys)
let dragState = null;    // { el, index, startY, sourceId, gpuIndex }

// DOM elements
const elGpuContainer = document.getElementById('gpu-container');
const elStatus = document.getElementById('connection-status');
const elLastUpdate = document.getElementById('last-update');
const elPollCount = document.getElementById('poll-count');
const elSettingsModal = document.getElementById('settings-modal');
const elNoData = document.getElementById('no-data');

// Button listeners
document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('btn-cancel-settings').addEventListener('click', closeSettings);
document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
document.getElementById('btn-test-connection').addEventListener('click', testConnection);
document.getElementById('btn-add-source').addEventListener('click', addSourceEntry);
document.getElementById('btn-minimize').addEventListener('click', minimizeWindow);
document.getElementById('btn-close').addEventListener('click', closeWindow);

// Filter buttons — static "All" + dynamic per-source
document.getElementById('filter-all').addEventListener('click', () => {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('filter-all').classList.add('active');
  activeFilter = 'all';
  renderDashboard();
});

function renderSourceFilters() {
  const container = document.getElementById('filter-buttons');
  if (!container) return;
  container.innerHTML = '';
  const enabledSources = sources.sources.filter(s => s.enabled);
  // Group by display name
  const nameMap = {};
  enabledSources.forEach(s => {
    const key = s.name || s.type || s.id;
    if (!nameMap[key]) nameMap[key] = key;
  });
  Object.values(nameMap).forEach(name => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.dataset.filter = name;
    btn.textContent = name;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = name;
      renderDashboard();
    });
    container.appendChild(btn);
  });
}

// Tab buttons
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// Electron IPC
if (window.electronAPI) {
  window.electronAPI.onOpenSettings?.(() => openSettings());
  // Live always-on-top toggle
  document.getElementById('always-on-top-check')?.addEventListener('change', (e) => {
    window.electronAPI.setAlwaysOnTop(e.target.checked);
  });
}

// ====== Settings ======

async function loadSources() {
  try {
    if (window.electronAPI) {
      sources = await window.electronAPI.loadSources();
    }
    // Ensure sources.sources is always an array
    if (!sources?.sources || !Array.isArray(sources.sources)) {
      sources = {
        sources: [
          { id: 'ai-pc', name: 'AI PC', type: 'rocm', host: '', port: 5900, enabled: false },
          { id: 'desktop-4090', name: 'Local NVIDIA', type: 'nvidia', local: true, enabled: true },
        ],
        refreshInterval: 2000,
      };
    }
    // Load persisted card order
    try {
      const savedOrder = localStorage.getItem('gpu-card-order');
      if (savedOrder) gpuOrder = JSON.parse(savedOrder);
    } catch {}

    refreshInterval = sources.refreshInterval || 2000;
    console.log('Sources loaded:', sources);
    renderSourceFilters();
    startPolling();
  } catch (err) {
    console.error('Failed to load sources:', err);
    sources = {
      sources: [
        { id: 'ai-pc', name: 'AI PC', type: 'rocm', host: '', port: 5900, enabled: false },
        { id: 'local-nvidia', name: 'Local NVIDIA', type: 'nvidia', local: true, enabled: true },
      ],
      refreshInterval: 2000,
    };
    renderSourceFilters();
    startPolling();
  }
}

async function openSettings() {
  renderSourceEntries();
  document.getElementById('refresh-interval').value = (refreshInterval / 1000) || 2;
  document.getElementById('settings-message').textContent = '';
  // Load current always-on-top state
  if (window.electronAPI) {
    try {
      const aot = await window.electronAPI.getAlwaysOnTop();
      document.getElementById('always-on-top-check').checked = aot;
    } catch {}
  }
  elSettingsModal.classList.remove('hidden');
}

function closeSettings() {
  elSettingsModal.classList.add('hidden');
}

function renderSourceEntries() {
  const list = document.getElementById('sources-list');
  list.innerHTML = sources.sources.map((src, idx) => `
    <div class="source-entry" data-index="${idx}">
      <div class="source-entry-header">
        <strong>${src.name || 'Untitled'}</strong>
        <div style="display:flex;gap:4px;align-items:center;">
          <select class="source-type-select" data-index="${idx}">
            <option value="rocm" ${src.type === 'rocm' ? 'selected' : ''}>HTTP (ROCm)</option>
            <option value="nvidia" ${src.type === 'nvidia' ? 'selected' : ''}>NVIDIA (Local)</option>
            <option value="xpu" ${src.type === 'xpu' ? 'selected' : ''}>HTTP (Intel XPU)</option>
          </select>
          <button class="btn btn-secondary" onclick="removeSourceEntry(${idx})" style="padding:3px 8px;font-size:0.75rem;" title="Remove source">✕</button>
        </div>
      </div>
      <div class="source-entry-fields">
        <div class="form-group">
          <label>Name</label>
          <input type="text" value="${escapeHtml(src.name || '')}" placeholder="e.g. AI PC" data-field="name" data-index="${idx}">
        </div>
        ${src.local ? '' : `
        <div class="form-group">
          <label>Host</label>
          <input type="text" value="${escapeHtml(src.host || '')}" placeholder="192.168.x.x" data-field="host" data-index="${idx}">
        </div>
        <div class="form-group">
          <label>Port</label>
          <input type="number" value="${src.port || 5900}" placeholder="5900" data-field="port" data-index="${idx}">
        </div>`}
      </div>
      <div class="source-entry-toggle">
        <input type="checkbox" ${src.enabled !== false ? 'checked' : ''} data-field="enabled" data-index="${idx}">
        <span>Enabled</span>
      </div>
    </div>
  `).join('');

  // Add event listeners for change events
  list.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('change', () => {}); // handled in saveSettings via querySelectorAll
  });

  // Add reorder buttons to source entries
  list.querySelectorAll('.source-entry-header strong').forEach(label => {
    if (!label.querySelector('.reorder-handle')) {
      const handle = document.createElement('span');
      handle.className = 'reorder-handle';
      handle.textContent = '⠿';
      handle.title = 'Drag to reorder source';
      handle.style.cursor = 'grab';
      handle.style.marginRight = '8px';
      label.insertBefore(handle, label.firstChild);
    }
  });
}

function addSourceEntry() {
  sources.sources.push({
    id: 'source-' + Date.now(),
    name: 'New Source',
    type: 'rocm',
    host: '',
    port: 5900,
    enabled: true,
  });
  renderSourceEntries();
  // Focus the name field of the new entry
  setTimeout(() => {
    const entries = document.querySelectorAll('.source-entry');
    const lastEntry = entries[entries.length - 1];
    if (lastEntry) {
      const nameInput = lastEntry.querySelector('[data-field="name"]');
      if (nameInput) { nameInput.focus(); nameInput.select(); }
    }
  }, 50);
}

function removeSourceEntry(idx) {
  sources.sources.splice(idx, 1);
  renderSourceEntries();
}

async function saveSettings() {
  // Collect values from DOM
  document.querySelectorAll('.source-entry').forEach(entry => {
    const idx = entry.dataset.index;
    sources.sources[idx].name = entry.querySelector('[data-field="name"]')?.value || 'Untitled';
    sources.sources[idx].type = entry.querySelector('.source-type-select')?.value || 'rocm';
    sources.sources[idx].enabled = entry.querySelector('[data-field="enabled"]')?.checked !== false;

    if (sources.sources[idx].type === 'rocm' || sources.sources[idx].type === 'xpu') {
      sources.sources[idx].host = entry.querySelector('[data-field="host"]')?.value || '';
      sources.sources[idx].port = parseInt(entry.querySelector('[data-field="port"]')?.value) || 5900;
    }
  });

  sources.refreshInterval = (parseInt(document.getElementById('refresh-interval').value) || 2) * 1000;
  refreshInterval = sources.refreshInterval;

  // Handle always-on-top toggle
  const aotCheck = document.getElementById('always-on-top-check');
  if (aotCheck && window.electronAPI) {
    window.electronAPI.setAlwaysOnTop(aotCheck.checked);
  }

  if (window.electronAPI) {
    await window.electronAPI.saveSources(sources);
  }

  closeSettings();
  renderSourceFilters();
  startPolling();
}

async function testConnection() {
  const msgEl = document.getElementById('settings-message');
  const activeTab = document.querySelector('.tab-content.active');

  if (activeTab.id === 'tab-general') {
    msgEl.textContent = 'Test connection from the Sources tab.';
    msgEl.style.color = '#fbbf24';
    return;
  }

  // Find first enabled ROCm source
  const rocmSource = sources.sources.find(s => s.type === 'rocm' && s.enabled && s.host);
  const xpuSource = sources.sources.find(s => s.type === 'xpu' && s.enabled && s.host);
  const targetSource = rocmSource || xpuSource;
  if (!targetSource) {
    msgEl.textContent = 'No ROCm/XPU source configured.';
    msgEl.style.color = '#f87171';
    return;
  }

  msgEl.textContent = 'Testing connection...';
  msgEl.style.color = '#fbbf24';

  try {
    const resp = await fetch(`http://${targetSource.host}:${targetSource.port}/health`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      msgEl.textContent = `✓ Connected to ${targetSource.name}!`;
      msgEl.style.color = '#4ade80';
    } else {
      msgEl.textContent = `✗ HTTP ${resp.status}`;
      msgEl.style.color = '#f87171';
    }
  } catch (err) {
    msgEl.textContent = `✗ Failed: ${err.message}`;
    msgEl.style.color = '#f87171';
  }
}

// ====== Data Fetching ======

async function fetchAllSources() {
  const enabledSources = sources.sources.filter(s => s.enabled);
  if (enabledSources.length === 0) return [];

  // Fetch all sources in parallel
  const promises = enabledSources.map(async (src) => {
    if (src.type === 'rocm') {
      return fetchROCM(src);
    } else if (src.type === 'nvidia') {
      return fetchNVIDIA(src);
    } else if (src.type === 'xpu') {
      return fetchXPU(src);
    }
    return { sourceId: src.id, sourceName: src.name, error: 'Unknown type' };
  });

  return Promise.all(promises);
}

async function fetchROCM(source) {
  try {
    const url = `http://${source.host}:${source.port}/api/rocm`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    return {
      sourceId: source.id,
      sourceName: source.name,
      sourceType: 'rocm',
      gpus: (data.gpus || []).map((gpu, idx) => ({
        gpu: idx,
        name: `${source.name} - ${gpu.name || 'GPU ' + idx}`,
        temperature: gpu.temperature || 0,
        hotspot_temp: gpu.hotspot_temp || null,
        mem_temp: gpu.mem_temp || null,
        memory_used: gpu.memory_used || 0,
        memory_total: gpu.memory_total || 0,
        memory_free: gpu.memory_free || 0,
        memory_percent: gpu.vram_percent || 0,
        power_draw: gpu.power_draw || 0,
        power_limit: 0,
        fan_speed: gpu.fan_pct != null ? gpu.fan_pct : (gpu.fan_speed > 0 ? Math.round((gpu.fan_speed / 255) * 100) : 0),
        fan_rpm: gpu.fan_rpm || 0,
        utilization: gpu.gpu_use || 0,
        clock_gr: gpu.sclk || 'N/A',
        clock_mem: gpu.mclk || 'N/A',
      })),
      timestamp: data.timestamp || new Date().toISOString(),
    };
  } catch (err) {
    return { sourceId: source.id, sourceName: source.name, error: err.message };
  }
}

async function fetchNVIDIA(source) {
  try {
    const data = await window.electronAPI.runNvidiaSmi();
    if (data.error) throw new Error(data.error);

    const memUsed = parseMemoryStr(data.memory_used);
    const memTotal = parseMemoryStr(data.memory_total);

    return {
      sourceId: source.id,
      sourceName: source.name,
      sourceType: 'nvidia',
      gpus: [{
        gpu: 0,
        name: data.name || 'NVIDIA GPU',
        model: data.name || 'NVIDIA GPU',
        temperature: data.temperature || 0,
        memory_used: memUsed,
        memory_total: memTotal,
        memory_percent: memTotal > 0 ? (memUsed / memTotal * 100) : 0,
        power_draw: data.power_draw || 0,
        power_limit: data.power_limit || 0,
        clock_gr: data.clock_gr || 'N/A',
        clock_mem: data.clock_mem || 'N/A',
        utilization: data.utilization || 0,
        fan_speed: data.fan_speed || 0,
        driver_version: data.driver_version || '',
      }],
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return { sourceId: source.id, sourceName: source.name, error: err.message };
  }
}

async function fetchXPU(source) {
  try {
    const url = `http://${source.host}:${source.port}/api/xpu`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    return {
      sourceId: source.id,
      sourceName: source.name,
      sourceType: 'xpu',
      gpus: (data.gpus || []).map((gpu, idx) => ({
        gpu: idx,
        name: `${source.name} - ${gpu.name || 'Intel GPU ' + idx}`,
        temperature: gpu.temperature || 0,
        hotspot_temp: null,
        mem_temp: gpu.mem_temp || null,
        memory_used: gpu.memory_used || 0,
        memory_total: gpu.memory_total || 0,
        memory_free: gpu.memory_free || 0,
        memory_percent: gpu.vram_percent || 0,
        power_draw: gpu.power_draw || 0,
        power_limit: gpu.power_limit || 0,
        fan_speed: gpu.fan_speed || 0,
        fan_rpm: gpu.fan_rpm || 0,
        utilization: gpu.gpu_use || 0,
        clock_gr: gpu.sclk || 'N/A',
        clock_mem: gpu.mclk || 'N/A',
        // Intel-specific fields
        eu_active: gpu.eu_active || null,
        eu_stall: gpu.eu_stall || null,
        eu_idle: gpu.eu_idle || null,
        pcie_tx: gpu.pcie_tx || 0,
        pcie_rx: gpu.pcie_rx || 0,
        mem_read_bw: gpu.mem_read_bw || 0,
        mem_write_bw: gpu.mem_write_bw || 0,
        serial: gpu.serial || '',
        driver_version: gpu.driver_version || '',
      })),
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return { sourceId: source.id, sourceName: source.name, error: err.message };
  }
}

function parseMemoryStr(str) {
  if (!str) return 0;
  const num = parseFloat(String(str).replace(/[^0-9.]/g, ''));
  return isNaN(num) ? 0 : num;
}

// ====== Dashboard Rendering ======

/** Generate a unique key for each GPU card to track order across polls */
function gpuKey(sourceId, gpuIndex) {
  return `${sourceId}-gpu${gpuIndex}`;
}

async function pollAll() {
  try {
    elStatus.className = 'status-badge connecting';
    elStatus.textContent = 'Updating...';

    console.log('Polling sources:', sources.sources?.map(s => `${s.name} (${s.type})`));

    const results = await fetchAllSources();
    console.log('Poll results:', results);

    // Flatten all GPUs with source info
    let allGpus = [];
    let hasError = false;

    for (const result of results) {
      if (result.error) {
        hasError = true;
        console.warn(`[${result.sourceName}] ${result.error}`);
      }
      if (result.gpus && result.gpus.length > 0) {
        allGpus.push(...result.gpus.map((gpu, idx) => ({
          ...gpu,
          sourceId: result.sourceId,
          sourceName: result.sourceName,
          sourceType: result.sourceType,
          _cardKey: gpuKey(result.sourceId, idx),
        })));
      }
    }

    pollCount++;

    if (allGpus.length === 0) {
      elStatus.className = hasError ? 'status-badge disconnected' : 'status-badge connecting';
      elStatus.textContent = hasError ? 'Error' : 'Connecting...';
    } else {
      elStatus.className = 'status-badge connected';
      elStatus.textContent = `${allGpus.length} GPU${allGpus.length > 1 ? 's' : ''}`;
    }

    renderDashboard(allGpus);
    elLastUpdate.textContent = `Last update: ${new Date().toLocaleTimeString()}`;
    elPollCount.textContent = `Polls: ${pollCount}`;

  } catch (err) {
    elStatus.className = 'status-badge disconnected';
    elStatus.textContent = `Error: ${err.message}`;
    console.error('Poll failed:', err);
  }
}

function renderDashboard(allGpus) {
  if (!allGpus || allGpus.length === 0) {
    elGpuContainer.innerHTML = '';
    elNoData.classList.remove('hidden');
    return;
  }

  elNoData.classList.add('hidden');

  // Apply filter
  const filtered = activeFilter === 'all'
    ? allGpus
    : allGpus.filter(g => g.sourceId === activeFilter);

  if (filtered.length === 0) {
    elGpuContainer.innerHTML = '';
    elNoData.classList.remove('hidden');
    elNoData.querySelector('p').textContent = `No GPUs from ${activeFilter}`;
    return;
  }

  elNoData.classList.add('hidden');

  // Build a map of current GPU keys for order persistence
  const currentKeys = new Set(filtered.map(g => g._cardKey));

  // Update gpuOrder: keep existing order, add new cards at end, remove stale cards
  gpuOrder = [
    ...gpuOrder.filter(k => currentKeys.has(k)),
    ...filtered.filter(g => !gpuOrder.includes(g._cardKey)).map(g => g._cardKey),
  ];

  // Persist order
  try { localStorage.setItem('gpu-card-order', JSON.stringify(gpuOrder)); } catch {}

  // Sort filtered GPUs by persisted order
  const orderIndex = {};
  gpuOrder.forEach((key, i) => { orderIndex[key] = i; });
  filtered.sort((a, b) => {
    const ia = orderIndex[a._cardKey] ?? Infinity;
    const ib = orderIndex[b._cardKey] ?? Infinity;
    return ia - ib;
  });

  elGpuContainer.innerHTML = filtered.map((gpu, displayIdx) => {
    const temp = parseFloat(gpu.temperature) || 0;
    const memUsed = gpu.memory_used || 0;
    const memTotal = gpu.memory_total || 0;
    const memPercent = memTotal > 0 ? (memUsed / memTotal * 100) : 0;
    const power = parseFloat(gpu.power_draw) || 0;
    const fan = parseFloat(gpu.fan_speed) || 0;
    const util = parseFloat(gpu.utilization) || parseFloat(gpu.gpu_use) || 0;

    // Source class for accent colour
    const sourceClass = gpu.sourceType === 'rocm' ? 'source-rocm' : gpu.sourceType === 'xpu' ? 'source-xpu' : 'source-nvidia';

    return `
      <div class="gpu-card ${sourceClass}" data-card-key="${gpu._cardKey}">
        <!-- Drag handle -->
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        <h2>
          <span>${gpu.name || gpu.model || 'GPU ' + (gpu.gpu ?? 0)}</span>
          <span class="gpu-source-tag">${escapeHtml(gpu.sourceName)}</span>
        </h2>

        <!-- Temperature -->
        <div class="metric-row">
          <span class="metric-label">Temperature</span>
          <span class="metric-value ${temp > 85 ? 'danger' : temp > 70 ? 'warning' : ''}">
            ${temp.toFixed(1)}°C
            ${gpu.hotspot_temp != null && gpu.hotspot_temp !== undefined ? ` (Hot: ${gpu.hotspot_temp}°C)` : ''}
            ${gpu.mem_temp != null && gpu.mem_temp !== undefined ? ` (Mem: ${gpu.mem_temp}°C)` : ''}
          </span>
        </div>

        <!-- VRAM -->
        <div class="metric-row" style="flex-direction: column; align-items: stretch;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span class="metric-label">VRAM</span>
            <span class="metric-value">${memUsed.toFixed(0)} / ${memTotal.toFixed(0)} MB (${memPercent.toFixed(1)}%)</span>
          </div>
          <div class="progress-bar">
            <div class="progress-bar-fill ${memPercent > 90 ? 'red' : memPercent > 70 ? 'yellow' : 'green'}"
                 style="width: ${Math.min(memPercent, 100)}%"></div>
          </div>
        </div>

        <!-- Power -->
        <div class="metric-row">
          <span class="metric-label">Power Draw</span>
          <span class="metric-value ${power > 300 ? 'warning' : ''}">
            ${power.toFixed(1)} W${gpu.power_limit ? ` / ${gpu.power_limit.toFixed(0)} W` : ''}
          </span>
        </div>

        <!-- Fan -->
        <div class="metric-row">
          <span class="metric-label">Fan Speed</span>
          <span class="metric-value">
            ${fan > 0 ? fan.toFixed(0) + '%' : 'N/A'}
            ${gpu.fan_rpm > 0 ? ` (${gpu.fan_rpm} RPM)` : ''}
          </span>
        </div>

        <!-- Intel EU Array (Intel-specific) -->
        ${gpu.eu_active != null && gpu.eu_active !== undefined ? `
        <div class="metric-row">
          <span class="metric-label">EU Active</span>
          <span class="metric-value">${parseFloat(gpu.eu_active).toFixed(1)}%</span>
        </div>` : ''}

        <!-- Clock -->
        <div class="metric-row">
          <span class="metric-label">Clock</span>
          <span class="metric-value">${gpu.clock_gr || gpu.CLK || gpu.sclk || 'N/A'}</span>
        </div>

        <!-- Utilization -->
        <div class="metric-row">
          <span class="metric-label">Utilization</span>
          <span class="metric-value ${util > 90 ? 'warning' : ''}">
            ${util.toFixed(0)}%
          </span>
        </div>

        <!-- Driver (NVIDIA only) -->
        ${gpu.driver_version ? `
        <div class="metric-row">
          <span class="metric-label">Driver</span>
          <span class="metric-value" style="font-size: 0.85rem;">v${escapeHtml(gpu.driver_version)}</span>
        </div>` : ''}
      </div>`;
  }).join('');

  // Re-attach drag events on newly created cards
  attachDragEvents();

  // Re-apply reorder mode state to new cards
  elGpuContainer.querySelectorAll('.gpu-card').forEach(card => {
    card.draggable = reorderMode;
    card.style.opacity = reorderMode ? '0.85' : '1';
  });
}

// ====== Drag & Drop (handle-based) ======

function attachDragEvents() {
  const handles = elGpuContainer.querySelectorAll('.drag-handle');
  handles.forEach(handle => {
    handle.addEventListener('mousedown', onHandleMouseDown);
  });
}

let dragGhost = null;
let dragCard = null;
let dragKey = null;
let mouseOffset = { x: 0, y: 0 };

function onHandleMouseDown(e) {
  e.preventDefault();
  const card = e.target.closest('.gpu-card');
  if (!card) return;

  dragCard = card;
  dragKey = card.dataset.cardKey;

  // Create a ghost element that follows the cursor
  dragGhost = card.cloneNode(true);
  dragGhost.style.position = 'fixed';
  dragGhost.style.zIndex = '9999';
  dragGhost.style.pointerEvents = 'none';
  dragGhost.style.opacity = '0.85';
  dragGhost.style.transform = 'scale(1.03) rotate(1deg)';
  dragGhost.style.boxShadow = '0 8px 32px rgba(0,0,0,0.5)';
  dragGhost.style.width = card.offsetWidth + 'px';
  document.body.appendChild(dragGhost);

  mouseOffset.x = e.clientX;
  mouseOffset.y = e.clientY;

  // Dim the original card
  card.style.opacity = '0.25';
  card.style.transition = 'opacity 0.15s';

  // Highlight potential drop targets
  elGpuContainer.querySelectorAll('.gpu-card').forEach(c => {
    if (c !== card) c.classList.add('drag-over');
  });

  document.addEventListener('mousemove', onDragMouseMove);
  document.addEventListener('mouseup', onDragMouseUp);
}

function onDragMouseMove(e) {
  if (!dragGhost) return;
  dragGhost.style.left = (e.clientX - 20) + 'px';
  dragGhost.style.top = (e.clientY - 20) + 'px';

  // Highlight the card under cursor
  elGpuContainer.querySelectorAll('.gpu-card').forEach(c => {
    const rect = c.getBoundingClientRect();
    const over = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    c.classList.toggle('drag-over', over && c !== dragCard);
  });
}

function onDragMouseUp(e) {
  document.removeEventListener('mousemove', onDragMouseMove);
  document.removeEventListener('mouseup', onDragMouseUp);

  if (!dragGhost || !dragCard) return;

  // Find drop target (card under cursor, excluding self)
  let targetCard = null;
  elGpuContainer.querySelectorAll('.gpu-card').forEach(c => {
    const rect = c.getBoundingClientRect();
    if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
      targetCard = c;
    }
    c.classList.remove('drag-over');
  });

  // Remove ghost and restore original
  document.body.removeChild(dragGhost);
  dragGhost = null;
  dragCard.style.opacity = '1';

  if (targetCard && targetCard !== dragCard) {
    const fromIdx = gpuOrder.indexOf(dragKey);
    const toIdx = gpuOrder.indexOf(targetCard.dataset.cardKey);
    if (fromIdx !== -1 && toIdx !== -1) {
      const [moved] = gpuOrder.splice(fromIdx, 1);
      gpuOrder.splice(toIdx, 0, moved);
      try { localStorage.setItem('gpu-card-order', JSON.stringify(gpuOrder)); } catch {}
      pollAll();
    }
  }

  dragCard = null;
  dragKey = null;
}

// ====== Polling ======

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollAll, refreshInterval);
  // Initial fetch immediately
  pollAll();
}

// ====== Helpers ======

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function minimizeWindow() {
  if (window.electronAPI?.minimize) {
    window.electronAPI.minimize();
  }
}

function closeWindow() {
  if (window.electronAPI?.close) {
    window.electronAPI.close();
  }
}

// ====== Start ======

loadSources();
