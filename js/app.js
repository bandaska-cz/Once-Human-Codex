/* ==========================================================================
   ONCE HUMAN MASTER CODEX & RECIPE MATRIX - APPLICATION ENGINE
   Optimized with:
   - Pre-computed search indexing for instant multi-term filtering
   - Input debouncing (120ms) to reduce DOM thrashing
   - Batched DOM insertion with DocumentFragment
   - Deferred rendering (content-visibility: auto) for off-screen cards
   - Deep linking & URL hash synchronization (#tab=... / #recipe/...)
   - Favorites / Bookmark persistence in localStorage
   - Keyboard accessibility (Esc to close, / to search)
   - PWA Service Worker offline registration
   ========================================================================== */

let currentLang = localStorage.getItem('once_human_lang') || 'cs';
let modalHistory = [];
let activeTab = 'discovered';
let searchQuery = '';
let selectedScenario = 'all';
let selectedCategory = 'all';
let selectedRarity = 'all';
let sortCriterion = 'name-asc';
let favoritesOnly = false;
let selectedEffectTag = 'all';
let searchDebounceTimer = null;

// Favorites Set stored in localStorage

// Crafting Queue / Farming Planner State
let craftQueue = [];
try {
  const savedQueue = JSON.parse(localStorage.getItem('once_human_craft_queue') || '[]');
  if (Array.isArray(savedQueue)) craftQueue = savedQueue;
} catch (e) {
  craftQueue = [];
}

function saveCraftQueue() {
  try {
    localStorage.setItem('once_human_craft_queue', JSON.stringify(craftQueue));
  } catch (e) {}
  updateQueueBadge();
}

function updateQueueBadge() {
  const badge = document.getElementById('queue-badge-count');
  if (badge) {
    const totalCount = craftQueue.reduce((sum, item) => sum + (item.count || 1), 0);
    badge.innerText = totalCount;
    if (totalCount > 0) {
      badge.classList.remove('hidden');
    } else {
      badge.innerText = '0';
    }
  }
}

function addToQueue(recipeId, count = 1, event) {
  if (event) event.stopPropagation();
  const recipe = findRecipeById(recipeId);
  if (!recipe) return;

  const existing = craftQueue.find(q => q.recipeId === recipeId && !q.isResearch);
  if (existing) {
    existing.count = (existing.count || 1) + count;
  } else {
    craftQueue.push({ recipeId, count, isResearch: false });
  }

  saveCraftQueue();

  const rName = currentLang === 'cs' ? recipe.nameCs : recipe.nameEn;
  const msg = currentLang === 'cs' ? `Položka "${rName}" přidána do plánu (${count}×)` : `Added "${rName}" to plan (${count}×)`;
  showNotification(msg);

  const qModal = document.getElementById('craft-queue-modal');
  if (qModal && !qModal.classList.contains('hidden')) {
    renderQueueModalContent();
  }
}

function addInventionToQueue(recipeId, count = 1, event) {
  if (event) event.stopPropagation();
  const recipe = findRecipeById(recipeId);
  if (!recipe || !recipe.researchInvention) return;

  const existing = craftQueue.find(q => q.recipeId === recipeId && q.isResearch);
  if (existing) {
    existing.count = (existing.count || 1) + count;
  } else {
    craftQueue.push({ recipeId, count, isResearch: true });
  }

  saveCraftQueue();

  const rName = currentLang === 'cs' ? recipe.nameCs : recipe.nameEn;
  const msg = currentLang === 'cs' ? `🧪 Výzkum "${rName}" přidán do plánu (${count}×)` : `🧪 Research "${rName}" added to plan (${count}×)`;
  showNotification(msg);

  const qModal = document.getElementById('craft-queue-modal');
  if (qModal && !qModal.classList.contains('hidden')) {
    renderQueueModalContent();
  }
}

function updateQueueCountByIndex(index, delta) {
  if (index < 0 || index >= craftQueue.length) return;
  craftQueue[index].count = (craftQueue[index].count || 1) + delta;
  if (craftQueue[index].count <= 0) {
    craftQueue.splice(index, 1);
  }
  saveCraftQueue();
  renderQueueModalContent();
}

function updateQueueCount(recipeId, delta) {
  const item = craftQueue.find(q => q.recipeId === recipeId);
  if (!item) return;
  item.count = (item.count || 1) + delta;
  if (item.count <= 0) {
    removeFromQueue(recipeId);
    return;
  }
  saveCraftQueue();
  renderQueueModalContent();
}

function removeFromQueueByIndex(index) {
  if (index < 0 || index >= craftQueue.length) return;
  craftQueue.splice(index, 1);
  saveCraftQueue();
  renderQueueModalContent();
}

function removeFromQueue(recipeId) {
  craftQueue = craftQueue.filter(q => q.recipeId !== recipeId);
  saveCraftQueue();
  renderQueueModalContent();
}

function clearQueue() {
  craftQueue = [];
  saveCraftQueue();
  renderQueueModalContent();
}

function openQueueModal() {
  const modal = document.getElementById('craft-queue-modal');
  if (!modal) return;
  renderQueueModalContent();
  modal.classList.remove('hidden');
}

function closeQueueModal() {
  const modal = document.getElementById('craft-queue-modal');
  if (modal) modal.classList.add('hidden');
}


// Checked materials set stored in localStorage
let checkedMaterials = new Set();
try {
  const savedChecked = JSON.parse(localStorage.getItem('once_human_checked_mats') || '[]');
  if (Array.isArray(savedChecked)) checkedMaterials = new Set(savedChecked);
} catch (e) {
  checkedMaterials = new Set();
}

let rawDecompositionMode = localStorage.getItem('once_human_raw_mode') === 'true';

function saveCheckedMaterials() {
  try {
    localStorage.setItem('once_human_checked_mats', JSON.stringify(Array.from(checkedMaterials)));
  } catch (e) {}
}

function toggleMaterialCheck(matName) {
  if (checkedMaterials.has(matName)) {
    checkedMaterials.delete(matName);
  } else {
    checkedMaterials.add(matName);
  }
  saveCheckedMaterials();
  renderQueueModalContent();
}

function uncheckAllMaterials() {
  checkedMaterials.clear();
  saveCheckedMaterials();
  renderQueueModalContent();
}

function toggleDecompositionMode(mode) {
  rawDecompositionMode = Boolean(mode);
  try {
    localStorage.setItem('once_human_raw_mode', rawDecompositionMode ? 'true' : 'false');
  } catch (e) {}
  renderQueueModalContent();
}

function decomposeSingleIngredient(name, amount, lang = 'cs', depth = 0, visited = new Set()) {
  if (depth > 5 || visited.has(name)) {
    return [{ name, amount, isRaw: true }];
  }

  const meta = getIngredientMeta(name);
  if (!meta || !meta.recipeId) {
    return [{ name, amount, isRaw: true }];
  }

  const subRecipe = findRecipeById(meta.recipeId);
  if (!subRecipe) {
    return [{ name, amount, isRaw: true }];
  }

  const subVisited = new Set(visited);
  subVisited.add(name);

  const subIngredients = lang === 'cs' ? subRecipe.ingredientsCs : subRecipe.ingredientsEn;
  let results = [];

  subIngredients.forEach(subIng => {
    const match = (subIng.amount || '').match(/\d+/);
    const subAmtPerCraft = match ? parseInt(match[0], 10) : 1;
    const totalSubAmt = subAmtPerCraft * amount;

    const deeper = decomposeSingleIngredient(subIng.name, totalSubAmt, lang, depth + 1, subVisited);
    results = results.concat(deeper);
  });

  return results;
}

function calculateQueueMaterials() {
  const totals = {};

  craftQueue.forEach(item => {
    const recipe = findRecipeById(item.recipeId);
    if (!recipe) return;

    let ingredients;
    if (item.isResearch && recipe.researchInvention) {
      ingredients = currentLang === 'cs' ? recipe.researchInvention.materialsCs : recipe.researchInvention.materialsEn;
    } else {
      ingredients = currentLang === 'cs' ? recipe.ingredientsCs : recipe.ingredientsEn;
    }
    const mult = item.count || 1;

    ingredients.forEach(ing => {
      const match = (ing.amount || '').match(/\d+/);
      const amountPerCraft = match ? parseInt(match[0], 10) : 1;
      const totalAmount = amountPerCraft * mult;

      if (rawDecompositionMode && !item.isResearch) {
        // Recursive raw decomposition to base natural resources
        const decomposed = decomposeSingleIngredient(ing.name, totalAmount, currentLang);
        decomposed.forEach(rawItem => {
          if (!totals[rawItem.name]) {
            const meta = getIngredientMeta(rawItem.name);
            totals[rawItem.name] = {
              name: rawItem.name,
              amount: 0,
              isPrimary: false,
              recipeId: null,
              location: meta ? (currentLang === 'cs' ? meta.locationCs : meta.locationEn) : null
            };
          }
          totals[rawItem.name].amount += rawItem.amount;
        });
      } else {
        // Direct recipe materials
        if (!totals[ing.name]) {
          const meta = getIngredientMeta(ing.name);
          totals[ing.name] = {
            name: ing.name,
            amount: 0,
            isPrimary: ing.isPrimary || false,
            recipeId: meta ? meta.recipeId : null,
            location: meta ? (currentLang === 'cs' ? meta.locationCs : meta.locationEn) : null
          };
        }
        totals[ing.name].amount += totalAmount;
      }
    });
  });

  return Object.values(totals);
}

function renderQueueModalContent() {
  const content = document.getElementById('queue-modal-content');
  if (!content) return;

  const t = i18n[currentLang];
  if (craftQueue.length === 0) {
    content.innerHTML = `
      <div class="text-center py-12">
        <i class="fa-solid fa-clipboard-list text-4xl text-slate-600 mb-3"></i>
        <h3 class="font-orbitron font-bold text-white text-base mb-1">${t.queueTitle}</h3>
        <p class="text-xs font-mono text-slate-400 max-w-md mx-auto">${t.queueEmpty}</p>
      </div>
    `;
    return;
  }

  const materials = calculateQueueMaterials();
  const totalMatsCount = materials.length;
  const checkedCount = materials.filter(m => checkedMaterials.has(m.name)).length;
  const progressPercent = totalMatsCount > 0 ? Math.round((checkedCount / totalMatsCount) * 100) : 0;

  content.innerHTML = `
    <div class="flex items-center justify-between pb-3 mb-4 border-b border-hud-border flex-wrap gap-2">
      <div>
        <h3 class="font-orbitron font-bold text-white text-lg flex items-center gap-2">
          <i class="fa-solid fa-clipboard-check text-hud-cyan"></i>
          <span>${t.queueTitle}</span>
        </h3>
        <p class="text-xs font-mono text-slate-400 mt-0.5">${t.queueDesc}</p>
      </div>
      <button onclick="clearQueue()" class="px-2.5 py-1 bg-red-950/60 hover:bg-red-900 border border-red-700/60 rounded text-red-300 text-xs font-mono transition flex items-center gap-1.5 cursor-pointer">
        <i class="fa-solid fa-trash-can text-[11px]"></i>
        <span>${t.clearQueueBtn}</span>
      </button>
    </div>

    <!-- Section 1: Planned recipes list -->
    <div class="mb-5 bg-slate-900/40 p-3 rounded-lg border border-slate-800">
      <h4 class="text-xs font-mono uppercase text-hud-cyan mb-2 font-bold flex items-center justify-between">
        <span class="flex items-center gap-1.5">
          <i class="fa-solid fa-list-check"></i>
          <span>${t.plannedItems} (${craftQueue.length})</span>
        </span>
      </h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-44 overflow-y-auto pr-1">
        ${craftQueue.map((item, idx) => {
          const recipe = findRecipeById(item.recipeId);
          if (!recipe) return '';
          let name = currentLang === 'cs' ? recipe.nameCs : recipe.nameEn;
          let workbench = recipe.workbench;
          if (item.isResearch) {
            name = '🧪 ' + (currentLang === 'cs' ? 'Výzkum: ' : 'Research: ') + name;
            workbench = currentLang === 'cs' ? 'Stůl pro technologický výzkum' : 'Tech Research Workbench';
          }
          const rar = rarityConfig[recipe.rarity] || rarityConfig.Common;

          return `
            <div class="p-2 bg-hud-bg border border-hud-border rounded flex items-center justify-between gap-1.5">
              <div class="truncate mr-1">
                <div class="flex items-center gap-1">
                  <span class="w-1.5 h-1.5 rounded-full ${rar.dot}"></span>
                  <span class="text-xs font-medium text-white truncate cursor-pointer hover:text-hud-cyan" onclick="openModal('${recipe.id}', true)">${name}</span>
                </div>
                <div class="text-[9px] font-mono text-slate-500 truncate">${workbench}</div>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <button onclick="updateQueueCountByIndex(${idx}, -1)" class="w-5 h-5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center font-bold text-xs cursor-pointer">-</button>
                <span class="w-5 text-center font-mono font-bold text-hud-cyan text-xs">${item.count}</span>
                <button onclick="updateQueueCountByIndex(${idx}, 1)" class="w-5 h-5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center font-bold text-xs cursor-pointer">+</button>
                <button onclick="removeFromQueueByIndex(${idx})" class="text-slate-500 hover:text-red-400 p-0.5 cursor-pointer ml-0.5">
                  <i class="fa-solid fa-xmark text-xs"></i>
                </button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <!-- Section 2: Aggregated Raw Materials Shopping List with Mode Toggle & Checkbox Progress -->
    <div class="mb-3">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
        <!-- Direct vs Raw Mode Switcher -->
        <div class="flex items-center bg-hud-card border border-hud-border rounded p-1 text-xs font-mono">
          <button 
            type="button"
            onclick="toggleDecompositionMode(false)" 
            class="px-2.5 py-1 rounded transition font-bold cursor-pointer ${!rawDecompositionMode ? 'bg-hud-cyan text-black shadow' : 'text-slate-400 hover:text-white'}"
          >
            ${t.directModeBtn}
          </button>
          <button 
            type="button"
            onclick="toggleDecompositionMode(true)" 
            class="px-2.5 py-1 rounded transition font-bold cursor-pointer flex items-center gap-1 ${rawDecompositionMode ? 'bg-hud-cyan text-black shadow' : 'text-slate-400 hover:text-white'}"
          >
            <i class="fa-solid fa-leaf text-[10px]"></i>
            <span>${t.rawDecomposeBtn}</span>
          </button>
        </div>

        <div class="flex items-center gap-2">
          <button onclick="uncheckAllMaterials()" class="text-[11px] font-mono text-slate-400 hover:text-slate-200 underline cursor-pointer">
            ${t.uncheckAllBtn}
          </button>
          <button onclick="copyQueueToDiscord()" class="px-3 py-1 bg-hud-cyan/20 hover:bg-hud-cyan/30 border border-hud-cyan/60 rounded text-hud-cyan hover:text-white text-xs font-mono flex items-center gap-1.5 transition cursor-pointer">
            <i class="fa-solid fa-copy text-xs"></i>
            <span>${t.copyDiscordBtn}</span>
          </button>
        </div>
      </div>

      <!-- Checklist Progress Bar -->
      <div class="mb-3 p-2.5 bg-hud-bg/80 border border-hud-border rounded-lg">
        <div class="flex items-center justify-between text-xs font-mono mb-1.5">
          <span class="text-slate-300 flex items-center gap-1.5">
            <i class="fa-solid fa-bars-progress text-hud-cyan"></i>
            <span>${t.checkedProgress}</span>
            <strong class="text-hud-cyan">${checkedCount} / ${totalMatsCount}</strong>
          </span>
          <span class="font-bold ${progressPercent === 100 ? 'text-emerald-400' : 'text-hud-cyan'}">${progressPercent}%</span>
        </div>
        <div class="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
          <div class="h-2 rounded-full transition-all duration-300 ${progressPercent === 100 ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]' : 'bg-hud-cyan shadow-[0_0_8px_rgba(0,240,255,0.4)]'}" style="width: ${progressPercent}%"></div>
        </div>
      </div>

      <!-- Materials Grid with Checkboxes -->
      <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 max-h-72 overflow-y-auto pr-1">
        ${materials.map(mat => {
          const isChecked = checkedMaterials.has(mat.name);
          const isCrafted = Boolean(mat.recipeId) && !rawDecompositionMode;

          return `
            <div 
              onclick="toggleMaterialCheck('${mat.name.replace(/'/g, "\\'")}')"
              class="p-2.5 rounded border transition-all flex items-center justify-between text-xs cursor-pointer select-none ${
                isChecked 
                  ? 'bg-emerald-950/30 border-emerald-500/50 opacity-60' 
                  : isCrafted 
                    ? 'bg-hud-bg/90 border-hud-cyan/50 hover:border-hud-cyan' 
                    : 'bg-hud-bg/90 border-hud-border hover:border-slate-500'
              }"
            >
              <div class="flex items-center gap-2 truncate mr-2">
                <input 
                  type="checkbox" 
                  ${isChecked ? 'checked' : ''} 
                  onclick="event.stopPropagation(); toggleMaterialCheck('${mat.name.replace(/'/g, "\\'")}')"
                  class="w-4 h-4 rounded border-slate-700 bg-slate-900 text-hud-cyan focus:ring-0 cursor-pointer accent-cyan-400 shrink-0"
                >
                <div class="truncate">
                  <span class="${isChecked ? 'line-through text-slate-400' : mat.isPrimary ? 'text-amber-300 font-semibold' : 'text-slate-200'} truncate block" title="${mat.name}">
                    ${isCrafted ? '<i class="fa-solid fa-wrench text-[10px] text-hud-cyan mr-1"></i>' : ''}${mat.name}
                  </span>
                  ${mat.location ? `<span class="text-[9px] font-mono text-slate-500 truncate block">${mat.location}</span>` : ''}
                </div>
              </div>
              <span class="font-mono font-bold ${isChecked ? 'text-emerald-400 bg-emerald-950/50' : 'text-hud-cyan bg-slate-900/80'} px-2 py-0.5 rounded border border-slate-700 shrink-0">
                ${mat.amount}×
              </span>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function copyQueueToDiscord() {
  const materials = calculateQueueMaterials();
  if (materials.length === 0) return;

  const t = i18n[currentLang];
  let text = `📦 **Once Human - ${currentLang === 'cs' ? 'Nákupní a farmící seznam' : 'Crafting & Farming List'}**\n\n`;
  text += `**${currentLang === 'cs' ? 'Plánovaná výroba' : 'Planned Items'}:**\n`;
  craftQueue.forEach(item => {
    const recipe = findRecipeById(item.recipeId);
    let rName = recipe ? (currentLang === 'cs' ? recipe.nameCs : recipe.nameEn) : item.recipeId;
    if (item.isResearch) {
      rName = '🧪 ' + (currentLang === 'cs' ? 'Výzkum: ' : 'Research: ') + rName;
    }
    text += `• ${rName} (${item.count}×)\n`;
  });

  text += `\n**${currentLang === 'cs' ? (rawDecompositionMode ? 'Základní přírodní suroviny celkem' : 'Potřebné suroviny celkem') : (rawDecompositionMode ? 'Base Raw Nature Materials' : 'Total Materials Required')}:**\n`;
  materials.forEach(mat => {
    const isChecked = checkedMaterials.has(mat.name);
    const checkIcon = isChecked ? '✅ ' : '⬜ ';
    text += `${checkIcon}${mat.name}: **${mat.amount}×**\n`;
  });

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }

  showNotification(t.discordCopied);
}

function showNotification(msg) {
  const notice = document.createElement('div');
  notice.className = "fixed bottom-5 right-5 bg-hud-cyan text-black font-mono font-bold px-4 py-2 rounded-lg shadow-lg z-50 text-xs";
  notice.innerText = msg;
  document.body.appendChild(notice);
  setTimeout(() => notice.remove(), 2500);
}

let favorites = new Set();
try {
  const savedFavs = JSON.parse(localStorage.getItem('once_human_favorites') || '[]');
  if (Array.isArray(savedFavs)) favorites = new Set(savedFavs);
} catch (e) {
  favorites = new Set();
}

function saveFavorites() {
  try {
    localStorage.setItem('once_human_favorites', JSON.stringify(Array.from(favorites)));
  } catch (e) {
    console.warn('Failed to save favorites to localStorage:', e);
  }
}

function isFavorite(id) {
  return favorites.has(id);
}

function toggleFavorite(id, event) {
  if (event) event.stopPropagation();
  if (favorites.has(id)) {
    favorites.delete(id);
  } else {
    favorites.add(id);
  }
  saveFavorites();

  // Update UI stars on existing card & modal if visible
  const cardStar = document.getElementById(`fav-star-${id}`);
  if (cardStar) {
    cardStar.className = favorites.has(id)
      ? 'fa-solid fa-star text-amber-400 hover:scale-125 transition cursor-pointer'
      : 'fa-regular fa-star text-slate-500 hover:text-amber-400 hover:scale-125 transition cursor-pointer';
  }

  const modalStar = document.getElementById(`modal-fav-star-${id}`);
  if (modalStar) {
    modalStar.className = favorites.has(id)
      ? 'fa-solid fa-star text-amber-400 text-lg hover:scale-125 transition cursor-pointer'
      : 'fa-regular fa-star text-slate-500 hover:text-amber-400 text-lg hover:scale-125 transition cursor-pointer';
  }

  if (favoritesOnly) {
    applyFiltersAndSort();
  updateQueueBadge();
  }
}

function toggleFavoritesOnly() {
  favoritesOnly = !favoritesOnly;
  const favBtn = document.getElementById('filter-favorites-btn');
  if (favBtn) {
    if (favoritesOnly) {
      favBtn.classList.remove('bg-hud-surface', 'text-slate-400', 'border-hud-border');
      favBtn.classList.add('bg-amber-500/20', 'text-amber-300', 'border-amber-500/70', 'shadow-[0_0_10px_rgba(245,158,11,0.3)]');
    } else {
      favBtn.classList.add('bg-hud-surface', 'text-slate-400', 'border-hud-border');
      favBtn.classList.remove('bg-amber-500/20', 'text-amber-300', 'border-amber-500/70', 'shadow-[0_0_10px_rgba(245,158,11,0.3)]');
    }
  }
  applyFiltersAndSort();
}

/* ==========================================================================
   PRE-COMPUTED SEARCH INDEX FOR ULTRA-FAST LOOKUPS
   ========================================================================== */

function selectEffectTag(tag) {
  selectedEffectTag = tag;
  const tags = ['all', 'combat', 'survival', 'utility', 'archetypes', 'thermal'];
  tags.forEach(t => {
    const el = document.getElementById('tag-pill-' + t);
    if (!el) return;
    if (t === tag) {
      el.className = "tag-pill px-2.5 py-1 rounded border text-[11px] transition whitespace-nowrap bg-hud-cyan text-black border-hud-cyan font-bold shadow cursor-pointer";
    } else {
      el.className = "tag-pill px-2.5 py-1 rounded border text-[11px] transition whitespace-nowrap bg-hud-bg text-slate-300 border-hud-border hover:border-hud-cyan hover:text-white cursor-pointer";
    }
  });
  applyFiltersAndSort();
}

function matchesEffectTag(item, tag) {
  if (tag === 'all') return true;
  const effectsText = ((item.effectsCs || []).join(' ') + ' ' + (item.effectsEn || []).join(' ')).toLowerCase();
  
  if (tag === 'combat') {
    return /damage|dmg|crit|weakspot|attack|poškození|útok|zásah|zbraň/i.test(effectsText);
  }
  if (tag === 'survival') {
    return /sanity|pollution|odolnost|hp|health|regenerace|znečištění|léčení|bleed|krvácení/i.test(effectsText);
  }
  if (tag === 'utility') {
    return /batoh|carry|weight|mining|krumpáč|těžba|stamina|výdrž|rychlost|speed|skok|jump|pádem/i.test(effectsText);
  }
  if (tag === 'archetypes') {
    return /shrapnel|burn|frost|vortex|shock|bomber|fast gunner|fortress|archetyp|bounce/i.test(effectsText);
  }
  if (tag === 'thermal') {
    return /cold|frost|cryo|chlad|mráz|heat|warmth|teplota|arktický|winter|oheň|burn/i.test(effectsText);
  }
  return true;
}

function shareRecipeLink(recipeId) {
  const url = window.location.origin + window.location.pathname + '#recipe/' + recipeId;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).catch(() => fallbackCopy(url));
  } else {
    fallbackCopy(url);
  }
  const t = i18n[currentLang];
  showNotification(t.shareNotice || 'Link copied to clipboard!');
}

function openBackupModal() {
  const modal = document.getElementById('backup-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeBackupModal() {
  const modal = document.getElementById('backup-modal');
  if (modal) modal.classList.add('hidden');
}

function exportUserData() {
  const data = {
    app: "OnceHumanCodex",
    version: 1,
    exportedAt: new Date().toISOString(),
    favorites: Array.from(favorites),
    craftQueue: craftQueue,
    checkedMaterials: Array.from(checkedMaterials),
    lang: currentLang
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `once-human-codex-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importUserData(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || typeof data !== 'object') throw new Error('Invalid format');

      if (Array.isArray(data.favorites)) {
        favorites = new Set(data.favorites);
        saveFavorites();
      }
      if (Array.isArray(data.craftQueue)) {
        craftQueue = data.craftQueue;
        saveCraftQueue();
      }
      if (Array.isArray(data.checkedMaterials)) {
        checkedMaterials = new Set(data.checkedMaterials);
        saveCheckedMaterials();
      }
      if (data.lang && (data.lang === 'cs' || data.lang === 'en')) {
        setLanguage(data.lang);
      }

      applyFiltersAndSort();
      updateQueueBadge();
      closeBackupModal();
      const t = i18n[currentLang];
      showNotification(t.importSuccess || 'Data successfully restored!');
    } catch (err) {
      console.error(err);
      const t = i18n[currentLang];
      showNotification(t.importError || 'Invalid backup file format');
    }
  };
  reader.readAsText(file);
}

function initSearchIndex() {
  getAllRecipes().forEach(item => {
    const csTokens = [
      item.nameCs || '',
      item.categoryCs || '',
      item.descriptionCs || '',
      item.sourceCs || '',
      item.workbench || '',
      ...(item.effectsCs || []),
      ...(item.ingredientsCs || []).map(i => i.name)
    ].join(' ');

    const enTokens = [
      item.nameEn || '',
      item.categoryEn || '',
      item.descriptionEn || '',
      item.sourceEn || '',
      item.workbench || '',
      ...(item.effectsEn || []),
      ...(item.ingredientsEn || []).map(i => i.name)
    ].join(' ');

    let invTokens = '';
    if (item.researchInvention) {
      invTokens = ' tech invention výzkum technological research bench ' + 
        (item.researchInvention.materialsCs || []).map(m => m.name).join(' ') + ' ' +
        (item.researchInvention.materialsEn || []).map(m => m.name).join(' ') + ' ' +
        (item.researchInvention.reverseEngineeringCs || '');
    }

    let gearTokens = '';
    if (item.archetype || item.uniquePerkCs || item.caliber || item.weaponType) {
      gearTokens = ` ${item.archetype || ''} ${item.archetypeCs || ''} ${item.caliber || ''} ${item.weaponType || ''} ${item.weaponTypeCs || ''} ${item.uniquePerkCs || ''} ${item.uniquePerkEn || ''} ${item.recommendedGearCs || ''} ${item.recommendedWeaponsCs || ''} weapon zbraň zbroj armor blueprint`;
    }

    let deviantTokens = '';
    if (item.deviantType || item.skillCs || item.cradleSynergyCs) {
      deviantTokens = ` ${item.deviantType || ''} ${item.deviantTypeCs || ''} ${item.deviantTypeEn || ''} ${item.skillCs || ''} ${item.skillEn || ''} ${item.cradleSynergyCs || ''} ${item.cradleSynergyEn || ''} deviant bestiář securement cradle containment jednotka unit`;
      if (item.containmentCs) {
        deviantTokens += ` ${item.containmentCs.lighting || ''} ${item.containmentCs.temperature || ''} ${item.containmentCs.music || ''} ${item.containmentCs.surroundings || ''}`;
      }
    }

    let zoneTokens = '';
    if (item.zoneType || item.levelRange || item.monolithBossCs || item.mysticCratesCs) {
      zoneTokens = ` ${item.zoneType || ''} ${item.levelRange || ''} ${item.monolithBossCs || ''} ${item.monolithBossEn || ''} ${item.silosCs || ''} ${item.silosEn || ''} ${(item.mysticCratesCs || []).join(' ')} ${(item.mysticCratesEn || []).join(' ')} ${(item.keyLootCs || []).join(' ')} ${(item.keyLootEn || []).join(' ')} zone zóna region průzkum exploration dungeon silo monolith mystic crate truhla`;
    }

    let fishTokens = '';
    if (item.habitatCs || item.preferredBaitCs || item.culinaryUseCs || item.tradingValueCs) {
      fishTokens = ` ${item.habitatCs || ''} ${item.habitatEn || ''} ${item.preferredBaitCs || ''} ${item.preferredBaitEn || ''} ${item.culinaryUseCs || ''} ${item.culinaryUseEn || ''} ${item.tradingValueCs || ''} ${item.tradingValueEn || ''} ryba rybolov fishing bait návnada úlovek akvárium catch eel úhoř`;
    }

    let bossTokens = '';
    if (item.weakspotsCs || item.phasesCs || item.recommendedArchetypesCs) {
      bossTokens = ` ${item.weakspotsCs || ''} ${item.weakspotsEn || ''} ${(item.phasesCs || []).join(' ')} ${(item.phasesEn || []).join(' ')} ${item.recommendedArchetypesCs || ''} ${item.recommendedArchetypesEn || ''} ${item.recommendedDeviantsCs || ''} ${item.recommendedDeviantsEn || ''} boss raid taktika mechanika monolith wipe weakspot fázování silo hunter treant arachsiam hound giant`;
    }

    let memeticTokens = '';
    if (item.levelBracket || item.tierRanking || item.resetItem) {
      memeticTokens = ` ${item.levelBracket || ''} ${item.tierRanking || ''} ${item.resetItem || ''} memetic specializace specialization mastery perk cleaner reset talent link sulfur chemist solar drill biomass missile`;
    }

    let modTokens = '';
    if (item.gearSlot || item.modArchetypeCs || item.subStatsPriorityCs) {
      modTokens = ` ${item.gearSlot || ''} ${item.modArchetypeCs || ''} ${item.modArchetypeEn || ''} ${item.subStatsPriorityCs || ''} ${item.subStatsPriorityEn || ''} ${item.dropSourceCs || ''} ${item.dropSourceEn || ''} mod modifikace zbraň zbroj slot substat sub-stat helm mask top vesta kalhoty bottoms gloves rukavice shoes boty shrapnel burn frost surge bounce bomber`;
    }

    item._searchIndex = (csTokens + ' ' + enTokens + ' ' + (item.scenario || '') + ' ' + invTokens + ' ' + gearTokens + ' ' + deviantTokens + ' ' + zoneTokens + ' ' + fishTokens + ' ' + bossTokens + ' ' + memeticTokens + ' ' + modTokens).toLowerCase();
  });
}

/* ==========================================================================
   INITIALIZATION & DEEP LINKING
   ========================================================================== */
window.onload = function() {
  initSearchIndex();
  applyLanguageUI();
  updateTotalStats();
  renderFilterControls();
  updateQueueBadge();
  
  // Restore state from URL Hash if present
  handleInitialHash();

  applyFiltersAndSort();
  calculateSynergies();

  // Register PWA Service Worker if supported
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.log('SW registration skipped:', err);
    });
  }
};

window.addEventListener('hashchange', handleHashChange);

function handleInitialHash() {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return;

  if (hash.startsWith('recipe/')) {
    const recipeId = hash.replace('recipe/', '');
    const tab = determineRecipeTab(recipeId);
    if (tab) switchTab(tab, false);
    setTimeout(() => openModal(recipeId, false), 50);
  } else if (hash.startsWith('tab=')) {
    const tabName = hash.replace('tab=', '');
    if (['discovered', 'creative', 'medicine', 'inventions'].includes(tabName)) {
      switchTab(tabName, false);
    }
  }
}

function handleHashChange() {
  const hash = window.location.hash.replace(/^#/, '');
  if (hash.startsWith('recipe/')) {
    const recipeId = hash.replace('recipe/', '');
    openModal(recipeId, false);
  } else if (hash.startsWith('tab=')) {
    const tabName = hash.replace('tab=', '');
    if (activeTab !== tabName && ['discovered', 'creative', 'medicine', 'inventions', 'gear', 'deviants', 'zones', 'fishing', 'bosses', 'memetics', 'mods'].includes(tabName)) {
      switchTab(tabName, false);
    }
  }
}

function updateUrlHash(type, id) {
  if (type === 'recipe') {
    history.replaceState(null, '', '#recipe/' + id);
  } else if (type === 'tab') {
    history.replaceState(null, '', '#tab=' + id);
  }
}

// Global Keyboard Shortcuts (Escape to close, / to focus search)
window.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    const modal = document.getElementById('detail-modal');
    const backupModal = document.getElementById('backup-modal');
    if (backupModal && !backupModal.classList.contains('hidden')) {
      closeBackupModal();
      return;
    }
    const gridModal = document.getElementById('grid-calc-modal');
    if (gridModal && !gridModal.classList.contains('hidden')) {
      closeGridCalcModal();
      return;
    }
    const queueModal = document.getElementById('craft-queue-modal');
    if (queueModal && !queueModal.classList.contains('hidden')) {
      closeQueueModal();
      return;
    }
    if (modal && !modal.classList.contains('hidden')) {
      closeModal();
      return;
    }
    hidePortalTooltipNow();
  } else if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
    e.preventDefault();
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.focus();
  }
});

function getAllRecipes() {
  return [...discoveredRecipes, ...creativeDishes, ...medicineRecipes, ...inventionRecipes, ...gearRecipes, ...deviantRecipes, ...zoneRecipes, ...fishRecipes, ...bossTactics, ...memeticSpecializations, ...gearMods];
}

function findRecipeById(id) {
  return getAllRecipes().find(r => r.id === id);
}

function determineRecipeTab(recipeId) {
  if (discoveredRecipes.some(r => r.id === recipeId)) return 'discovered';
  if (creativeDishes.some(r => r.id === recipeId)) return 'creative';
  if (medicineRecipes.some(r => r.id === recipeId)) return 'medicine';
  if (inventionRecipes.some(r => r.id === recipeId)) return 'inventions';
  if (gearRecipes.some(r => r.id === recipeId)) return 'gear';
  if (deviantRecipes.some(r => r.id === recipeId)) return 'deviants';
  if (zoneRecipes.some(r => r.id === recipeId)) return 'zones';
  if (fishRecipes.some(r => r.id === recipeId)) return 'fishing';
  if (bossTactics.some(r => r.id === recipeId)) return 'bosses';
  if (memeticSpecializations.some(r => r.id === recipeId)) return 'memetics';
  if (gearMods.some(r => r.id === recipeId)) return 'mods';
  return 'discovered';
}

function navigateToRecipe(targetRecipeId) {
  const targetRecipe = findRecipeById(targetRecipeId);
  if (!targetRecipe) return;

  const targetTab = determineRecipeTab(targetRecipeId);
  if (activeTab !== targetTab) {
    switchTab(targetTab, false);
  }

  openModal(targetRecipeId, true);
}

function getActiveDataset() {
  switch (activeTab) {
    case 'discovered': return discoveredRecipes;
    case 'creative': return creativeDishes;
    case 'medicine': return medicineRecipes;
    case 'inventions': return inventionRecipes;
    case 'gear': return gearRecipes;
    case 'deviants': return deviantRecipes;
    case 'zones': return zoneRecipes;
    case 'fishing': return fishRecipes;
    case 'bosses': return bossTactics;
    case 'memetics': return memeticSpecializations;
    case 'mods': return gearMods;
    default: return discoveredRecipes;
  }
}

function setLanguage(lang) {
  if (currentLang === lang) return;
  currentLang = lang;
  try {
    localStorage.setItem('once_human_lang', lang);
  } catch (e) {}

  applyLanguageUI();
  renderFilterControls();
  applyFiltersAndSort();
  calculateSynergies();
}

function applyLanguageUI() {
  const t = i18n[currentLang];
  document.getElementById('ui-subtitle').innerText = t.subtitle;
  document.getElementById('tab-txt-discovered').innerText = `${t.tabDiscovered} (${discoveredRecipes.length})`;
  document.getElementById('tab-txt-creative').innerText = `${t.tabCreative} (${creativeDishes.length})`;
  document.getElementById('tab-txt-medicine').innerText = `${t.tabMedicine} (${medicineRecipes.length})`;
  document.getElementById('tab-txt-inventions').innerText = `${t.tabInventions} (${inventionRecipes.length})`;
  const gearTabEl = document.getElementById('tab-txt-gear');
  if (gearTabEl) gearTabEl.innerText = `${t.tabGear || 'Weapons & Armor'} (${gearRecipes.length})`;
  const devTabEl = document.getElementById('tab-txt-deviants');
  if (devTabEl) devTabEl.innerText = `${t.tabDeviants || 'Deviants & Cradle'} (${deviantRecipes.length})`;
  const zoneTabEl = document.getElementById('tab-txt-zones');
  if (zoneTabEl) zoneTabEl.innerText = `${t.tabZones || 'Zones & Exploration'} (${zoneRecipes.length})`;
  const fishTabEl = document.getElementById('tab-txt-fishing');
  if (fishTabEl) fishTabEl.innerText = `${t.tabFishing || 'Fishing & Baits'} (${fishRecipes.length})`;
  const bossTabEl = document.getElementById('tab-txt-bosses');
  if (bossTabEl) bossTabEl.innerText = `${t.tabBosses || 'Boss Tactics & Raids'} (${bossTactics.length})`;
  const memTabEl = document.getElementById('tab-txt-memetics');
  if (memTabEl) memTabEl.innerText = `${t.tabMemetics || 'Memetic Specializations'} (${memeticSpecializations.length})`;
  const modTabEl = document.getElementById('tab-txt-mods');
  if (modTabEl) modTabEl.innerText = `${t.tabMods || 'Weapon & Armor Mods'} (${gearMods.length})`;
  document.getElementById('calc-title').innerText = t.calcTitle;
  document.getElementById('calc-desc').innerText = t.calcDesc;
  document.getElementById('searchInput').placeholder = t.searchPlaceholder;

  const gridBtnLabel = document.getElementById('grid-calc-btn-label');
  if (gridBtnLabel) gridBtnLabel.innerText = currentLang === 'cs' ? 'Síť & Kyselina' : 'Grid & Acid';
  const gridTitle = document.getElementById('grid-modal-title');
  if (gridTitle) gridTitle.innerText = t.gridCalcTitle || 'KALKULÁTOR ENERGETICKÉ SÍTĚ & AUTOMATIZACE KYSELINY';
  const gridDesc = document.getElementById('grid-modal-desc');
  if (gridDesc) gridDesc.innerText = t.gridCalcDesc || 'Simulace výkonu generátorů, spotřeby báze a hodinové výtěžnosti farem na kyselinu.';
  const gridTabPower = document.getElementById('grid-tab-lbl-power');
  if (gridTabPower) gridTabPower.innerText = t.gridTabPower || 'Energetická síť';
  const gridTabAcid = document.getElementById('grid-tab-lbl-acid');
  if (gridTabAcid) gridTabAcid.innerText = t.gridTabAcid || 'Farma na kyselinu';

  // Language buttons visual sync
  const csBtn = document.getElementById('lang-cs');
  const enBtn = document.getElementById('lang-en');
  if (currentLang === 'cs') {
    csBtn.className = "px-2.5 py-1 rounded text-xs font-mono font-bold transition-all bg-hud-cyan text-black shadow";
    enBtn.className = "px-2.5 py-1 rounded text-xs font-mono font-bold transition-all text-slate-400 hover:text-white";
  } else {
    enBtn.className = "px-2.5 py-1 rounded text-xs font-mono font-bold transition-all bg-hud-cyan text-black shadow";
    csBtn.className = "px-2.5 py-1 rounded text-xs font-mono font-bold transition-all text-slate-400 hover:text-white";
  }
}

function switchTab(tabId, updateHash = true) {
  activeTab = tabId;
  selectedCategory = 'all';
  selectedRarity = 'all';

  if (updateHash) {
    updateUrlHash('tab', tabId);
  }

  const buttons = [
    { id: 'tab-btn-discovered', name: 'discovered' },
    { id: 'tab-btn-creative', name: 'creative' },
    { id: 'tab-btn-medicine', name: 'medicine' },
    { id: 'tab-btn-inventions', name: 'inventions' },
    { id: 'tab-btn-gear', name: 'gear' },
    { id: 'tab-btn-deviants', name: 'deviants' },
    { id: 'tab-btn-zones', name: 'zones' },
    { id: 'tab-btn-fishing', name: 'fishing' },
    { id: 'tab-btn-bosses', name: 'bosses' },
    { id: 'tab-btn-memetics', name: 'memetics' },
    { id: 'tab-btn-mods', name: 'mods' }
  ];

  buttons.forEach(btn => {
    const el = document.getElementById(btn.id);
    if (!el) return;
    if (btn.name === tabId) {
      el.className = "tab-button px-4 py-2.5 rounded font-orbitron text-xs sm:text-sm font-semibold tracking-wide transition-all bg-hud-cyan text-black shadow-[0_0_15px_rgba(0,240,255,0.4)] flex items-center space-x-2";
    } else {
      el.className = "tab-button px-4 py-2.5 rounded font-orbitron text-xs sm:text-sm font-semibold tracking-wide transition-all bg-hud-surface text-slate-300 hover:text-white border border-hud-border flex items-center space-x-2";
    }
  });

  const calcPanel = document.getElementById('creative-calculator-panel');
  if (calcPanel) {
    if (tabId === 'creative') {
      calcPanel.classList.remove('hidden');
    } else {
      calcPanel.classList.add('hidden');
    }
  }

  renderFilterControls();
  applyFiltersAndSort();
}

function renderFilterControls() {
  const dataset = getActiveDataset();
  const catSelect = document.getElementById('filterCategory');
  const currentVal = selectedCategory;

  const categories = new Set();
  dataset.forEach(item => {
    const cat = currentLang === 'cs' ? item.categoryCs : item.categoryEn;
    categories.add(cat);
  });

  const t = i18n[currentLang];
  let optionsHtml = `<option value="all">${t.allCategories}</option>`;
  Array.from(categories).sort().forEach(cat => {
    optionsHtml += `<option value="${cat}">${cat}</option>`;
  });
  catSelect.innerHTML = optionsHtml;
  catSelect.value = categories.has(currentVal) ? currentVal : 'all';

  const scenSelect = document.getElementById('filterScenario');
  const prevScen = scenSelect.value;
  scenSelect.innerHTML = `
    <option value="all">${t.scenarioAll}</option>
    <option value="core">${t.scenarioCore}</option>
    <option value="manibus">${t.scenarioManibus}</option>
    <option value="winter">${t.scenarioWinter}</option>
    <option value="prismverse">${t.scenarioPrismverse}</option>
  `;
  scenSelect.value = prevScen || 'all';

  const sortSelect = document.getElementById('sortCriterion');
  const prevSort = sortSelect.value;
  sortSelect.innerHTML = `
    <option value="name-asc">${t.sortNameAsc}</option>
    <option value="name-desc">${t.sortNameDesc}</option>
    <option value="ing-asc">${t.sortIngAsc}</option>
    <option value="rarity-desc">${t.sortRarityDesc}</option>
  `;
  sortSelect.value = prevSort || 'name-asc';
}

/* Debounced search handler for smooth UI responsiveness */
function handleSearch(val) {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchQuery = val.trim().toLowerCase();
    const clearBtn = document.getElementById('clearSearchBtn');
    if (searchQuery.length > 0) {
      clearBtn.classList.remove('hidden');
    } else {
      clearBtn.classList.add('hidden');
    }
    applyFiltersAndSort();
  }, 120);
}

function clearSearch() {
  const input = document.getElementById('searchInput');
  input.value = '';
  searchQuery = '';
  document.getElementById('clearSearchBtn').classList.add('hidden');
  applyFiltersAndSort();
}

function handleScenarioFilter(val) {
  selectedScenario = val;
  applyFiltersAndSort();
}

function handleCategoryFilter(val) {
  selectedCategory = val;
  applyFiltersAndSort();
}

function handleRarityFilter(val) {
  selectedRarity = val;
  applyFiltersAndSort();
}

function handleSortChange(val) {
  sortCriterion = val;
  applyFiltersAndSort();
}

function applyFiltersAndSort() {
  const dataset = getActiveDataset();
  const t = i18n[currentLang];

  let filtered = dataset.filter(item => {
    if (favoritesOnly && !isFavorite(item.id)) {
      return false;
    }

    if (selectedRarity !== 'all' && item.rarity !== selectedRarity) {
      return false;
    }

    if (selectedScenario !== 'all') {
      if (selectedScenario === 'core' && item.scenario !== 'core') return false;
      if (selectedScenario === 'manibus' && item.scenario !== 'manibus' && item.scenario !== 'core') return false;
      if (selectedScenario === 'winter' && item.scenario !== 'winter') return false;
      if (selectedScenario === 'prismverse' && item.scenario !== 'prismverse') return false;
    }

    const itemCat = currentLang === 'cs' ? item.categoryCs : item.categoryEn;
    if (selectedCategory !== 'all' && itemCat !== selectedCategory) {
      return false;
    }

    if (selectedEffectTag !== 'all' && !matchesEffectTag(item, selectedEffectTag)) {
      return false;
    }

    if (searchQuery) {
      if (item._searchIndex) {
        return item._searchIndex.includes(searchQuery);
      }
      const rawText = ((item.nameCs || '') + ' ' + (item.nameEn || '') + ' ' + (item.descriptionCs || '') + ' ' + (item.effectsCs || []).join(' ') + ' ' + (item.scenario || '')).toLowerCase();
      return rawText.includes(searchQuery);
    }

    return true;
  });

  filtered.sort((a, b) => {
    const nameA = currentLang === 'cs' ? a.nameCs : a.nameEn;
    const nameB = currentLang === 'cs' ? b.nameCs : b.nameEn;

    const ingA = currentLang === 'cs' ? (a.ingredientsCs[0]?.name || '') : (a.ingredientsEn[0]?.name || '');
    const ingB = currentLang === 'cs' ? (b.ingredientsCs[0]?.name || '') : (b.ingredientsEn[0]?.name || '');

    const rarOrderA = rarityConfig[a.rarity]?.order || 0;
    const rarOrderB = rarityConfig[b.rarity]?.order || 0;

    switch (sortCriterion) {
      case 'name-asc': return nameA.localeCompare(nameB);
      case 'name-desc': return nameB.localeCompare(nameA);
      case 'ing-asc': return ingA.localeCompare(ingB);
      case 'rarity-desc': return rarOrderB - rarOrderA;
      default: return 0;
    }
  });

  renderRecipeCards(filtered);
  document.getElementById('results-count').innerHTML = `${t.resultsCount} <strong class="text-hud-cyan">${filtered.length}</strong>`;
}

function updateTotalStats() {
  const total = getAllRecipes().length;
  const t = i18n[currentLang];
  document.getElementById('total-db-count').innerHTML = `${t.totalCount} <strong class="text-white">${total}</strong>`;
}

/* Batched rendering with DocumentFragment and deferred rendering for performance */
function renderRecipeCards(items) {
  const container = document.getElementById('recipes-grid');
  const emptyState = document.getElementById('empty-state');
  const t = i18n[currentLang];

  container.innerHTML = '';

  if (items.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  const fragment = document.createDocumentFragment();

  items.forEach((item, index) => {
    const rar = rarityConfig[item.rarity] || rarityConfig.Common;
    const primaryName = currentLang === 'cs' ? item.nameCs : item.nameEn;
    const secondaryName = currentLang === 'cs' ? item.nameEn : item.nameCs;
    const categoryText = currentLang === 'cs' ? item.categoryCs : item.categoryEn;
    const effects = currentLang === 'cs' ? item.effectsCs : item.effectsEn;
    const ingredients = currentLang === 'cs' ? item.ingredientsCs : item.ingredientsEn;
    const primaryIng = ingredients.find(i => i.isPrimary) || ingredients[0] || { name: 'N/A' };
    const source = currentLang === 'cs' ? (item.sourceCs || 'Objevení ve světě') : (item.sourceEn || 'World Discovery');
    const isFav = isFavorite(item.id);

    let scenBadge = 'bg-cyan-950/70 text-cyan-300 border-cyan-800';
    let scenName = 'Core World';
    if (item.scenario === 'winter') {
      scenBadge = 'bg-blue-950/90 text-blue-300 border-blue-500';
      scenName = 'The Way of Winter';
    } else if (item.scenario === 'manibus') {
      scenBadge = 'bg-purple-950/90 text-purple-300 border-purple-500';
      scenName = 'Manibus (PVE)';
    } else if (item.scenario === 'prismverse') {
      scenBadge = 'bg-amber-950/90 text-amber-300 border-amber-500';
      scenName = 'Prismverse';
    }

    // Apply deferred rendering optimization on cards outside initial viewport (index >= 6)
    const deferClass = index >= 6 ? 'recipe-card-deferred' : '';

    const card = document.createElement('div');
    card.className = `group bg-hud-surface/90 border border-hud-border hover:border-hud-cyan rounded-lg p-5 flex flex-col justify-between transition-all duration-300 hover:shadow-[0_0_20px_rgba(0,240,255,0.15)] relative hud-cut-tr ${deferClass}`;

    card.innerHTML = `
      <div>
        <!-- Header: Category, Scenario, Rarity Badge & Favorite Star -->
        <div class="flex items-center justify-between gap-1.5 mb-2 flex-wrap">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
              ${categoryText}
            </span>
            <span class="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border ${scenBadge}">
              ${scenName}
            </span>
            ${item.researchInvention ? `
              <span class="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border border-purple-500/60 bg-purple-950/80 text-purple-300 font-bold flex items-center gap-1 shadow-[0_0_8px_rgba(181,23,158,0.3)]">
                <i class="fa-solid fa-flask-vial text-[8px] text-hud-purple"></i>Tech Invention
              </span>
            ` : ''}
            ${item.archetype ? `
              <span class="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border border-amber-500/60 bg-amber-950/80 text-amber-300 font-bold flex items-center gap-1 shadow-[0_0_8px_rgba(245,158,11,0.3)]">
                <i class="fa-solid fa-crosshairs text-[8px] text-amber-400"></i>${currentLang === 'cs' ? (item.archetypeCs || item.archetype) : item.archetype}
              </span>
            ` : ''}
            ${item.caliber ? `
              <span class="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800 text-slate-300">
                ${item.caliber}
              </span>
            ` : ''}
            ${item.deviantType ? `
              <span class="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border ${
                item.deviantType === 'combat' 
                  ? 'border-red-500/60 bg-red-950/80 text-red-300 shadow-[0_0_8px_rgba(239,68,68,0.25)]' 
                  : item.deviantType === 'territory' 
                    ? 'border-emerald-500/60 bg-emerald-950/80 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.25)]' 
                    : 'border-cyan-500/60 bg-cyan-950/80 text-cyan-300 shadow-[0_0_8px_rgba(6,182,212,0.25)]'
              } font-bold flex items-center gap-1">
                <i class="fa-solid ${item.deviantType === 'combat' ? 'fa-crosshairs' : item.deviantType === 'territory' ? 'fa-house-chimney' : 'fa-industry'} text-[8px]"></i>
                ${currentLang === 'cs' ? (item.categoryCs || 'Deviant') : (item.categoryEn || 'Deviant')}
              </span>
            ` : ''}
            ${item.levelRange ? `
              <span class="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border border-hud-cyan/60 bg-cyan-950/80 text-cyan-300 font-bold flex items-center gap-1 shadow-[0_0_8px_rgba(0,240,255,0.25)]">
                <i class="fa-solid fa-location-dot text-[8px] text-hud-cyan"></i>${item.levelRange}
              </span>
            ` : ''}
            ${item.habitatCs ? `
              <span class="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border border-cyan-500/60 bg-cyan-950/80 text-cyan-300 font-bold flex items-center gap-1 shadow-[0_0_8px_rgba(6,182,212,0.25)]">
                <i class="fa-solid fa-fish-fins text-[8px] text-cyan-400"></i>${currentLang === 'cs' ? (item.categoryCs || 'Rybolov') : (item.categoryEn || 'Fishing')}
              </span>
            ` : ''}
            ${item.weakspotsCs ? `
              <span class="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border border-red-500/60 bg-red-950/80 text-red-300 font-bold flex items-center gap-1 shadow-[0_0_8px_rgba(239,68,68,0.25)]">
                <i class="fa-solid fa-skull-crossbones text-[8px] text-red-400"></i>${currentLang === 'cs' ? 'Boss Encounter' : 'Boss Raid'}
              </span>
            ` : ''}
            ${item.levelBracket ? `
              <span class="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border border-purple-500/60 bg-purple-950/80 text-purple-300 font-bold flex items-center gap-1 shadow-[0_0_8px_rgba(181,23,158,0.25)]">
                <i class="fa-solid fa-brain text-[8px] text-purple-400"></i>${item.levelBracket}
              </span>
            ` : ''}
            ${item.tierRanking ? `
              <span class="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border border-amber-500/60 bg-amber-950/80 text-amber-300 font-bold flex items-center gap-1 shadow-[0_0_8px_rgba(245,158,11,0.25)]">
                <i class="fa-solid fa-award text-[8px] text-amber-400"></i>${item.tierRanking.split(' ')[0]}
              </span>
            ` : ''}
            ${item.gearSlot ? `
              <span class="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border border-blue-500/60 bg-blue-950/80 text-blue-300 font-bold flex items-center gap-1 shadow-[0_0_8px_rgba(59,130,246,0.25)]">
                <i class="fa-solid fa-puzzle-piece text-[8px] text-blue-400"></i>${item.gearSlot}
              </span>
            ` : ''}
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[10px] font-mono uppercase px-2 py-0.5 rounded border ${rar.bg} ${rar.text} ${rar.border} font-bold flex items-center space-x-1">
              <span class="w-1.5 h-1.5 rounded-full ${rar.dot} inline-block"></span>
              <span>${item.rarity}</span>
            </span>
            <button 
              type="button"
              onclick="toggleFavorite('${item.id}', event)" 
              title="Oblíbené / Favorite"
              class="p-1 text-slate-400 hover:text-amber-400 focus:outline-none"
            >
              <i id="fav-star-${item.id}" class="${isFav ? 'fa-solid fa-star text-amber-400' : 'fa-regular fa-star text-slate-500 hover:text-amber-400'} text-xs transition-transform hover:scale-125"></i>
            </button>
          </div>
        </div>

        <!-- Title & Secondary Name -->
        <h3 class="font-orbitron font-bold text-base text-white group-hover:text-hud-cyan transition leading-tight mb-0.5">
          ${primaryName}
        </h3>
        <div class="text-xs font-mono text-slate-400 mb-3">${secondaryName}</div>

        <!-- Stats Ribbon (Energy, Hydration, Duration) -->
        ${(item.energy > 0 || item.hydration > 0 || item.buffDuration) ? `
          <div class="flex items-center space-x-3 text-[11px] font-mono bg-hud-bg/80 border border-hud-border px-3 py-1.5 rounded mb-3">
            ${item.energy > 0 ? `<span class="text-amber-400"><i class="fa-solid fa-bolt mr-1"></i>${item.energy} E</span>` : ''}
            ${item.hydration > 0 ? `<span class="text-hud-cyan"><i class="fa-solid fa-droplet mr-1"></i>${item.hydration} H</span>` : ''}
            ${item.buffDuration ? `<span class="text-slate-300 ml-auto"><i class="fa-regular fa-clock mr-1"></i>${item.buffDuration}</span>` : ''}
          </div>
        ` : ''}

        <!-- Effects Checklist -->
        <div class="space-y-1.5 mb-4">
          ${effects.map(effect => `
            <div class="text-xs text-slate-300 flex items-start space-x-1.5">
              <i class="fa-solid fa-caret-right text-hud-cyan mt-0.5 text-[10px] shrink-0"></i>
              <span class="leading-relaxed">${effect}</span>
            </div>
          `).join('')}
        </div>

        <!-- Unique Weapon Perk or Set Synergy Preview -->
        ${item.uniquePerkCs ? `
          <div class="mb-3 p-2.5 bg-amber-950/30 border border-amber-500/40 rounded text-xs text-amber-200 leading-snug">
            <span class="text-[10px] uppercase font-bold text-amber-400 block mb-1 flex items-center gap-1">
              <i class="fa-solid fa-star text-[9px]"></i>${currentLang === 'cs' ? 'Unikátní perk zbraně' : 'Unique Weapon Perk'}
            </span>
            ${currentLang === 'cs' ? item.uniquePerkCs : item.uniquePerkEn}
          </div>
        ` : ''}
        ${item.recommendedGearCs || item.recommendedWeaponsCs ? `
          <div class="mb-3 text-[11px] font-mono text-cyan-300 p-1.5 bg-hud-bg/80 border border-hud-border rounded flex items-center gap-1.5">
            <i class="fa-solid fa-link text-hud-cyan text-[10px]"></i>
            <span class="text-slate-400">${currentLang === 'cs' ? 'Synergie' : 'Synergy'}:</span>
            <strong class="text-white truncate">${currentLang === 'cs' ? (item.recommendedGearCs || item.recommendedWeaponsCs) : (item.recommendedGearEn || item.recommendedWeaponsEn)}</strong>
          </div>
        ` : ''}

        <!-- Deviant Ability Preview -->
        ${item.skillCs ? `
          <div class="mb-3 p-2.5 bg-slate-900/90 border border-hud-cyan/40 rounded text-xs text-slate-200 leading-snug">
            <span class="text-[10px] uppercase font-bold text-hud-cyan block mb-1 flex items-center gap-1">
              <i class="fa-solid fa-ghost text-[9px]"></i>${currentLang === 'cs' ? 'Schopnost Devianta' : 'Deviant Ability'}
            </span>
            ${currentLang === 'cs' ? item.skillCs : item.skillEn}
          </div>
        ` : ''}
        ${item.cradleSynergyCs ? `
          <div class="mb-3 text-[11px] font-mono text-emerald-300 p-1.5 bg-hud-bg/80 border border-emerald-500/40 rounded flex items-center gap-1.5">
            <i class="fa-solid fa-dna text-emerald-400 text-[10px]"></i>
            <span class="text-slate-400">Cradle:</span>
            <strong class="text-emerald-200 truncate">${currentLang === 'cs' ? item.cradleSynergyCs : item.cradleSynergyEn}</strong>
          </div>
        ` : ''}

        <!-- Zone / Region Monolith Boss & Mystic Crates Preview -->
        ${item.monolithBossCs ? `
          <div class="mb-2 text-[11px] font-mono text-amber-300 p-2 bg-amber-950/30 border border-amber-500/40 rounded flex items-center justify-between gap-1.5">
            <span class="text-slate-400 flex items-center gap-1.5 truncate">
              <i class="fa-solid fa-skull text-amber-400 text-[10px] shrink-0"></i>
              <span>${currentLang === 'cs' ? 'Boss' : 'Boss'}:</span>
              <strong class="text-white truncate">${currentLang === 'cs' ? item.monolithBossCs : item.monolithBossEn}</strong>
            </span>
            ${item.silosCs ? `<span class="text-[9px] font-mono text-hud-cyan shrink-0 border border-cyan-800/80 px-1 py-0.2 rounded bg-cyan-950/60">${currentLang === 'cs' ? 'Silo' : 'Silo'}</span>` : ''}
          </div>
        ` : ''}
        ${item.mysticCratesCs && item.mysticCratesCs.length > 0 ? `
          <div class="mb-3 text-[11px] font-mono text-purple-300 p-1.5 bg-purple-950/30 border border-purple-500/40 rounded flex items-center justify-between">
            <span class="text-slate-300 flex items-center gap-1.5">
              <i class="fa-solid fa-box-open text-purple-400 text-[10px]"></i>
              ${currentLang === 'cs' ? 'Mystické truhly' : 'Mystic Crates'}:
            </span>
            <strong class="text-hud-cyan font-bold">${item.mysticCratesCs.length}</strong>
          </div>
        ` : ''}

        <!-- Fishing Habitat & Preferred Bait Preview -->
        ${item.preferredBaitCs ? `
          <div class="mb-3 p-2.5 bg-cyan-950/40 border border-cyan-500/40 rounded text-xs text-cyan-200 leading-snug">
            <div class="flex items-center justify-between mb-1">
              <span class="text-[10px] uppercase font-bold text-cyan-400 flex items-center gap-1">
                <i class="fa-solid fa-worm text-[9px]"></i>${currentLang === 'cs' ? 'Návnada' : 'Bait'}:
              </span>
              <span class="font-mono text-[11px] text-white font-semibold">${currentLang === 'cs' ? item.preferredBaitCs : item.preferredBaitEn}</span>
            </div>
            ${item.culinaryUseCs ? `
              <div class="text-[11px] text-slate-300 border-t border-cyan-800/50 pt-1 mt-1 truncate" title="${currentLang === 'cs' ? item.culinaryUseCs : item.culinaryUseEn}">
                <i class="fa-solid fa-utensils text-cyan-400 text-[9px] mr-1"></i>${currentLang === 'cs' ? item.culinaryUseCs : item.culinaryUseEn}
              </div>
            ` : ''}
          </div>
        ` : ''}

        <!-- Boss Weakspots & Recommended Archetypes Preview -->
        ${item.weakspotsCs ? `
          <div class="mb-3 p-2.5 bg-red-950/30 border border-red-500/40 rounded text-xs text-red-200 leading-snug">
            <div class="flex items-center gap-1 text-[10px] uppercase font-bold text-red-400 mb-1">
              <i class="fa-solid fa-crosshairs text-[9px]"></i>${currentLang === 'cs' ? 'Weakspot' : 'Weakspot'}:
              <span class="text-white font-normal truncate">${currentLang === 'cs' ? item.weakspotsCs : item.weakspotsEn}</span>
            </div>
            ${item.recommendedArchetypesCs ? `
              <div class="text-[11px] font-mono text-amber-300 border-t border-red-800/50 pt-1 mt-1 flex items-center gap-1.5 truncate">
                <i class="fa-solid fa-bullseye text-amber-400 text-[9px]"></i>
                <span class="text-slate-400">${currentLang === 'cs' ? 'Doporučený build' : 'Recommended'}:</span>
                <strong class="text-amber-200 truncate">${currentLang === 'cs' ? item.recommendedArchetypesCs : item.recommendedArchetypesEn}</strong>
              </div>
            ` : ''}
          </div>
        ` : ''}

        <!-- Memetic Specialization Preview -->
        ${item.levelBracket ? `
          <div class="mb-3 p-2.5 bg-purple-950/40 border border-purple-500/40 rounded text-xs text-purple-200 leading-snug">
            <div class="flex items-center justify-between mb-1">
              <span class="text-[10px] uppercase font-bold text-purple-400 flex items-center gap-1">
                <i class="fa-solid fa-layer-group text-[9px]"></i>${currentLang === 'cs' ? 'Milník (Bracket)' : 'Level Bracket'}:
              </span>
              <span class="font-mono text-[11px] text-white font-semibold">${item.levelBracket}</span>
            </div>
            ${item.tierRanking ? `
              <div class="text-[11px] text-amber-300 border-t border-purple-800/50 pt-1 mt-1 flex items-center gap-1.5">
                <i class="fa-solid fa-trophy text-amber-400 text-[9px]"></i>
                <strong class="text-amber-200">${item.tierRanking}</strong>
              </div>
            ` : ''}
          </div>
        ` : ''}

        <!-- Gear Mod Slot & Sub-Stat Priority Preview -->
        ${item.gearSlot ? `
          <div class="mb-3 p-2.5 bg-blue-950/40 border border-blue-500/40 rounded text-xs text-blue-200 leading-snug">
            <div class="flex items-center justify-between mb-1">
              <span class="text-[10px] uppercase font-bold text-blue-400 flex items-center gap-1">
                <i class="fa-solid fa-puzzle-piece text-[9px]"></i>${currentLang === 'cs' ? 'Slot & Archetyp' : 'Slot & Archetype'}:
              </span>
              <span class="font-mono text-[11px] text-white font-semibold">${item.gearSlot} • ${currentLang === 'cs' ? (item.modArchetypeCs || '') : (item.modArchetypeEn || '')}</span>
            </div>
            ${item.subStatsPriorityCs ? `
              <div class="text-[10px] text-slate-300 font-mono border-t border-blue-800/50 pt-1 mt-1 truncate" title="${currentLang === 'cs' ? item.subStatsPriorityCs : item.subStatsPriorityEn}">
                <i class="fa-solid fa-list-ol text-blue-400 text-[9px] mr-1"></i>${currentLang === 'cs' ? item.subStatsPriorityCs : item.subStatsPriorityEn}
              </div>
            ` : ''}
          </div>
        ` : ''}

        <!-- Ingredients with boundary-safe tooltips -->
        <div class="mb-3">
          <span class="text-[10px] font-mono uppercase text-slate-500 tracking-wider block mb-1.5 flex items-center justify-between">
            <span><i class="fa-solid fa-layer-group text-hud-cyan mr-1"></i>${t.materialsTitle}</span>
            <span class="text-[9px] text-amber-400 font-mono">${t.keyIngr} ${primaryIng.name.split(' ')[0]}</span>
          </span>
          <div class="flex flex-wrap gap-1.5">
            ${ingredients.map(ing => {
              const meta = getIngredientMeta(ing.name);
              const isCrafted = meta && meta.recipeId;
              const escapedName = ing.name.replace(/'/g, "\\'");
              
              return `
                <div class="inline-block">
                  <span 
                    onmouseenter="showPortalTooltip(this, '${escapedName}')"
                    onmouseleave="scheduleHidePortalTooltip()"
                    ${isCrafted ? `onclick="event.stopPropagation(); navigateToRecipe('${meta.recipeId}');"` : ''}
                    class="text-[11px] font-mono px-2 py-0.5 rounded bg-hud-bg border transition-all inline-flex items-center gap-1 ${
                      isCrafted 
                        ? 'border-hud-cyan/70 text-hud-cyan hover:bg-hud-cyan/20 cursor-pointer shadow-[0_0_8px_rgba(0,240,255,0.2)]' 
                        : ing.isPrimary 
                          ? 'border-amber-500/50 text-amber-300 font-semibold cursor-help' 
                          : 'border-hud-border text-slate-300 cursor-help'
                    }">
                    ${isCrafted ? '<i class="fa-solid fa-wrench text-[9px] text-hud-cyan"></i>' : ''}${ing.name} <span class="text-hud-cyan font-bold ml-1">${ing.amount}</span>
                  </span>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <!-- Source location badge -->
        <div class="mb-2 bg-slate-900/60 p-2 rounded border border-slate-800 text-[11px] font-mono text-slate-400">
          <span class="text-slate-500 block text-[9px] uppercase"><i class="fa-solid fa-location-crosshairs text-hud-cyan mr-1"></i>${t.sourceTitle}:</span>
          <span class="text-slate-300">${source}</span>
        </div>
      </div>

      <!-- Card Footer Action -->
      <div class="pt-3 border-t border-hud-border flex items-center justify-between text-xs font-mono text-slate-400">
        <span class="truncate max-w-[200px]" title="${item.workbench}">
          <i class="fa-solid fa-toolbox text-hud-cyan mr-1"></i>${item.workbench}
        </span>
        <div class="flex items-center gap-2">
          <button 
            type="button"
            onclick="addToQueue('${item.id}', 1, event)" 
            title="Přidat do plánu / Add to plan"
            class="px-2 py-0.5 rounded bg-slate-800 hover:bg-cyan-950 border border-slate-700 hover:border-hud-cyan text-hud-cyan text-[11px] font-mono flex items-center gap-1 transition cursor-pointer"
          >
            <i class="fa-solid fa-plus text-[9px]"></i>
            <span>Plán</span>
          </button>
          <button onclick="openModal('${item.id}', false)" class="text-hud-cyan hover:text-cyan-300 hover:underline flex items-center gap-1 font-sans text-xs">
            ${t.detailBtn} <i class="fa-solid fa-up-right-from-square text-[10px]"></i>
          </button>
        </div>
      </div>
    `;

    fragment.appendChild(card);
  });

  container.appendChild(fragment);
}

/* ==========================================================================
   DETAIL MODAL, RECIPE CROSS-LINKING & BREADCRUMBS
   ========================================================================== */
function openModal(id, pushHistory = false) {
  const all = getAllRecipes();
  const item = all.find(i => i.id === id);
  if (!item) return;

  if (!pushHistory) {
    modalHistory = [id];
  } else {
    if (modalHistory[modalHistory.length - 1] !== id) {
      modalHistory.push(id);
    }
  }

  // Sync modal state to URL hash
  updateUrlHash('recipe', id);

  const modal = document.getElementById('detail-modal');
  const content = document.getElementById('modal-content');
  const rar = rarityConfig[item.rarity] || rarityConfig.Common;
  const t = i18n[currentLang];

  const primaryName = currentLang === 'cs' ? item.nameCs : item.nameEn;
  const secondaryName = currentLang === 'cs' ? item.nameEn : item.nameCs;
  const categoryText = currentLang === 'cs' ? item.categoryCs : item.categoryEn;
  const effects = currentLang === 'cs' ? item.effectsCs : item.effectsEn;
  const ingredients = currentLang === 'cs' ? item.ingredientsCs : item.ingredientsEn;
  const desc = currentLang === 'cs' ? item.descriptionCs : item.descriptionEn;
  const source = currentLang === 'cs' ? (item.sourceCs || 'Naleziště ve hře') : (item.sourceEn || 'World Discovery');
  const isFav = isFavorite(item.id);

  const hasHistory = modalHistory.length > 1;
  const previousRecipeId = hasHistory ? modalHistory[modalHistory.length - 2] : null;
  const previousRecipe = previousRecipeId ? findRecipeById(previousRecipeId) : null;
  const previousName = previousRecipe ? (currentLang === 'cs' ? previousRecipe.nameCs : previousRecipe.nameEn) : '';

  content.innerHTML = `
    <!-- History / Back Breadcrumb -->
    ${hasHistory ? `
      <div class="mb-3">
        <button onclick="goBackInModal()" class="text-xs font-mono text-hud-cyan hover:text-cyan-200 bg-cyan-950/60 border border-hud-cyan/40 rounded px-2.5 py-1 flex items-center gap-1.5 transition">
          <i class="fa-solid fa-arrow-left"></i>
          <span>${t.backToRecipe}: <strong class="text-white">${previousName}</strong></span>
        </button>
      </div>
    ` : ''}

    <div class="flex items-center justify-between mb-2">
      <div class="flex items-center gap-2">
        <span class="px-2.5 py-0.5 rounded text-[11px] font-mono font-bold border ${rar.bg} ${rar.text} ${rar.border}">
          ${item.rarity}
        </span>
        <span class="text-xs font-mono uppercase text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
          ${categoryText}
        </span>
        <span class="text-xs font-mono uppercase text-hud-cyan bg-cyan-950/80 border border-cyan-800 px-2 py-0.5 rounded">
          ${item.scenario.toUpperCase()}
        </span>
      </div>
      <button 
        type="button"
        onclick="toggleFavorite('${item.id}', event)" 
        title="Oblíbené / Favorite"
        class="p-1 text-slate-400 hover:text-amber-400 focus:outline-none"
      >
        <i id="modal-fav-star-${item.id}" class="${isFav ? 'fa-solid fa-star text-amber-400' : 'fa-regular fa-star text-slate-500 hover:text-amber-400'} text-lg transition-transform hover:scale-125"></i>
      </button>
    </div>

    <h2 class="text-xl font-orbitron font-bold text-white">${primaryName}</h2>
    <h4 class="text-sm font-rajdhani font-semibold text-hud-cyan mb-3">${secondaryName}</h4>

    <div class="bg-hud-bg/90 border border-hud-border p-3 rounded-lg mb-4 text-xs text-slate-300 italic">
      "${desc}"
    </div>

    <div class="mb-3">
      <h5 class="text-xs font-mono uppercase text-slate-400 mb-2 flex items-center gap-1.5">
        <i class="fa-solid fa-bolt text-hud-cyan"></i> ${t.effectsTitle}
      </h5>
      <div class="space-y-1.5">
        ${effects.map(e => `
          <div class="p-2 rounded bg-slate-800/60 border border-slate-700/60 text-xs text-slate-200 flex items-start gap-2">
            <i class="fa-solid fa-chevron-right text-hud-cyan mt-0.5 text-[10px]"></i>
            <span>${e}</span>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Weapon Archetype, Unique Perk & Synergy Section -->
    ${item.archetype ? `
      <div class="mb-4 p-3.5 bg-slate-900/90 border border-amber-500/60 rounded-lg shadow-[0_0_15px_rgba(245,158,11,0.15)]">
        <div class="flex items-center justify-between mb-2 flex-wrap gap-1.5">
          <span class="text-xs font-orbitron font-bold text-amber-400 flex items-center gap-1.5">
            <i class="fa-solid fa-crosshairs text-amber-400"></i>
            ${currentLang === 'cs' ? 'Bojový archetyp' : 'Combat Archetype'}: ${currentLang === 'cs' ? (item.archetypeCs || item.archetype) : item.archetype}
          </span>
          <div class="flex items-center gap-1.5">
            ${item.weaponType ? `<span class="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-200 border border-slate-700">${currentLang === 'cs' ? (item.weaponTypeCs || item.weaponType) : item.weaponType}</span>` : ''}
            ${item.caliber ? `<span class="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-950/80 text-amber-300 border border-amber-500/60 font-bold">${item.caliber}</span>` : ''}
          </div>
        </div>
        ${item.uniquePerkCs ? `
          <div class="text-xs text-amber-200 bg-amber-950/40 p-3 rounded border border-amber-500/40 mb-2 leading-relaxed">
            <strong class="block text-amber-400 mb-1 text-xs uppercase flex items-center gap-1">
              <i class="fa-solid fa-award"></i>${currentLang === 'cs' ? 'Legendární unikátní perk zbraně' : 'Legendary Unique Weapon Perk'}
            </strong>
            ${currentLang === 'cs' ? item.uniquePerkCs : item.uniquePerkEn}
          </div>
        ` : ''}
        ${item.recommendedGearCs || item.recommendedWeaponsCs ? `
          <div class="text-xs text-slate-300 font-mono bg-hud-bg/90 p-2.5 rounded border border-hud-border flex items-center justify-between flex-wrap gap-1.5">
            <span class="text-slate-400 flex items-center gap-1">
              <i class="fa-solid fa-link text-hud-cyan"></i>
              ${currentLang === 'cs' ? 'Doporučené synergie & sety zbrojí' : 'Recommended Synergies & Sets'}:
            </span>
            <strong class="text-hud-cyan">${currentLang === 'cs' ? (item.recommendedGearCs || item.recommendedWeaponsCs) : (item.recommendedGearEn || item.recommendedWeaponsEn)}</strong>
          </div>
        ` : ''}
      </div>
    ` : ''}

    <!-- Deviant Containment, Ability & Cradle Synergy Section -->
    ${item.deviantType ? `
      <div class="mb-4 p-4 bg-slate-900/90 border border-hud-cyan/60 rounded-lg shadow-[0_0_20px_rgba(0,240,255,0.15)]">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <span class="text-xs font-orbitron font-bold text-white flex items-center gap-1.5">
            <i class="fa-solid fa-ghost text-hud-cyan"></i>
            ${currentLang === 'cs' ? (item.categoryCs || 'Deviant') : (item.categoryEn || 'Deviant')} • <span class="text-hud-cyan">${primaryName}</span>
          </span>
          <span class="text-[10px] font-mono px-2 py-0.5 rounded ${
            item.deviantType === 'combat' ? 'bg-red-950/80 text-red-300 border border-red-500/60' : item.deviantType === 'territory' ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/60' : 'bg-cyan-950/80 text-cyan-300 border border-cyan-500/60'
          } font-bold uppercase">
            ${currentLang === 'cs' ? (item.deviantTypeCs || item.categoryCs) : (item.deviantTypeEn || item.categoryEn)}
          </span>
        </div>

        <!-- Skill & Active function -->
        ${item.skillCs ? `
          <div class="text-xs text-slate-200 bg-slate-800/80 p-3 rounded border border-hud-cyan/40 mb-3 leading-relaxed">
            <strong class="block text-hud-cyan mb-1 text-xs uppercase font-mono flex items-center gap-1.5">
              <i class="fa-solid fa-bolt"></i>${currentLang === 'cs' ? (t.deviantSkillTitle || 'Aktivní / Teritoriální schopnost:') : (t.deviantSkillTitle || 'Active / Territory Skill:')}
            </strong>
            ${currentLang === 'cs' ? item.skillCs : item.skillEn}
          </div>
        ` : ''}

        <!-- Containment Unit Optimal Requirements -->
        ${item.containmentCs ? `
          <div class="mb-3 bg-hud-bg/90 p-3 rounded border border-hud-border">
            <span class="text-[10px] font-mono uppercase text-slate-400 font-bold block mb-2 flex items-center justify-between">
              <span><i class="fa-solid fa-box text-hud-cyan mr-1"></i>${t.deviantContainmentTitle || 'Podmínky Securement Unit (Uchovávání)'}</span>
              <span class="text-hud-cyan font-bold">${currentLang === 'cs' ? item.containmentCs.regenRate : item.containmentEn.regenRate}</span>
            </span>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-mono text-slate-300">
              <div class="p-1.5 rounded bg-slate-800/60 border border-slate-700/60 flex items-center gap-2">
                <i class="fa-solid fa-lightbulb text-amber-400 shrink-0"></i>
                <span><strong>${currentLang === 'cs' ? 'Světlo' : 'Light'}:</strong> ${currentLang === 'cs' ? item.containmentCs.lighting : item.containmentEn.lighting}</span>
              </div>
              <div class="p-1.5 rounded bg-slate-800/60 border border-slate-700/60 flex items-center gap-2">
                <i class="fa-solid fa-temperature-half text-cyan-400 shrink-0"></i>
                <span><strong>${currentLang === 'cs' ? 'Teplota' : 'Temp'}:</strong> ${currentLang === 'cs' ? item.containmentCs.temperature : item.containmentEn.temperature}</span>
              </div>
              <div class="p-1.5 rounded bg-slate-800/60 border border-slate-700/60 flex items-center gap-2">
                <i class="fa-solid fa-music text-purple-400 shrink-0"></i>
                <span><strong>${currentLang === 'cs' ? 'Zvuk' : 'Audio'}:</strong> ${currentLang === 'cs' ? item.containmentCs.music : item.containmentEn.music}</span>
              </div>
              <div class="p-1.5 rounded bg-slate-800/60 border border-slate-700/60 flex items-center gap-2">
                <i class="fa-solid fa-seedling text-emerald-400 shrink-0"></i>
                <span><strong>${currentLang === 'cs' ? 'Okolí' : 'Surroundings'}:</strong> ${currentLang === 'cs' ? item.containmentCs.surroundings : item.containmentEn.surroundings}</span>
              </div>
            </div>
          </div>
        ` : ''}

        <!-- Cradle Synergy -->
        ${item.cradleSynergyCs ? `
          <div class="p-2.5 rounded bg-emerald-950/40 border border-emerald-500/50 text-xs text-emerald-200 flex items-start gap-2">
            <i class="fa-solid fa-dna text-emerald-400 mt-0.5 shrink-0"></i>
            <div>
              <strong class="block text-emerald-300 text-[10px] uppercase font-mono">${t.cradleSynergyTitle || 'Doporučená Cradle synergie:'}</strong>
              <span>${currentLang === 'cs' ? item.cradleSynergyCs : item.cradleSynergyEn}</span>
            </div>
          </div>
        ` : ''}
      </div>
    ` : ''}

    <!-- Zone Explorer & Map Guide Section -->
    ${item.zoneType ? `
      <div class="mb-4 p-4 bg-slate-900/90 border border-hud-cyan/60 rounded-lg shadow-[0_0_20px_rgba(0,240,255,0.15)]">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <span class="text-xs font-orbitron font-bold text-white flex items-center gap-1.5">
            <i class="fa-solid fa-map-location-dot text-hud-cyan"></i>
            ${currentLang === 'cs' ? (item.categoryCs || 'Zóna') : (item.categoryEn || 'Zone')} • <span class="text-hud-cyan">${primaryName}</span>
          </span>
          <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-500/60 font-bold uppercase">
            ${item.levelRange || 'Explore'}
          </span>
        </div>

        <!-- Monolith Boss & Silos Overview -->
        ${(item.monolithBossCs || item.silosCs) ? `
          <div class="mb-3 bg-hud-bg/90 p-3 rounded border border-hud-border">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono">
              ${item.monolithBossCs ? `
                <div class="p-2 rounded bg-amber-950/30 border border-amber-500/40 text-amber-200">
                  <span class="text-[10px] text-amber-400 font-bold uppercase block mb-0.5 flex items-center gap-1">
                    <i class="fa-solid fa-skull"></i>${t.monolithBossTitle || 'Monolit & Hlavní boss:'}
                  </span>
                  <strong>${currentLang === 'cs' ? item.monolithBossCs : item.monolithBossEn}</strong>
                </div>
              ` : ''}
              ${item.silosCs ? `
                <div class="p-2 rounded bg-cyan-950/30 border border-hud-cyan/40 text-cyan-200">
                  <span class="text-[10px] text-hud-cyan font-bold uppercase block mb-0.5 flex items-center gap-1">
                    <i class="fa-solid fa-dungeon"></i>${t.silosTitle || 'Přidružená Sila a Dungeony:'}
                  </span>
                  <strong>${currentLang === 'cs' ? item.silosCs : item.silosEn}</strong>
                </div>
              ` : ''}
            </div>
          </div>
        ` : ''}

        <!-- Mystic Crates Breakdown -->
        ${item.mysticCratesCs && item.mysticCratesCs.length > 0 ? `
          <div class="mb-3 bg-purple-950/20 p-3 rounded border border-purple-500/40">
            <span class="text-[10px] font-mono uppercase text-purple-300 font-bold block mb-2 flex items-center gap-1.5">
              <i class="fa-solid fa-box-open text-hud-purple"></i>
              ${t.mysticCratesTitle || 'Lokace Mystických truhel (Mystic Crates):'}
            </span>
            <div class="space-y-1.5">
              ${(currentLang === 'cs' ? item.mysticCratesCs : item.mysticCratesEn).map(c => `
                <div class="p-2 rounded bg-slate-800/60 border border-slate-700/60 text-xs text-slate-200 flex items-start gap-2">
                  <i class="fa-solid fa-gem text-hud-purple mt-0.5 text-[10px] shrink-0"></i>
                  <span>${c}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <!-- Key Loot, Blueprints & Deviants -->
        ${item.keyLootCs && item.keyLootCs.length > 0 ? `
          <div class="p-3 rounded bg-emerald-950/30 border border-emerald-500/40 text-xs">
            <span class="text-[10px] font-mono uppercase text-emerald-300 font-bold block mb-2 flex items-center gap-1.5">
              <i class="fa-solid fa-gift text-emerald-400"></i>
              ${t.keyLootTitle || 'Klíčový loot, mody & Devianti:'}
            </span>
            <div class="space-y-1 text-slate-300 font-mono text-[11px]">
              ${(currentLang === 'cs' ? item.keyLootCs : item.keyLootEn).map(l => `
                <div class="flex items-start gap-1.5">
                  <i class="fa-solid fa-check text-emerald-400 mt-0.5 text-[9px] shrink-0"></i>
                  <span>${l}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    ` : ''}

    <!-- Fishing Guide, Bait & Habitat Section -->
    ${item.preferredBaitCs || item.habitatCs ? `
      <div class="mb-4 p-4 bg-slate-900/90 border border-cyan-500/60 rounded-lg shadow-[0_0_20px_rgba(6,182,212,0.15)]">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <span class="text-xs font-orbitron font-bold text-white flex items-center gap-1.5">
            <i class="fa-solid fa-fish-fins text-hud-cyan"></i>
            ${currentLang === 'cs' ? (item.categoryCs || 'Rybolov') : (item.categoryEn || 'Fishing')} • <span class="text-hud-cyan">${primaryName}</span>
          </span>
          ${item.tradingValueCs ? `
            <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-500/60 font-bold">
              <i class="fa-solid fa-coins mr-1 text-amber-400"></i>${currentLang === 'cs' ? item.tradingValueCs : item.tradingValueEn}
            </span>
          ` : ''}
        </div>

        <div class="space-y-2 text-xs font-mono mb-3">
          ${item.preferredBaitCs ? `
            <div class="p-2.5 rounded bg-hud-bg/90 border border-hud-border flex items-start gap-2">
              <i class="fa-solid fa-worm text-amber-400 mt-0.5 shrink-0"></i>
              <div>
                <strong class="block text-slate-400 text-[10px] uppercase">${t.baitLabel || 'Doporučená návnada:'}</strong>
                <span class="text-white font-semibold">${currentLang === 'cs' ? item.preferredBaitCs : item.preferredBaitEn}</span>
              </div>
            </div>
          ` : ''}
          ${item.habitatCs ? `
            <div class="p-2.5 rounded bg-hud-bg/90 border border-hud-border flex items-start gap-2">
              <i class="fa-solid fa-water text-cyan-400 mt-0.5 shrink-0"></i>
              <div>
                <strong class="block text-slate-400 text-[10px] uppercase">${t.habitatLabel || 'Prostředí / Výskyt:'}</strong>
                <span class="text-slate-200">${currentLang === 'cs' ? item.habitatCs : item.habitatEn}</span>
              </div>
            </div>
          ` : ''}
          ${item.culinaryUseCs ? `
            <div class="p-2.5 rounded bg-amber-950/30 border border-amber-500/40 text-amber-200 flex items-start gap-2">
              <i class="fa-solid fa-utensils text-amber-400 mt-0.5 shrink-0"></i>
              <div>
                <strong class="block text-amber-400 text-[10px] uppercase font-bold">${currentLang === 'cs' ? 'Kulinářské / Herní využití:' : 'Culinary / Gameplay Usage:'}</strong>
                <span>${currentLang === 'cs' ? item.culinaryUseCs : item.culinaryUseEn}</span>
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    ` : ''}

    <!-- Boss Raid Tactics, Phases & Weakspots Section -->
    ${item.weakspotsCs || item.phasesCs ? `
      <div class="mb-4 p-4 bg-slate-900/90 border border-red-500/60 rounded-lg shadow-[0_0_20px_rgba(239,68,68,0.15)]">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <span class="text-xs font-orbitron font-bold text-white flex items-center gap-1.5">
            <i class="fa-solid fa-skull-crossbones text-red-400"></i>
            ${currentLang === 'cs' ? (item.categoryCs || 'Boss Taktika') : (item.categoryEn || 'Boss Tactics')} • <span class="text-red-300">${primaryName}</span>
          </span>
          ${item.monolithBossCs ? `
            <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-red-950/80 text-red-300 border border-red-500/60 font-bold uppercase">
              <i class="fa-solid fa-dungeon mr-1"></i>${currentLang === 'cs' ? item.monolithBossCs : item.monolithBossEn}
            </span>
          ` : ''}
        </div>

        ${item.weakspotsCs ? `
          <div class="mb-3 p-2.5 rounded bg-red-950/40 border border-red-500/50 text-xs text-red-200">
            <strong class="block text-red-400 text-[10px] uppercase font-mono flex items-center gap-1 mb-0.5">
              <i class="fa-solid fa-crosshairs"></i>${t.bossWeakspotsTitle || 'Slabá místa (Weakspots):'}
            </strong>
            <span class="font-bold text-white">${currentLang === 'cs' ? item.weakspotsCs : item.weakspotsEn}</span>
          </div>
        ` : ''}

        ${item.phasesCs && item.phasesCs.length > 0 ? `
          <div class="mb-3 bg-hud-bg/90 p-3 rounded border border-hud-border">
            <strong class="block text-slate-400 text-[10px] uppercase font-mono mb-2 flex items-center gap-1">
              <i class="fa-solid fa-diagram-project text-hud-cyan"></i>${t.bossPhasesTitle || 'Fázování a klíčové mechaniky:'}
            </strong>
            <div class="space-y-1.5">
              ${(currentLang === 'cs' ? item.phasesCs : item.phasesEn).map((phase, pIdx) => `
                <div class="p-2 rounded bg-slate-800/60 border border-slate-700/60 text-xs text-slate-200 flex items-start gap-2">
                  <span class="w-5 h-5 rounded-full bg-red-950 border border-red-500/60 text-red-300 text-[10px] font-bold font-mono flex items-center justify-center shrink-0 mt-0.5">
                    ${pIdx + 1}
                  </span>
                  <span class="leading-relaxed">${phase}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        ${item.recommendedArchetypesCs || item.recommendedDeviantsCs ? `
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono">
            ${item.recommendedArchetypesCs ? `
              <div class="p-2.5 rounded bg-amber-950/30 border border-amber-500/40 text-amber-200">
                <span class="text-[10px] text-amber-400 font-bold uppercase block mb-1 flex items-center gap-1">
                  <i class="fa-solid fa-gun"></i>${t.recommendedBuildsTitle || 'Doporučený archetyp:'}
                </span>
                <strong class="text-white">${currentLang === 'cs' ? item.recommendedArchetypesCs : item.recommendedArchetypesEn}</strong>
              </div>
            ` : ''}
            ${item.recommendedDeviantsCs ? `
              <div class="p-2.5 rounded bg-purple-950/30 border border-purple-500/40 text-purple-200">
                <span class="text-[10px] text-purple-400 font-bold uppercase block mb-1 flex items-center gap-1">
                  <i class="fa-solid fa-ghost"></i>${currentLang === 'cs' ? 'Doporučený Deviant:' : 'Recommended Deviant:'}
                </span>
                <strong class="text-white">${currentLang === 'cs' ? item.recommendedDeviantsCs : item.recommendedDeviantsEn}</strong>
              </div>
            ` : ''}
          </div>
        ` : ''}
      </div>
    ` : ''}

    <!-- Memetic Specialization Details Section -->
    ${item.levelBracket || item.tierRanking ? `
      <div class="mb-4 p-4 bg-slate-900/90 border border-purple-500/60 rounded-lg shadow-[0_0_20px_rgba(181,23,158,0.2)]">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <span class="text-xs font-orbitron font-bold text-white flex items-center gap-1.5">
            <i class="fa-solid fa-brain text-purple-400"></i>
            ${currentLang === 'cs' ? (item.categoryCs || 'Memetická specializace') : (item.categoryEn || 'Memetic Specialization')} • <span class="text-purple-300">${primaryName}</span>
          </span>
          <div class="flex items-center gap-1.5">
            ${item.levelBracket ? `
              <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-950/80 text-purple-300 border border-purple-500/60 font-bold uppercase">
                ${item.levelBracket}
              </span>
            ` : ''}
            ${item.tierRanking ? `
              <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-950/80 text-amber-300 border border-amber-500/60 font-bold uppercase">
                <i class="fa-solid fa-award mr-1 text-amber-400"></i>${item.tierRanking}
              </span>
            ` : ''}
          </div>
        </div>

        <div class="space-y-2 text-xs font-mono mb-3">
          ${item.resetItem ? `
            <div class="p-2.5 rounded bg-hud-bg/90 border border-hud-border flex items-start justify-between gap-2">
              <span class="text-slate-400 flex items-center gap-1.5">
                <i class="fa-solid fa-rotate-left text-hud-cyan text-[10px]"></i>
                ${t.memeticResetCostLabel || 'Resetovací předmět:'}
              </span>
              <strong class="text-white">${item.resetItem}</strong>
            </div>
          ` : ''}
        </div>
      </div>
    ` : ''}

    <!-- Weapon & Armor Mod Details Section -->
    ${item.gearSlot || item.subStatsPriorityCs ? `
      <div class="mb-4 p-4 bg-slate-900/90 border border-blue-500/60 rounded-lg shadow-[0_0_20px_rgba(59,130,246,0.2)]">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <span class="text-xs font-orbitron font-bold text-white flex items-center gap-1.5">
            <i class="fa-solid fa-puzzle-piece text-blue-400"></i>
            ${currentLang === 'cs' ? (item.categoryCs || 'Modifikace') : (item.categoryEn || 'Gear Mod')} • <span class="text-blue-300">${primaryName}</span>
          </span>
          <div class="flex items-center gap-1.5">
            ${item.gearSlot ? `
              <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-950/80 text-blue-300 border border-blue-500/60 font-bold uppercase">
                <i class="fa-solid fa-shield-halved mr-1"></i>Slot: ${item.gearSlot}
              </span>
            ` : ''}
            ${item.modArchetypeCs ? `
              <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-950/80 text-amber-300 border border-amber-500/60 font-bold">
                <i class="fa-solid fa-crosshairs mr-1 text-amber-400"></i>${currentLang === 'cs' ? item.modArchetypeCs : item.modArchetypeEn}
              </span>
            ` : ''}
          </div>
        </div>

        ${item.subStatsPriorityCs ? `
          <div class="mb-3 p-3 rounded bg-blue-950/30 border border-blue-500/40 text-xs">
            <strong class="block text-blue-400 text-[10px] uppercase font-mono flex items-center gap-1 mb-1.5">
              <i class="fa-solid fa-arrow-down-short-wide"></i>${t.modSubStatsLabel || 'Doporučené Sub-staty (Priority):'}
            </strong>
            <div class="font-mono text-slate-200 text-[11px] leading-relaxed p-2 rounded bg-slate-900/80 border border-slate-700">
              ${currentLang === 'cs' ? item.subStatsPriorityCs : item.subStatsPriorityEn}
            </div>
          </div>
        ` : ''}

        ${item.dropSourceCs ? `
          <div class="p-2.5 rounded bg-hud-bg/90 border border-hud-border flex items-start justify-between gap-2 text-xs font-mono">
            <span class="text-slate-400 flex items-center gap-1.5">
              <i class="fa-solid fa-location-dot text-hud-cyan text-[10px]"></i>
              ${t.modDropSourceLabel || 'Farma / Drop lokace:'}
            </span>
            <strong class="text-hud-cyan">${currentLang === 'cs' ? item.dropSourceCs : item.dropSourceEn}</strong>
          </div>
        ` : ''}
      </div>
    ` : ''}

    
    <!-- Technological Invention & Reverse Engineering Section -->
    ${item.researchInvention ? `
      <div class="mb-4 p-3.5 bg-purple-950/40 border border-purple-500/70 rounded-lg shadow-[0_0_15px_rgba(181,23,158,0.2)]">
        <div class="flex items-center justify-between mb-2 flex-wrap gap-1">
          <span class="text-xs font-orbitron font-bold text-purple-300 flex items-center gap-1.5">
            <i class="fa-solid fa-flask-vial text-hud-purple"></i>
            ${t.techInventionTitle}
          </span>
          <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-900/80 text-purple-200 border border-purple-400/60 font-bold">
            ${item.researchInvention.chance}
          </span>
        </div>
        <p class="text-[11px] font-sans text-slate-300 mb-2.5 leading-relaxed">
          ${t.techInventionDesc}
        </p>
        
        <div class="mb-3">
          <span class="text-[10px] font-mono uppercase text-purple-300 font-bold block mb-1.5 flex items-center justify-between">
            <span><i class="fa-solid fa-microchip text-hud-purple mr-1"></i>${t.inventionMaterials}</span>
            <span class="text-[9px] font-mono text-purple-400">Tech Research Bench Slot</span>
          </span>
          <div class="flex flex-wrap gap-1.5">
            ${(currentLang === 'cs' ? item.researchInvention.materialsCs : item.researchInvention.materialsEn).map(m => `
              <span class="text-[11px] font-mono px-2.5 py-1 rounded bg-hud-bg border border-purple-500/50 text-slate-200 inline-flex items-center gap-1.5 shadow-sm">
                <span>${m.name}</span>
                <strong class="text-hud-cyan font-bold">${m.amount}</strong>
              </span>
            `).join('')}
          </div>
        </div>

        <div class="pt-2 border-t border-purple-900/70 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-[11px] font-mono">
          <div class="text-slate-300 text-[10px] leading-relaxed">
            <i class="fa-solid fa-recycle text-hud-cyan mr-1"></i>
            <strong class="text-white">${t.reverseEngineeringLabel}</strong> ${currentLang === 'cs' ? item.researchInvention.reverseEngineeringCs : item.researchInvention.reverseEngineeringEn}
          </div>
          <button onclick="addInventionToQueue('${item.id}', 1, event)" class="px-2.5 py-1 bg-purple-900/60 hover:bg-purple-800 border border-purple-400/60 rounded text-purple-200 hover:text-white text-xs font-mono transition flex items-center gap-1 shrink-0 cursor-pointer">
            <i class="fa-solid fa-plus text-[10px]"></i>
            <span>${t.addInventionToQueueBtn}</span>
          </button>
        </div>
      </div>
    ` : ''}

    <!-- Detailed Ingredients breakdown with direct cross-links -->
    <div class="mb-4">
      <h5 class="text-xs font-mono uppercase text-slate-400 mb-2 flex items-center gap-1.5">
        <i class="fa-solid fa-cubes-stacked text-amber-400"></i> ${t.materialsTitle}
      </h5>
      <div class="space-y-2.5">
        ${ingredients.map(ing => {
          const meta = getIngredientMeta(ing.name);
          const isCrafted = meta && meta.recipeId;
          const subRecipe = isCrafted ? findRecipeById(meta.recipeId) : null;
          const subRecipeName = subRecipe ? (currentLang === 'cs' ? subRecipe.nameCs : subRecipe.nameEn) : '';
          const locText = meta ? (currentLang === 'cs' ? meta.locationCs : meta.locationEn) : (currentLang === 'cs' ? 'Naleziště v otevřeném světě (volný sběr nebo lov).' : 'Open world exploration, harvesting or hunting.');

          return `
            <div class="p-3 bg-hud-bg border ${isCrafted ? 'border-hud-cyan/50' : 'border-hud-border'} rounded-lg">
              <div class="flex items-center justify-between text-xs mb-1">
                <span class="${ing.isPrimary ? 'text-amber-300 font-semibold' : 'text-slate-200 font-medium'} flex items-center gap-1.5">
                  ${isCrafted ? '<i class="fa-solid fa-wrench text-hud-cyan text-xs"></i>' : '<i class="fa-solid fa-circle text-[6px] text-slate-500"></i>'}
                  ${ing.name}
                </span>
                <span class="font-mono font-bold text-hud-cyan">${ing.amount}</span>
              </div>
              
              <div class="text-[11px] text-slate-400 mt-1 pl-3 border-l-2 border-slate-700">
                <span class="text-slate-500 text-[10px] block uppercase font-mono">${t.locationWhereToFind}</span>
                <span class="text-slate-300">${locText}</span>
              </div>

              ${isCrafted && subRecipe ? `
                <div class="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between">
                  <span class="text-[11px] text-cyan-300 font-mono">
                    <i class="fa-solid fa-link text-hud-cyan mr-1"></i> ${t.craftedVia} <strong class="text-white">${subRecipeName}</strong>
                  </span>
                  <button 
                    type="button" 
                    onclick="navigateToRecipe('${meta.recipeId}')" 
                    class="px-2.5 py-1 bg-cyan-500/20 hover:bg-cyan-500/30 border border-hud-cyan/60 rounded text-[11px] font-mono text-hud-cyan hover:text-white flex items-center gap-1 transition cursor-pointer"
                  >
                    <span>${t.openRecipeBtn}</span>
                    <i class="fa-solid fa-arrow-right text-[9px]"></i>
                  </button>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <div class="mb-4 bg-slate-900/80 p-2.5 rounded-lg border border-hud-border text-xs font-mono">
      <span class="text-slate-400 block text-[10px] uppercase font-bold text-hud-cyan">${t.sourceTitle}:</span>
      <span class="text-slate-200">${source}</span>
    </div>

    <div class="pt-3 border-t border-hud-border flex items-center justify-between text-xs font-mono text-slate-400">
      <span>${t.workbenchLabel} <strong class="text-white">${item.workbench}</strong></span>
      <div class="flex items-center gap-2 flex-wrap">
        <button onclick="shareRecipeLink('${item.id}')" title="Kopírovat odkaz na recept / Share link" class="px-2.5 py-1.5 bg-hud-surface hover:bg-hud-bg border border-hud-border hover:border-hud-cyan rounded text-slate-300 hover:text-hud-cyan font-mono text-xs transition flex items-center gap-1.5 cursor-pointer">
          <i class="fa-solid fa-link text-xs text-hud-cyan"></i>
          <span class="hidden sm:inline">${t.shareBtn || 'Sdílet'}</span>
        </button>
        <button onclick="addToQueue('${item.id}', 1, event)" class="px-3 py-1.5 bg-cyan-950/80 hover:bg-cyan-900 border border-hud-cyan/60 rounded text-hud-cyan hover:text-white font-mono text-xs transition flex items-center gap-1.5 cursor-pointer">
          <i class="fa-solid fa-plus text-xs"></i>
          <span>${t.addToQueue}</span>
        </button>
        <button onclick="copyRecipeName('${item.nameEn}')" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded text-slate-300 hover:text-white transition cursor-pointer">
          <i class="fa-solid fa-copy mr-1"></i> ${t.copyBtn}
        </button>
      </div>
    </div>
  `;

  modal.classList.remove('hidden');
}

function goBackInModal() {
  if (modalHistory.length > 1) {
    modalHistory.pop();
    const prevId = modalHistory[modalHistory.length - 1];
    openModal(prevId, false);
  }
}

function closeModal() {
  document.getElementById('detail-modal').classList.add('hidden');
  modalHistory = [];
  updateUrlHash('tab', activeTab);
}

window.addEventListener('click', function(e) {
  const backupModal = document.getElementById('backup-modal');
  if (e.target === backupModal) closeBackupModal();
  const queueModal = document.getElementById('craft-queue-modal');
  if (e.target === queueModal) closeQueueModal();
  const modal = document.getElementById('detail-modal');
  if (e.target === modal) closeModal();
});

function copyRecipeName(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
  
  const t = i18n[currentLang];
  const copyNotice = document.createElement('div');
  copyNotice.className = "fixed bottom-5 right-5 bg-hud-cyan text-black font-mono font-bold px-4 py-2 rounded-lg shadow-lg z-50 text-xs";
  copyNotice.innerText = `${t.copiedNotice}: "${text}"`;
  document.body.appendChild(copyNotice);
  setTimeout(() => copyNotice.remove(), 2500);
}

function fallbackCopy(text) {
  const tempInput = document.createElement("input");
  tempInput.value = text;
  document.body.appendChild(tempInput);
  tempInput.select();
  document.execCommand("copy");
  document.body.removeChild(tempInput);
}

/* ==========================================================================
   GLOBAL BODY-LEVEL PORTAL TOOLTIP SYSTEM (ZERO CLIPPING GUARANTEE)
   ========================================================================== */
let tooltipHideTimer = null;
const portalTooltip = document.getElementById('global-portal-tooltip');

if (portalTooltip) {
  portalTooltip.addEventListener('mouseenter', () => {
    if (tooltipHideTimer) {
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }
  });

  portalTooltip.addEventListener('mouseleave', () => {
    scheduleHidePortalTooltip();
  });
}

function showPortalTooltip(triggerEl, ingName) {
  if (tooltipHideTimer) {
    clearTimeout(tooltipHideTimer);
    tooltipHideTimer = null;
  }

  const meta = getIngredientMeta(ingName);
  const isCrafted = meta && meta.recipeId;
  const t = i18n[currentLang];
  const locText = meta ? (currentLang === 'cs' ? meta.locationCs : meta.locationEn) : (currentLang === 'cs' ? 'Naleziště v otevřeném světě (sběr/lov/demontáž).' : 'Open world exploration or dismantling.');

  document.getElementById('portal-tooltip-name').innerText = ingName;
  document.getElementById('portal-tooltip-loc').innerText = locText;

  const actionBox = document.getElementById('portal-tooltip-action');
  const actionBtn = document.getElementById('portal-tooltip-btn');
  const actionBtnText = document.getElementById('portal-tooltip-btn-text');

  if (isCrafted) {
    actionBox.classList.remove('hidden');
    actionBtnText.innerText = t.craftedBadge;
    actionBtn.onclick = (e) => {
      e.stopPropagation();
      hidePortalTooltipNow();
      navigateToRecipe(meta.recipeId);
    };
  } else {
    actionBox.classList.add('hidden');
    actionBtn.onclick = null;
  }

  portalTooltip.classList.remove('hidden');
  portalTooltip.style.visibility = 'hidden';
  portalTooltip.style.opacity = '0';

  const triggerRect = triggerEl.getBoundingClientRect();
  const tooltipRect = portalTooltip.getBoundingClientRect();

  const tooltipWidth = tooltipRect.width || 290;
  const tooltipHeight = tooltipRect.height || 110;
  const margin = 12;

  let left = triggerRect.left + (triggerRect.width / 2) - (tooltipWidth / 2);
  if (left < margin) {
    left = margin;
  } else if (left + tooltipWidth > window.innerWidth - margin) {
    left = window.innerWidth - tooltipWidth - margin;
  }

  let top = triggerRect.top - tooltipHeight - 8;
  if (top < 75) {
    top = triggerRect.bottom + 8;
  }

  portalTooltip.style.left = `${left}px`;
  portalTooltip.style.top = `${top}px`;
  portalTooltip.style.visibility = 'visible';
  portalTooltip.style.opacity = '1';
}

function scheduleHidePortalTooltip() {
  if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
  tooltipHideTimer = setTimeout(() => {
    hidePortalTooltipNow();
  }, 180);
}

function hidePortalTooltipNow() {
  if (portalTooltip) {
    portalTooltip.style.opacity = '0';
    portalTooltip.classList.add('hidden');
  }
}

/* ==========================================================================
   CHEF MATRIX SYNERGY CALCULATOR LOGIC (MEAT ARCHETYPES)
   ========================================================================== */
function calculateSynergies() {
  const meatEl = document.getElementById('calc-slot-meat');
  const vegEl = document.getElementById('calc-slot-veg');
  const spiceEl = document.getElementById('calc-slot-spice');
  const enhEl = document.getElementById('calc-slot-enhancer');

  if (!meatEl || !vegEl || !spiceEl || !enhEl) return;

  const meat = meatEl.value;
  const veg = vegEl.value;
  const spice = spiceEl.value;
  const enh = enhEl.value;

  let energy = 10;
  let hydro = 10;
  let effectsCs = [];
  let effectsEn = [];
  let titleCs = "Běžný polní pokrm";
  let titleEn = "Basic Field Ration";

  if (meat === 'deer') {
    energy += 30;
    effectsCs.push("⚔️ Shrapnel & Melee: +3% Melee DMG & Shrapnel Crit");
    effectsEn.push("⚔️ Shrapnel & Melee: +3% Melee DMG & Shrapnel Crit");
  } else if (meat === 'rabbit') {
    energy += 35;
    effectsCs.push("⚡ Fast Gunner: +3% Attack while in Fast Gunner state");
    effectsEn.push("⚡ Fast Gunner: +3% Attack while in Fast Gunner state");
  } else if (meat === 'pork') {
    energy += 45;
    effectsCs.push("💣 Unstable Bomber: +3% Bomber DMG");
    effectsEn.push("💣 Unstable Bomber: +3% Bomber DMG");
  } else if (meat === 'goat') {
    energy += 40;
    effectsCs.push("🔥 Burn Archetyp: +3% Burn DMG");
    effectsEn.push("🔥 Burn Archetype: +3% Burn DMG");
  } else if (meat === 'bear') {
    energy += 50;
    effectsCs.push("🛡️ Fortress Archetyp: +3% Shrapnel DMG & Max HP +250");
    effectsEn.push("🛡️ Fortress Archetype: +3% Shrapnel DMG & Max HP +250");
  } else if (meat === 'polar_bear') {
    energy += 55;
    effectsCs.push("❄️ Way of Winter Cryo: Frost Vortex DMG +25% & Cold RES +30");
    effectsEn.push("❄️ Way of Winter Cryo: Frost Vortex DMG +25% & Cold RES +30");
  } else if (meat === 'croc') {
    energy += 45;
    effectsCs.push("⚡ Shock Archetyp: +4% Shock DMG");
    effectsEn.push("⚡ Shock Archetype: +4% Shock DMG");
  } else if (meat === 'turtle') {
    energy += 40;
    effectsCs.push("🏰 Fortress Warfare: +3% DMG while in Fortress Warfare");
    effectsEn.push("🏰 Fortress Warfare: +3% DMG while in Fortress Warfare");
  } else if (meat === 'fish') {
    energy += 35;
    hydro += 10;
    effectsCs.push("🎯 Precision: Crit Rate +5% & Weakspot +10%");
    effectsEn.push("🎯 Precision: Crit Rate +5% & Weakspot +10%");
  }

  if (veg === 'corn') {
    energy += 25;
    hydro += 15;
    effectsCs.push("Stamina regen +15%");
    effectsEn.push("Stamina regen +15%");
  } else if (veg === 'deviated_saffron') {
    energy += 30;
    effectsCs.push("🌿 Saffron Catalyst: +40% k bonusům ostatních plodin");
    effectsEn.push("🌿 Saffron Catalyst: +40% Crop bonus magnitude");
  } else if (veg === 'deviated_pumpkin') {
    energy += 30;
    effectsCs.push("PSI Intensity +10%");
    effectsEn.push("PSI Intensity +10%");
  } else if (veg === 'mushrooms') {
    energy += 20;
    hydro += 10;
    effectsCs.push("Pollution RES +20% & Sanity +150");
    effectsEn.push("Pollution RES +20% & Sanity +150");
  }

  if (spice === 'pepper') {
    effectsCs.push("Creative Success Rate +20% & Attack +8%");
    effectsEn.push("Creative Success Rate +20% & Attack +8%");
  } else if (spice === 'sugar') {
    hydro += 10;
    effectsCs.push("+20% Dish Energy & Sanity +200");
    effectsEn.push("+20% Dish Energy & Sanity +200");
  } else if (spice === 'salt') {
    effectsCs.push("Rock Salt: Trvanlivost jídla +100%");
    effectsEn.push("Rock Salt: Dish Durability +100%");
  } else if (spice === 'stardust_salt') {
    effectsCs.push("✨ Hvězdná sůl: Jídlo se NIKDY nezkazí (-1% Sanity / 5s)");
    effectsEn.push("✨ Stardust Salt: Dish NEVER decays (-1% Sanity / 5s)");
  }

  if (enh === 'stardust') {
    effectsCs.push("⚡ STARDUST AMPLIFIER: Účinek buffů zvýšen o +50%!");
    effectsEn.push("⚡ STARDUST AMPLIFIER: All buff effects boosted by +50%!");
    titleCs = "Hvězdný synergický pokrm";
    titleEn = "Stardust Synergistic Dish";
  } else if (enh === 'butter') {
    effectsCs.push("Máslová redukce: +30% síla masových buffů");
    effectsEn.push("Butter Glaze: +30% Meat buff magnitude");
  } else if (enh === 'cheese') {
    effectsCs.push("Zrající sýr: +30% síla pokrmu (-30% trvání)");
    effectsEn.push("Cured Cheese: +30% Magnitude (-30% Duration)");
  } else if (enh === 'oil') {
    effectsCs.push("Kukuřičný olej: +20% trvanlivost jídla v batohu");
    effectsEn.push("Corn Oil: +20% Backpack durability");
  }

  document.getElementById('calc-result-title').innerText = currentLang === 'cs' ? titleCs : titleEn;
  document.getElementById('calc-result-effects').innerText = (currentLang === 'cs' ? effectsCs : effectsEn).join(" • ");
  document.getElementById('calc-res-energy').innerText = energy;
  document.getElementById('calc-res-hydro').innerText = hydro;
}

function resetSynergyCalc() {
  document.getElementById('calc-slot-meat').value = 'none';
  document.getElementById('calc-slot-veg').value = 'none';
  document.getElementById('calc-slot-spice').value = 'none';
  document.getElementById('calc-slot-enhancer').value = 'none';
  calculateSynergies();
}

/* ==========================================================================
   POWER GRID & ACID AUTOMATION CALCULATOR ENGINE
   ========================================================================== */

let gridCalcState = {
  activeTab: 'power',
  generators: {
    solarBasic: 2,
    solarAdvanced: 1,
    biomassSmall: 0,
    biomassLarge: 0,
    hydraulic: 0,
    fuel: 0,
    deviation: 0
  },
  eels: 1,
  consumers: {
    pump: 4,
    purifier: 2,
    turret: 2,
    smelter: 1,
    stove: 1,
    fridge: 1,
    growLight: 2,
    securement5w: 3,
    securement10w: 1
  },
  acidFarm: {
    pumps: 4,
    purifiers: 2,
    barrels: 4
  }
};

const gridSpecs = {
  generators: {
    solarBasic: { nameCs: "Základní solární panel", nameEn: "Basic Solar Generator", watts: 20, icon: "fa-solar-panel" },
    solarAdvanced: { nameCs: "Pokročilý solární panel", nameEn: "Advanced Solar Generator", watts: 40, icon: "fa-solar-panel" },
    biomassSmall: { nameCs: "Malý generátor na biomasu", nameEn: "Small Biomass Generator", watts: 20, icon: "fa-seedling" },
    biomassLarge: { nameCs: "Velký generátor na biomasu", nameEn: "Large Biomass Generator", watts: 35, icon: "fa-fire-burner" },
    hydraulic: { nameCs: "Hydraulická vodní elektrárna", nameEn: "Hydraulic Generator", watts: 30, icon: "fa-water" },
    fuel: { nameCs: "Palivový generátor na ropu", nameEn: "Fuel Generator", watts: 30, icon: "fa-gas-pump" },
    deviation: { nameCs: "Generátor na odchylky (Deviation)", nameEn: "Deviation Energy Generator", watts: 35, icon: "fa-ghost" }
  },
  consumers: {
    pump: { nameCs: "Vodní čerpadlo (Voda / Ropa)", nameEn: "Water / Oil Pump", watts: 10, icon: "fa-faucet-drip" },
    purifier: { nameCs: "Osmotická čistička", nameEn: "Osmosis Purifier", watts: 10, icon: "fa-filter" },
    turret: { nameCs: "Automatická obranná věž", nameEn: "Automated Defense Turret", watts: 10, icon: "fa-shield-halved" },
    smelter: { nameCs: "Elektrická tavicí pec", nameEn: "Electric Smelter", watts: 10, icon: "fa-fire" },
    stove: { nameCs: "Elektrický kuchyňský sporák", nameEn: "Kitchen Electric Stove", watts: 10, icon: "fa-utensils" },
    fridge: { nameCs: "Lednice na potraviny", nameEn: "Food Refrigerator", watts: 5, icon: "fa-snowflake" },
    growLight: { nameCs: "Pěstitelské UV světlo", nameEn: "Botanical Grow Light", watts: 5, icon: "fa-sun" },
    securement5w: { nameCs: "Jednotka Devianta (5W)", nameEn: "Securement Unit (5W)", watts: 5, icon: "fa-box" },
    securement10w: { nameCs: "Zesílená jednotka Devianta (10W)", nameEn: "High-Power Unit (10W)", watts: 10, icon: "fa-boxes-stacked" }
  }
};

function openGridCalcModal() {
  const modal = document.getElementById('grid-calc-modal');
  if (modal) {
    modal.classList.remove('hidden');
    renderGridCalc();
  }
}

function closeGridCalcModal() {
  const modal = document.getElementById('grid-calc-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

function switchGridCalcTab(tab) {
  gridCalcState.activeTab = tab;
  const btnPower = document.getElementById('grid-tab-btn-power');
  const btnAcid = document.getElementById('grid-tab-btn-acid');
  if (tab === 'power') {
    if (btnPower) btnPower.className = "px-4 py-2 rounded font-orbitron text-xs font-bold transition-all bg-amber-500 text-black shadow-[0_0_12px_rgba(245,158,11,0.4)] flex items-center gap-2";
    if (btnAcid) btnAcid.className = "px-4 py-2 rounded font-orbitron text-xs font-bold transition-all bg-hud-card text-slate-300 hover:text-white border border-hud-border flex items-center gap-2";
  } else {
    if (btnAcid) btnAcid.className = "px-4 py-2 rounded font-orbitron text-xs font-bold transition-all bg-amber-500 text-black shadow-[0_0_12px_rgba(245,158,11,0.4)] flex items-center gap-2";
    if (btnPower) btnPower.className = "px-4 py-2 rounded font-orbitron text-xs font-bold transition-all bg-hud-card text-slate-300 hover:text-white border border-hud-border flex items-center gap-2";
  }
  renderGridCalc();
}

function updateGridGen(key, delta) {
  const curr = gridCalcState.generators[key] || 0;
  gridCalcState.generators[key] = Math.max(0, Math.min(20, curr + delta));
  renderGridCalc();
}

function updateGridEels(delta) {
  const curr = gridCalcState.eels || 0;
  gridCalcState.eels = Math.max(0, Math.min(5, curr + delta));
  renderGridCalc();
}

function updateGridConsumer(key, delta) {
  const curr = gridCalcState.consumers[key] || 0;
  gridCalcState.consumers[key] = Math.max(0, Math.min(50, curr + delta));
  renderGridCalc();
}

function updateAcidFarm(key, delta) {
  const curr = gridCalcState.acidFarm[key] || 0;
  gridCalcState.acidFarm[key] = Math.max(0, Math.min(30, curr + delta));
  renderGridCalc();
}

function resetGridCalc() {
  gridCalcState = {
    activeTab: gridCalcState.activeTab,
    generators: {
      solarBasic: 2,
      solarAdvanced: 1,
      biomassSmall: 0,
      biomassLarge: 0,
      hydraulic: 0,
      fuel: 0,
      deviation: 0
    },
    eels: 1,
    consumers: {
      pump: 4,
      purifier: 2,
      turret: 2,
      smelter: 1,
      stove: 1,
      fridge: 1,
      growLight: 2,
      securement5w: 3,
      securement10w: 1
    },
    acidFarm: {
      pumps: 4,
      purifiers: 2,
      barrels: 4
    }
  };
  renderGridCalc();
}

function renderGridCalc() {
  const container = document.getElementById('grid-calc-content');
  if (!container) return;

  if (gridCalcState.activeTab === 'power') {
    renderPowerGridTab(container);
  } else {
    renderAcidFarmTab(container);
  }
}

function renderPowerGridTab(container) {
  const totalGenCount = Object.values(gridCalcState.generators).reduce((a, b) => a + b, 0);
  const rawGenWatts = Object.entries(gridCalcState.generators).reduce((acc, [k, count]) => acc + count * gridSpecs.generators[k].watts, 0);
  const eelBonusWatts = totalGenCount * (gridCalcState.eels * 12);
  const totalGenWatts = rawGenWatts + eelBonusWatts;

  const totalConsumerWatts = Object.entries(gridCalcState.consumers).reduce((acc, [k, count]) => acc + count * gridSpecs.consumers[k].watts, 0);
  const balanceWatts = totalGenWatts - totalConsumerWatts;

  let balanceColor = 'text-hud-cyan border-hud-cyan/50 bg-cyan-950/40 shadow-[0_0_15px_rgba(0,240,255,0.2)]';
  let balanceIcon = 'fa-circle-check';
  let balanceTextCs = `+${balanceWatts}W (STABILNÍ SÍŤ - Plný provoz a bezpečná rezerva)`;
  let balanceTextEn = `+${balanceWatts}W (STABLE GRID - Full operation with safe reserve)`;

  if (balanceWatts === 0) {
    balanceColor = 'text-amber-400 border-amber-500/50 bg-amber-950/40 shadow-[0_0_15px_rgba(245,158,11,0.2)]';
    balanceIcon = 'fa-triangle-exclamation';
    balanceTextCs = `0W (VYROVNANÁ SÍŤ - Žádná rezerva pro další spotřebiče)`;
    balanceTextEn = `0W (BALANCED GRID - Zero reserve for new facilities)`;
  } else if (balanceWatts < 0) {
    balanceColor = 'text-red-400 border-red-500/60 bg-red-950/60 shadow-[0_0_20px_rgba(239,68,68,0.3)] animate-pulse';
    balanceIcon = 'fa-triangle-exclamation';
    balanceTextCs = `${balanceWatts}W (PŘETÍŽENÍ SÍTĚ! Výpadky proudu a vyřazená obrana!)`;
    balanceTextEn = `${balanceWatts}W (GRID OVERLOAD! Power blackouts & offline turrets!)`;
  }

  container.innerHTML = `
    <!-- Real-time HUD Power Dashboard -->
    <div class="mb-5 p-4 rounded-lg border ${balanceColor} flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <i class="fa-solid ${balanceIcon} text-2xl shrink-0"></i>
        <div>
          <span class="text-[10px] font-mono uppercase tracking-wider block opacity-80">
            ${currentLang === 'cs' ? 'Stav energetické sítě základny' : 'Base Territory Grid Status'}
          </span>
          <h4 class="font-orbitron font-bold text-sm sm:text-base">
            ${currentLang === 'cs' ? balanceTextCs : balanceTextEn}
          </h4>
        </div>
      </div>
      <div class="flex items-center gap-4 text-xs font-mono shrink-0">
        <div class="text-right">
          <span class="text-slate-400 text-[10px] block">${currentLang === 'cs' ? 'Výroba celkem' : 'Total Generated'}</span>
          <strong class="text-amber-400 text-sm">${totalGenWatts} W</strong>
          ${eelBonusWatts > 0 ? `<span class="text-emerald-400 text-[9px] block">+${eelBonusWatts}W úhoř</span>` : ''}
        </div>
        <div class="h-8 w-px bg-slate-700"></div>
        <div class="text-left">
          <span class="text-slate-400 text-[10px] block">${currentLang === 'cs' ? 'Spotřeba celkem' : 'Total Demand'}</span>
          <strong class="text-hud-cyan text-sm">${totalConsumerWatts} W</strong>
        </div>
      </div>
    </div>

    <!-- Eel Booster Callout -->
    <div class="mb-5 p-3 rounded-lg bg-emerald-950/30 border border-emerald-500/40 flex items-center justify-between flex-wrap gap-2 text-xs">
      <div class="flex items-center gap-2">
        <i class="fa-solid fa-bolt text-emerald-400 text-base"></i>
        <div>
          <span class="font-bold text-emerald-300 block">
            ${currentLang === 'cs' ? 'Bonus Devianta: Elektrický úhoř (Electric Eel)' : 'Deviant Bonus: Electric Eel'}
          </span>
          <span class="text-[11px] text-slate-300 font-mono">
            ${currentLang === 'cs' ? 'Posiluje KAŽDÝ generátor o +12W čistého výkonu!' : 'Overcharges EVERY generator by +12W base power!'}
          </span>
        </div>
      </div>
      <div class="flex items-center gap-2 bg-slate-900/80 px-2.5 py-1 rounded border border-slate-700 font-mono">
        <span class="text-slate-400 text-[11px]">${currentLang === 'cs' ? 'Aktivní úhoři' : 'Active Eels'}:</span>
        <button onclick="updateGridEels(-1)" class="w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 text-white flex items-center justify-center font-bold text-xs">-</button>
        <span class="text-emerald-300 font-bold px-1">${gridCalcState.eels}</span>
        <button onclick="updateGridEels(1)" class="w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 text-white flex items-center justify-center font-bold text-xs">+</button>
      </div>
    </div>

    <!-- Generator & Consumer Columns -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
      <!-- Left: Generators -->
      <div class="p-4 rounded-lg bg-hud-bg border border-hud-border">
        <h5 class="text-xs font-orbitron font-bold text-amber-400 mb-3 flex items-center gap-1.5 uppercase">
          <i class="fa-solid fa-plug text-amber-400"></i>
          ${currentLang === 'cs' ? 'Zdroje energie (Generátory)' : 'Power Sources (Generators)'}
        </h5>
        <div class="space-y-2.5">
          ${Object.entries(gridSpecs.generators).map(([k, spec]) => {
            const count = gridCalcState.generators[k] || 0;
            const singleGenOutput = spec.watts + (gridCalcState.eels * 12);
            return `
              <div class="p-2 rounded bg-slate-800/70 border border-slate-700 flex items-center justify-between text-xs font-mono">
                <div class="flex items-center gap-2">
                  <i class="fa-solid ${spec.icon} text-amber-400 text-xs w-4 text-center"></i>
                  <div>
                    <span class="text-slate-200 block text-[11px]">${currentLang === 'cs' ? spec.nameCs : spec.nameEn}</span>
                    <span class="text-[10px] text-slate-400">${singleGenOutput}W / ks</span>
                  </div>
                </div>
                <div class="flex items-center gap-1.5">
                  <button onclick="updateGridGen('${k}', -1)" class="w-6 h-6 rounded bg-slate-700 hover:bg-slate-600 text-white flex items-center justify-center font-bold text-xs cursor-pointer">-</button>
                  <span class="w-6 text-center text-white font-bold">${count}</span>
                  <button onclick="updateGridGen('${k}', 1)" class="w-6 h-6 rounded bg-slate-700 hover:bg-slate-600 text-white flex items-center justify-center font-bold text-xs cursor-pointer">+</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <!-- Right: Consumers -->
      <div class="p-4 rounded-lg bg-hud-bg border border-hud-border">
        <h5 class="text-xs font-orbitron font-bold text-hud-cyan mb-3 flex items-center gap-1.5 uppercase">
          <i class="fa-solid fa-power-off text-hud-cyan"></i>
          ${currentLang === 'cs' ? 'Spotřebiče & Zařízení základny' : 'Base Appliances & Facilities'}
        </h5>
        <div class="space-y-2.5">
          ${Object.entries(gridSpecs.consumers).map(([k, spec]) => {
            const count = gridCalcState.consumers[k] || 0;
            return `
              <div class="p-2 rounded bg-slate-800/70 border border-slate-700 flex items-center justify-between text-xs font-mono">
                <div class="flex items-center gap-2">
                  <i class="fa-solid ${spec.icon} text-hud-cyan text-xs w-4 text-center"></i>
                  <div>
                    <span class="text-slate-200 block text-[11px]">${currentLang === 'cs' ? spec.nameCs : spec.nameEn}</span>
                    <span class="text-[10px] text-slate-400">${spec.watts}W / ks</span>
                  </div>
                </div>
                <div class="flex items-center gap-1.5">
                  <button onclick="updateGridConsumer('${k}', -1)" class="w-6 h-6 rounded bg-slate-700 hover:bg-slate-600 text-white flex items-center justify-center font-bold text-xs cursor-pointer">-</button>
                  <span class="w-6 text-center text-white font-bold">${count}</span>
                  <button onclick="updateGridConsumer('${k}', 1)" class="w-6 h-6 rounded bg-slate-700 hover:bg-slate-600 text-white flex items-center justify-center font-bold text-xs cursor-pointer">+</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderAcidFarmTab(container) {
  const pumps = gridCalcState.acidFarm.pumps;
  const purifiers = gridCalcState.acidFarm.purifiers;
  const barrels = gridCalcState.acidFarm.barrels;

  // Rates in Once Human:
  // 1 pump in polluted water = 12 polluted water / hr
  const pollutedWaterPerHour = pumps * 12;

  // 1 osmosis purifier processes 30 polluted water / hr -> 15 impure acid / hr + pure water
  const purifierWaterCapacityPerHour = purifiers * 30;
  const waterProcessedPerHour = Math.min(pollutedWaterPerHour, purifierWaterCapacityPerHour);
  const impureAcidProducedPerHour = Math.floor(waterProcessedPerHour / 2);

  // 1 fermentation barrel processes 6 impure acid / hr -> 3 pure acid / hr
  const barrelImpureCapacityPerHour = barrels * 6;
  const impureAcidProcessedPerHour = Math.min(impureAcidProducedPerHour, barrelImpureCapacityPerHour);
  const pureAcidPerHour = Math.floor(impureAcidProcessedPerHour / 2);
  const pureAcidPerDay = pureAcidPerHour * 24;

  const farmPowerWatts = (pumps * 10) + (purifiers * 10);

  let statusClass = 'border-emerald-500/60 bg-emerald-950/30 text-emerald-300';
  let statusTextCs = '✅ Dokonale vyvážený výrobní řetězec! Pumpy, čističky i kvasné sudy běží na 100% kapacity.';
  let statusTextEn = '✅ Perfectly balanced production pipeline! Pumps, purifiers and barrels operating at 100% capacity.';

  if (pumps > 0 && purifiers === 0) {
    statusClass = 'border-red-500/60 bg-red-950/40 text-red-300';
    statusTextCs = '❌ Chybí osmotické čističky! Znečištěná voda se hromadí a nepřeměňuje na nečistou kyselinu.';
    statusTextEn = '❌ Missing Osmosis Purifiers! Polluted water is backing up without being converted.';
  } else if (purifiers > 0 && barrels === 0) {
    statusClass = 'border-amber-500/60 bg-amber-950/40 text-amber-300';
    statusTextCs = '⚠️ Chybí kvasné sudy! Vyrábíte nečistou kyselinu, ale nemáte ji kde nechat zkvasit na čistou kyselinu.';
    statusTextEn = '⚠️ Missing Fermentation Barrels! Impure acid is produced but cannot ferment into Pure Acid.';
  } else if (pollutedWaterPerHour > purifierWaterCapacityPerHour) {
    statusClass = 'border-amber-500/60 bg-amber-950/40 text-amber-300';
    statusTextCs = `⚠️ Úzké hrdlo: Pumpy těží ${pollutedWaterPerHour} l/h, ale čističky stíhají jen ${purifierWaterCapacityPerHour} l/h. Přidejte čističku!`;
    statusTextEn = `⚠️ Bottleneck: Pumps extract ${pollutedWaterPerHour} /h, but purifiers handle only ${purifierWaterCapacityPerHour} /h. Add more purifiers!`;
  } else if (impureAcidProducedPerHour > barrelImpureCapacityPerHour) {
    statusClass = 'border-amber-500/60 bg-amber-950/40 text-amber-300';
    statusTextCs = `⚠️ Úzké hrdlo: Čističky produkují ${impureAcidProducedPerHour} nečisté kyseliny/h, ale sudy stíhají zpracovat jen ${barrelImpureCapacityPerHour}/h. Přidejte kvasné sudy!`;
    statusTextEn = `⚠️ Bottleneck: Purifiers produce ${impureAcidProducedPerHour} impure acid/h, but barrels process only ${barrelImpureCapacityPerHour}/h. Add barrels!`;
  }

  container.innerHTML = `
    <!-- Top Result Banner -->
    <div class="mb-5 p-4 rounded-lg border border-hud-purple/60 bg-purple-950/40 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 shadow-[0_0_20px_rgba(181,23,158,0.2)]">
      <div>
        <span class="text-[10px] font-mono uppercase tracking-wider text-purple-300 block">
          ${currentLang === 'cs' ? 'Konečný výnos čisté kyseliny (Acid)' : 'Net Pure Acid Production Rate'}
        </span>
        <div class="flex items-baseline gap-3 mt-1">
          <h4 class="font-orbitron font-bold text-2xl text-white">
            ~${pureAcidPerHour} <span class="text-sm font-mono text-hud-cyan font-normal">${currentLang === 'cs' ? 'ks / hod' : 'pcs / hr'}</span>
          </h4>
          <span class="text-sm font-mono text-amber-400 font-bold">
            (~${pureAcidPerDay} ${currentLang === 'cs' ? 'ks / 24 hod' : 'pcs / 24 hrs'})
          </span>
        </div>
      </div>
      <div class="text-xs font-mono text-slate-300 text-right bg-slate-900/80 p-2.5 rounded border border-slate-700">
        <div><span class="text-slate-400">${currentLang === 'cs' ? 'Příkon farmy' : 'Farm Power'}:</span> <strong class="text-amber-400">${farmPowerWatts} W</strong></div>
        <div><span class="text-slate-400">${currentLang === 'cs' ? 'Znečištěná voda' : 'Polluted Water'}:</span> <strong class="text-cyan-300">${pollutedWaterPerHour} / h</strong></div>
      </div>
    </div>

    <!-- Bottleneck Diagnosis Box -->
    <div class="mb-5 p-3 rounded-lg border text-xs font-mono ${statusClass}">
      ${currentLang === 'cs' ? statusTextCs : statusTextEn}
    </div>

    <!-- Interactive Facility Configurator -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
      <!-- 1. Water Pumps -->
      <div class="p-3.5 rounded-lg bg-hud-bg border border-hud-border flex flex-col justify-between">
        <div>
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-orbitron font-bold text-white flex items-center gap-1.5">
              <i class="fa-solid fa-faucet-drip text-hud-cyan"></i>
              ${currentLang === 'cs' ? '1. Vodní pumpy' : '1. Water Pumps'}
            </span>
            <span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">10W</span>
          </div>
          <p class="text-[11px] text-slate-400 mb-3">
            ${currentLang === 'cs' ? 'Čerpají znečištěnou vodu v zamořené oblasti (Pollution > 1).' : 'Extracts Polluted Water in contaminated zones.'}
          </p>
        </div>
        <div class="flex items-center justify-between bg-slate-800/80 p-1.5 rounded border border-slate-700 font-mono">
          <button onclick="updateAcidFarm('pumps', -1)" class="w-7 h-7 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold cursor-pointer">-</button>
          <span class="text-sm font-bold text-hud-cyan">${pumps} ks</span>
          <button onclick="updateAcidFarm('pumps', 1)" class="w-7 h-7 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold cursor-pointer">+</button>
        </div>
      </div>

      <!-- 2. Osmosis Purifiers -->
      <div class="p-3.5 rounded-lg bg-hud-bg border border-hud-border flex flex-col justify-between">
        <div>
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-orbitron font-bold text-white flex items-center gap-1.5">
              <i class="fa-solid fa-filter text-amber-400"></i>
              ${currentLang === 'cs' ? '2. Osmóza' : '2. Osmosis'}
            </span>
            <span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">10W</span>
          </div>
          <p class="text-[11px] text-slate-400 mb-3">
            ${currentLang === 'cs' ? 'Mění 2x znečištěnou vodu na 1x nečistou kyselinu (Impure Acid).' : 'Converts 2x Polluted Water into 1x Impure Acid.'}
          </p>
        </div>
        <div class="flex items-center justify-between bg-slate-800/80 p-1.5 rounded border border-slate-700 font-mono">
          <button onclick="updateAcidFarm('purifiers', -1)" class="w-7 h-7 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold cursor-pointer">-</button>
          <span class="text-sm font-bold text-amber-400">${purifiers} ks</span>
          <button onclick="updateAcidFarm('purifiers', 1)" class="w-7 h-7 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold cursor-pointer">+</button>
        </div>
      </div>

      <!-- 3. Fermentation Barrels -->
      <div class="p-3.5 rounded-lg bg-hud-bg border border-hud-border flex flex-col justify-between">
        <div>
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-orbitron font-bold text-white flex items-center gap-1.5">
              <i class="fa-solid fa-wine-bottle text-purple-400"></i>
              ${currentLang === 'cs' ? '3. Kvasné sudy' : '3. Barrels'}
            </span>
            <span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">0W (Pasivní)</span>
          </div>
          <p class="text-[11px] text-slate-400 mb-3">
            ${currentLang === 'cs' ? 'Zkvasí 2x nečistou kyselinu + čistou vodu na 1x čistou kyselinu.' : 'Ferments 2x Impure Acid + Pure Water into 1x Pure Acid.'}
          </p>
        </div>
        <div class="flex items-center justify-between bg-slate-800/80 p-1.5 rounded border border-slate-700 font-mono">
          <button onclick="updateAcidFarm('barrels', -1)" class="w-7 h-7 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold cursor-pointer">-</button>
          <span class="text-sm font-bold text-purple-400">${barrels} ks</span>
          <button onclick="updateAcidFarm('barrels', 1)" class="w-7 h-7 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold cursor-pointer">+</button>
        </div>
      </div>
    </div>

    <!-- Optimization Pro-Tips -->
    <div class="p-3 bg-slate-900/90 rounded border border-slate-800 text-xs font-mono text-slate-400 leading-relaxed">
      <span class="text-hud-cyan font-bold block mb-1 flex items-center gap-1.5">
        <i class="fa-solid fa-lightbulb"></i>${currentLang === 'cs' ? 'Zlaté pravidlo optimálního zapojení farmy na kyselinu' : 'Golden Rule of Acid Automation'}:
      </span>
      <span>${currentLang === 'cs' ? 'Ideální vyvážený poměr je <strong>2 Vodní čerpadla : 1 Osmotická čistička : 2 Kvasné sudy</strong>. Vodu přivádějte gravitací (sudy níže než pumpy) nebo použijte malé přetlakové ventily, abyste předešli zpětnému toku kapaliny.' : 'Ideal balanced ratio is <strong>2 Water Pumps : 1 Osmosis Purifier : 2 Fermentation Barrels</strong>. Utilize gravity feed (barrels lower than pumps) to avoid flow stagnation.'}</span>
    </div>
  `;
}


