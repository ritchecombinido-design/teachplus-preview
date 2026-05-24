/* ═══════════════════════════════════════════════════════════════════
TEACHPLUS SCORE RECORDER — SESSION-BASED ARCHITECTURE (v10)
Session identity: schoolYear + gradeLevel + section + subjectGroup
+ subjectName + mapehGroup + term
All operations are scoped to the ACTIVE SESSION. No cross-contamination.
═══════════════════════════════════════════════════════════════════ */

// ── DATABASE ─────────────────────────────────────────────────────────
const db = new Dexie('TeachPlusDB');

// ======================= VERSION 10 =======================
// Full session isolation: tasks keyed to
// [sectionId + subjectGroup + subjectName + mapehGroup + term]
// subjectName differentiates e.g. Math vs Science in the same section.
// mapehGroup isolates MAPEH Group 1 (Music+Arts) from Group 2 (PE+Health).
db.version(10).stores({
  settings:       '&key, value',
  quotes:         '++id, quoteIndex, shownAt',
  activityLogs:   '++id, message, icon, color, ts',
  cacheData:      '&cacheKey, data, updatedAt',
  schoolMeta:     '&key, value',
  sections:       '++id, gradeLevel, sectionName',
  learners:       '++id, lrn, fullname, sex, gradeLevel, section, [gradeLevel+section]',
  attendance:     '++id, learnerId, date, section, month, [section+date]',
  interventions:  '++id, learnerId, section, message, createdAt, updatedAt',
  themeState:     '&key, value',

  // Full session key in compound index
  sr_tasks:
    '++id, type, sectionId, subjectGroup, subjectName, mapehGroup, term, slot, title, ' +
    '[sectionId+subjectGroup+subjectName+mapehGroup+term], ' +
    '[type+sectionId+subjectGroup+subjectName+mapehGroup+term]',

  sr_scores:
    '++id, taskId, learnerId, [taskId+learnerId]',

  sr_terms:
    '++id, sectionId, subjectGroup, subjectName, mapehGroup, term, createdAt, ' +
    '[sectionId+subjectGroup+subjectName+mapehGroup+term]',

  seating:        '&id, schoolYear, gradeLevel, section, layout, updatedAt',

  subjects:       '++id, sectionId, subjectName, subjectGroup',

  sr_grades:
    '++id, learnerId, sectionId, subjectGroup, subjectName, mapehGroup, term, ' +
    'wwAvg, ptAvg, stTeAvg, initialGrade, transmutedGrade, descriptor, updatedAt, ' +
    '[learnerId+sectionId+subjectGroup+subjectName+mapehGroup+term]',
});
/* ============================================================
   THEME SYNC
   ============================================================ */
async function loadTheme() {
  try {
    // Try Dexie themeState (set by dashboard)
    let row = await db.themeState.get('active');
    if (!row || !row.value) {
      // Fallback: settings table
      row = await db.settings.get('theme');
    }
    const theme = (row && row.value) ? row.value : (localStorage.getItem('tp_theme') || 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch(e) {
    const ls = localStorage.getItem('tp_theme') || 'light';
    document.documentElement.setAttribute('data-theme', ls);
  }
}

// Watch for theme changes from other tabs via localStorage
window.addEventListener('storage', e => {
  if (e.key === 'tp_theme' && e.newValue) {
    document.documentElement.setAttribute('data-theme', e.newValue);
  }
});

// Poll Dexie every 3s for theme changes
setInterval(async () => {
  try {
    let row = await db.themeState.get('active');
    if (!row) row = await db.settings.get('theme');
    const t = row?.value || 'light';
    const cur = document.documentElement.getAttribute('data-theme');
    if (t !== cur) document.documentElement.setAttribute('data-theme', t);
  } catch(e) {}
}, 3000);

/* ============================================================
   TOAST
   ============================================================ */
function toast(msg, type = 'info', icon = 'fa-info-circle') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `sf2-toast ${type}`;
  t.innerHTML = `<i class="fas ${icon}"></i><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, 3500);
}

/* ============================================================
   LOAD GRADES & SECTIONS
   ============================================================ */
async function loadGrades() {
  const grades = [...new Set((await db.sections.toArray()).map(s => s.gradeLevel))].sort();
  const sel = document.getElementById('sf2-grade');
  sel.innerHTML = '<option value="">Select Grade</option>' + grades.map(g => `<option value="${g}">Grade ${g}</option>`).join('');
}

async function updateSF2Sections() {
  const grade = document.getElementById('sf2-grade').value;
  const secs = grade
    ? (await db.sections.where('gradeLevel').equals(grade).toArray()).map(s => s.sectionName)
    : [];
  const sel = document.getElementById('sf2-section');
  sel.innerHTML = '<option value="">Select Section</option>' + secs.map(s => `<option value="${s}">${s}</option>`).join('');
}

/* ============================================================
   HELPER UTILITIES
   ============================================================ */
const MONTHS = ['','January','February','March','April','May','June','July','August','September','October','November','December'];

function getMonthDays(year, month) {
  return new Date(year, month, 0).getDate();
}

function isWeekend(year, month, day) {
  const d = new Date(year, month - 1, day).getDay();
  return d === 0 || d === 6;
}

function getSchoolDays(year, month) {
  const days = [];
  const total = getMonthDays(year, month);
  for (let d = 1; d <= total; d++) {
    if (!isWeekend(year, month, d)) days.push(d);
  }
  return days;
}

function padDate(y, m, d) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function getDOW(year, month, day) {
  return new Date(year, month - 1, day).getDay(); // 0=Sun..6=Sat
}

// Get color for attendance rate
function rateColor(pct) {
  if (pct >= 90) return '#0d9488';
  if (pct >= 75) return '#d97706';
  return '#e11d48';
}

function rateClass(pct) {
  if (pct >= 90) return 'risk-low';
  if (pct >= 75) return 'risk-medium';
  return 'risk-high';
}

function riskLabel(pct) {
  if (pct >= 90) return 'Good';
  if (pct >= 75) return 'At Risk';
  return 'Critical';
}

/* ============================================================
   MAIN DATA LOADER
   ============================================================ */
let currentSF2 = null; // store for export

async function loadSF2Data() {
  const grade   = document.getElementById('sf2-grade').value;
  const section = document.getElementById('sf2-section').value;
  const month   = parseInt(document.getElementById('sf2-month').value);
  const syVal   = document.getElementById('sf2-sy').value.trim();

  if (!grade || !section) {
    toast('Please select a grade and section.', 'error', 'fa-exclamation-circle');
    return;
  }
  if (!month) {
    toast('Please select a month.', 'error', 'fa-exclamation-circle');
    return;
  }

  const dyn = document.getElementById('sf2-dynamic');
  dyn.innerHTML = `<div class="sf2-loading"><div class="sf2-spinner"></div> Loading attendance data...</div>`;

  try {
    // School meta
    const metas = {};
    (await db.schoolMeta.toArray()).forEach(m => metas[m.key] = m.value);

    // Teacher profile
    const settingsArr = await db.settings.toArray();
    const settings = {};
    settingsArr.forEach(s => settings[s.key] = s.value);

    const year = new Date().getFullYear();
    const schoolYear = syVal || metas.schoolYear || `${year}-${year+1}`;
    const schoolName = metas.schoolName || 'N/A';
    const schoolId   = metas.schoolId   || 'N/A';

    // Teacher name
    const firstname  = settings.firstname  || '';
    const middlename = settings.middlename || '';
    const surname    = settings.surname    || '';
    const teacherName = `${firstname} ${middlename} ${surname}`.replace(/\s+/,' ').trim() || 'N/A';
    const principal  = settings.principal  || 'N/A';

    // Learners
    const allLearners = await db.learners.toArray();
    const sectionLearners = allLearners.filter(l => l.gradeLevel === grade && l.section === section);

    const males   = sectionLearners.filter(l => l.sex === 'M').sort((a,b) => a.fullname.localeCompare(b.fullname));
    const females = sectionLearners.filter(l => l.sex === 'F').sort((a,b) => a.fullname.localeCompare(b.fullname));

    // Attendance records for this section/month
    const allAtt = await db.attendance.where('section').equals(section).toArray();
    const monthAtt = allAtt.filter(a => {
      const d = new Date(a.date);
      return d.getMonth() + 1 === month;
    });

    // Build lookup: learnerId+date -> status
    const attMap = {};
    monthAtt.forEach(a => {
      attMap[`${a.learnerId}_${a.date}`] = (a.status || 'present').toLowerCase();
    });

    // School days
    const schoolDays = getSchoolDays(year, month);

    // Per-learner stats
    function learnerStats(learner) {
      const dates = schoolDays.map(d => padDate(year, month, d));
      let present = 0, absent = 0, late = 0, cutting = 0;
      const dayStatuses = {};
      dates.forEach(dt => {
        const key = `${learner.id}_${dt}`;
        const st = attMap[key] || 'present';
        dayStatuses[dt] = st;
        if (st === 'present') present++;
        else if (st === 'absent') absent++;
        else if (st === 'late') late++;
        else if (st === 'cutting') cutting++;
      });
      return { present, absent, late, cutting, dayStatuses };
    }

    // Consecutive absent days
    function maxConsecAbsent(learner) {
      let max = 0, cur = 0;
      schoolDays.forEach(d => {
        const dt = padDate(year, month, d);
        const st = attMap[`${learner.id}_${dt}`] || 'present';
        if (st === 'absent') { cur++; max = Math.max(max, cur); }
        else cur = 0;
      });
      return max;
    }

    // Per-day totals
    function dayTotals(group) {
      const totals = {};
      schoolDays.forEach(d => {
        const dt = padDate(year, month, d);
        let p = 0;
        group.forEach(l => {
          const st = attMap[`${l.id}_${dt}`] || 'present';
          if (st === 'present') p++;
        });
        totals[dt] = p;
      });
      return totals;
    }

    const maleDayTotals   = dayTotals(males);
    const femaleDayTotals = dayTotals(females);

    // Overall stats
    const maleStats   = males.map(l => ({ ...l, ...learnerStats(l), consec: maxConsecAbsent(l) }));
    const femaleStats = females.map(l => ({ ...l, ...learnerStats(l), consec: maxConsecAbsent(l) }));
    const allStats    = [...maleStats, ...femaleStats];

    // Totals
    const totalMale   = males.length;
    const totalFemale = females.length;
    const totalAll    = totalMale + totalFemale;

    const totalMalePresent   = maleStats.reduce((s,l) => s + l.present, 0);
    const totalMaleAbsent    = maleStats.reduce((s,l) => s + l.absent, 0);
    const totalFemalePresent = femaleStats.reduce((s,l) => s + l.present, 0);
    const totalFemaleAbsent  = femaleStats.reduce((s,l) => s + l.absent, 0);
    const totalPresent = totalMalePresent + totalFemalePresent;
    const totalAbsent  = totalMaleAbsent  + totalFemaleAbsent;
    const totalLate    = allStats.reduce((s,l) => s + l.late, 0);
    const totalCutting = allStats.reduce((s,l) => s + l.cutting, 0);

    const schoolDayCount = schoolDays.length;
    const ada  = schoolDayCount > 0 ? (totalMalePresent + totalFemalePresent) / (totalAll * schoolDayCount) * 100 : 0;
    const adaM = (totalMale > 0 && schoolDayCount > 0) ? totalMalePresent   / (totalMale   * schoolDayCount) * 100 : 0;
    const adaF = (totalFemale > 0 && schoolDayCount > 0) ? totalFemalePresent / (totalFemale * schoolDayCount) * 100 : 0;

    const maleConsec5   = maleStats.filter(l => l.consec >= 5).length;
    const femaleConsec5 = femaleStats.filter(l => l.consec >= 5).length;
    const totalConsec5  = maleConsec5 + femaleConsec5;

    // Save for export
    currentSF2 = {
      grade, section, month, schoolYear, schoolName, schoolId,
      teacherName, principal,
      males: maleStats, females: femaleStats,
      schoolDays, year,
      maleDayTotals, femaleDayTotals,
      totalMale, totalFemale, totalAll,
      totalMalePresent, totalMaleAbsent,
      totalFemalePresent, totalFemaleAbsent,
      totalPresent, totalAbsent, totalLate, totalCutting,
      ada, adaM, adaF,
      maleConsec5, femaleConsec5, totalConsec5,
      attMap
    };

    renderSF2(currentSF2);

    // Show export buttons
    document.getElementById('exportXlsxBtn').style.display = 'flex';
    document.getElementById('exportPdfBtn').style.display = 'flex';
    document.getElementById('exportReadyBadge').style.display = 'flex';

  } catch(e) {
    console.error(e);
    dyn.innerHTML = `<div class="sf2-empty"><i class="fas fa-exclamation-triangle"></i><h3>Error loading data</h3><p>${e.message}</p></div>`;
    toast('Error loading data: ' + e.message, 'error', 'fa-exclamation-circle');
  }
}

/* ============================================================
   RENDER SF2 PAGE
   ============================================================ */
function renderSF2(d) {
  const dyn = document.getElementById('sf2-dynamic');
  const attPct = d.totalAll > 0 ? ((d.totalPresent / (d.totalAll * d.schoolDays.length)) * 100).toFixed(1) : 0;

  dyn.innerHTML = `
    <!-- STATS -->
    <div class="sf2-stats-row">
      <div class="sf2-stat" style="--stat-color:var(--accent);--stat-bg:rgba(37,99,235,.1)">
        <div class="sf2-stat-icon"><i class="fas fa-users"></i></div>
        <div class="sf2-stat-val">${d.totalAll}</div>
        <div class="sf2-stat-label">Total Learners</div>
      </div>
      <div class="sf2-stat" style="--stat-color:#3b82f6;--stat-bg:rgba(59,130,246,.1)">
        <div class="sf2-stat-icon"><i class="fas fa-mars"></i></div>
        <div class="sf2-stat-val">${d.totalMale}</div>
        <div class="sf2-stat-label">Male</div>
      </div>
      <div class="sf2-stat" style="--stat-color:#db2777;--stat-bg:rgba(219,39,119,.1)">
        <div class="sf2-stat-icon"><i class="fas fa-venus"></i></div>
        <div class="sf2-stat-val">${d.totalFemale}</div>
        <div class="sf2-stat-label">Female</div>
      </div>
      <div class="sf2-stat" style="--stat-color:var(--green);--stat-bg:rgba(13,148,136,.1)">
        <div class="sf2-stat-icon"><i class="fas fa-user-check"></i></div>
        <div class="sf2-stat-val">${d.totalPresent}</div>
        <div class="sf2-stat-label">Total Present</div>
      </div>
      <div class="sf2-stat" style="--stat-color:var(--rose);--stat-bg:rgba(225,29,72,.1)">
        <div class="sf2-stat-icon"><i class="fas fa-user-times"></i></div>
        <div class="sf2-stat-val">${d.totalAbsent}</div>
        <div class="sf2-stat-label">Total Absent</div>
      </div>
      <div class="sf2-stat" style="--stat-color:var(--amber);--stat-bg:rgba(217,119,6,.1)">
        <div class="sf2-stat-icon"><i class="fas fa-clock"></i></div>
        <div class="sf2-stat-val">${d.totalLate}</div>
        <div class="sf2-stat-label">Total Late</div>
      </div>
      <div class="sf2-stat" style="--stat-color:var(--purple);--stat-bg:rgba(124,58,237,.1)">
        <div class="sf2-stat-icon"><i class="fas fa-door-open"></i></div>
        <div class="sf2-stat-val">${d.totalCutting}</div>
        <div class="sf2-stat-label">Cutting Classes</div>
      </div>
      <div class="sf2-stat" style="--stat-color:${rateColor(parseFloat(attPct))};--stat-bg:rgba(13,148,136,.08)">
        <div class="sf2-stat-icon"><i class="fas fa-chart-line"></i></div>
        <div class="sf2-stat-val">${attPct}%</div>
        <div class="sf2-stat-label">Attendance Rate</div>
      </div>
    </div>

    <!-- SUMMARY GRID -->
    <div class="sf2-summary-grid">
      ${renderSummaryCard(d)}
      ${renderADACard(d)}
      ${renderConsecCard(d)}
    </div>

    <!-- CHARTS -->
    <div class="sf2-charts-grid">
      <div class="sf2-chart-card">
        <div class="sf2-chart-title"><i class="fas fa-chart-bar"></i> Daily Attendance Overview</div>
        <div class="sf2-chart-wrap"><canvas id="chartDaily"></canvas></div>
      </div>
      <div class="sf2-chart-card">
        <div class="sf2-chart-title"><i class="fas fa-chart-pie"></i> Attendance Breakdown</div>
        <div class="sf2-chart-wrap"><canvas id="chartPie"></canvas></div>
      </div>
      <div class="sf2-chart-card">
        <div class="sf2-chart-title"><i class="fas fa-venus-mars"></i> Male vs Female Present (Daily)</div>
        <div class="sf2-chart-wrap"><canvas id="chartGender"></canvas></div>
      </div>
      <div class="sf2-chart-card">
        <div class="sf2-chart-title"><i class="fas fa-fire-alt"></i> Weekly Attendance Rate Heatmap</div>
        <div class="heatmap-wrap" id="heatmapWrap"></div>
      </div>
    </div>

    <!-- LEARNER ATTENDANCE TABLE -->
    <div class="sf2-table-card">
      <div class="sf2-section-heading"><i class="fas fa-mars"></i> Male Learners Attendance</div>
      ${renderLearnerTable(d.males, d.schoolDays, d.year, d.month, d.attMap, d.totalAll)}
    </div>

    <div class="sf2-table-card">
      <div class="sf2-section-heading" style="color:var(--rose)"><i class="fas fa-venus" style="color:#db2777"></i> Female Learners Attendance</div>
      ${renderLearnerTable(d.females, d.schoolDays, d.year, d.month, d.attMap, d.totalAll, '#db2777')}
    </div>

    <!-- CONSECUTIVE ABSENT TABLE -->
    <div class="sf2-table-card">
      <div class="sf2-section-heading"><i class="fas fa-exclamation-triangle" style="color:var(--rose)"></i> Learners with ≥5 Consecutive Absences</div>
      ${renderConsecTable(d)}
    </div>

    <!-- DAILY TOTALS TABLE -->
    <div class="sf2-table-card">
      <div class="sf2-section-heading"><i class="fas fa-table"></i> Daily Present Totals (M/F/Total)</div>
      ${renderDailyTotalsTable(d)}
    </div>

    <!-- INFO FOOTER -->
    <div class="sf2-table-card" style="margin-bottom:0;">
      <div class="sf2-section-heading"><i class="fas fa-info-circle"></i> SF2 Record Information</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;font-size:.82rem;">
        ${[
          ['School', d.schoolName],
          ['School ID', d.schoolId],
          ['School Year', d.schoolYear],
          ['Grade & Section', `Grade ${d.grade} – ${d.section}`],
          ['Month', MONTHS[d.month]],
          ['School Days', d.schoolDays.length],
          ['Teacher', d.teacherName],
          ['Principal', d.principal],
        ].map(([k,v]) => `<div><div style="color:var(--text3);font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;">${k}</div><div style="font-weight:700;color:var(--text);">${v}</div></div>`).join('')}
      </div>
    </div>
  `;

  // Draw charts after DOM insert
  requestAnimationFrame(() => {
    renderChartDaily(d);
    renderChartPie(d);
    renderChartGender(d);
    renderHeatmap(d);
  });
}

/* ── SUMMARY CARDS ── */
function renderSummaryCard(d) {
  const pctM = d.totalMale > 0 ? ((d.totalMalePresent / (d.totalMale * d.schoolDays.length)) * 100).toFixed(1) : '0.0';
  const pctF = d.totalFemale > 0 ? ((d.totalFemalePresent / (d.totalFemale * d.schoolDays.length)) * 100).toFixed(1) : '0.0';
  const pctAll = d.totalAll > 0 ? ((d.totalPresent / (d.totalAll * d.schoolDays.length)) * 100).toFixed(1) : '0.0';
  return `
    <div class="sf2-summary-card">
      <h4><i class="fas fa-percentage" style="color:var(--accent)"></i> Attendance Rate</h4>
      <div class="sf2-summary-row">
        <span class="label"><i class="fas fa-mars" style="color:#3b82f6;font-size:.75rem"></i> Male</span>
        <div>
          <span class="value">${pctM}%</span>
          <div class="sf2-progress-bar" style="width:90px;display:inline-block;vertical-align:middle;margin-left:8px;">
            <div class="sf2-progress-fill ${parseFloat(pctM)>=90?'green':parseFloat(pctM)>=75?'amber':'rose'}" style="width:${pctM}%"></div>
          </div>
        </div>
      </div>
      <div class="sf2-summary-row">
        <span class="label"><i class="fas fa-venus" style="color:#db2777;font-size:.75rem"></i> Female</span>
        <div>
          <span class="value">${pctF}%</span>
          <div class="sf2-progress-bar" style="width:90px;display:inline-block;vertical-align:middle;margin-left:8px;">
            <div class="sf2-progress-fill ${parseFloat(pctF)>=90?'green':parseFloat(pctF)>=75?'amber':'rose'}" style="width:${pctF}%"></div>
          </div>
        </div>
      </div>
      <div class="sf2-summary-row">
        <span class="label"><i class="fas fa-users" style="color:var(--accent);font-size:.75rem"></i> Overall</span>
        <div>
          <span class="value">${pctAll}%</span>
          <div class="sf2-progress-bar" style="width:90px;display:inline-block;vertical-align:middle;margin-left:8px;">
            <div class="sf2-progress-fill ${parseFloat(pctAll)>=90?'green':parseFloat(pctAll)>=75?'amber':'rose'}" style="width:${pctAll}%"></div>
          </div>
        </div>
      </div>
    </div>`;
}

function renderADACard(d) {
  return `
    <div class="sf2-summary-card">
      <h4><i class="fas fa-chart-line" style="color:var(--green)"></i> Average Daily Attendance</h4>
      <div class="sf2-summary-row">
        <span class="label"><i class="fas fa-mars" style="color:#3b82f6;font-size:.75rem"></i> Male ADA</span>
        <span class="value">${d.adaM.toFixed(2)}%</span>
      </div>
      <div class="sf2-summary-row">
        <span class="label"><i class="fas fa-venus" style="color:#db2777;font-size:.75rem"></i> Female ADA</span>
        <span class="value">${d.adaF.toFixed(2)}%</span>
      </div>
      <div class="sf2-summary-row">
        <span class="label"><i class="fas fa-users" style="color:var(--accent);font-size:.75rem"></i> Total ADA</span>
        <span class="value">${d.ada.toFixed(2)}%</span>
      </div>
      <div class="sf2-summary-row">
        <span class="label">School Days</span>
        <span class="value">${d.schoolDays.length}</span>
      </div>
    </div>`;
}

function renderConsecCard(d) {
  return `
    <div class="sf2-summary-card">
      <h4><i class="fas fa-exclamation-triangle" style="color:var(--rose)"></i> Chronic Absenteeism (≥5 Days)</h4>
      <div class="sf2-summary-row">
        <span class="label"><i class="fas fa-mars" style="color:#3b82f6;font-size:.75rem"></i> Male</span>
        <span class="value" style="color:var(--rose)">${d.maleConsec5}</span>
      </div>
      <div class="sf2-summary-row">
        <span class="label"><i class="fas fa-venus" style="color:#db2777;font-size:.75rem"></i> Female</span>
        <span class="value" style="color:var(--rose)">${d.femaleConsec5}</span>
      </div>
      <div class="sf2-summary-row">
        <span class="label"><i class="fas fa-users" style="color:var(--accent);font-size:.75rem"></i> Total</span>
        <span class="value" style="color:var(--rose)">${d.totalConsec5}</span>
      </div>
      <div class="sf2-summary-row">
        <span class="label">% of Class</span>
        <span class="value">${d.totalAll > 0 ? ((d.totalConsec5 / d.totalAll)*100).toFixed(1) : 0}%</span>
      </div>
    </div>`;
}

/* ── LEARNER TABLE ── */
function renderLearnerTable(learners, schoolDays, year, month, attMap, totalAll, nameColor) {
  if (!learners.length) return `<p style="color:var(--text3);font-size:.82rem;padding:12px;">No learners found.</p>`;

  // Limit visible day columns to avoid overflow – show first 10 days with all statuses
  const visibleDays = schoolDays.slice(0, 20);

  return `
    <div style="overflow-x:auto;">
    <table class="sf2-table">
      <thead>
        <tr>
          <th>#</th>
          <th style="min-width:180px">Learner Name</th>
          ${visibleDays.map(d => `<th style="text-align:center;min-width:36px;">${d}</th>`).join('')}
          ${schoolDays.length > 20 ? `<th style="text-align:center">+${schoolDays.length-20} more</th>` : ''}
          <th style="text-align:center">Present</th>
          <th style="text-align:center">Absent</th>
          <th style="text-align:center">Late</th>
          <th style="text-align:center">Rate</th>
          <th style="text-align:center">Risk</th>
        </tr>
      </thead>
      <tbody>
        ${learners.map((l, i) => {
          const days = schoolDays.length;
          const pct = days > 0 ? (l.present / days * 100).toFixed(0) : 0;
          return `<tr>
            <td style="color:var(--text3);font-size:.75rem;">${i+1}</td>
            <td style="font-weight:600;color:${nameColor||'var(--text)'};">${l.fullname}</td>
            ${visibleDays.map(d => {
              const dt = padDate(year, month, d);
              const st = attMap[`${l.id}_${dt}`] || 'present';
              const icons = { present:'✓', absent:'✗', late:'▲', cutting:'▽' };
              const colors = { present:'var(--green)', absent:'var(--rose)', late:'var(--amber)', cutting:'var(--purple)' };
              return `<td style="text-align:center;color:${colors[st]||'var(--green)'};font-weight:700;font-size:.78rem;" title="${dt}: ${st}">${icons[st]||'✓'}</td>`;
            }).join('')}
            ${schoolDays.length > 20 ? `<td style="text-align:center;color:var(--text3);font-size:.75rem;">…</td>` : ''}
            <td style="text-align:center;color:var(--green);font-weight:700;">${l.present}</td>
            <td style="text-align:center;color:var(--rose);font-weight:700;">${l.absent}</td>
            <td style="text-align:center;color:var(--amber);font-weight:700;">${l.late}</td>
            <td style="text-align:center;">
              <span class="sf2-risk-badge ${rateClass(parseFloat(pct))}">${pct}%</span>
            </td>
            <td style="text-align:center;">
              <span class="sf2-risk-badge ${rateClass(parseFloat(pct))}">${riskLabel(parseFloat(pct))}</span>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
      <tfoot>
        <tr style="background:var(--surface2);font-weight:700;">
          <td colspan="2" style="font-weight:700;">TOTAL</td>
          ${visibleDays.map(d => {
            const dt = padDate(year, month, d);
            const cnt = learners.filter(l => (attMap[`${l.id}_${dt}`] || 'present') === 'present').length;
            return `<td style="text-align:center;font-size:.75rem;">${cnt}</td>`;
          }).join('')}
          ${schoolDays.length > 20 ? '<td></td>' : ''}
          <td style="text-align:center;color:var(--green);">${learners.reduce((s,l)=>s+l.present,0)}</td>
          <td style="text-align:center;color:var(--rose);">${learners.reduce((s,l)=>s+l.absent,0)}</td>
          <td style="text-align:center;color:var(--amber);">${learners.reduce((s,l)=>s+l.late,0)}</td>
          <td colspan="2"></td>
        </tr>
      </tfoot>
    </table>
    </div>`;
}

/* ── CONSECUTIVE TABLE ── */
function renderConsecTable(d) {
  const at_risk = [...d.males, ...d.females].filter(l => l.consec >= 5);
  if (!at_risk.length) return `<p style="color:var(--green);font-size:.84rem;padding:8px;"><i class="fas fa-check-circle"></i> No learners with 5 or more consecutive absences this month.</p>`;
  return `
    <table class="sf2-consec-table">
      <thead>
        <tr>
          <th>Learner</th>
          <th>Sex</th>
          <th>Max Consec. Absences</th>
          <th>Total Absent</th>
          <th>Risk Level</th>
        </tr>
      </thead>
      <tbody>
        ${at_risk.sort((a,b) => b.consec - a.consec).map(l => `
          <tr>
            <td style="font-weight:600;">${l.fullname}</td>
            <td><span class="sf2-badge ${l.sex==='M'?'badge-male':'badge-female'}">${l.sex==='M'?'Male':'Female'}</span></td>
            <td style="font-weight:700;color:var(--rose);">${l.consec} days</td>
            <td style="color:var(--rose);">${l.absent}</td>
            <td><span class="sf2-risk-badge risk-high">Critical</span></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

/* ── DAILY TOTALS TABLE ── */
function renderDailyTotalsTable(d) {
  const days = d.schoolDays.slice(0, 20); // show first 20
  return `
    <div style="overflow-x:auto;">
    <table class="sf2-table">
      <thead>
        <tr>
          <th>Category</th>
          ${days.map(day => `<th style="text-align:center;min-width:34px;">${day}</th>`).join('')}
          ${d.schoolDays.length > 20 ? `<th>+more</th>` : ''}
          <th style="text-align:center;">Total</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="font-weight:600;color:#3b82f6;"><i class="fas fa-mars"></i> Male Present</td>
          ${days.map(day => {
            const dt = padDate(d.year, d.month, day);
            return `<td style="text-align:center;font-weight:600;">${d.maleDayTotals[dt]||0}</td>`;
          }).join('')}
          ${d.schoolDays.length > 20 ? '<td>…</td>' : ''}
          <td style="text-align:center;font-weight:700;color:#3b82f6;">${d.totalMalePresent}</td>
        </tr>
        <tr>
          <td style="font-weight:600;color:#db2777;"><i class="fas fa-venus"></i> Female Present</td>
          ${days.map(day => {
            const dt = padDate(d.year, d.month, day);
            return `<td style="text-align:center;font-weight:600;">${d.femaleDayTotals[dt]||0}</td>`;
          }).join('')}
          ${d.schoolDays.length > 20 ? '<td>…</td>' : ''}
          <td style="text-align:center;font-weight:700;color:#db2777;">${d.totalFemalePresent}</td>
        </tr>
        <tr style="background:var(--surface2);">
          <td style="font-weight:700;"><i class="fas fa-users"></i> Total Present</td>
          ${days.map(day => {
            const dt = padDate(d.year, d.month, day);
            const t = (d.maleDayTotals[dt]||0) + (d.femaleDayTotals[dt]||0);
            return `<td style="text-align:center;font-weight:700;">${t}</td>`;
          }).join('')}
          ${d.schoolDays.length > 20 ? '<td>…</td>' : ''}
          <td style="text-align:center;font-weight:700;">${d.totalPresent}</td>
        </tr>
      </tbody>
    </table>
    </div>`;
}

/* ============================================================
   CHARTS
   ============================================================ */
let charts = {};

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function chartColors() {
  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  const gridColor = theme === 'dark' ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.06)';
  const textColor = theme === 'dark' ? '#8b9ab0' : '#8aa0b8';
  return { gridColor, textColor };
}

function renderChartDaily(d) {
  destroyChart('daily');
  const ctx = document.getElementById('chartDaily');
  if (!ctx) return;
  const { gridColor, textColor } = chartColors();
  const labels = d.schoolDays.map(day => `${MONTHS[d.month].slice(0,3)} ${day}`);
  const presentPerDay = d.schoolDays.map(day => {
    const dt = padDate(d.year, d.month, day);
    return (d.maleDayTotals[dt]||0) + (d.femaleDayTotals[dt]||0);
  });
  charts['daily'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Present',
        data: presentPerDay,
        backgroundColor: 'rgba(37,99,235,.7)',
        borderRadius: 6,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } },
        y: { ticks: { color: textColor }, grid: { color: gridColor }, beginAtZero: true, max: d.totalAll }
      }
    }
  });
}

function renderChartPie(d) {
  destroyChart('pie');
  const ctx = document.getElementById('chartPie');
  if (!ctx) return;
  charts['pie'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Present', 'Absent', 'Late', 'Cutting'],
      datasets: [{
        data: [d.totalPresent, d.totalAbsent, d.totalLate, d.totalCutting],
        backgroundColor: ['#0d9488','#e11d48','#d97706','#7c3aed'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { padding: 14, font: { size: 11 }, color: chartColors().textColor }
        }
      }
    }
  });
}

function renderChartGender(d) {
  destroyChart('gender');
  const ctx = document.getElementById('chartGender');
  if (!ctx) return;
  const { gridColor, textColor } = chartColors();
  const labels = d.schoolDays.map(day => day.toString());
  const maleData   = d.schoolDays.map(day => d.maleDayTotals[padDate(d.year, d.month, day)]   || 0);
  const femaleData = d.schoolDays.map(day => d.femaleDayTotals[padDate(d.year, d.month, day)] || 0);
  charts['gender'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Male', data: maleData, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,.12)', tension: .3, fill: true, pointRadius: 3 },
        { label: 'Female', data: femaleData, borderColor: '#db2777', backgroundColor: 'rgba(219,39,119,.08)', tension: .3, fill: true, pointRadius: 3 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: textColor, font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } },
        y: { ticks: { color: textColor }, grid: { color: gridColor }, beginAtZero: true }
      }
    }
  });
}

function renderHeatmap(d) {
  const wrap = document.getElementById('heatmapWrap');
  if (!wrap) return;

  // Group days by week (Mon–Fri)
  const weeks = [];
  let currentWeek = [];
  const dayNames = ['Mon','Tue','Wed','Thu','Fri'];

  d.schoolDays.forEach(day => {
    const dow = getDOW(d.year, d.month, day); // 1=Mon..5=Fri
    if (dow === 1 && currentWeek.length > 0) { weeks.push(currentWeek); currentWeek = []; }
    currentWeek.push(day);
  });
  if (currentWeek.length) weeks.push(currentWeek);

  const maxPresent = d.totalAll || 1;

  let html = `<div class="heatmap-grid" style="grid-template-columns:repeat(${weeks.length},1fr)">`;
  weeks.forEach((week, wi) => {
    html += `<div class="heatmap-col">
      <div class="heatmap-label">Wk ${wi+1}</div>`;
    week.forEach(day => {
      const dt = padDate(d.year, d.month, day);
      const p = (d.maleDayTotals[dt]||0) + (d.femaleDayTotals[dt]||0);
      const pct = maxPresent > 0 ? p/maxPresent : 0;
      const bg = pct >= .9 ? '#0d9488' : pct >= .75 ? '#d97706' : pct >= .5 ? '#e11d48' : '#991b1b';
      const opacity = 0.4 + pct * 0.6;
      html += `<div class="heatmap-cell" style="background:${bg};opacity:${opacity}" title="${dt}: ${p}/${d.totalAll} present (${Math.round(pct*100)}%)">
        ${p}
      </div>`;
    });
    html += `</div>`;
  });
  html += `</div>`;
  wrap.innerHTML = html;
}

/* ============================================================
   XLSX EXPORT – SF2 MAPPING (ExcelJS — preserves template)
   ============================================================ */
async function exportToXLSX() {
  if (!currentSF2) {
    toast('Please load data first.', 'error', 'fa-exclamation-circle');
    return;
  }

  if (typeof ExcelJS === 'undefined') {
    toast('ExcelJS not loaded.', 'error', 'fa-exclamation-circle');
    return;
  }

  const d = currentSF2;

  toast('Loading SF2 template...', 'info', 'fa-cog fa-spin');

  const workbook = new ExcelJS.Workbook();

  // ─────────────────────────────
  // LOAD TEMPLATE (STRICT)
  // ─────────────────────────────
  const resp = await fetch('sf2_template.xlsx');
  if (!resp.ok) throw new Error("Template not found");

  const buffer = await resp.arrayBuffer();
  await workbook.xlsx.load(buffer);

  const ws = workbook.getWorksheet(1);
  if (!ws) throw new Error("SF2 sheet missing in template");

  // ─────────────────────────────
  // CELL CACHE (IMPORTANT FIX)
  // prevents repeated style reconstruction
  // ─────────────────────────────
  const cellCache = new Map();

  function setCell(addr, value) {
    let cell = cellCache.get(addr);

    if (!cell) {
      cell = ws.getCell(addr);
      cellCache.set(addr, cell);
    }

    cell.value = value ?? "";
  }

  // ─────────────────────────────
  // WEEKDAY MAP
  // ─────────────────────────────
  const weekDayMap = [
    { mon:'F',  tue:'H',  wed:'I',  thu:'J',  fri:'K'  },
    { mon:'L',  tue:'N',  wed:'O',  thu:'P',  fri:'Q'  },
    { mon:'R',  tue:'T',  wed:'U',  thu:'V',  fri:'X'  },
    { mon:'Z',  tue:'AB', wed:'AC', thu:'AD', fri:'AE' },
    { mon:'AF', tue:'AG', wed:'AI', thu:'AJ', fri:'AK' }
  ];

  const DOW = { 1:'mon', 2:'tue', 3:'wed', 4:'thu', 5:'fri' };

  function getDayMapping(days) {
    const map = {};
    let weekIndex = 0;
    let last = -1;

    days.forEach(day => {
      const dow = getDOW(d.year, d.month, day);

      if (dow === 1 && last !== -1 && weekIndex < 4) {
        weekIndex++;
      }

      last = dow;

      const key = DOW[dow];
      const wk = weekDayMap[Math.min(weekIndex, 4)];

      if (key && wk) {
        map[day] = wk[key];
      }
    });

    return map;
  }

  const dayColMap = getDayMapping(d.schoolDays);

  // ─────────────────────────────
  // WRITE QUEUE (IMPORTANT FIX)
  // ─────────────────────────────
  const writes = [];

  const push = (addr, value) => {
    writes.push([addr, value]);
  };

  // ─────────────────────────────
  // HEADER
  // ─────────────────────────────
  push("F3", d.schoolId);
  push("M3", d.schoolYear);
  push("AA3", MONTHS[d.month]);
  push("F4", d.schoolName);
  push("AA4", `Grade ${d.grade}`);
  push("AM4", d.section);

  // ─────────────────────────────
  // DATE ROW (ROW 6)
  // ─────────────────────────────
  d.schoolDays.forEach(day => {
    const col = dayColMap[day];
    if (col) push(`${col}6`, day);
  });

  // ─────────────────────────────
  // MALES (ROWS 8–107)
  // ─────────────────────────────
  d.males.forEach((l, i) => {
    const row = 8 + i;

    push(`C${row}`, l.fullname);
    push(`AM${row}`, l.absent);
    push(`AO${row}`, l.present);

    d.schoolDays.forEach(day => {
      const col = dayColMap[day];
      if (!col) return;

      const dt = padDate(d.year, d.month, day);
      const st = d.attMap[`${l.id}_${dt}`] || "present";

      if (st === "absent") push(`${col}${row}`, "X");
      else if (st === "late") push(`${col}${row}`, "/");
      else if (st === "cutting") push(`${col}${row}`, "\\");
    });
  });

  // ─────────────────────────────
  // MALE TOTALS (ROW 108)
  // ─────────────────────────────
  d.schoolDays.forEach(day => {
    const col = dayColMap[day];
    if (col) push(`${col}108`, d.maleDayTotals[day] || 0);
  });

  push("AM108", d.totalMaleAbsent);
  push("AO108", d.totalMalePresent);

  // ─────────────────────────────
  // FEMALES (ROWS 109–208)
  // ─────────────────────────────
  d.females.forEach((l, i) => {
    const row = 109 + i;

    push(`C${row}`, l.fullname);
    push(`AM${row}`, l.absent);
    push(`AO${row}`, l.present);

    d.schoolDays.forEach(day => {
      const col = dayColMap[day];
      if (!col) return;

      const dt = padDate(d.year, d.month, day);
      const st = d.attMap[`${l.id}_${dt}`] || "present";

      if (st === "absent") push(`${col}${row}`, "X");
      else if (st === "late") push(`${col}${row}`, "/");
      else if (st === "cutting") push(`${col}${row}`, "\\");
    });
  });

  // ─────────────────────────────
  // FEMALE TOTALS (ROW 209)
  // ─────────────────────────────
  d.schoolDays.forEach(day => {
    const col = dayColMap[day];
    if (col) push(`${col}209`, d.femaleDayTotals[day] || 0);
  });

  push("AM209", d.totalFemaleAbsent);
  push("AO209", d.totalFemalePresent);

  // ─────────────────────────────
  // COMBINED TOTALS (ROW 210)
  // ─────────────────────────────
  d.schoolDays.forEach(day => {
    const col = dayColMap[day];
    if (!col) return;

    const total =
      (d.maleDayTotals[day] || 0) +
      (d.femaleDayTotals[day] || 0);

    push(`${col}210`, total);
  });

  push("AM210", d.totalAbsent);
  push("AO210", d.totalPresent);

  // ─────────────────────────────
  // ENROLLMENT
  // ─────────────────────────────
  push("AR219", d.totalMale);
  push("AR213", d.totalMale);

  push("AS219", d.totalFemale);
  push("AS213", d.totalFemale);

  push("AT219", d.totalAll);
  push("AT213", d.totalAll);

  // ─────────────────────────────
  // PERCENT ENROLLMENT
  // ─────────────────────────────
  push("AR221", d.totalMale ? 100 : 0);
  push("AS221", d.totalFemale ? 100 : 0);
  push("AT221", d.totalAll ? 100 : 0);

  // ─────────────────────────────
  // ADA
  // ─────────────────────────────
  push("AR223", d.adaM);
  push("AS223", d.adaF);
  push("AT223", d.ada);

  // ─────────────────────────────
  // ATTENDANCE %
  // ─────────────────────────────
  push("AR225", d.pctM);
  push("AS225", d.pctF);
  push("AT225", d.pctT);

  // ─────────────────────────────
  // CONSECUTIVE ABSENCE
  // ─────────────────────────────
  push("AR226", d.maleConsec5);
  push("AS226", d.femaleConsec5);
  push("AT226", d.totalConsec5);

  // ─────────────────────────────
  // SIGNATORIES
  // ─────────────────────────────
  push("AN236", d.teacherName);
  push("AN242", d.principal);

  // ─────────────────────────────
  // FLUSH ALL WRITES (IMPORTANT FIX)
  // ─────────────────────────────
  writes.forEach(([addr, val]) => {
    setCell(addr, val);
  });

// ─────────────────────────────
// AUTO-HIDE EMPTY LEARNER ROWS
// ─────────────────────────────

// MALES (8–107)
const maleStart = 8;
const maleEnd = 107;
const lastMaleRow = maleStart + d.males.length - 1;

for (let r = lastMaleRow + 1; r <= maleEnd; r++) {
  const row = ws.getRow(r);
  row.hidden = true;
}

// FEMALES (109–208)
const femaleStart = 109;
const femaleEnd = 208;
const lastFemaleRow = femaleStart + d.females.length - 1;

for (let r = lastFemaleRow + 1; r <= femaleEnd; r++) {
  const row = ws.getRow(r);
  row.hidden = true;
}

  // ─────────────────────────────
  // EXPORT
  // ─────────────────────────────
  const out = await workbook.xlsx.writeBuffer();

  const blob = new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });

  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `SF2_${d.grade}_${d.section}_${MONTHS[d.month]}_${d.schoolYear}.xlsx`.replace(/\s/g, "_");

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);

  toast("SF2 exported successfully!", "success", "fa-check-circle");
}

/* ============================================================
   PDF EXPORT (Print-based)
   ============================================================ */
function exportToPDF() {
  if (!currentSF2) { toast('Please load data first.', 'error', 'fa-exclamation-circle'); return; }
  toast('Preparing PDF preview...', 'info', 'fa-print');
  setTimeout(() => window.print(), 400);
}

/* ============================================================
   INIT
   ============================================================ */
async function init() {
  await loadTheme();

  // Set current month
  const now = new Date();
  document.getElementById('sf2-month').value = now.getMonth() + 1;

  // Load school year from meta
  try {
    const metas = await db.schoolMeta.toArray();
    const meta = {};
    metas.forEach(m => meta[m.key] = m.value);
    if (meta.schoolYear) document.getElementById('sf2-sy').value = meta.schoolYear;
  } catch(e) {}

  await loadGrades();
}

init();


