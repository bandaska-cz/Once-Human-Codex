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

  const existing = craftQueue.find(q => q.recipeId === recipeId);
  if (existing) {
    existing.count = (existing.count || 1) + count;
  } else {
    craftQueue.push({ recipeId, count });
  }

  saveCraftQueue();

  const rName = currentLang === 'cs' ? recipe.nameCs : recipe.nameEn;
  const msg = currentLang === 'cs' ? `Položka "${rName}" přidána do plánu (${count}×)` : `Added "${rName}" to plan (${count}×)`;
  showNotification(msg);

  // If queue modal is open, re-render it
  const qModal = document.getElementById('craft-queue-modal');
  if (qModal && !qModal.classList.contains('hidden')) {
    renderQueueModalContent();
  }
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

function calculateQueueMaterials() {
  const totals = {};

  craftQueue.forEach(item => {
    const recipe = findRecipeById(item.recipeId);
    if (!recipe) return;

    const ingredients = currentLang === 'cs' ? recipe.ingredientsCs : recipe.ingredientsEn;
    const mult = item.count || 1;

    ingredients.forEach(ing => {
      const match = (ing.amount || '').match(/\d+/);
      const amountPerCraft = match ? parseInt(match[0], 10) : 1;
      const totalAmount = amountPerCraft * mult;

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

  content.innerHTML = `
    <div class="flex items-center justify-between pb-3 mb-4 border-b border-hud-border">
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
    <div class="mb-6">
      <h4 class="text-xs font-mono uppercase text-hud-cyan mb-2 font-bold flex items-center gap-1.5">
        <i class="fa-solid fa-list-check"></i>
        <span>${t.plannedItems} (${craftQueue.length})</span>
      </h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-52 overflow-y-auto pr-1">
        ${craftQueue.map(item => {
          const recipe = findRecipeById(item.recipeId);
          if (!recipe) return '';
          const name = currentLang === 'cs' ? recipe.nameCs : recipe.nameEn;
          const rar = rarityConfig[recipe.rarity] || rarityConfig.Common;

          return `
            <div class="p-2.5 bg-hud-bg border border-hud-border rounded flex items-center justify-between gap-2">
              <div class="truncate">
                <div class="flex items-center gap-1.5">
                  <span class="w-1.5 h-1.5 rounded-full ${rar.dot}"></span>
                  <span class="text-xs font-medium text-white truncate cursor-pointer hover:text-hud-cyan" onclick="openModal('${recipe.id}', true)">${name}</span>
                </div>
                <div class="text-[10px] font-mono text-slate-500 truncate">${recipe.workbench}</div>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <button onclick="updateQueueCount('${recipe.id}', -1)" class="w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center font-bold text-xs">-</button>
                <span class="w-7 text-center font-mono font-bold text-hud-cyan text-xs">${item.count}</span>
                <button onclick="updateQueueCount('${recipe.id}', 1)" class="w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center font-bold text-xs">+</button>
                <button onclick="removeFromQueue('${recipe.id}')" class="ml-1 text-slate-500 hover:text-red-400 p-1">
                  <i class="fa-solid fa-xmark text-xs"></i>
                </button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <!-- Section 2: Aggregated Raw Materials Shopping List -->
    <div class="mb-4">
      <div class="flex items-center justify-between mb-2">
        <h4 class="text-xs font-mono uppercase text-amber-400 font-bold flex items-center gap-1.5">
          <i class="fa-solid fa-boxes-stacked"></i>
          <span>${t.totalMaterialsTitle}</span>
        </h4>
        <button onclick="copyQueueToDiscord()" class="px-3 py-1 bg-hud-cyan/20 hover:bg-hud-cyan/30 border border-hud-cyan/60 rounded text-hud-cyan hover:text-white text-xs font-mono flex items-center gap-1.5 transition cursor-pointer">
          <i class="fa-solid fa-copy text-xs"></i>
          <span>${t.copyDiscordBtn}</span>
        </button>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-64 overflow-y-auto pr-1">
        ${materials.map(mat => {
          const isCrafted = Boolean(mat.recipeId);
          return `
            <div class="p-2 bg-hud-bg/90 border ${isCrafted ? 'border-hud-cyan/50' : 'border-hud-border'} rounded flex items-center justify-between text-xs">
              <div class="truncate mr-2">
                <span class="${mat.isPrimary ? 'text-amber-300 font-semibold' : 'text-slate-200'} truncate block" title="${mat.name}">
                  ${isCrafted ? '<i class="fa-solid fa-wrench text-[10px] text-hud-cyan mr-1"></i>' : ''}${mat.name}
                </span>
                ${mat.location ? `<span class="text-[9px] font-mono text-slate-500 truncate block">${mat.location}</span>` : ''}
              </div>
              <span class="font-mono font-bold text-hud-cyan bg-slate-900/80 px-2 py-0.5 rounded border border-slate-700 shrink-0">
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
    const rName = recipe ? (currentLang === 'cs' ? recipe.nameCs : recipe.nameEn) : item.recipeId;
    text += `• ${rName} (${item.count}×)\n`;
  });

  text += `\n**${currentLang === 'cs' ? 'Potřebné suroviny celkem' : 'Total Materials Required'}:**\n`;
  materials.forEach(mat => {
    text += `• ${mat.name}: **${mat.amount}×**\n`;
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

    item._searchIndex = (csTokens + ' ' + enTokens + ' ' + (item.scenario || '')).toLowerCase();
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
    if (activeTab !== tabName && ['discovered', 'creative', 'medicine', 'inventions'].includes(tabName)) {
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
  return [...discoveredRecipes, ...creativeDishes, ...medicineRecipes, ...inventionRecipes];
}

function findRecipeById(id) {
  return getAllRecipes().find(r => r.id === id);
}

function determineRecipeTab(recipeId) {
  if (discoveredRecipes.some(r => r.id === recipeId)) return 'discovered';
  if (creativeDishes.some(r => r.id === recipeId)) return 'creative';
  if (medicineRecipes.some(r => r.id === recipeId)) return 'medicine';
  if (inventionRecipes.some(r => r.id === recipeId)) return 'inventions';
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
  document.getElementById('tab-txt-discovered').innerText = t.tabDiscovered;
  document.getElementById('tab-txt-creative').innerText = t.tabCreative;
  document.getElementById('tab-txt-medicine').innerText = t.tabMedicine;
  document.getElementById('tab-txt-inventions').innerText = t.tabInventions;
  document.getElementById('calc-title').innerText = t.calcTitle;
  document.getElementById('calc-desc').innerText = t.calcDesc;
  document.getElementById('searchInput').placeholder = t.searchPlaceholder;

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
    { id: 'tab-btn-inventions', name: 'inventions' }
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
          <div class="flex items-center gap-1.5">
            <span class="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
              ${categoryText}
            </span>
            <span class="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border ${scenBadge}">
              ${scenName}
            </span>
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
      <div class="flex items-center gap-2">
        <button onclick="addToQueue('${item.id}', 1, event)" class="px-3 py-1.5 bg-cyan-950/80 hover:bg-cyan-900 border border-hud-cyan/60 rounded text-hud-cyan hover:text-white font-mono text-xs transition flex items-center gap-1.5 cursor-pointer">
          <i class="fa-solid fa-plus text-xs"></i>
          <span>${t.addToQueue}</span>
        </button>
        <button onclick="copyRecipeName('${item.nameEn}')" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded text-slate-300 hover:text-white transition">
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

