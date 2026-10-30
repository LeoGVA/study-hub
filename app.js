/**
 * StudyHub App - v3.2
 * 青チャート解説動画完全対応 ＆ 逆算ペースメーカー
 */
class StudyHubApp {
  constructor() {
    this.data = window.STUDY_DATA || { books: [], total_problems: 0 };
    this.problemMap = new Map();
    this.chapterMap = new Map();
    this._openChapters = new Set();

    // Flatten problems and populate maps
    for (const book of (this.data.books || [])) {
      const chapters = [];
      for (const chapter of (book.chapters || [])) {
        if (!chapter.problems || chapter.problems.length === 0) {
          chapter.problems = (chapter.sections || []).flatMap(s => s.problems || []);
        }
        chapters.push(chapter);
        // By default open all chapters
        this._openChapters.add(chapter.id);

        for (const problem of chapter.problems) {
          this.problemMap.set(problem.id, {
            ...problem,
            book_id: book.id,
            book_title: book.title,
            subject: book.subject,
          });
        }
      }
      this.chapterMap.set(book.id, chapters);
    }

    this.state = this.loadState();
    this._videoModalProblemId = null;
    this._problemModalProblemId = null;
    this._timerInterval = null;
    this._timerRunning = false;
    this._timerMode = 'work';
    this._timerModes = { work: 25 * 60, shortBreak: 5 * 60, longBreak: 15 * 60 };
    this._timerRemaining = this._timerModes.work;
    this._timerSessions = 0;

    this.init();
  }

  // ─────────────────────────────────────────
  // STATE MANAGEMENT (堅牢なバリデーション付き)
  // ─────────────────────────────────────────
  loadState() {
    let s = null;
    try {
      const raw = localStorage.getItem('studyhub_v3');
      if (raw) s = JSON.parse(raw);
    } catch (e) {}

    const defaultBookId = this.data.books[0]?.id || '3t39887g9b';
    if (!s || typeof s !== 'object') s = {};

    // Validate currentBookId
    if (!s.currentBookId || !this.data.books.some(b => b.id === s.currentBookId)) {
      s.currentBookId = defaultBookId;
    }
    if (!s.statusMap || typeof s.statusMap !== 'object') s.statusMap = {};
    if (!s.starMap || typeof s.starMap !== 'object') s.starMap = {};
    if (!s.noteMap || typeof s.noteMap !== 'object') s.noteMap = {};
    if (!s.completedDateMap || typeof s.completedDateMap !== 'object') s.completedDateMap = {};
    if (!s.dailyActivity || typeof s.dailyActivity !== 'object') s.dailyActivity = {};
    if (!Array.isArray(s.customResources)) s.customResources = [];
    if (!Array.isArray(s.goals)) s.goals = [];
    s.darkMode = Boolean(s.darkMode);
    // Migrate legacy status values → new 〇△× system
    if (s.statusMap && typeof s.statusMap === 'object') {
      Object.keys(s.statusMap).forEach(id => {
        if (s.statusMap[id] === 'completed') s.statusMap[id] = 'maru';
        if (s.statusMap[id] === 'review')    s.statusMap[id] = 'sankaku';
      });
    }
    s.statusFilter = 'all'; // always reset filter on load to prevent blank screen
    s.chapterFilter = 'all'; // always reset chapter filter to all
    s.searchQuery = ''; // always reset search query
    s.currentView = s.currentView || 'book';

    return s;
  }

  _getTodayStr() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  setProblemStatus(problemId, status) {
    if (!problemId) return;
    this.state.statusMap[problemId] = status;
    const today = this._getTodayStr();
    if (!this.state.completedDateMap) this.state.completedDateMap = {};
    if (!this.state.dailyActivity) this.state.dailyActivity = {};

    // 〇, △, × are all counted as studied/attempted
    if (status === 'maru' || status === 'sankaku' || status === 'batsu') {
      this.state.completedDateMap[problemId] = today;
      if (!this.state.dailyActivity[today]) this.state.dailyActivity[today] = [];
      if (!this.state.dailyActivity[today].includes(problemId)) {
        this.state.dailyActivity[today].push(problemId);
      }
    } else {
      delete this.state.completedDateMap[problemId];
      if (this.state.dailyActivity[today]) {
        this.state.dailyActivity[today] = this.state.dailyActivity[today].filter(id => id !== problemId);
      }
    }
    this.saveState();
  }

  saveState() {
    try { localStorage.setItem('studyhub_v3', JSON.stringify(this.state)); } catch (e) {}
    fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.state),
    }).catch(() => {});
  }

  async syncFromServer() {
    try {
      const res = await fetch('/api/data');
      if (res.ok) {
        const serverData = await res.json();
        if (serverData && typeof serverData === 'object' && Object.keys(serverData).length > 0) {
          const today = this._getTodayStr();
          const serverCompMap = serverData.completedDateMap || {};
          const localCompMap = this.state.completedDateMap || {};
          const mergedCompMap = { ...serverCompMap, ...localCompMap };

          // If any problem is completed but not in mergedCompMap, assign today
          const statusMap = { ...(this.state.statusMap || {}), ...(serverData.statusMap || {}) };
          Object.keys(statusMap).forEach(id => {
            if ((statusMap[id] === 'maru' || statusMap[id] === 'sankaku' || statusMap[id] === 'batsu') && !mergedCompMap[id]) {
              mergedCompMap[id] = today;
            }
          });

          this.state = {
            ...this.state,
            ...serverData,
            statusMap,
            completedDateMap: mergedCompMap,
          };

          this.saveState();
          this.renderNav();
          this.renderCurrentView();
        }
      }
    } catch (e) {}
  }

  // ─────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────
  init() {
    if (this.state.darkMode) document.documentElement.classList.add('dark');
    this.renderNav();
    this.renderCurrentView();
    this.syncFromServer();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeVideoModal();
        this.closeProblemModal();
        this.closeGoalModal();
        this.closeCustomModal();
        this.closeBackupModal();
      }
    });
  }

  // ─────────────────────────────────────────
  // NAV
  // ─────────────────────────────────────────
  renderNav() {
    const navEl = document.getElementById('nav-tabs');
    const mobileEl = document.getElementById('mobile-menu');
    if (!navEl) return;

    const views = [
      ...this.data.books.map(b => ({
        key: 'book:' + b.id,
        label: b.subject,
        icon: 'book-open',
        action: `app.switchView('book', '${b.id}')`,
      })),
      { key: 'pacemaker', label: 'ペースメーカー', icon: 'target', action: "app.switchView('pacemaker')" },
      { key: 'dashboard', label: 'ダッシュボード', icon: 'bar-chart-2', action: "app.switchView('dashboard')" },
      { key: 'custom', label: '自作資料', icon: 'folder-open', action: "app.switchView('custom')" },
    ];

    const activeKey = this.state.currentView === 'book'
      ? 'book:' + this.state.currentBookId
      : this.state.currentView;

    const makeTab = (v, mobile) => {
      const active = v.key === activeKey;
      const base = mobile
        ? 'w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 transition'
        : 'nav-tab px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5 transition';
      const cls = active
        ? 'bg-blue-600 text-white font-bold shadow-sm'
        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800';
      const act = mobile ? `${v.action};app.toggleMobileMenu()` : v.action;
      return `<button onclick="${act}" class="${base} ${cls}"><i data-lucide="${v.icon}" class="w-4 h-4"></i><span>${v.label}</span></button>`;
    };

    navEl.innerHTML = views.map(v => makeTab(v, false)).join('');
    if (mobileEl) mobileEl.innerHTML = views.map(v => makeTab(v, true)).join('');
    if (window.lucide) lucide.createIcons();
  }

  switchView(view, bookId) {
    this.state.currentView = view;
    if (view === 'book' && bookId) {
      this.state.currentBookId = bookId;
      this.state.statusFilter = 'all';
      this.state.chapterFilter = 'all';
      this.state.searchQuery = '';
      // Ensure all chapters of this book are open
      const book = this.data.books.find(b => b.id === bookId);
      if (book) {
        book.chapters.forEach(c => this._openChapters.add(c.id));
      }
    }
    this.saveState();
    this.renderNav();
    this.renderCurrentView();
  }

  renderCurrentView() {
    ['book', 'pacemaker', 'dashboard', 'custom'].forEach(v => {
      document.getElementById('view-' + v)?.classList.add('hidden');
    });
    const el = document.getElementById('view-' + this.state.currentView);
    if (el) {
      el.classList.remove('hidden');
      el.classList.remove('animate-view-fade');
      void el.offsetWidth;
      el.classList.add('animate-view-fade');
    }

    const cv = this.state.currentView;
    if (cv === 'book') this.renderBookView();
    else if (cv === 'pacemaker') this.renderPacemakerView();
    else if (cv === 'dashboard') this.renderDashboardView();
    else if (cv === 'custom') this.renderCustomView();
  }

  toggleMobileMenu() {
    document.getElementById('mobile-menu')?.classList.toggle('hidden');
  }

  // ─────────────────────────────────────────
  // BOOK VIEW (青チャート解説一覧)
  // ─────────────────────────────────────────
  renderBookView() {
    let book = this.data.books.find(b => b.id === this.state.currentBookId);
    if (!book) {
      book = this.data.books[0];
      if (book) this.state.currentBookId = book.id;
    }
    if (!book) return;

    this.renderBookHeader(book);
    this.renderChapterSelect(book);
    this.renderCurriculumList(book);
    this.updateCounts(book);
  }

  renderBookHeader(book) {
    const el = document.getElementById('book-header-banner');
    if (!el) return;
    const colorMap = {
      '数学I+A': 'from-blue-600 via-indigo-600 to-blue-700',
      '数学II+B': 'from-violet-600 via-purple-600 to-indigo-700',
      '数学III': 'from-emerald-600 via-teal-600 to-emerald-700',
      '数学C': 'from-rose-600 via-pink-600 to-rose-700',
    };
    const grad = colorMap[book.subject] || 'from-blue-600 to-indigo-600';
    const probs = book.chapters.flatMap(c => c.problems || []);
    const total = probs.length;

    const maru    = probs.filter(p => this.state.statusMap[p.id] === 'maru').length;
    const sankaku = probs.filter(p => this.state.statusMap[p.id] === 'sankaku').length;
    const batsu   = probs.filter(p => this.state.statusMap[p.id] === 'batsu').length;
    const studied = maru + sankaku + batsu;
    const pct     = total ? Math.round(studied / total * 100) : 0;
    const maruPct    = total ? (maru    / total * 100) : 0;
    const sankakuPct = total ? (sankaku / total * 100) : 0;
    const batsuPct   = total ? (batsu   / total * 100) : 0;

    el.className = `rounded-2xl p-6 shadow-md border transition-all duration-300 bg-gradient-to-br ${grad} text-white border-transparent`;
    el.innerHTML = `
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        <div>
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/20 text-white text-xs font-semibold backdrop-blur-md mb-2">
            <i data-lucide="video" class="w-3.5 h-3.5"></i>
            <span>青チャート 解説動画・資料まとめ</span>
          </div>
          <h1 class="text-2xl sm:text-3xl font-extrabold tracking-tight">${book.title}</h1>
          <p class="text-sm mt-1.5 opacity-90">全 ${total} 問 · ${book.chapters.length} 章 の解説動画と例題を網羅</p>
          
          <div class="flex flex-wrap items-center gap-2.5 mt-4">
            <a href="${book.cds_url}" target="_blank" rel="noopener noreferrer" 
               class="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white text-blue-700 hover:bg-blue-50 font-bold text-xs shadow-md transition">
              <i data-lucide="external-link" class="w-4 h-4"></i>
              <span>数研公式 CDS サイトで開く</span>
            </a>
            <button onclick="app.toggleAllChapters(true)" class="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/20 hover:bg-white/30 text-white font-medium text-xs backdrop-blur-md transition">
              <i data-lucide="chevrons-down" class="w-3.5 h-3.5"></i>
              <span>全単元を一括展開</span>
            </button>
          </div>
        </div>

        <div class="bg-black/20 backdrop-blur-md rounded-2xl p-4 sm:p-5 flex items-center justify-between sm:justify-start gap-6 border border-white/10 shrink-0">
          <div>
            <div class="text-xs opacity-80 font-medium">現在の習得度</div>
            <div class="text-4xl font-black mt-0.5">${pct}<span class="text-xl font-semibold ml-0.5">%</span></div>
            <div class="text-xs opacity-90 mt-1 font-medium">${studied} / ${total} 問 完了</div>
            <div class="text-[10px] opacity-75 mt-0.5 flex items-center gap-1.5">
              <span>〇${maru}</span><span>△${sankaku}</span><span>×${batsu}</span>
            </div>
          </div>
          <div class="w-32 sm:w-44 space-y-2">
            <div class="h-3.5 w-full bg-black/40 rounded-full overflow-hidden p-0.5 border border-white/20 flex shadow-inner">
              <div class="h-full bg-emerald-400 rounded-l-full transition-all duration-700" style="width:${maruPct.toFixed(1)}%" title="〇 習得済: ${maru}問"></div>
              <div class="h-full bg-amber-300 transition-all duration-700" style="width:${sankakuPct.toFixed(1)}%" title="△ 要復習: ${sankaku}問"></div>
              <div class="h-full bg-rose-400 rounded-r-full transition-all duration-700" style="width:${batsuPct.toFixed(1)}%" title="× 未定着: ${batsu}問"></div>
            </div>
            <div class="text-[11px] opacity-80 text-right font-medium">残り ${total - studied} 問</div>
          </div>
        </div>
      </div>`;
    if (window.lucide) lucide.createIcons();
  }

    renderChapterSelect(book) {
    const sel = document.getElementById('chapter-select');
    if (!sel) return;
    sel.innerHTML = `<option value="all">すべての章（全 ${book.chapters.length} 章）</option>` +
      book.chapters.map(c =>
        `<option value="${c.id}" ${this.state.chapterFilter === c.id ? 'selected' : ''}>${c.title} (${c.problems.length}問)</option>`
      ).join('');
  }

  getFilteredProblems(book) {
    let problems = book.chapters.flatMap(c =>
      c.problems.map(p => ({ ...p, chapter_id: c.id, chapter_title: c.title }))
    );
    if (this.state.chapterFilter !== 'all') {
      problems = problems.filter(p => p.chapter_id === this.state.chapterFilter);
    }
    if (this.state.statusFilter === 'starred') {
      problems = problems.filter(p => this.state.starMap[p.id]);
    } else if (this.state.statusFilter !== 'all') {
      problems = problems.filter(p => {
        const s = this.state.statusMap[p.id] || 'unstudied';
        return s === this.state.statusFilter;
      });
    }
    if (this.state.searchQuery) {
      const q = this.state.searchQuery.toLowerCase();
      problems = problems.filter(p =>
        (p.title || '').toLowerCase().includes(q) ||
        (p.chapter_title || '').toLowerCase().includes(q) ||
        (p.section_title || '').toLowerCase().includes(q)
      );
    }
    return problems;
  }

  renderCurriculumList(book) {
    const container = document.getElementById('curriculum-container');
    if (!container) return;

    const filteredProbs = this.getFilteredProblems(book);
    const filteredIds = new Set(filteredProbs.map(p => p.id));

    if (filteredProbs.length === 0) {
      container.innerHTML = `
        <div class="flex flex-col items-center justify-center py-20 text-slate-400 dark:text-slate-500 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800">
          <i data-lucide="search-x" class="w-12 h-12 mb-3 opacity-40"></i>
          <p class="text-sm font-semibold text-slate-700 dark:text-slate-300">該当する例題が見つかりませんでした</p>
          <p class="text-xs text-slate-400 mt-1">検索キーワードや絞り込み条件をご確認ください</p>
          <button onclick="app.clearSearch();app.setStatusFilter('all')" class="mt-4 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm transition">
            絞り込みをすべて解除
          </button>
        </div>`;
      if (window.lucide) lucide.createIcons();
      return;
    }

    const html = book.chapters.map(chapter => {
      const chProbs = chapter.problems.filter(p => filteredIds.has(p.id));
      if (chProbs.length === 0) return '';

      const isOpen = this._openChapters.has(chapter.id);
      const chTotal = chapter.problems.length;
      const chMaru = chapter.problems.filter(p => this.state.statusMap[p.id] === 'maru').length;
      const chSankaku = chapter.problems.filter(p => this.state.statusMap[p.id] === 'sankaku').length;
      const chBatsu = chapter.problems.filter(p => this.state.statusMap[p.id] === 'batsu').length;
      const chDone = chMaru + chSankaku + chBatsu;
      const pct = chTotal ? Math.round(chDone / chTotal * 100) : 0;
      const chMaruPct = chTotal ? (chMaru / chTotal * 100) : 0;
      const chSankakuPct = chTotal ? (chSankaku / chTotal * 100) : 0;
      const chBatsuPct = chTotal ? (chBatsu / chTotal * 100) : 0;

      const sectionMap = {};
      for (const p of chProbs) {
        const key = p.section_title || '例題一覧';
        if (!sectionMap[key]) sectionMap[key] = [];
        sectionMap[key].push(p);
      }

      return `
        <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden mb-4">
          <button onclick="app.toggleChapter('${chapter.id}')" class="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 transition">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0">
                <i data-lucide="${isOpen ? 'chevron-down' : 'chevron-right'}" class="w-4 h-4"></i>
              </div>
              <div class="min-w-0">
                <div class="font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 truncate">${chapter.title}</div>
                <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">${chProbs.length} 問表示中 / 全 ${chTotal} 問 · 習得済 ${pct}%</div>
              </div>
            </div>
              <div class="hidden sm:flex w-24 h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                <div class="h-full bg-emerald-500 transition-all duration-500" style="width:${chMaruPct.toFixed(1)}%"></div>
                <div class="h-full bg-amber-400 transition-all duration-500" style="width:${chSankakuPct.toFixed(1)}%"></div>
                <div class="h-full bg-rose-500 transition-all duration-500" style="width:${chBatsuPct.toFixed(1)}%"></div>
              </div>
              <span class="text-xs font-bold text-slate-500 dark:text-slate-400 w-12 text-right">${chDone}/${chTotal}</span>
          </button>
          <div id="ch-${chapter.id}" class="${isOpen ? '' : 'hidden'}">
            ${Object.entries(sectionMap).map(([sec, probs]) => `
              <div class="px-5 pb-5">
                <div class="py-2.5 mb-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <span class="text-xs font-bold text-slate-600 dark:text-slate-300">${sec}</span>
                  <span class="text-[11px] text-slate-400">${probs.length} 問</span>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  ${probs.map(p => this.renderProblemCard({ ...p, chapter_id: chapter.id, chapter_title: chapter.title })).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>`;
    }).filter(Boolean).join('');

    container.innerHTML = html;
    if (window.lucide) lucide.createIcons();
  }

  renderProblemCard(p) {
    const status = this.state.statusMap[p.id] || 'unstudied';
    const starred = this.state.starMap[p.id] || false;
    const hasNote = !!(this.state.noteMap[p.id]);
    const statusStyles = {
      unstudied: 'bg-white dark:bg-slate-900 border-2 border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-100 hover:border-blue-400 dark:hover:border-blue-500',
      sankaku:   'bg-amber-100/90 dark:bg-amber-950/60 border-2 border-amber-400 dark:border-amber-600 text-amber-950 dark:text-amber-100 hover:border-amber-500 shadow-sm',
      maru:      'bg-emerald-100/90 dark:bg-emerald-950/60 border-2 border-emerald-400 dark:border-emerald-600 text-emerald-950 dark:text-emerald-100 hover:border-emerald-500 shadow-sm',
      batsu:     'bg-rose-100/90 dark:bg-rose-950/60 border-2 border-rose-400 dark:border-rose-600 text-rose-950 dark:text-rose-100 hover:border-rose-500 shadow-sm',
    };
    const dotColor = {
      unstudied: 'bg-slate-300 dark:bg-slate-600',
      sankaku:   'bg-amber-500 ring-2 ring-amber-300 dark:ring-amber-700',
      maru:      'bg-emerald-500 ring-2 ring-emerald-300 dark:ring-emerald-700',
      batsu:     'bg-rose-500 ring-2 ring-rose-300 dark:ring-rose-700',
    };
    const typeLabel = (p.subgroup_title && p.subgroup_title !== '解説動画') ? p.subgroup_title : '';
    const directUrl = p.direct_url || p.cds_url;

    return `
      <div onclick="app.openProblemModal('${p.id}')"
           class="relative group p-3.5 rounded-xl border cursor-pointer ${statusStyles[status]} flex flex-col justify-between select-none study-card hover:shadow-lg">
        <div>
          <div class="flex items-start justify-between gap-2 mb-1.5">
            <div class="flex items-center gap-2 min-w-0">
              <span class="w-2.5 h-2.5 rounded-full shrink-0 ${dotColor[status]}"></span>
              <div class="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100 truncate" title="${p.title || ''}">${p.title || '例題'}</div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              ${starred ? `<i data-lucide="star" class="w-3.5 h-3.5 fill-amber-400 text-amber-400"></i>` : ''}
              ${hasNote ? `<i data-lucide="file-text" class="w-3.5 h-3.5 text-blue-500"></i>` : ''}
            </div>
          </div>
          ${typeLabel ? `<div class="text-[10px] text-slate-400 dark:text-slate-500 mb-2 truncate">${typeLabel}</div>` : '<div class="h-2"></div>'}
        </div>

        <div class="pt-2 border-t border-slate-100 dark:border-slate-800/60 flex items-center gap-1.5" onclick="event.stopPropagation()">
          <!-- Main Play Button (Popup Modal) -->
          <button onclick="event.stopPropagation(); app.openVideoModal('${p.id}')"
            class="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-sm shadow-blue-500/20 transition active:scale-95"
            title="解説動画をアプリ内ポップアップで再生">
            <i data-lucide="play" class="w-3.5 h-3.5 fill-white shrink-0"></i>
            <span>解説動画</span>
          </button>

          <!-- Direct Link to CDS Video (New Tab) -->
          <a href="${directUrl}" target="_blank" rel="noopener noreferrer"
             onclick="event.stopPropagation()"
             class="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition"
             title="公式動画ページをブラウザの別タブで直接開く">
            <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
          </a>

          <!-- Details & Note Modal -->
          <button onclick="event.stopPropagation(); app.openProblemModal('${p.id}')"
            class="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition"
            title="メモ記入・ステータス変更">
            <i data-lucide="more-horizontal" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </div>`;
  }

  updateCounts(book) {
    const probs = book.chapters.flatMap(c => c.problems || []);
    const total = probs.length;
    const maru    = probs.filter(p => this.state.statusMap[p.id] === 'maru').length;
    const sankaku = probs.filter(p => this.state.statusMap[p.id] === 'sankaku').length;
    const batsu   = probs.filter(p => this.state.statusMap[p.id] === 'batsu').length;
    const starred = probs.filter(p => this.state.starMap[p.id]).length;
    const unstudied = total - maru - sankaku - batsu;

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('cnt-all', total);
    set('cnt-unstudied', unstudied);
    set('cnt-maru', maru);
    set('cnt-sankaku', sankaku);
    set('cnt-batsu', batsu);
    set('cnt-starred', starred);
  }

  toggleChapter(chapterId) {
    if (this._openChapters.has(chapterId)) this._openChapters.delete(chapterId);
    else this._openChapters.add(chapterId);
    const el = document.getElementById('ch-' + chapterId);
    if (el) {
      el.classList.toggle('hidden');
      const btn = el.previousElementSibling;
      const icon = btn?.querySelector('[data-lucide]');
      if (icon) {
        icon.setAttribute('data-lucide', this._openChapters.has(chapterId) ? 'chevron-down' : 'chevron-right');
        if (window.lucide) lucide.createIcons();
      }
    }
  }

  toggleAllChapters(open) {
    const book = this.data.books.find(b => b.id === this.state.currentBookId);
    if (!book) return;
    book.chapters.forEach(c => {
      const el = document.getElementById('ch-' + c.id);
      if (!el) return;
      if (open) { el.classList.remove('hidden'); this._openChapters.add(c.id); }
      else { el.classList.add('hidden'); this._openChapters.delete(c.id); }
    });
    if (window.lucide) lucide.createIcons();
  }

  handleSearch(value) {
    this.state.searchQuery = value;
    document.getElementById('search-clear-btn')?.classList.toggle('hidden', !value);
    this._renderBookOnly();
  }

  clearSearch() {
    this.state.searchQuery = '';
    const inp = document.getElementById('search-input');
    if (inp) inp.value = '';
    document.getElementById('search-clear-btn')?.classList.add('hidden');
    this._renderBookOnly();
  }

  handleChapterFilter(val) {
    this.state.chapterFilter = val;
    this._renderBookOnly();
  }

  setStatusFilter(filter) {
    this.state.statusFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(btn => {
      const active = btn.dataset.status === filter;
      if (active) {
        btn.className = 'filter-btn px-3 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 bg-blue-600 text-white shadow-sm';
      } else {
        btn.className = 'filter-btn px-3 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700';
      }
    });
    this._renderBookOnly();
  }

  _renderBookOnly() {
    const book = this.data.books.find(b => b.id === this.state.currentBookId);
    if (!book) return;
    this.renderCurriculumList(book);
    this.updateCounts(book);
  }

  // ─────────────────────────────────────────
  // VIDEO MODAL (解説動画専用ポップアップ)
  // ─────────────────────────────────────────
  openVideoModal(problemId) {
    const problem = this.problemMap.get(problemId);
    if (!problem) return;
    this._videoModalProblemId = problemId;

    const url = problem.direct_url || problem.cds_url;

    // iframe
    const iframe = document.getElementById('vmodal-iframe');
    if (iframe) {
      iframe.src = '';
      setTimeout(() => { iframe.src = url; }, 50);
    }

    // tab link
    const tabLink = document.getElementById('vmodal-tab-link');
    if (tabLink) tabLink.href = url;

    // header info
    document.getElementById('vmodal-title').textContent = problem.title || '例題';
    document.getElementById('vmodal-subtitle').textContent =
      `${problem.chapter_title || ''} > ${problem.section_title || ''}`;
    document.getElementById('vmodal-subject-badge').textContent = problem.subject || '';

    // sync controls
    this._syncVideoModalStatus(problemId);
    this._syncVideoModalStar(problemId);
    const noteInput = document.getElementById('vmodal-note-input');
    if (noteInput) noteInput.value = this.state.noteMap[problemId] || '';
    document.getElementById('vmodal-note-panel')?.classList.add('hidden');

    // fallback hint banner: always visible or shown immediately so user knows they can click
    const fb = document.getElementById('vmodal-fallback');
    if (fb) {
      fb.classList.remove('hidden');
    }

    document.getElementById('modal-video-viewer')?.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (window.lucide) lucide.createIcons();
  }

  closeVideoModal() {
    const modal = document.getElementById('modal-video-viewer');
    if (!modal || modal.classList.contains('hidden')) return;

    // Auto-save note if opened/edited
    if (this._videoModalProblemId) {
      const inp = document.getElementById('vmodal-note-input');
      if (inp) {
        this.state.noteMap[this._videoModalProblemId] = inp.value;
      }
      this.saveState();
      this._refreshBook();
    }

    modal.classList.add('hidden');
    const iframe = document.getElementById('vmodal-iframe');
    if (iframe) iframe.src = '';
    this._videoModalProblemId = null;
    document.body.style.overflow = '';
  }

  openCurrentVideoInWindow() {
    const p = this.problemMap.get(this._videoModalProblemId);
    if (!p) return;
    const url = p.direct_url || p.cds_url;
    window.open(url, '_blank', 'width=1200,height=800,resizable=yes,scrollbars=yes');
  }

  _syncVideoModalStatus(problemId) {
    const status = this.state.statusMap[problemId] || 'unstudied';
    const activeClasses = {
      unstudied: ['bg-slate-600', 'text-white', 'font-bold'],
      maru:      ['bg-emerald-600', 'text-white', 'font-bold'],
      sankaku:   ['bg-amber-500', 'text-white', 'font-bold'],
      batsu:     ['bg-rose-600', 'text-white', 'font-bold'],
    };
    ['unstudied', 'maru', 'sankaku', 'batsu'].forEach(s => {
      ['vmodal-btn-' + s, 'vmodal-m-btn-' + s].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.classList.remove(
          'bg-blue-600', 'bg-slate-600', 'bg-emerald-600', 'bg-amber-500', 'bg-rose-600',
          'text-white', 'font-bold'
        );
        if (s === status) {
          btn.classList.add(...activeClasses[s]);
        }
      });
    });
  }

  _syncVideoModalStar(problemId) {
    const starred = this.state.starMap[problemId] || false;
    ['vmodal-star-btn', 'vmodal-m-star-btn'].forEach(id => {
      const icon = document.getElementById(id)?.querySelector('[data-lucide]');
      if (!icon) return;
      if (starred) icon.classList.add('fill-amber-400', 'text-amber-400');
      else icon.classList.remove('fill-amber-400', 'text-amber-400');
      icon.classList.remove('star-pop');
      void icon.offsetWidth;
      icon.classList.add('star-pop');
    });
  }

  setVideoModalStatus(status) {
    if (!this._videoModalProblemId) return;
    this.setProblemStatus(this._videoModalProblemId, status);
    this._syncVideoModalStatus(this._videoModalProblemId);
    this._refreshBook();
  }

  toggleVideoModalStar() {
    if (!this._videoModalProblemId) return;
    this.state.starMap[this._videoModalProblemId] = !this.state.starMap[this._videoModalProblemId];
    this.saveState();
    this._syncVideoModalStar(this._videoModalProblemId);
  }

  toggleVideoModalNote() {
    document.getElementById('vmodal-note-panel')?.classList.toggle('hidden');
  }

  saveVideoModalNote() {
    if (!this._videoModalProblemId) return;
    const inp = document.getElementById('vmodal-note-input');
    if (inp) { this.state.noteMap[this._videoModalProblemId] = inp.value; this.saveState(); }
    this._showToast('メモを保存しました');
  }

  openVideoFromProblemModal() {
    const id = this._problemModalProblemId;
    this.closeProblemModal();
    if (id) this.openVideoModal(id);
  }

  _refreshBook() {
    if (this.state.currentView === 'book') {
      const book = this.data.books.find(b => b.id === this.state.currentBookId);
      if (book) {
        this.renderBookHeader(book);
        this.renderCurriculumList(book);
        this.updateCounts(book);
      }
    } else if (this.state.currentView === 'pacemaker') {
      this.renderPacemakerView();
    } else if (this.state.currentView === 'dashboard') {
      this.renderDashboardView();
    }
  }

  // ─────────────────────────────────────────
  // PROBLEM MODAL
  // ─────────────────────────────────────────
  openProblemModal(problemId) {
    const problem = this.problemMap.get(problemId);
    if (!problem) return;
    this._problemModalProblemId = problemId;

    const colorMap = {
      '数学I+A': 'bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300',
      '数学II+B': 'bg-violet-100 dark:bg-violet-900/60 text-violet-700 dark:text-violet-300',
      '数学III': 'bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300',
      '数学C': 'bg-rose-100 dark:bg-rose-900/60 text-rose-700 dark:text-rose-300',
    };

    document.getElementById('modal-prob-title').textContent = problem.title || '';
    document.getElementById('modal-prob-path').textContent =
      `${problem.chapter_title || ''} > ${problem.section_title || ''}`;
    const subj = document.getElementById('modal-prob-subject');
    if (subj) {
      subj.textContent = problem.subject || '';
      subj.className = `text-xs px-2 py-0.5 rounded-full font-medium ${colorMap[problem.subject] || 'bg-slate-100 text-slate-600'}`;
    }

    this._syncProblemModalStatus(problemId);
    const starIcon = document.getElementById('modal-prob-star')?.querySelector('[data-lucide]');
    if (starIcon) {
      if (this.state.starMap[problemId]) starIcon.classList.add('fill-amber-400', 'text-amber-400');
      else starIcon.classList.remove('fill-amber-400', 'text-amber-400');
    }
    const noteInp = document.getElementById('modal-prob-note-input');
    if (noteInp) noteInp.value = this.state.noteMap[problemId] || '';

    document.getElementById('modal-problem-note')?.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (window.lucide) lucide.createIcons();
  }

  closeProblemModal() {
    if (this._problemModalProblemId) {
      const inp = document.getElementById('modal-prob-note-input');
      if (inp) {
        this.state.noteMap[this._problemModalProblemId] = inp.value;
      }
      this.saveState();
      this._refreshBook();
    }
    document.getElementById('modal-problem-note')?.classList.add('hidden');
    this._problemModalProblemId = null;
    document.body.style.overflow = '';
  }

  _syncProblemModalStatus(problemId) {
    const status = this.state.statusMap[problemId] || 'unstudied';
    const active = {
      unstudied: 'border-2 border-slate-400 bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-100 font-bold',
      maru:      'border-2 border-emerald-500 bg-emerald-100 dark:bg-emerald-900/70 text-emerald-950 dark:text-emerald-100 font-bold shadow-sm ring-2 ring-emerald-400/30',
      sankaku:   'border-2 border-amber-500 bg-amber-100 dark:bg-amber-900/70 text-amber-950 dark:text-amber-100 font-bold shadow-sm ring-2 ring-amber-400/30',
      batsu:     'border-2 border-rose-500 bg-rose-100 dark:bg-rose-900/70 text-rose-950 dark:text-rose-100 font-bold shadow-sm ring-2 ring-rose-400/30',
    };
    ['unstudied', 'maru', 'sankaku', 'batsu'].forEach(s => {
      const btn = document.getElementById('modal-btn-' + s);
      if (!btn) return;
      btn.className = `py-2 px-3 rounded-lg border text-center font-medium transition ${
        s === status ? active[s] : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
      }`;
    });
  }

  setCurrentModalStatus(status) {
    if (!this._problemModalProblemId) return;
    this.setProblemStatus(this._problemModalProblemId, status);
    this._syncProblemModalStatus(this._problemModalProblemId);
    this._refreshBook();
    const label = status === 'maru' ? '〇 習得済みに更新しました！' : status === 'sankaku' ? '△ 要復習に追加しました！' : status === 'batsu' ? '× 未定着に設定しました！' : '未着手に変更しました';
    this._showToast(label);
  }

  toggleCurrentModalStar() {
    if (!this._problemModalProblemId) return;
    const id = this._problemModalProblemId;
    this.state.starMap[id] = !this.state.starMap[id];
    this.saveState();
    const icon = document.getElementById('modal-prob-star')?.querySelector('[data-lucide]');
    if (icon) {
      if (this.state.starMap[id]) icon.classList.add('fill-amber-400', 'text-amber-400');
      else icon.classList.remove('fill-amber-400', 'text-amber-400');
      icon.classList.remove('star-pop');
      void icon.offsetWidth;
      icon.classList.add('star-pop');
    }
    this._showToast(this.state.starMap[id] ? 'お気に入りに追加しました ⭐' : 'お気に入りを解除しました');
    this._refreshBook();
  }

  saveCurrentModalNote() {
    this.closeProblemModal();
  }

  // ─────────────────────────────────────────
  // PACEMAKER VIEW (逆算ペースメーカー)
  // ─────────────────────────────────────────
  renderPacemakerView() {
    const el = document.getElementById('view-pacemaker');
    if (!el) return;
    const goals = this.state.goals || [];

    const empty = `
      <div class="flex flex-col items-center justify-center py-20 text-slate-400 dark:text-slate-500 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-8 text-center">
        <div class="w-16 h-16 rounded-2xl bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400 mb-4">
          <i data-lucide="target" class="w-8 h-8"></i>
        </div>
        <h3 class="text-base font-bold text-slate-800 dark:text-slate-100 mb-1">目標がまだ設定されていません</h3>
        <p class="text-xs text-slate-500 dark:text-slate-400 max-w-sm mb-6">
          塾の宿題や定期テストなどの「期日」と「範囲」を登録すると、今日から締め切りまでに解くべき1日の問題数を自動計算します。
        </p>
        <button onclick="app.openGoalModal()" class="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-md shadow-blue-500/20 flex items-center gap-2 transition">
          <i data-lucide="plus" class="w-4 h-4"></i>
          <span>最初の学習目標を追加する</span>
        </button>
      </div>`;

    // Calculate overall daily stats across all goals
    let overallDailyHtml = '';
    if (goals.length > 0) {
      const allProgs = goals.map(g => this.calcGoalProgress(g));
      const totalDailyTarget = allProgs.reduce((sum, p) => sum + p.dailyTarget, 0);
      const totalTodayDone = allProgs.reduce((sum, p) => sum + p.todayDone, 0);
      const totalTodayRemain = Math.max(0, totalDailyTarget - totalTodayDone);
      const totalTodayPct = totalDailyTarget > 0 ? Math.min(100, Math.round((totalTodayDone / totalDailyTarget) * 100)) : 100;
      const isAllDone = totalDailyTarget > 0 && totalTodayDone >= totalDailyTarget;

      // Count ALL problems completed today across all books
      const todayStr = this._getTodayStr();
      const allBooksTodayCompleted = Object.keys(this.state.statusMap || {}).filter(id =>
        (this.state.statusMap[id] === 'maru' || this.state.statusMap[id] === 'sankaku' || this.state.statusMap[id] === 'batsu') && this.state.completedDateMap?.[id] === todayStr
      ).length;

      overallDailyHtml = `
        <div class="mb-5 p-4 sm:p-5 rounded-2xl border ${
          isAllDone 
            ? 'bg-gradient-to-r from-emerald-500/10 via-teal-500/10 to-emerald-500/10 border-emerald-300 dark:border-emerald-800' 
            : 'bg-gradient-to-r from-blue-500/10 via-indigo-500/10 to-blue-500/10 border-blue-200 dark:border-blue-800/60'
        } shadow-sm backdrop-blur-sm">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3.5">
            <div>
              <div class="flex items-center gap-2">
                <span class="text-xl">${isAllDone ? '🏆' : '🔥'}</span>
                <h3 class="text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                  本日の総合学習サマリー (${this._getTodayStr()})
                </h3>
              </div>
              <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">全目標を合わせた今日の総合ノルマ進捗です</p>
            </div>
            <div>
              ${isAllDone 
                ? `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-500 text-white shadow-sm">
                     <i data-lucide="check-circle" class="w-4 h-4"></i> 本日の全ノルマ達成！
                   </span>`
                : `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-200">
                     本日残り <span class="text-sm font-black text-blue-600 dark:text-blue-300">${totalTodayRemain}</span> 問
                   </span>`
              }
            </div>
          </div>

          <div class="grid grid-cols-3 gap-2.5 sm:gap-4 text-center mb-3">
            <div class="p-2.5 sm:p-3 bg-white/90 dark:bg-slate-900/80 rounded-xl border border-slate-200/60 dark:border-slate-800 shadow-sm">
              <div class="text-xl sm:text-2xl font-black text-slate-800 dark:text-slate-100">${totalDailyTarget}</div>
              <div class="text-[10px] sm:text-xs text-slate-500 dark:text-slate-400 font-medium">本日の総ノルマ</div>
            </div>
            <div class="p-2.5 sm:p-3 bg-white/90 dark:bg-slate-900/80 rounded-xl border border-slate-200/60 dark:border-slate-800 shadow-sm">
              <div class="text-xl sm:text-2xl font-black text-emerald-600 dark:text-emerald-400">
                ${totalTodayDone} <span class="text-xs font-normal text-slate-400">問</span>
              </div>
              <div class="text-[10px] sm:text-xs text-slate-500 dark:text-slate-400 font-medium">
                目標内の本日完了 ${allBooksTodayCompleted > totalTodayDone ? `<span class="text-emerald-600 font-bold block sm:inline">(全体: ${allBooksTodayCompleted}問)</span>` : ''}
              </div>
            </div>
            <div class="p-2.5 sm:p-3 bg-white/90 dark:bg-slate-900/80 rounded-xl border border-slate-200/60 dark:border-slate-800 shadow-sm">
              <div class="text-xl sm:text-2xl font-black ${totalTodayRemain === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-600 dark:text-blue-400'}">${totalTodayRemain}</div>
              <div class="text-[10px] sm:text-xs text-slate-500 dark:text-slate-400 font-medium">本日の残り</div>
            </div>
          </div>

          <!-- Total Today Progress Bar -->
          <div class="space-y-1">
            <div class="flex items-center justify-between text-xs">
              <span class="text-slate-600 dark:text-slate-400 font-medium">本日の総合達成率</span>
              <span class="font-bold ${isAllDone ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-600 dark:text-blue-400'}">
                ${totalTodayDone} / ${totalDailyTarget} 問 (${totalTodayPct}%)
              </span>
            </div>
            <div class="h-3 bg-slate-200/80 dark:bg-slate-800 rounded-full overflow-hidden p-0.5 border border-slate-300/40 dark:border-slate-700">
              <div class="h-full rounded-full transition-all duration-700 ${
                isAllDone
                  ? 'bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-400 shadow-sm'
                  : 'bg-gradient-to-r from-blue-600 via-indigo-500 to-blue-500 shadow-sm'
              }" style="width:${totalTodayPct}%"></div>
            </div>
          </div>
        </div>
      `;
    }

    el.innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <div>
          <h2 class="text-xl font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
            <i data-lucide="target" class="w-5 h-5 text-blue-600"></i>
            <span>逆算ペースメーカー</span>
          </h2>
          <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">塾の宿題やテスト期日に合わせて、今日やるべきノルマと残りを自動計算します</p>
        </div>
        <button onclick="app.openGoalModal()" class="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-md shadow-blue-500/20 flex items-center gap-2 transition active:scale-95">
          <i data-lucide="plus" class="w-4 h-4"></i>
          <span>目標を追加</span>
        </button>
      </div>

      ${overallDailyHtml}

      ${goals.length === 0 ? empty : `<div class="grid grid-cols-1 md:grid-cols-2 gap-5">${goals.map(g => this.renderGoalCard(g)).join('')}</div>`}`;

    if (window.lucide) lucide.createIcons();
  }

  renderGoalCard(goal) {
    const prog = this.calcGoalProgress(goal);
    const paceColor = { good: 'text-emerald-600 dark:text-emerald-400', warn: 'text-amber-600 dark:text-amber-400', late: 'text-rose-600 dark:text-rose-400', done: 'text-blue-600 dark:text-blue-400' };
    const paceEmoji = { good: '🟢', warn: '🟡', late: '🔴', done: '✅' };
    const paceLabel = { good: '順調', warn: 'やや遅れ', late: '遅延', done: '達成完了' };
    const book = this.data.books.find(b => b.id === goal.bookId);
    let scopeLabel = (goal.chapterIds && goal.chapterIds.length)
      ? `${goal.chapterIds.length}個の章`
      : '全章';
    if (goal.numStart || goal.numEnd) {
      const startText = goal.numStart ? `例題${goal.numStart}` : '';
      const endText   = goal.numEnd   ? `例題${goal.numEnd}`   : '';
      scopeLabel += ` (${startText}〜${endText})`;
    }
    if (goal.statusFilter && goal.statusFilter !== 'all') {
      const sfMap = { 'not-maru': '△×のみ', 'sankaku': '△のみ', 'batsu': '×のみ' };
      scopeLabel += ` [${sfMap[goal.statusFilter] || goal.statusFilter}]`;
    }
    const overallPct = prog.totalProblems > 0 ? Math.round(prog.completedProblems / prog.totalProblems * 100) : 100;
    const isGoalDone = prog.remainProblems === 0;
    const isTodayQuotaDone = prog.dailyTarget > 0 && prog.todayDone >= prog.dailyTarget;

    return `
      <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-5 space-y-4 flex flex-col justify-between">
        <div class="space-y-4">
          <!-- Goal Card Header -->
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="font-bold text-base text-slate-800 dark:text-slate-100 truncate flex items-center gap-2">
                <span>${goal.name}</span>
                ${isGoalDone ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300">達成!</span>' : ''}
              </h3>
              <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">${book?.title || goal.bookId} · ${scopeLabel}</p>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <button onclick="app.openGoalModal('${goal.id}')" class="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 transition" title="編集">
                <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
              </button>
              <button onclick="app.deleteGoal('${goal.id}')" class="p-1.5 rounded-lg border border-rose-200 dark:border-rose-900/40 hover:bg-rose-50 dark:hover:bg-rose-950/20 text-rose-500 dark:text-rose-400 transition" title="削除">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
              </button>
            </div>
          </div>

          <!-- TODAY'S PROGRESS & QUOTA PANEL (今日のノルマ進捗バー & 今日の残り問題数) -->
          <div class="p-3.5 sm:p-4 rounded-xl border ${
            isTodayQuotaDone
              ? 'bg-emerald-50/90 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-800/80 shadow-sm'
              : 'bg-gradient-to-br from-blue-50/80 to-indigo-50/80 dark:from-blue-950/40 dark:to-indigo-950/40 border-blue-200 dark:border-blue-800/60 shadow-sm'
          } space-y-3">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-1.5">
                <span class="text-base">${isTodayQuotaDone ? '🎉' : '⏱️'}</span>
                <span class="text-xs font-bold ${isTodayQuotaDone ? 'text-emerald-900 dark:text-emerald-200' : 'text-blue-900 dark:text-blue-200'}">
                  今日のノルマ進捗
                </span>
              </div>
              <div>
                ${
                  isTodayQuotaDone
                    ? `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-600 text-white shadow-sm flex items-center gap-1 animate-pulse-subtle">
                         <i data-lucide="check" class="w-3 h-3"></i> 本日のノルマ達成！
                       </span>`
                    : `<span class="text-xs font-medium text-slate-600 dark:text-slate-300">
                         今日残り <span class="text-sm font-black text-blue-600 dark:text-blue-400">${prog.todayRemain}</span> 問
                       </span>`
                }
              </div>
            </div>

            <!-- Today's 3 Metrics -->
            <div class="grid grid-cols-3 gap-2 text-center">
              <div class="p-2 bg-white/90 dark:bg-slate-900/80 rounded-lg border border-slate-200/60 dark:border-slate-800">
                <div class="text-lg font-black text-slate-800 dark:text-slate-100">${prog.dailyTarget}</div>
                <div class="text-[10px] text-slate-500 dark:text-slate-400 font-medium">今日のノルマ</div>
              </div>
              <div class="p-2 bg-white/90 dark:bg-slate-900/80 rounded-lg border border-slate-200/60 dark:border-slate-800">
                <div class="text-lg font-black text-emerald-600 dark:text-emerald-400">${prog.todayDone}</div>
                <div class="text-[10px] text-slate-500 dark:text-slate-400 font-medium">今日完了</div>
              </div>
              <div class="p-2 bg-white/90 dark:bg-slate-900/80 rounded-lg border border-slate-200/60 dark:border-slate-800">
                <div class="text-lg font-black ${prog.todayRemain === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-600 dark:text-blue-400'}">${prog.todayRemain}</div>
                <div class="text-[10px] text-slate-500 dark:text-slate-400 font-medium">今日の残り</div>
              </div>
            </div>

            <!-- Today's Quota Progress Bar -->
            <div class="space-y-1">
              <div class="flex items-center justify-between text-[11px]">
                <span class="text-slate-600 dark:text-slate-400 font-medium">今日のノルマ進捗バー</span>
                <span class="font-extrabold ${isTodayQuotaDone ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-600 dark:text-blue-400'}">
                  ${prog.todayDone} / ${prog.dailyTarget} 問 (${prog.todayPct}%)
                </span>
              </div>
              <div class="h-2.5 bg-white/90 dark:bg-slate-800 rounded-full overflow-hidden p-0.5 border border-slate-200/70 dark:border-slate-700">
                <div class="h-full rounded-full transition-all duration-700 ease-out shimmer-active ${
                  isTodayQuotaDone
                    ? 'bg-gradient-to-r from-emerald-500 to-teal-400 shadow-sm'
                    : 'bg-gradient-to-r from-blue-500 to-indigo-500 shadow-sm'
                }" style="width:${prog.todayPct}%"></div>
              </div>
            </div>
          </div>

          <!-- Overall Scope Metrics -->
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 text-center text-xs">
            <div class="p-2.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl">
              <div class="text-lg font-black text-slate-800 dark:text-slate-100">${Math.max(0, prog.daysLeft)} <span class="text-xs font-normal text-slate-400">日</span></div>
              <div class="text-[10px] text-slate-500 dark:text-slate-400 font-medium">残り日数</div>
            </div>
            <div class="p-2.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl">
              <div class="text-lg font-black text-slate-800 dark:text-slate-100">${prog.remainProblems} <span class="text-xs font-normal text-slate-400">問</span></div>
              <div class="text-[10px] text-slate-500 dark:text-slate-400 font-medium">全体の残り問題数</div>
            </div>
            <div class="col-span-2 sm:col-span-1 p-2.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl">
              <div class="text-lg font-black text-slate-800 dark:text-slate-100">${overallPct}%</div>
              <div class="text-[10px] text-slate-500 dark:text-slate-400 font-medium">目標全体の達成度</div>
            </div>
          </div>

          <!-- Overall Goal Progress Bar -->
          <div class="space-y-1">
            <div class="flex items-center justify-between text-xs">
              <span class="text-slate-500 dark:text-slate-400">目標全体の累計進捗</span>
              <span class="font-bold text-slate-700 dark:text-slate-200">${prog.completedProblems} / ${prog.totalProblems} 問 (${overallPct}%)</span>
            </div>
            <div class="h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
              <div class="h-full bg-emerald-500 rounded-full transition-all duration-700" style="width:${overallPct}%"></div>
            </div>
          </div>
        </div>

        <!-- Footer Actions -->
        <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
          <div class="flex items-center gap-1.5">
            <span>${paceEmoji[prog.paceStatus]}</span>
            <span class="font-bold ${paceColor[prog.paceStatus]}">${paceLabel[prog.paceStatus]}</span>
            <span class="text-slate-400">· 期日: ${goal.deadline}</span>
          </div>
          <button onclick="app.jumpToGoalRange('${goal.id}')" class="px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-semibold hover:bg-indigo-100 dark:hover:bg-indigo-800/40 transition flex items-center gap-1 shadow-sm active:scale-95">
            <i data-lucide="arrow-right" class="w-3.5 h-3.5"></i>
            <span>この範囲を解く</span>
          </button>
        </div>
      </div>`;
  }

  calcGoalProgress(goal) {
    const todayStr = this._getTodayStr();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const deadline = new Date(goal.deadline); deadline.setHours(0, 0, 0, 0);
    const daysLeft = Math.ceil((deadline - today) / 86400000);

    const book = this.data.books.find(b => b.id === goal.bookId);
    if (!book) return { 
      daysLeft, totalProblems: 0, remainProblems: 0, completedProblems: 0, 
      dailyTarget: 0, todayDone: 0, todayRemain: 0, todayPct: 0, paceStatus: 'done' 
    };

    let problems = book.chapters.flatMap(c => (c.problems || []).map(p => ({ ...p, chapter_id: c.id })));
    if (goal.chapterIds && goal.chapterIds.length) {
      problems = problems.filter(p => goal.chapterIds.includes(p.chapter_id));
    }

    // Filter by example number range (e.g. 例題127 〜 140)
    if (goal.numStart || goal.numEnd) {
      problems = problems.filter(p => {
        const m = p.title && p.title.match(/例題\s*(\d+)/);
        if (!m) return false;
        const n = parseInt(m[1], 10);
        if (goal.numStart && n < goal.numStart) return false;
        if (goal.numEnd   && n > goal.numEnd)   return false;
        return true;
      });
    }

    // Filter by status scope if specified
    if (goal.statusFilter === 'not-maru') {
      // △×のみ（未習得）を対象
      problems = problems.filter(p => this.state.statusMap[p.id] !== 'maru');
    } else if (goal.statusFilter === 'sankaku') {
      problems = problems.filter(p => this.state.statusMap[p.id] === 'sankaku');
    } else if (goal.statusFilter === 'batsu') {
      problems = problems.filter(p => this.state.statusMap[p.id] === 'batsu');
    }

    const totalProblems = problems.length;
    // Count problems studied (maru, sankaku, batsu) as done / progress
    const studiedProblems = problems.filter(p => {
      const st = this.state.statusMap[p.id];
      return st === 'maru' || st === 'sankaku' || st === 'batsu';
    }).length;
    const remainProblems = totalProblems - studiedProblems;
    const completedProblems = studiedProblems;

    // Problems done today for this goal (today studied: maru/sankaku/batsu)
    const todayDone = problems.filter(p => 
      (this.state.statusMap[p.id] === 'maru' || this.state.statusMap[p.id] === 'sankaku' || this.state.statusMap[p.id] === 'batsu') && 
      this.state.completedDateMap?.[p.id] === todayStr
    ).length;

    // Remaining total from start of today = currently remaining + already done today
    const neededForToday = remainProblems + todayDone;
    const dailyTarget = (daysLeft > 0)
      ? Math.ceil(neededForToday / Math.max(1, daysLeft))
      : neededForToday;

    const todayRemain = Math.max(0, dailyTarget - todayDone);
    const todayPct = dailyTarget > 0 ? Math.min(100, Math.round((todayDone / dailyTarget) * 100)) : (todayDone > 0 ? 100 : 0);

    let paceStatus = 'good';
    if (remainProblems === 0) paceStatus = 'done';
    else if (daysLeft <= 0) paceStatus = 'late';
    else {
      const created = new Date(goal.createdAt || today); created.setHours(0, 0, 0, 0);
      const totalDays = Math.max(1, Math.ceil((deadline - created) / 86400000));
      const elapsedDays = totalDays - daysLeft;
      const expectedDone = Math.round(totalProblems * elapsedDays / totalDays);
      paceStatus = completedProblems >= expectedDone ? 'good' : completedProblems >= expectedDone * 0.75 ? 'warn' : 'late';
    }

    return {
      daysLeft,
      totalProblems,
      remainProblems,
      completedProblems,
      dailyTarget,
      todayDone,
      todayRemain,
      todayPct,
      paceStatus,
    };
  }

  jumpToGoalRange(goalId) {
    const goal = (this.state.goals || []).find(g => g.id === goalId);
    if (!goal) return;
    this.state.currentBookId = goal.bookId;
    this.state.chapterFilter = (goal.chapterIds && goal.chapterIds.length === 1) ? goal.chapterIds[0] : 'all';
    this.state.statusFilter = 'all';
    this.state.searchQuery = '';
    if (goal.chapterIds) goal.chapterIds.forEach(id => this._openChapters.add(id));
    this.switchView('book', goal.bookId);
  }

  deleteGoal(goalId) {
    if (!confirm('この目標を削除しますか？')) return;
    this.state.goals = (this.state.goals || []).filter(g => g.id !== goalId);
    this.saveState();
    this.renderPacemakerView();
  }

  // GOAL MODAL
  openGoalModal(editGoalId) {
    const modal = document.getElementById('modal-goal');
    if (!modal) return;

    const bookSel = document.getElementById('goal-form-book');
    if (bookSel) bookSel.innerHTML = this.data.books.map(b => `<option value="${b.id}">${b.title}</option>`).join('');

    if (editGoalId) {
      const goal = (this.state.goals || []).find(g => g.id === editGoalId);
      if (!goal) return;
      document.getElementById('goal-form-id').value = goal.id;
      document.getElementById('goal-form-name').value = goal.name;
      document.getElementById('goal-form-book').value = goal.bookId;
      document.getElementById('goal-form-deadline').value = goal.deadline;
      document.getElementById('modal-goal-title').textContent = '学習目標を編集';
      this.handleGoalBookChange(goal.bookId);
      const hasCustom = goal.chapterIds && goal.chapterIds.length > 0;
      document.querySelector(`input[name="goal-scope-type"][value="${hasCustom ? 'custom' : 'all'}"]`).checked = true;
      this.handleGoalScopeTypeChange(hasCustom ? 'custom' : 'all');
      if (hasCustom) {
        setTimeout(() => {
          goal.chapterIds.forEach(id => {
            const cb = document.getElementById('ch-cb-' + id);
            if (cb) cb.checked = true;
          });
        }, 50);
      }
      const numStartEl = document.getElementById('goal-form-num-start');
      const numEndEl   = document.getElementById('goal-form-num-end');
      if (numStartEl) numStartEl.value = goal.numStart || '';
      if (numEndEl)   numEndEl.value   = goal.numEnd   || '';
      const sfVal = goal.statusFilter || 'all';
      const sfEl = document.querySelector(`input[name="goal-status-filter"][value="${sfVal}"]`);
      if (sfEl) sfEl.checked = true;
    } else {
      document.getElementById('goal-form-id').value = '';
      document.getElementById('goal-form-name').value = '';
      document.getElementById('goal-form-deadline').value = '';
      document.getElementById('modal-goal-title').textContent = '学習目標・期日の設定';
      document.querySelector('input[name="goal-scope-type"][value="all"]').checked = true;
      this.handleGoalScopeTypeChange('all');
      this.handleGoalBookChange(this.data.books[0]?.id);
      const numStartEl = document.getElementById('goal-form-num-start');
      const numEndEl   = document.getElementById('goal-form-num-end');
      if (numStartEl) numStartEl.value = '';
      if (numEndEl)   numEndEl.value   = '';
      const sfEl = document.querySelector('input[name="goal-status-filter"][value="all"]');
      if (sfEl) sfEl.checked = true;
    }

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (window.lucide) lucide.createIcons();
  }

  closeGoalModal() {
    document.getElementById('modal-goal')?.classList.add('hidden');
    document.body.style.overflow = '';
  }

  handleGoalBookChange(bookId) {
    if (!bookId) return;
    const book = this.data.books.find(b => b.id === bookId);
    if (!book) return;
    const container = document.getElementById('goal-chapters-checkboxes');
    if (!container) return;
    container.innerHTML = book.chapters.map(c => `
      <label class="flex items-center gap-2 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700/50 rounded-lg px-2 py-1 transition">
        <input type="checkbox" id="ch-cb-${c.id}" value="${c.id}" class="rounded accent-blue-600">
        <span class="text-xs text-slate-700 dark:text-slate-200">${c.title} (${c.problems.length}問)</span>
      </label>`).join('');
  }

  handleGoalScopeTypeChange(type) {
    const container = document.getElementById('goal-scope-custom-container');
    if (!container) return;
    if (type === 'custom') container.classList.remove('hidden');
    else container.classList.add('hidden');
  }

  handleSaveGoal(e) {
    e.preventDefault();
    const id = document.getElementById('goal-form-id').value || 'goal_' + Date.now();
    const name = document.getElementById('goal-form-name').value.trim();
    const bookId = document.getElementById('goal-form-book').value;
    const deadline = document.getElementById('goal-form-deadline').value;
    const scopeType = document.querySelector('input[name="goal-scope-type"]:checked')?.value;
    const chapterIds = scopeType === 'custom'
      ? [...document.querySelectorAll('#goal-chapters-checkboxes input[type="checkbox"]:checked')].map(cb => cb.value)
      : [];

    const numStartEl = document.getElementById('goal-form-num-start');
    const numEndEl   = document.getElementById('goal-form-num-end');
    const sfEl       = document.querySelector('input[name="goal-status-filter"]:checked');
    const numStart   = (numStartEl && numStartEl.value) ? parseInt(numStartEl.value, 10) : null;
    const numEnd     = (numEndEl   && numEndEl.value)   ? parseInt(numEndEl.value, 10)   : null;
    const statusFilter = sfEl ? sfEl.value : 'all';

    const existing = (this.state.goals || []).find(g => g.id === id);
    const goal = { id, name, bookId, deadline, chapterIds, numStart, numEnd, statusFilter, createdAt: existing?.createdAt || new Date().toISOString().slice(0, 10) };
    if (!this.state.goals) this.state.goals = [];
    const idx = this.state.goals.findIndex(g => g.id === id);
    if (idx >= 0) this.state.goals[idx] = goal;
    else this.state.goals.push(goal);
    this.saveState();
    this.closeGoalModal();
    this.renderPacemakerView();
  }

  // ─────────────────────────────────────────
  // DASHBOARD VIEW
  // ─────────────────────────────────────────
  renderDashboardView() {
    const el = document.getElementById('view-dashboard');
    if (!el) return;

    const allProblems = this.data.books.flatMap(b =>
      b.chapters.flatMap(c => (c.problems || []).map(p => ({ ...p, book_id: b.id, subject: b.subject, chapter_title: c.title })))
    );
    const total   = allProblems.length;
    const maru    = allProblems.filter(p => this.state.statusMap[p.id] === 'maru').length;
    const sankaku = allProblems.filter(p => this.state.statusMap[p.id] === 'sankaku').length;
    const batsu   = allProblems.filter(p => this.state.statusMap[p.id] === 'batsu').length;
    const starred = allProblems.filter(p => this.state.starMap[p.id]).length;
    
    // △ and × are counted as studied progress
    const studied = maru + sankaku + batsu;
    const pct     = total ? Math.round(studied / total * 100) : 0;
    const maruPct    = total ? (maru    / total * 100) : 0;
    const sankakuPct = total ? (sankaku / total * 100) : 0;
    const batsuPct   = total ? (batsu   / total * 100) : 0;

    const bookStats = this.data.books.map(b => {
      const bp = b.chapters.flatMap(c => c.problems || []);
      const bMaru    = bp.filter(p => this.state.statusMap[p.id] === 'maru').length;
      const bSankaku = bp.filter(p => this.state.statusMap[p.id] === 'sankaku').length;
      const bBatsu   = bp.filter(p => this.state.statusMap[p.id] === 'batsu').length;
      const bStudied = bMaru + bSankaku + bBatsu;
      const bpct = bp.length ? Math.round(bStudied / bp.length * 100) : 0;
      const bMaruPct    = bp.length ? (bMaru    / bp.length * 100) : 0;
      const bSankakuPct = bp.length ? (bSankaku / bp.length * 100) : 0;
      const bBatsuPct   = bp.length ? (bBatsu   / bp.length * 100) : 0;
      return { 
        ...b, total: bp.length, maru: bMaru, sankaku: bSankaku, batsu: bBatsu, studied: bStudied, pct: bpct,
        maruPct: bMaruPct, sankakuPct: bSankakuPct, batsuPct: bBatsuPct 
      };
    });

    // Grouping helper for review lists
    const groupByChapter = (list) => {
      const map = {};
      list.forEach(p => {
        if (!map[p.chapter_title]) map[p.chapter_title] = [];
        map[p.chapter_title].push(p);
      });
      return map;
    };

    const sankakuList = allProblems.filter(p => this.state.statusMap[p.id] === 'sankaku');
    const batsuList   = allProblems.filter(p => this.state.statusMap[p.id] === 'batsu');
    const starList    = allProblems.filter(p => this.state.starMap[p.id]).slice(0, 40);

    const renderReviewSection = (list, title, borderColor, headerColor, iconName, bgItem, borderItem, dotBg) => {
      if (!list.length) return '';
      const grouped = groupByChapter(list);
      const chapters = Object.keys(grouped);
      return `
        <div class="bg-white dark:bg-slate-900 rounded-2xl border ${borderColor} shadow-sm p-5 mb-6">
          <h3 class="font-bold ${headerColor} text-sm mb-3 flex items-center gap-2">
            <i data-lucide="${iconName}" class="w-4 h-4"></i> ${title} (${list.length}問)
          </h3>
          <div class="space-y-4">
            ${chapters.map(ch => `
              <div class="border-t border-slate-100 dark:border-slate-800 pt-3 first:border-0 first:pt-0">
                <div class="text-xs font-bold text-slate-600 dark:text-slate-300 mb-2 px-1 flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full ${dotBg}"></span>
                  <span>${ch}</span>
                  <span class="text-[10px] text-slate-400 font-normal">(${grouped[ch].length}問)</span>
                </div>
                <div class="space-y-1.5">
                  ${grouped[ch].map(p => `
                    <div onclick="app.openProblemModal('${p.id}')" class="flex items-center justify-between text-xs py-2 px-3 rounded-xl ${bgItem} border ${borderItem} cursor-pointer hover:shadow-sm transition">
                      <div class="min-w-0">
                        <span class="font-bold text-slate-800 dark:text-slate-100">${p.title}</span>
                        <span class="text-slate-400 ml-2 text-[11px]">${p.subject}</span>
                      </div>
                      <div class="flex items-center gap-1.5 ml-2 shrink-0" onclick="event.stopPropagation()">
                        <button onclick="event.stopPropagation(); app.openVideoModal('${p.id}')" class="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-bold flex items-center gap-1 transition">
                          <i data-lucide="play" class="w-3 h-3 fill-white"></i> 解説
                        </button>
                        <a href="${p.direct_url || p.cds_url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="p-1 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition">
                          <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                        </a>
                      </div>
                    </div>`).join('')}
                </div>
              </div>`).join('')}
          </div>
        </div>`;
    };

    el.innerHTML = `
      <h2 class="text-xl font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-4">
        <i data-lucide="bar-chart-2" class="w-5 h-5 text-blue-600"></i>
        <span>学習ダッシュボード</span>
      </h2>

      <!-- 4 Stat Summary Cards -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        ${[
          { label: '全体進捗', val: pct + '%', sub: `${studied}/${total}問`, color: 'text-blue-600 dark:text-blue-400' },
          { label: '〇 習得済み', val: maru + '問', sub: `${total ? Math.round(maru/total*100) : 0}%`, color: 'text-emerald-600 dark:text-emerald-400' },
          { label: '△ 要復習', val: sankaku + '問', sub: `${total ? Math.round(sankaku/total*100) : 0}%`, color: 'text-amber-600 dark:text-amber-400' },
          { label: '× 未定着', val: batsu + '問', sub: `${total ? Math.round(batsu/total*100) : 0}%`, color: 'text-rose-600 dark:text-rose-400' },
        ].map(s => `
          <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 text-center shadow-sm">
            <div class="text-3xl font-black ${s.color}">${s.val}</div>
            <div class="text-xs text-slate-500 dark:text-slate-400 mt-1 font-medium">${s.label}</div>
            <div class="text-[10px] text-slate-400 mt-0.5">${s.sub}</div>
          </div>`).join('')}
      </div>

      <!-- Segmented Multi-Color Progress Bar -->
      <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-5 mb-6">
        <div class="flex items-center justify-between text-xs mb-2">
          <span class="font-bold text-slate-700 dark:text-slate-200">全体進捗バー <span class="text-blue-600 font-extrabold">${pct}%</span></span>
          <span class="text-slate-500 dark:text-slate-400 font-medium">${studied} / ${total} 問 学習完了</span>
        </div>
        <div class="h-3.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden flex shadow-inner">
          <div class="h-full bg-emerald-500 transition-all duration-700" style="width:${maruPct.toFixed(1)}%" title="〇 習得済み: ${maru}問 (${maruPct.toFixed(1)}%)"></div>
          <div class="h-full bg-amber-400 transition-all duration-700"  style="width:${sankakuPct.toFixed(1)}%" title="△ 要復習: ${sankaku}問 (${sankakuPct.toFixed(1)}%)"></div>
          <div class="h-full bg-rose-500 transition-all duration-700"   style="width:${batsuPct.toFixed(1)}%" title="× 未定着: ${batsu}問 (${batsuPct.toFixed(1)}%)"></div>
        </div>
        <div class="flex flex-wrap items-center gap-4 mt-3 text-xs text-slate-600 dark:text-slate-300">
          <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block shadow-sm"></span>〇 習得済: <b>${maru}</b>問</span>
          <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block shadow-sm"></span>△ 要復習: <b>${sankaku}</b>問</span>
          <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block shadow-sm"></span>× 未定着: <b>${batsu}</b>問</span>
          <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-slate-300 dark:bg-slate-600 inline-block shadow-sm"></span>未着手: <b>${total - studied}</b>問</span>
        </div>
      </div>

      <!-- Per-Book Segmented Progress Bars -->
      <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-5 space-y-4 mb-6">
        <h3 class="font-bold text-slate-700 dark:text-slate-200 text-sm">教材別 進捗</h3>
        ${bookStats.map(b => `
          <div>
            <div class="flex items-center justify-between text-xs mb-1.5">
              <button onclick="app.switchView('book','${b.id}')" class="font-semibold text-slate-700 dark:text-slate-200 hover:text-blue-600 dark:hover:text-blue-400 transition">${b.title}</button>
              <span class="text-slate-500 dark:text-slate-400 text-[11px]">
                <span class="text-emerald-600 font-semibold">〇${b.maru}</span>
                <span class="text-amber-500 font-semibold ml-1">△${b.sankaku}</span>
                <span class="text-rose-500 font-semibold ml-1">×${b.batsu}</span>
                <span class="ml-1.5">/ ${b.total}問 (${b.pct}%)</span>
              </span>
            </div>
            <div class="h-2.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden flex">
              <div class="h-full bg-emerald-500 transition-all duration-700" style="width:${b.maruPct.toFixed(1)}%"></div>
              <div class="h-full bg-amber-400 transition-all duration-700"  style="width:${b.sankakuPct.toFixed(1)}%"></div>
              <div class="h-full bg-rose-500 transition-all duration-700"   style="width:${b.batsuPct.toFixed(1)}%"></div>
            </div>
          </div>`).join('')}
      </div>

      <!-- △ 要復習リスト (章ごとにグループ化) -->
      ${renderReviewSection(sankakuList, '△ 要復習リスト', 'border-amber-200 dark:border-amber-800/40', 'text-amber-700 dark:text-amber-400', 'alert-triangle', 'bg-amber-50/50 dark:bg-amber-950/20', 'border-amber-100 dark:border-amber-900/30', 'bg-amber-500')}

      <!-- × 未定着リスト (章ごとにグループ化) -->
      ${renderReviewSection(batsuList, '× 未定着リスト', 'border-rose-200 dark:border-rose-800/40', 'text-rose-700 dark:text-rose-400', 'x-circle', 'bg-rose-50/50 dark:bg-rose-950/20', 'border-rose-100 dark:border-rose-900/30', 'bg-rose-500')}

      <!-- ★ お気に入り -->
      ${starList.length ? `
        <div class="bg-white dark:bg-slate-900 rounded-2xl border border-amber-200 dark:border-amber-800/40 shadow-sm p-5 mb-6">
          <h3 class="font-bold text-amber-600 dark:text-amber-400 text-sm mb-3 flex items-center gap-2">
            <i data-lucide="star" class="w-4 h-4 fill-amber-400"></i> お気に入り (${starList.length}問)
          </h3>
          <div class="space-y-1.5">
            ${starList.map(p => `
              <div onclick="app.openProblemModal('${p.id}')" class="flex items-center justify-between text-xs py-2 px-3 rounded-xl bg-amber-50/30 dark:bg-amber-950/10 border border-amber-100 dark:border-amber-900/20 cursor-pointer hover:border-amber-400 transition">
                <div class="min-w-0">
                  <span class="font-bold text-slate-800 dark:text-slate-100">${p.title}</span>
                  <span class="text-slate-400 ml-2">${p.chapter_title}</span>
                </div>
                <div class="flex items-center gap-1.5 ml-2 shrink-0" onclick="event.stopPropagation()">
                  <button onclick="event.stopPropagation(); app.openVideoModal('${p.id}')" class="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-bold flex items-center gap-1 transition">
                    <i data-lucide="play" class="w-3 h-3 fill-white"></i> 解説
                  </button>
                  <a href="${p.direct_url || p.cds_url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="p-1 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition">
                    <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                  </a>
                </div>
              </div>`).join('')}
          </div>
        </div>` : ''}
    `;
    if (window.lucide) lucide.createIcons();
  }

  // ─────────────────────────────────────────
  // CUSTOM RESOURCES VIEW
  // ─────────────────────────────────────────
  renderCustomView() {
    const el = document.getElementById('view-custom');
    if (!el) return;
    const resources = this.state.customResources || [];
    const catColor = {
      '数学': 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
      '英語': 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300',
      '物理': 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
      '化学': 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300',
      '国語': 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
    };

    el.innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
          <i data-lucide="folder-open" class="w-5 h-5 text-blue-600"></i>
          <span>自作資料・参考リンク</span>
        </h2>
        <button onclick="app.openCustomModal()" class="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-md shadow-blue-500/20 flex items-center gap-2 transition">
          <i data-lucide="plus" class="w-4 h-4"></i>
          <span>資料を追加</span>
        </button>
      </div>
      ${resources.length === 0 ? `
        <div class="flex flex-col items-center justify-center py-20 text-slate-400 dark:text-slate-500 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-8 text-center">
          <i data-lucide="folder-open" class="w-14 h-14 mb-3 opacity-30"></i>
          <p class="text-base font-bold text-slate-700 dark:text-slate-300">資料が追加されていません</p>
          <p class="text-xs text-slate-400 mt-1">青チャート以外のYouTube動画・PDF・Web教材などをまとめて管理できます</p>
        </div>` : `
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          ${resources.map(r => `
            <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-4 space-y-3">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <span class="text-[11px] px-2 py-0.5 rounded-full font-medium ${catColor[r.category] || 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'}">${r.category || 'その他'}</span>
                  <h4 class="font-bold text-sm text-slate-800 dark:text-slate-100 mt-1.5 truncate">${r.name}</h4>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <button onclick="app.openCustomModal('${r.id}')" class="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                  <button onclick="app.deleteCustomResource('${r.id}')" class="p-1 rounded text-rose-400 hover:text-rose-600 transition"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
              </div>
              ${r.desc ? `<p class="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">${r.desc}</p>` : ''}
              ${r.url ? `<a href="${r.url}" target="_blank" rel="noopener" class="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:underline truncate"><i data-lucide="external-link" class="w-3 h-3 shrink-0"></i><span class="truncate">${r.url}</span></a>` : ''}
            </div>`).join('')}
        </div>`}`;
    if (window.lucide) lucide.createIcons();
  }

  openCustomModal(editId) {
    const modal = document.getElementById('modal-custom-resource');
    if (!modal) return;
    if (editId) {
      const r = (this.state.customResources || []).find(x => x.id === editId);
      if (!r) return;
      document.getElementById('custom-res-id').value = r.id;
      document.getElementById('custom-res-name').value = r.name || '';
      document.getElementById('custom-res-category').value = r.category || '数学';
      document.getElementById('custom-res-url').value = r.url || '';
      document.getElementById('custom-res-desc').value = r.desc || '';
      document.getElementById('custom-modal-title').textContent = '学習資料の編集';
    } else {
      document.getElementById('custom-res-id').value = '';
      document.getElementById('custom-res-name').value = '';
      document.getElementById('custom-res-category').value = '数学';
      document.getElementById('custom-res-url').value = '';
      document.getElementById('custom-res-desc').value = '';
      document.getElementById('custom-modal-title').textContent = '学習資料の追加';
    }
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  closeCustomModal() {
    document.getElementById('modal-custom-resource')?.classList.add('hidden');
    document.body.style.overflow = '';
  }

  handleSaveCustomResource(e) {
    e.preventDefault();
    const id = document.getElementById('custom-res-id').value || 'res_' + Date.now();
    const res = {
      id,
      name: document.getElementById('custom-res-name').value.trim(),
      category: document.getElementById('custom-res-category').value,
      url: document.getElementById('custom-res-url').value.trim(),
      desc: document.getElementById('custom-res-desc').value.trim(),
    };
    if (!this.state.customResources) this.state.customResources = [];
    const idx = this.state.customResources.findIndex(r => r.id === id);
    if (idx >= 0) this.state.customResources[idx] = res;
    else this.state.customResources.push(res);
    this.saveState();
    this.closeCustomModal();
    this.renderCustomView();
  }

  deleteCustomResource(id) {
    if (!confirm('この資料を削除しますか？')) return;
    this.state.customResources = (this.state.customResources || []).filter(r => r.id !== id);
    this.saveState();
    this.renderCustomView();
  }

  // ─────────────────────────────────────────
  // POMODORO TIMER
  // ─────────────────────────────────────────
  toggleTimerModal() { document.getElementById('modal-timer')?.classList.toggle('hidden'); }

  setTimerMode(mode) {
    this._timerMode = mode;
    this._timerRunning = false;
    clearInterval(this._timerInterval);
    this._timerRemaining = this._timerModes[mode];
    this._updateTimerDisplay();
    ['work', 'shortBreak', 'longBreak'].forEach(m => {
      const btn = document.getElementById('timer-mode-' + m);
      if (!btn) return;
      if (m === mode) btn.classList.add('bg-white', 'dark:bg-slate-700', 'text-blue-600', 'dark:text-blue-300', 'shadow-sm');
      else btn.classList.remove('bg-white', 'dark:bg-slate-700', 'text-blue-600', 'dark:text-blue-300', 'shadow-sm');
    });
    const playBtn = document.getElementById('btn-timer-play');
    if (playBtn) {
      playBtn.querySelector('[data-lucide]')?.setAttribute('data-lucide', 'play');
      playBtn.querySelector('span').textContent = 'スタート';
      if (window.lucide) lucide.createIcons();
    }
    document.getElementById('nav-timer-dot')?.classList.add('hidden');
  }

  startStopTimer() {
    if (this._timerRunning) {
      this._timerRunning = false;
      clearInterval(this._timerInterval);
      const playBtn = document.getElementById('btn-timer-play');
      if (playBtn) {
        playBtn.querySelector('[data-lucide]')?.setAttribute('data-lucide', 'play');
        playBtn.querySelector('span').textContent = 'スタート';
        if (window.lucide) lucide.createIcons();
      }
      document.getElementById('nav-timer-dot')?.classList.add('hidden');
    } else {
      this._timerRunning = true;
      this._timerInterval = setInterval(() => {
        this._timerRemaining--;
        this._updateTimerDisplay();
        if (this._timerRemaining <= 0) {
          clearInterval(this._timerInterval);
          this._timerRunning = false;
          if (this._timerMode === 'work') {
            this._timerSessions++;
            const sc = document.getElementById('timer-sessions-count');
            if (sc) sc.textContent = this._timerSessions + ' 回';
          }
          alert(this._timerMode === 'work' ? '集中セッション終了！お疲れ様です！' : '休憩終了！また集中しましょう！');
        }
      }, 1000);
      const playBtn = document.getElementById('btn-timer-play');
      if (playBtn) {
        playBtn.querySelector('[data-lucide]')?.setAttribute('data-lucide', 'pause');
        playBtn.querySelector('span').textContent = '一時停止';
        if (window.lucide) lucide.createIcons();
      }
      document.getElementById('nav-timer-dot')?.classList.remove('hidden');
    }
  }

  resetTimer() {
    this._timerRunning = false;
    clearInterval(this._timerInterval);
    this._timerRemaining = this._timerModes[this._timerMode];
    this._updateTimerDisplay();
    const playBtn = document.getElementById('btn-timer-play');
    if (playBtn) {
      playBtn.querySelector('[data-lucide]')?.setAttribute('data-lucide', 'play');
      playBtn.querySelector('span').textContent = 'スタート';
      if (window.lucide) lucide.createIcons();
    }
    document.getElementById('nav-timer-dot')?.classList.add('hidden');
  }

  _updateTimerDisplay() {
    const m = String(Math.floor(this._timerRemaining / 60)).padStart(2, '0');
    const s = String(this._timerRemaining % 60).padStart(2, '0');
    const str = `${m}:${s}`;
    const el1 = document.getElementById('modal-timer-digits');
    const el2 = document.getElementById('nav-timer-display');
    if (el1) el1.textContent = str;
    if (el2) el2.textContent = str;
  }

  // ─────────────────────────────────────────
  // BACKUP / RESTORE
  // ─────────────────────────────────────────
  openBackupModal() {
    document.getElementById('modal-backup')?.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  closeBackupModal() {
    document.getElementById('modal-backup')?.classList.add('hidden');
    document.body.style.overflow = '';
  }

  exportDataJSON() {
    const blob = new Blob([JSON.stringify(this.state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `studyhub_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this._showToast('バックアップを保存しました');
  }

  importDataJSON(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data && typeof data === 'object') {
          this.state = { ...this.loadState(), ...data };
          this.saveState();
          location.reload();
        }
      } catch {
        alert('ファイルの読み込みに失敗しました。');
      }
    };
    reader.readAsText(file);
  }

  confirmResetData() {
    if (confirm('本当にすべての学習データを初期化しますか？\nこの操作は元に戻せません。')) {
      localStorage.removeItem('studyhub_v3');
      location.reload();
    }
  }

  // ─────────────────────────────────────────
  // DARK MODE
  // ─────────────────────────────────────────
  toggleDarkMode() {
    this.state.darkMode = !this.state.darkMode;
    document.documentElement.classList.toggle('dark', this.state.darkMode);
    this.saveState();
  }

  // ─────────────────────────────────────────
  // TOAST
  // ─────────────────────────────────────────
  _showToast(msg) {
    let toast = document.getElementById('_toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = '_toast';
      toast.className = 'fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] px-4 py-2.5 rounded-2xl bg-slate-900/95 dark:bg-slate-800/95 backdrop-blur-md text-white text-xs sm:text-sm font-semibold shadow-2xl border border-slate-700/60 flex items-center gap-2 transform transition-all duration-300 translate-y-4 opacity-0 pointer-events-none';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.remove('translate-y-4', 'opacity-0');
    toast.classList.add('translate-y-0', 'opacity-100');
    if (this._toastTimeout) clearTimeout(this._toastTimeout);
    this._toastTimeout = setTimeout(() => {
      toast.classList.remove('translate-y-0', 'opacity-100');
      toast.classList.add('translate-y-4', 'opacity-0');
    }, 2000);
  }
}

// Boot
window.app = new StudyHubApp();
