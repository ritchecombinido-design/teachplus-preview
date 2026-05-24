/* ═══════════════════════════════════════════════════════════════════
   TEACHPLUS LIVE SESSION ENGINE
   Data source: TeachPlusDB (Dexie / IndexedDB) only
   No BroadcastChannel. No real-time sync.
   UI updates ONLY when LOAD is clicked.
═══════════════════════════════════════════════════════════════════ */

// ── DATABASE ─────────────────────────────────────────────────────────
const db = new Dexie('TeachPlusDB');

// ── DB versions aligned with setup.js (must match to avoid Dexie conflicts) ──
db.version(6).stores({
  settings:     '&key, value',
  quotes:       '++id, quoteIndex, shownAt',
  activityLogs: '++id, message, icon, color, ts',
  cacheData:    '&cacheKey, data, updatedAt',
  schoolMeta:   '&key, value',
  sections:     '++id, gradeLevel, sectionName',
  learners:     '++id, lrn, fullname, sex, gradeLevel, section, [gradeLevel+section]',
  attendance:   '++id, learnerId, date, section, month, [section+date]',
  interventions:'++id, learnerId, section, message, createdAt, updatedAt',
  themeState:   '&key, value',
  sr_tasks:     '++id, type, sectionId, term, slot, title',
  sr_scores:    '++id, taskId, learnerId, [taskId+learnerId]',
  sr_terms:     '++id, sectionId, term, subject, createdAt',
  seating:      '&id, schoolYear, gradeLevel, section, layout, updatedAt',
});

// v10 — expanded sr_tasks/sr_terms indexes + new tables (subjects, sr_grades)
db.version(10).stores({
  settings:      '&key, value',
  quotes:        '++id, quoteIndex, shownAt',
  activityLogs:  '++id, message, icon, color, ts',
  cacheData:     '&cacheKey, data, updatedAt',
  schoolMeta:    '&key, value',
  sections:      '++id, gradeLevel, sectionName',
  learners:      '++id, lrn, fullname, sex, gradeLevel, section, [gradeLevel+section]',
  attendance:    '++id, learnerId, date, section, month, [section+date]',
  interventions: '++id, learnerId, section, message, createdAt, updatedAt',
  themeState:    '&key, value',
  sr_tasks:
    '++id, type, sectionId, subjectGroup, subjectName, mapehGroup, term, slot, title, ' +
    '[sectionId+subjectGroup+subjectName+mapehGroup+term], ' +
    '[type+sectionId+subjectGroup+subjectName+mapehGroup+term]',
  sr_scores:    '++id, taskId, learnerId, [taskId+learnerId]',
  sr_terms:
    '++id, sectionId, subjectGroup, subjectName, mapehGroup, term, createdAt, ' +
    '[sectionId+subjectGroup+subjectName+mapehGroup+term]',
  seating:      '&id, schoolYear, gradeLevel, section, layout, updatedAt',
  subjects:     '++id, sectionId, subjectName, subjectGroup',
  sr_grades:
    '++id, learnerId, sectionId, subjectGroup, subjectName, mapehGroup, term, ' +
    'wwAvg, ptAvg, stTeAvg, initialGrade, transmutedGrade, descriptor, updatedAt, ' +
    '[learnerId+sectionId+subjectGroup+subjectName+mapehGroup+term]',
});

// v11 — adds section_subject_config (required by setup.js)
db.version(11).stores({
  section_subject_config:
    '++id, sectionId, term, subjectGroup, subjectName, ' +
    '[sectionId+term], ' +
    '[sectionId+term+subjectName]',
});
// ====================================================
//  THEME SYSTEM
// ====================================================
// Apply theme immediately before page renders — reads same Dexie table as dashboard
// ====================================================
//  THEME — reads from shared Dexie table (dashboard writes here)
// ====================================================
async function setTheme(t) {
  localStorage.setItem('tp_theme', t); // sync bridge
  await db.themeState.put({ key: 'active', value: t });
  document.documentElement.setAttribute('data-theme', t);
  const el = document.getElementById('active-theme-name');
  if (el) el.textContent = t.charAt(0).toUpperCase() + t.slice(1);
  document.querySelectorAll('.theme-option').forEach(o =>
    o.classList.toggle('active', o.dataset.theme === t)
  );
}

async function loadTheme() {
  try {
    const row = await db.themeState.get('active');
    const theme = (row && row.value) ? row.value : 'light';
    localStorage.setItem('tp_theme', theme); // keep in sync
    document.documentElement.setAttribute('data-theme', theme);
    const el = document.getElementById('active-theme-name');
    if (el) el.textContent = theme.charAt(0).toUpperCase() + theme.slice(1);
  } catch(e) {}
}


function buildThemeGrid() {
  const themes = [
    {id:'light',label:'Light',colors:['#f3f6fb','#3b82f6'],icon:'fa-sun'},
    {id:'dark',label:'Dark',colors:['#0f172a','#60a5fa'],icon:'fa-moon'},
    {id:'pink',label:'Pink',colors:['#fdf2f8','#ec4899'],icon:'fa-heart'},
    {id:'blue',label:'Blue',colors:['#eff6ff','#2563eb'],icon:'fa-water'},
    {id:'green',label:'Green',colors:['#f0fdf4','#22c55e'],icon:'fa-leaf'},
    {id:'yellow',label:'Yellow',colors:['#fefce8','#eab308'],icon:'fa-star'},
    {id:'teal',label:'Teal',colors:['#f0fdfa','#14b8a6'],icon:'fa-spa'},
    {id:'purple',label:'Purple',colors:['#faf5ff','#8b5cf6'],icon:'fa-gem'},
  ];
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const grid = document.getElementById('theme-grid');
  if (!grid) return;
  grid.innerHTML = themes.map(t => `
    <div class="theme-option ${t.id === current ? 'active' : ''}" data-theme="${t.id}" onclick="setTheme('${t.id}')">
      <div class="theme-preview" style="background:linear-gradient(135deg,${t.colors[0]} 50%,${t.colors[1]} 50%);"></div>
      <i class="fa ${t.icon}" style="color:${t.colors[1]};margin-bottom:4px;"></i>
      <div>${t.label}</div>
    </div>`).join('');
}

// ============================================================
// BUG FIX START
// normalizeStatus() converts all known legacy/variant status
// strings to the single canonical lowercase form used by both
// Live Session and the Attendance matrix.
//
// Problem: older records (or records from other entry points)
// may store "late", "Late", "L", "TD", "Tardy", etc.
// Live Session stores "tardy" (lowercase). Attendance CSS now
// uses "status-tardy". This function bridges any mismatch.
// ============================================================
function normalizeStatus(raw) {
  const s = (raw || '').trim().toLowerCase();
  const ALIASES = {
    // Tardy variants → canonical "tardy"
    'late':   'tardy',
    'l':      'tardy',
    'td':     'tardy',
    // Present variants → canonical "present"
    'p':      'present',
    'here':   'present',
    // Absent variants → canonical "absent"
    'a':      'absent',
    'abs':    'absent',
    // Cutting variants → canonical "cutting"
    'cut':    'cutting',
    'c':      'cutting',
    // Excused variants → canonical "excused"
    'ex':     'excused',
    'exc':    'excused',
    'e':      'excused',
  };
  return ALIASES[s] || s || 'present';
}
// BUG FIX END


// ====================================================
//  NAVIGATION
// ====================================================
let sidebarCollapsed=false,mobileSidebarOpen=false;
function showPage(pageId,el){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const page=document.getElementById('page-'+pageId);
  if(page)page.classList.add('active');
  if(el)el.classList.add('active');
  if(pageId==='settings'){buildThemeGrid();loadSysInfo();}
  if(pageId==='learners'){loadGrades('lr-grade');updateLearnerSections();loadLearners();}
  if(pageId==='dashboard'){loadGrades('dash-grade');}
  if(pageId==='reports'){loadGrades('rpt-grade');setCurrentMonth();}
  if(pageId==='calendar'){renderCalendar();}
  if(pageId==='interventions'){loadGrades('int-grade');}
  if(pageId==='attendance'){loadGrades('att-grade');}
  if(window.innerWidth<768){document.getElementById('sidebar').classList.remove('mobile-open');mobileSidebarOpen=false;}
}
function toggleSidebar(){
  sidebarCollapsed=!sidebarCollapsed;
  document.getElementById('sidebar').classList.toggle('collapsed',sidebarCollapsed);
  document.getElementById('toggle-icon').className='fa fa-chevron-'+(sidebarCollapsed?'right':'left');
}
function toggleMobileSidebar(){
  mobileSidebarOpen=!mobileSidebarOpen;
  document.getElementById('sidebar').classList.toggle('mobile-open',mobileSidebarOpen);
}

function goBackToDashboard() {
  window.location.href = "index.html";
}
// ====================================================
//  CLOCK
// ====================================================
function updateClock(){
  const now=new Date();
  document.getElementById('clock').textContent=now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}
setInterval(updateClock,1000);updateClock();

// ====================================================
//  TOAST
// ====================================================
function toast(msg,type='info',icon='fa-info-circle'){
  const c=document.getElementById('toast-container');
  const t=document.createElement('div');
  t.className=`toast ${type}`;
  t.innerHTML=`<i class="fa ${icon}"></i><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(()=>t.remove(),3000);
}

// ====================================================
//  MODALS
// ====================================================
function openModal(id){document.getElementById(id).classList.add('open');}
function closeModal(id){document.getElementById(id).classList.remove('open');}
document.querySelectorAll('.modal-overlay').forEach(o=>o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('open');}));

// ====================================================
//  GRADES/SECTIONS HELPERS
// ====================================================
async function loadGrades(selectId){
  const grades=[...new Set((await db.sections.toArray()).map(s=>s.gradeLevel))].sort();
  const sel=document.getElementById(selectId);
  if(!sel)return;
  const cur=sel.value;
  sel.innerHTML='<option value="">All Grades</option>'+grades.map(g=>`<option value="${g}">${g}</option>`).join('');
  if(cur)sel.value=cur;
}
async function getSections(grade){
  const arr=grade?await db.sections.where('gradeLevel').equals(grade).toArray():await db.sections.toArray();
  return arr.map(s=>s.sectionName);
}
async function updateSelectSections(gradeSelectId,sectionSelectId){
  const grade=document.getElementById(gradeSelectId)?.value||'';
  const secs=await getSections(grade);
  const sel=document.getElementById(sectionSelectId);
  if(!sel)return;
  sel.innerHTML='<option value="">Select Section</option>'+secs.map(s=>`<option value="${s}">${s}</option>`).join('');
}
async function updateDashSections(){await updateSelectSections('dash-grade','dash-section');}
async function updateAttSections(){await updateSelectSections('att-grade','att-section');}
async function updateRptSections(){await updateSelectSections('rpt-grade','rpt-section');}
async function updateIntSections(){await updateSelectSections('int-grade','int-section');loadInterventions();}
async function updateLearnerSections(){await updateSelectSections('lr-grade','lr-section');loadLearners();}

// ====================================================
//  LEARNERS PAGE — Add Learner (from Learners page toolbar)
// ====================================================
function openAddLearner(){
  // Clear scope — user picks grade/section manually
  document.getElementById('al-lrn').value='';
  document.getElementById('al-fname').value='';
  document.getElementById('al-lname').value='';
  document.getElementById('al-mname').value='';
  document.getElementById('al-extname').value='';
  document.getElementById('al-sex').value='M';
  document.getElementById('al-birthdate').value='';
  document.getElementById('al-age').value='';
  document.getElementById('al-address').value='';
  document.getElementById('al-guardian').value='';
  document.getElementById('al-contact').value='';
  document.getElementById('al-grade').value='7';
  document.getElementById('al-section-input').value='';
  // Show grade/section fields (not scoped)
  document.getElementById('al-grade-row').style.display='';
  document.getElementById('al-section-row').style.display='';
  document.getElementById('al-modal-scope-info').style.display='none';
  // Save button calls saveLearner (generic)
  document.getElementById('al-save-btn').onclick = saveLearner;
  openModal('modal-addlearner');
}

async function saveLearner(){
  const lrn        = document.getElementById('al-lrn').value.trim();
  const lastName   = document.getElementById('al-lname').value.trim();
  const firstName  = document.getElementById('al-fname').value.trim();
  const middleName = document.getElementById('al-mname').value.trim();
  const extName    = document.getElementById('al-extname').value.trim();
  const sex        = document.getElementById('al-sex').value;
  const birthDate  = document.getElementById('al-birthdate').value;
  const age        = document.getElementById('al-age').value.trim();
  const address    = document.getElementById('al-address').value.trim();
  const guardian   = document.getElementById('al-guardian').value.trim();
  const contact    = document.getElementById('al-contact').value.trim();
  const gradeLevel = document.getElementById('al-grade').value;
  const section    = document.getElementById('al-section-input').value.trim();

  if(!lastName||!firstName||!gradeLevel||!section){
    toast('Last Name, First Name, Grade, and Section are required','error','fa-exclamation');return;
  }
  const fullname = buildFullname(lastName, firstName, middleName, extName);

  // Duplicate LRN check within same school year
  if(lrn){
    const sy = window._schoolMeta?.schoolYear || '';
    const dup = await db.learners.where('lrn').equals(lrn).first();
    if(dup && (!sy || dup.schoolYear === sy)){
      toast('Duplicate LRN detected for this school year!','error','fa-exclamation-triangle');return;
    }
  }

  const sy = window._schoolMeta?.schoolYear || '';
  await db.learners.add({lrn, fullname, lastName, firstName, middleName, extName,
    sex, gradeLevel, section, birthDate, age, address, guardian, contact, schoolYear: sy});
  const exists=await db.sections.where({gradeLevel,sectionName:section}).first();
  if(!exists)await db.sections.add({gradeLevel,sectionName:section});
  closeModal('modal-addlearner');
  loadLearners();
  toast('Learner added','success','fa-user-plus');
}

function buildFullname(last, first, middle, ext){
  let name = last + ', ' + first;
  if(middle) name += ' ' + middle.charAt(0).toUpperCase() + '.';
  if(ext) name += ' ' + ext;
  return name.trim();
}

// ====================================================
//  ATTENDANCE PAGE — Add Learner (scoped to active section)
// ====================================================
function openAttAddLearner(){
  // Pre-fill scope from currently loaded section
  document.getElementById('al-lrn').value='';
  document.getElementById('al-fname').value='';
  document.getElementById('al-lname').value='';
  document.getElementById('al-mname').value='';
  document.getElementById('al-extname').value='';
  document.getElementById('al-sex').value='M';
  document.getElementById('al-birthdate').value='';
  document.getElementById('al-age').value='';
  document.getElementById('al-address').value='';
  document.getElementById('al-guardian').value='';
  document.getElementById('al-contact').value='';
  // Hide grade/section — locked to current context
  document.getElementById('al-grade-row').style.display='none';
  document.getElementById('al-section-row').style.display='none';
  // Show scope info banner
  const grade = document.getElementById('att-grade').value;
  const section = document.getElementById('att-section').value;
  const sy = document.getElementById('att-sy').value;
  const scopeEl = document.getElementById('al-modal-scope-info');
  scopeEl.style.display='';
  scopeEl.innerHTML=`<i class="fa fa-info-circle"></i> Adding to: <strong>Grade ${grade} — ${section}</strong> &nbsp;|&nbsp; SY: <strong>${sy}</strong>`;
  // Save button calls scoped save
  document.getElementById('al-save-btn').onclick = saveAttLearner;
  openModal('modal-addlearner');
}

async function saveAttLearner(){
  const lrn        = document.getElementById('al-lrn').value.trim();
  const lastName   = document.getElementById('al-lname').value.trim();
  const firstName  = document.getElementById('al-fname').value.trim();
  const middleName = document.getElementById('al-mname').value.trim();
  const extName    = document.getElementById('al-extname').value.trim();
  const sex        = document.getElementById('al-sex').value;
  const birthDate  = document.getElementById('al-birthdate').value;
  const age        = document.getElementById('al-age').value.trim();
  const address    = document.getElementById('al-address').value.trim();
  const guardian   = document.getElementById('al-guardian').value.trim();
  const contact    = document.getElementById('al-contact').value.trim();

  // Auto-pull from currently active context
  const gradeLevel = document.getElementById('att-grade').value;
  const section    = document.getElementById('att-section').value;
  const sy         = document.getElementById('att-sy').value;

  if(!lastName||!firstName){
    toast('Last Name and First Name are required','error','fa-exclamation');return;
  }
  const fullname = buildFullname(lastName, firstName, middleName, extName);

  // Duplicate LRN check within same school year
  if(lrn){
    const dup = await db.learners.where('lrn').equals(lrn).toArray();
    const dupInSY = dup.find(d => !d.schoolYear || !sy || d.schoolYear === sy);
    if(dupInSY){
      toast('Duplicate LRN detected for this school year!','error','fa-exclamation-triangle');return;
    }
  }

  await db.learners.add({lrn, fullname, lastName, firstName, middleName, extName,
    sex, gradeLevel, section, birthDate, age, address, guardian, contact, schoolYear: sy});
  const exists=await db.sections.where({gradeLevel,sectionName:section}).first();
  if(!exists)await db.sections.add({gradeLevel,sectionName:section});

  closeModal('modal-addlearner');
  toast('Learner added — click Refresh to see them','success','fa-user-plus');
}
// ====================================================
//  LEARNERS LIST
// ====================================================
async function loadLearners(){
  const grade=document.getElementById('lr-grade')?.value||'';
  const section=document.getElementById('lr-section')?.value||'';
  const search=(document.getElementById('lr-search')?.value||'').toLowerCase();
  let query=db.learners.toCollection();
  let arr=await query.toArray();
  if(grade)arr=arr.filter(l=>l.gradeLevel===grade);
  if(section)arr=arr.filter(l=>l.section===section);
  if(search)arr=arr.filter(l=>l.fullname.toLowerCase().includes(search)||(l.lrn&&l.lrn.includes(search)));
  const el=document.getElementById('learner-list');
  if(!el)return;
  if(!arr.length){el.innerHTML=`<div class="empty-state"><i class="fa fa-users"></i><h3>No Learners Found</h3><p>Import an SF1 file or add learners manually.</p></div>`;return;}
  el.innerHTML=`<table class="risk-table" style="width:100%;">
    <thead><tr><th>LRN</th><th>Full Name</th><th>Sex</th><th>Grade</th><th>Section</th><th>Action</th></tr></thead>
    <tbody>${arr.map(l=>`<tr>
      <td style="font-family:monospace;font-size:12px;">${l.lrn||'—'}</td>
      <td style="font-weight:600;">${l.fullname}</td>
      <td><span class="section-pill">${l.sex==='M'?'Male':'Female'}</span></td>
      <td>${l.gradeLevel}</td>
      <td>${l.section}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteLearner(${l.id})"><i class="fa fa-trash"></i></button></td>
    </tr>`).join('')}</tbody></table>`;
}
async function deleteLearner(id){
  if(!confirm('Delete this learner?'))return;
  await db.learners.delete(id);
  loadLearners();
  toast('Learner removed','info','fa-trash');
}

// ====================================================
//  ATTENDANCE ENGINE
// ====================================================
const STATUS_CYCLE=['none','present','absent','late','cutting','excused'];
let attData={},attLearners=[],attSection='',attMonth=1,attYear=2025;

// ── Gender helpers ────────────────────────────────────────────────────────────
function normalizeGender(raw){
  const v=(raw||'').trim().toLowerCase();
  if(v==='m'||v==='male')return 'Male';
  if(v==='f'||v==='female')return 'Female';
  return 'Unknown';
}
function sortLearnersByGenderThenName(learners){
  const order={Male:0,Female:1,Unknown:2};
  return [...learners].sort((a,b)=>{
    const ga=normalizeGender(a.sex), gb=normalizeGender(b.sex);
    if(order[ga]!==order[gb])return order[ga]-order[gb];
    return a.fullname.localeCompare(b.fullname);
  });
}

async function loadAttendance(){
  const grade=document.getElementById('att-grade').value;
  const section=document.getElementById('att-section').value;
  if(!grade||!section){toast('Select grade and section','error','fa-exclamation');return;}
  attSection=section;
  const sy=document.getElementById('att-sy').value;
  const syYear=parseInt(sy.split('-')[0]);
  attYear=syYear;
  const learners=await db.learners.where({gradeLevel:grade,section:section}).toArray();
  if(!learners.length){toast('No learners in this section','error','fa-users');return;}
  attLearners=sortLearnersByGenderThenName(learners);
  const months=[6,7,8,9,10,11,12,1,2,3,4,5];
  const curM=new Date().getMonth()+1;
  attMonth=months.includes(curM)?curM:6;
  buildMonthTabs(months,sy);
  await loadAttendanceData();
  document.getElementById('att-output').style.display='block';
  renderAttMatrix();
  updateAttHeader(grade,section,sy);
}
function buildMonthTabs(months,sy){
  const names=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  document.getElementById('month-tabs').innerHTML=months.map(m=>
    `<div class="month-tab ${m===attMonth?'active':''}" onclick="switchMonth(${m})">${names[m]}</div>`).join('');
}
function switchMonth(m){
  attMonth=m;
  document.querySelectorAll('.month-tab').forEach(t=>t.classList.toggle('active',parseInt(t.textContent.replace(/[A-Za-z]/g,m=>({Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12})[m]||0))===m));
  // Simple text match
  document.querySelectorAll('.month-tab').forEach(t=>{
    const mm={'Jan':1,'Feb':2,'Mar':3,'Apr':4,'May':5,'Jun':6,'Jul':7,'Aug':8,'Sep':9,'Oct':10,'Nov':11,'Dec':12};
    t.classList.toggle('active',mm[t.textContent.trim()]===m);
  });
  loadAttendanceData().then(()=>renderAttMatrix());
}
async function loadAttendanceData(){
  const recs=await db.attendance.where({section:attSection,month:attMonth}).toArray();
  attData={};
  recs.forEach(r=>{attData[r.learnerId+'_'+r.date]=r.status;});
}
function getDaysInMonth(y,m){return new Date(y,m,0).getDate();}
function isWeekend(y,m,d){const day=new Date(y,m-1,d).getDay();return day===0||day===6;}
function updateAttHeader(grade,section,sy){
  const meta=window._schoolMeta||{};
  document.getElementById('att-header-info').innerHTML=`
    <div class="att-info-item"><label>School</label><span>${meta.schoolName||'—'}</span></div>
    <div class="att-info-item"><label>School ID</label><span>${meta.schoolId||'—'}</span></div>
    <div class="att-info-item"><label>School Year</label><span>${sy}</span></div>
    <div class="att-info-item"><label>Grade Level</label><span>Grade ${grade}</span></div>
    <div class="att-info-item"><label>Section</label><span>${section}</span></div>
    <div class="att-info-item"><label>Month</label><span>${['','January','February','March','April','May','June','July','August','September','October','November','December'][attMonth]}</span></div>`;
}
async function renderAttMatrix(){
  const days=getDaysInMonth(attYear,attMonth);
  const dayNums=Array.from({length:days},(_,i)=>i+1);
  const dayHeaders=dayNums.map(d=>{
    const dow=['Su','Mo','Tu','We','Th','Fr','Sa'][new Date(attYear,attMonth-1,d).getDay()];
    const wknd=isWeekend(attYear,attMonth,d);
    return `<th class="day-header" style="${wknd?'opacity:.4;':''}">${d}<br><span style="font-size:9px;font-weight:400;">${dow}</span></th>`;
  }).join('');
  let lastGroup=null;
  const rows=attLearners.map((l,idx)=>{
    const group=normalizeGender(l.sex);
    let headerRow='';
    if(group!==lastGroup){
      lastGroup=group;
      const colspan=dayNums.length+1;
      headerRow=`<tr><td colspan="${colspan}" style="padding:6px 10px;font-weight:700;font-size:12px;background:var(--surface2,#f0f4f8);color:var(--text-secondary,#555);border-top:2px solid var(--border,#ddd);letter-spacing:.5px;">${group}:</td></tr>`;
    }
    const cells=dayNums.map(d=>{
      const dateStr=`${attYear}-${String(attMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const st=attData[l.id+'_'+dateStr]||'none';
      const wknd=isWeekend(attYear,attMonth,d);
      return `<td class="att-cell status-${st}${wknd?' weekend':''}" 
        data-lid="${l.id}" data-date="${dateStr}" data-idx="${idx}"
        ${wknd?'':'onclick="cycleStatus(this)"'}
        title="${l.fullname} — ${dateStr}"></td>`;
    }).join('');
    return headerRow+`<tr class="att-row"><td class="att-cell name-col body-name">${l.fullname}</td>${cells}</tr>`;
  }).join('');
  document.getElementById('att-matrix').innerHTML=`
    <table class="att-table">
      <thead><tr><th class="name-col">Learner</th>${dayHeaders}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="att-action-bar">
      <button class="btn btn-primary btn-sm" onclick="openAttAddLearner()">
        <i class="fa fa-user-plus"></i> Add Learner
      </button>
      <button class="btn btn-secondary btn-sm" onclick="refreshAttSection()">
        <i class="fa fa-sync"></i> Refresh
      </button>
    </div>`;
}

async function refreshAttSection(){
  const grade=document.getElementById('att-grade').value;
  const section=document.getElementById('att-section').value;
  if(!grade||!section)return;
  // Reload learners from DB then re-render matrix
  const learners=await db.learners.where({gradeLevel:grade,section:section}).toArray();
  attLearners=sortLearnersByGenderThenName(learners);
  await loadAttendanceData();
  renderAttMatrix();
  toast('Section refreshed','info','fa-sync');
}
async function cycleStatus(cell){
  const lid=parseInt(cell.dataset.lid);
  const date=cell.dataset.date;
  const cur=STATUS_CYCLE.indexOf(cell.className.match(/status-(\w+)/)?.[1]||'none');
  const next=STATUS_CYCLE[(cur+1)%STATUS_CYCLE.length];
  cell.className=`att-cell status-${next}`;
  const month=parseInt(date.split('-')[1]);
  attData[lid+'_'+date]=next;
  if(next==='none'){
    const existing=await db.attendance.where({learnerId:lid,date,section:attSection}).first();
    if(existing)await db.attendance.delete(existing.id);
  } else {
    const existing=await db.attendance.where({learnerId:lid,date,section:attSection}).first();
    if(existing){await db.attendance.update(existing.id,{status:next,month});}
    else{await db.attendance.add({learnerId:lid,date,section:attSection,status:next,month});}
  }
}

// ====================================================
//  DASHBOARD
// ====================================================
async function loadDashboard(){
  const grade=document.getElementById('dash-grade').value;
  const section=document.getElementById('dash-section').value;
  if(!grade||!section){toast('Select grade and section','error','fa-exclamation');return;}

  const now = new Date();
const today =
  now.getFullYear() + '-' +
  String(now.getMonth()+1).padStart(2,'0') + '-' +
  String(now.getDate()).padStart(2,'0');

  const learners=await db.learners.where({gradeLevel:grade,section}).toArray();
  const todayRecs=await db.attendance.where({section,date:today}).toArray();
  const counts={present:0,absent:0,late:0,cutting:0,excused:0};
  todayRecs.forEach(r=>{if(counts[r.status]!==undefined)counts[r.status]++;});
  document.getElementById('stat-present').textContent=counts.present;
  document.getElementById('stat-absent').textContent=counts.absent;
  document.getElementById('stat-late').textContent=counts.late;
  document.getElementById('stat-cutting').textContent=counts.cutting;
  document.getElementById('dash-output').style.display='block';
  renderDashTrend(section);
  renderDashAtRisk(learners,section);
  renderDashHeatmap(section);
}
async function refreshDashboard(){
  const btn=document.querySelector('#page-dashboard .btn-primary');
  if(btn){btn.innerHTML='<i class="fa fa-sync fa-spin"></i> Refreshing';setTimeout(()=>btn.innerHTML='<i class="fa fa-sync"></i> Refresh',1000);}
  loadDashboard();
}
async function renderDashTrend(section){
  const months=[6,7,8,9,10,11,12,1,2,3,4,5];
  const names={6:'Jun',7:'Jul',8:'Aug',9:'Sep',10:'Oct',11:'Nov',12:'Dec',1:'Jan',2:'Feb',3:'Mar',4:'Apr',5:'May'};
  const allRecs=await db.attendance.where('section').equals(section).toArray();
  const rates=await Promise.all(months.map(async m=>{
    const recs=allRecs.filter(r=>r.month===m);
    if(!recs.length)return null;
    const present=recs.filter(r=>r.status==='present'||r.status==='late').length;
    return Math.round(present/recs.length*100);
  }));
  const maxRate=Math.max(...rates.filter(r=>r!==null),1);
  document.getElementById('dash-trend').innerHTML=`<div class="bar-chart">${months.map((m,i)=>{
    const r=rates[i];
    if(r===null)return '';
    return `<div class="bar-row">
      <div class="bar-label">${names[m]}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${r}%;background:var(--success);"></div></div>
      <div class="bar-val">${r}%</div></div>`;
  }).join('')}</div>`;
}
async function renderDashAtRisk(learners,section){
  const threshold=3;
  const risks=[];
  for(const l of learners){
    const recs=await db.attendance.where({learnerId:l.id,section}).toArray();
    const abs=recs.filter(r=>r.status==='absent').length;
    const late=recs.filter(r=>r.status==='late'||r.status==='cutting').length;
    if(abs>=threshold)risks.push({name:l.fullname,abs,late,level:abs>=5?'high':abs>=3?'med':'low'});
  }
  const el=document.getElementById('dash-atrisk');
  if(!risks.length){el.innerHTML=`<div class="empty-state" style="padding:20px;"><i class="fa fa-smile"></i><p>No at-risk learners!</p></div>`;return;}
  el.innerHTML=`<table class="risk-table"><thead><tr><th>Name</th><th>Absent</th><th>Late/Cut</th><th>Risk</th></tr></thead><tbody>${
    risks.slice(0,8).map(r=>`<tr><td style="font-weight:600;font-size:12px;">${r.name}</td>
      <td style="color:var(--danger);font-weight:700;">${r.abs}</td>
      <td style="color:var(--warning);font-weight:700;">${r.late}</td>
      <td><span class="risk-badge risk-${r.level}">${r.level.toUpperCase()}</span></td></tr>`).join('')
  }</tbody></table>`;
}
async function renderDashHeatmap(section){
  const m=new Date().getMonth()+1;
  const y=new Date().getFullYear();
  const days=getDaysInMonth(y,m);
  const recs=await db.attendance.where({section,month:m}).toArray();
  const dayMap={};
  recs.forEach(r=>{
    const d=parseInt(r.date.split('-')[2]);
    if(!dayMap[d])dayMap[d]={present:0,absent:0,total:0};
    dayMap[d].total++;
    if(r.status==='present')dayMap[d].present++;
    if(r.status==='absent')dayMap[d].absent++;
  });

const cells = Array.from({length:days},(_,i)=>{
  const d=i+1;
  const info=dayMap[d];
  const wknd=isWeekend(y,m,d);

  let cls='heat-0';
  let rate=0;
  let percent=0;

  if(info){
    rate = info.total ? info.present/info.total : 0;
    percent = Math.round(rate * 100);

cls =
  rate >= 0.90 ? 'heat-3' :   // Excellent
  rate >= 0.80 ? 'heat-2' :   // Good
  rate >= 0.70 ? 'heat-1' :   // Warning
  'heat-absent';              // Critical

  }

  return `<div class="heat-cell ${cls}" 
    title="Day ${d}${info ? ` (${info.present}/${info.total} - ${percent}%)` : ''}">
    <span class="heat-text">${info ? percent + '%' : ''}</span>
  </div>`;



  }).join('');
  document.getElementById('dash-heatmap').innerHTML=`
    <div style="display:flex;gap:8px;margin-bottom:6px;font-size:11px;color:var(--subtext);">
      <span>Current Month Heatmap</span>
    </div>
    <div class="heatmap-grid">${cells}</div>
    <div style="display:flex;gap:12px;margin-top:8px;font-size:11px;color:var(--subtext);">
      <span>🟩 High</span><span>🟨 Med</span><span>🟥 Low</span><span>⬜ Weekend</span>
    </div>`;
}

// ====================================================
//  REPORTS
// ====================================================
function setCurrentMonth(){
  const m=new Date().getMonth()+1;
  const sel=document.getElementById('rpt-month');
  if(sel)sel.value=m;
}
async function loadReports(){
  const grade=document.getElementById('rpt-grade').value;
  const section=document.getElementById('rpt-section').value;
  const month=parseInt(document.getElementById('rpt-month').value);
  if(!grade||!section){toast('Select grade and section','error','fa-exclamation');return;}
  const learners=await db.learners.where({gradeLevel:grade,section}).toArray();
  const recs=await db.attendance.where({section,month}).toArray();
  const total=recs.length;
  const present=recs.filter(r=>r.status==='present').length;
  const absent=recs.filter(r=>r.status==='absent').length;
  const late=recs.filter(r=>r.status==='late').length;
  const cutting=recs.filter(r=>r.status==='cutting').length;
  const rate=total?Math.round(present/total*100):0;
  // Per-learner analysis
  const learnerStats=learners.map(l=>{
    const lr=recs.filter(r=>r.learnerId===l.id);
    return {name:l.fullname,present:lr.filter(r=>r.status==='present').length,
      absent:lr.filter(r=>r.status==='absent').length,
      late:lr.filter(r=>r.status==='late').length,
      cutting:lr.filter(r=>r.status==='cutting').length,total:lr.length};
  }).sort((a,b)=>b.absent-a.absent);
  const names={1:'January',2:'February',3:'March',4:'April',5:'May',6:'June',7:'July',8:'August',9:'September',10:'October',11:'November',12:'December'};
  document.getElementById('rpt-output').innerHTML=`
    <div class="stats-grid" style="margin-bottom:16px;">
      <div class="stat-card"><div class="stat-icon" style="background:#dcfce7;color:#16a34a;"><i class="fa fa-percentage"></i></div>
        <div><div class="stat-val">${rate}%</div><div class="stat-lbl">Attendance Rate</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:#dcfce7;color:#16a34a;"><i class="fa fa-check"></i></div>
        <div><div class="stat-val">${present}</div><div class="stat-lbl">Present Records</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:#fee2e2;color:#dc2626;"><i class="fa fa-times"></i></div>
        <div><div class="stat-val">${absent}</div><div class="stat-lbl">Absent Records</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:#fef3c7;color:#d97706;"><i class="fa fa-clock"></i></div>
        <div><div class="stat-val">${late}</div><div class="stat-lbl">Late Records</div></div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
      <div class="card"><div class="card-title"><i class="fa fa-chart-pie"></i> Status Distribution</div>
        <div class="bar-chart">
          ${[['Present',present,'#10b981'],['Absent',absent,'#ef4444'],['Late',late,'#f59e0b'],['Cutting',cutting,'#8b5cf6']].map(([lbl,val,col])=>`
          <div class="bar-row"><div class="bar-label">${lbl}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${total?Math.round(val/total*100):0}%;background:${col};"></div></div>
            <div class="bar-val">${val}</div></div>`).join('')}
        </div></div>
      <div class="card"><div class="card-title"><i class="fa fa-trophy"></i> Top Absences — ${names[month]}</div>
        <table class="risk-table"><thead><tr><th>Learner</th><th>Absent</th><th>Late</th><th>Cut</th></tr></thead>
        <tbody>${learnerStats.slice(0,8).map(l=>`<tr>
          <td style="font-size:12px;font-weight:600;">${l.name}</td>
          <td style="color:var(--danger);font-weight:700;">${l.absent}</td>
          <td style="color:var(--warning);">${l.late}</td>
          <td style="color:var(--cut-color);">${l.cutting}</td></tr>`).join('')}</tbody></table>
      </div>
    </div>
    <div class="card"><div class="card-title"><i class="fa fa-table"></i> Full Learner Report — ${names[month]}</div>
      <table class="risk-table"><thead><tr><th>#</th><th>Name</th><th>Present</th><th>Absent</th><th>Late</th><th>Cutting</th><th>Rate</th></tr></thead>
      <tbody>${learnerStats.map((l,i)=>{
        const r=l.total?Math.round(l.present/l.total*100):0;
        return `<tr><td>${i+1}</td><td style="font-weight:600;">${l.name}</td>
          <td style="color:var(--success);">${l.present}</td>
          <td style="color:var(--danger);">${l.absent}</td>
          <td style="color:var(--warning);">${l.late}</td>
          <td style="color:var(--cut-color);">${l.cutting}</td>
          <td><span class="risk-badge ${r>=80?'risk-low':r>=60?'risk-med':'risk-high'}">${r}%</span></td></tr>`;
      }).join('')}</tbody></table>
    </div>`;
}

// ====================================================
//  CALENDAR
// ====================================================
let calYear=new Date().getFullYear(),calMonth=new Date().getMonth();
let calEvents=[];
async function loadCalEvents(){calEvents=JSON.parse(localStorage.getItem('tp_cal_events')||'[]');}
function saveCalEvents(){localStorage.setItem('tp_cal_events',JSON.stringify(calEvents));}
async function renderCalendar(){
  await loadCalEvents();
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  document.getElementById('cal-headers').innerHTML=days.map(d=>`<div class="cal-header-day">${d}</div>`).join('');
  const first=new Date(calYear,calMonth,1).getDay();
  const daysInM=new Date(calYear,calMonth+1,0).getDate();
  const today=new Date();
  const todayStr=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  let cells='';
  for(let i=0;i<first;i++)cells+=`<div class="cal-day empty"></div>`;
  for(let d=1;d<=daysInM;d++){
    const ds=`${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const ev=calEvents.find(e=>e.date===ds);
    const isToday=ds===todayStr;
    const cls=`cal-day${isToday?' today':''}${ev?.type==='holiday'?' holiday-day':ev?.type==='suspended'?' suspended-day':''}`;
    cells+=`<div class="${cls}"><div class="cal-day-num">${d}</div>${ev?`<div class="cal-day-label">${ev.desc}</div>`:''}</div>`;
  }
  document.getElementById('cal-body').innerHTML=cells;
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('cal-title').textContent=`${months[calMonth]} ${calYear}`;
  renderCalEventsList();
}
function renderCalEventsList(){
  const el=document.getElementById('cal-events-list');
  if(!calEvents.length){el.innerHTML=`<div class="empty-state" style="padding:20px;"><i class="fa fa-calendar-times"></i><p>No calendar events yet.</p></div>`;return;}
  el.innerHTML=`<table class="risk-table"><thead><tr><th>Date</th><th>Type</th><th>Description</th><th></th></tr></thead>
    <tbody>${calEvents.sort((a,b)=>a.date.localeCompare(b.date)).map((ev,i)=>`<tr>
      <td>${ev.date}</td>
      <td><span class="risk-badge ${ev.type==='holiday'?'risk-high':ev.type==='suspended'?'risk-med':'risk-low'}">${ev.type}</span></td>
      <td>${ev.desc}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteCalEvent(${i})"><i class="fa fa-trash"></i></button></td>
    </tr>`).join('')}</tbody></table>`;
}
function prevMonth(){calMonth--;if(calMonth<0){calMonth=11;calYear--;}renderCalendar();}
function nextMonth(){calMonth++;if(calMonth>11){calMonth=0;calYear++;}renderCalendar();}
function openCalEventModal(){const d=new Date();document.getElementById('ce-date').value=d.toISOString().split('T')[0];openModal('modal-calEvent');}
async function saveCalEvent(){
  const type=document.getElementById('ce-type').value;
  const date=document.getElementById('ce-date').value;
  const desc=document.getElementById('ce-desc').value.trim();
  if(!date||!desc){toast('Fill all fields','error','fa-exclamation');return;}
  await loadCalEvents();
  calEvents.push({type,date,desc});
  saveCalEvents();
  closeModal('modal-calEvent');
  renderCalendar();
  toast('Event added','success','fa-calendar-plus');
}
async function deleteCalEvent(idx){
  await loadCalEvents();
  calEvents.splice(idx,1);
  saveCalEvents();
  renderCalendar();
  toast('Event removed','info','fa-trash');
}

// ====================================================
//  INTERVENTIONS
// ====================================================
let currentIntLearnerId=null;
async function loadInterventions(){
  const grade=document.getElementById('int-grade')?.value||'';
  const section=document.getElementById('int-section')?.value||'';
  if(!grade||!section){document.getElementById('int-list').innerHTML=`<div class="empty-state"><i class="fa fa-hands-helping"></i><h3>Select a section</h3></div>`;return;}
  const learners=await db.learners.where({gradeLevel:grade,section}).toArray();
  const el=document.getElementById('int-list');
  if(!learners.length){el.innerHTML=`<div class="empty-state"><i class="fa fa-users"></i><h3>No learners</h3></div>`;return;}
  const cards=await Promise.all(learners.map(async l=>{
    const recs=await db.attendance.where({learnerId:l.id,section}).toArray();
    const abs=recs.filter(r=>r.status==='absent').length;
    const ints=await db.interventions.where({learnerId:l.id,section}).toArray();
    return {l,abs,ints};
  }));
  el.innerHTML=cards.map(({l,abs,ints})=>`
    <div class="intervention-card">
      <div class="int-header">
        <div><div class="int-name">${l.fullname}</div>
          <div style="font-size:12px;color:var(--subtext);margin-top:2px;">
            <i class="fa fa-times-circle" style="color:var(--danger);"></i> ${abs} absences
          </div></div>
        <span class="int-badge">${ints.length} log${ints.length!==1?'s':''}</span>
      </div>
      ${ints.length?`<div class="int-logs">${ints.slice(-3).map(i=>`
        <div class="int-log-item">${i.message}<div class="int-log-ts">${new Date(i.createdAt).toLocaleDateString()}</div></div>`).join('')}
      </div>`:'<div style="font-size:12px;color:var(--subtext);padding:4px 0;">No logs yet.</div>'}
      <div class="int-actions">
        <button class="btn btn-primary btn-sm" onclick="openIntModal(${l.id},'${l.fullname.replace(/'/g,"\\'")}')">
          <i class="fa fa-edit"></i> Manage Logs</button>
      </div>
    </div>`).join('');
}
async function openIntModal(learnerId,name){
  currentIntLearnerId=learnerId;
  document.getElementById('int-modal-title').textContent=`Interventions — ${name}`;
  document.getElementById('int-new-entry').value='';
  await renderIntLogs(learnerId);
  openModal('modal-intervention');
}
async function renderIntLogs(lid){
  const ints=await db.interventions.where({learnerId:lid}).toArray();
  const el=document.getElementById('int-modal-logs');
  if(!ints.length){el.innerHTML=`<div class="empty-state" style="padding:12px;"><i class="fa fa-notes-medical"></i><p>No logs yet.</p></div>`;return;}
  el.innerHTML=`<div class="int-logs">${ints.map(i=>`
    <div class="int-log-item" style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
      <div>${i.message}<div class="int-log-ts">${new Date(i.createdAt).toLocaleString()}</div></div>
      <button class="btn btn-danger btn-sm" onclick="deleteIntEntry(${i.id})"><i class="fa fa-trash"></i></button>
    </div>`).join('')}
  </div>`;
}
async function saveIntEntry(){
  const msg=document.getElementById('int-new-entry').value.trim();
  if(!msg||!currentIntLearnerId)return;
  const section=document.getElementById('int-section').value;
  const now=new Date().toISOString();
  await db.interventions.add({learnerId:currentIntLearnerId,section,message:msg,createdAt:now,updatedAt:now});
  document.getElementById('int-new-entry').value='';
  await renderIntLogs(currentIntLearnerId);
  loadInterventions();
  toast('Log added','success','fa-check');
}
async function deleteIntEntry(id){
  await db.interventions.delete(id);
  await renderIntLogs(currentIntLearnerId);
  loadInterventions();
  toast('Log deleted','info','fa-trash');
}

// ====================================================
//  SF1 IMPORT
// ====================================================
// ====================================================
//  SF1 IMPORT
// ===================================================

const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f) parseSF1(f);
});

function handleSF1File(inp) { if (inp.files[0]) parseSF1(inp.files[0]); }

function getCellVal(sheet, row, col) {
  const cell = sheet.getCell(row, col);
  if (!cell || cell.value === null || cell.value === undefined) return '';
  if (typeof cell.value === 'object' && cell.value.richText)
    return cell.value.richText.map(r => r.text).join('').trim();
  if (typeof cell.value === 'object' && cell.value.result !== undefined)
    return String(cell.value.result).trim();
  return String(cell.value).trim();
}

async function parseSF1(file) {
  toast('Parsing SF1 file...', 'info', 'fa-spinner');
  try {
    const buffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) { toast('No worksheet found in file', 'error', 'fa-exclamation'); return; }
    await processSF1Data(sheet, file.name);
  } catch (err) {
    console.error(err);
    toast('Failed to read file: ' + err.message, 'error', 'fa-exclamation');
  }
}

async function processSF1Data(sheet, filename) {
  // ── Fixed-cell metadata ──────────────────────────────
  const meta = {
    region:     getCellVal(sheet, 3,  11),  // K3
    division:   getCellVal(sheet, 3,  20),  // T3
    schoolName: getCellVal(sheet, 4,  6),   // F4
    schoolId:   getCellVal(sheet, 3,  6),   // F3
    schoolYear: getCellVal(sheet, 4,  20),  // T4
    gradeLevel: getCellVal(sheet, 4,  31),  // AE4
    section:    getCellVal(sheet, 4,  39),  // AM4
  };

  // ── Detect header row (look for "LAST NAME") ─────────
  let headerRow = -1;
  sheet.eachRow((row, rNum) => {
    if (headerRow >= 0) return;
    row.eachCell(cell => {
      if (String(cell.value || '').toUpperCase().includes('LAST NAME')) {
        headerRow = rNum;
      }
    });
  });

  if (headerRow < 0) {
    toast('Could not find learner table — check SF1 format', 'error', 'fa-exclamation');
    return;
  }

  const startRow = headerRow + 2; // data starts 2 rows after header
  const learners = [];
  let group = 'male'; // starts with male group

  sheet.eachRow((row, rNum) => {
    if (rNum < startRow) return;

    const rowText = String(row.getCell(1).value || '').toUpperCase()
                  + String(row.getCell(2).value || '').toUpperCase()
                  + String(row.getCell(3).value || '').toUpperCase();

    // Group switch sentinel
    if (rowText.includes('TOTAL MALE'))   { group = 'female'; return; }
    if (rowText.includes('TOTAL FEMALE')) { group = 'stop';   return; }
    if (group === 'stop') return;

    // ── Column mapping ───────────────────────────────────
    const lrn      = getCellVal(sheet, rNum, 1);   // A
    const fullname = getCellVal(sheet, rNum, 3);   // C
    const sex      = group === 'male' ? 'M' : 'F'; // derived from group
    const birthDate = getCellVal(sheet, rNum, 8);  // H
    const age      = getCellVal(sheet, rNum, 10);  // J
    const motherTongue = getCellVal(sheet, rNum, 12); // L
    const ip       = getCellVal(sheet, rNum, 14);  // N
    const religion = getCellVal(sheet, rNum, 15);  // O
    const purok    = getCellVal(sheet, rNum, 16);  // P
    const barangay = getCellVal(sheet, rNum, 18);  // R
    const city     = getCellVal(sheet, rNum, 21);  // U
    const province = getCellVal(sheet, rNum, 23);  // W
    const father   = getCellVal(sheet, rNum, 28);  // AB
    const mother   = getCellVal(sheet, rNum, 32);  // AF

    // Skip blank or header-like rows
    if (!fullname || fullname.length < 3) return;
    if (fullname.toUpperCase().includes('LAST NAME')) return;

    learners.push({
      lrn, fullname, sex,
      gradeLevel: meta.gradeLevel || '7',
      section:    meta.section    || 'Unknown',
      birthDate, age, motherTongue, ip, religion,
      purok, barangay, city, province, father, mother,
    });
  });

  if (!learners.length) {
    toast('No learners found — check SF1 format', 'error', 'fa-exclamation');
    return;
  }
  // ── Save to IndexedDB ─────────────────────────────────
  const sectionGroups = [...new Set(learners.map(l => l.gradeLevel + '|' + l.section))];
  for (const s of sectionGroups) {
    const [g, sec] = s.split('|');
    const exists = await db.sections.where({ gradeLevel: g, sectionName: sec }).first();
    if (!exists) await db.sections.add({ gradeLevel: g, sectionName: sec });
  }
  for (const l of learners) {
    const exists = l.lrn ? await db.learners.where({ lrn: l.lrn }).first() : null;
    if (!exists) await db.learners.add(l);
  }
  if (meta.schoolName) await db.schoolMeta.put({ key: 'schoolName', value: meta.schoolName });
  if (meta.schoolId)   await db.schoolMeta.put({ key: 'schoolId',   value: meta.schoolId });
  if (meta.schoolYear) await db.schoolMeta.put({ key: 'schoolYear', value: meta.schoolYear });
  if (meta.region)     await db.schoolMeta.put({ key: 'region',     value: meta.region });
  if (meta.division)   await db.schoolMeta.put({ key: 'division',   value: meta.division });
  window._schoolMeta = meta;

loadDashboardSchoolYear();
  loadAttendanceSchoolYear();
  loadGrades('dash-grade');
  loadGrades('att-grade');

  // ── Preview ───────────────────────────────────────────
  const previewEl = document.getElementById('import-preview');
  previewEl.style.display = 'block';
  previewEl.innerHTML = `
    <div class="card" style="background:var(--hover);">
      <div class="card-title" style="color:var(--success);">
        <i class="fa fa-check-circle"></i> Import Successful — ${filename}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;">
        ${Object.entries({
          School:           meta.schoolName || '—',
          ID:               meta.schoolId   || '—',
          'School Year':    meta.schoolYear || '—',
          Region:           meta.region     || '—',
          Division:         meta.division   || '—',
          'Grade Level':    meta.gradeLevel || '—',
          Section:          meta.section    || '—',
          'Learners Imported': learners.length,
        }).map(([k, v]) => `
          <div><div class="form-label">${k}</div>
               <div style="font-weight:700;font-size:14px;">${v}</div></div>`).join('')}
      </div>
      <table class="risk-table">
        <thead><tr><th>Section</th><th>Grade</th><th>Male</th><th>Female</th><th>Total</th></tr></thead>
        <tbody>${sectionGroups.map(s => {
          const [g, sec] = s.split('|');
          const ll = learners.filter(l => l.gradeLevel === g && l.section === sec);
          return `<tr>
            <td style="font-weight:600;">${sec}</td>
            <td>Grade ${g}</td>
            <td>${ll.filter(l => l.sex === 'M').length}</td>
            <td>${ll.filter(l => l.sex === 'F').length}</td>
            <td style="font-weight:700;">${ll.length}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;

  toast(`Imported ${learners.length} learners from ${sectionGroups.length} section(s)`, 'success', 'fa-file-import');
}


// ====================================================
//  SETTINGS
// ====================================================
async function saveSettings(){
  await db.settings.put({key:'themeSync',value:document.getElementById('tog-theme-sync').checked?'1':'0'});
  await db.settings.put({key:'kbd',value:document.getElementById('tog-kbd').checked?'1':'0'});
}
async function loadSettings(){
  const sync=await db.settings.get('themeSync');
  const kbd=await db.settings.get('kbd');
  if(sync)document.getElementById('tog-theme-sync').checked=sync.value==='1';
  if(kbd)document.getElementById('tog-kbd').checked=kbd.value!=='0';
}
async function loadSysInfo(){
  const lcount=await db.learners.count();
  const acount=await db.attendance.count();
  const scount=await db.sections.count();
  document.getElementById('sys-info').innerHTML=`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <div>📚 Total Learners: <strong>${lcount}</strong></div>
      <div>📊 Attendance Records: <strong>${acount}</strong></div>
      <div>🏫 Sections: <strong>${scount}</strong></div>
      <div>🗓 Current Theme: <strong>${currentTheme}</strong></div>
      <div>💾 Storage: <strong>IndexedDB (Dexie)</strong></div>
      <div>🌐 Mode: <strong>Offline-First PWA</strong></div>
      <div>🔢 DB Version: <strong>2</strong></div>
      <div>📅 Version: <strong>TEACHPLUS v3.0</strong></div>
    </div>`;
}
async function clearAllData(){
  if(!confirm('Clear ALL data? This cannot be undone!'))return;
  await db.learners.clear();await db.attendance.clear();await db.sections.clear();
  await db.interventions.clear();await db.schoolMeta.clear();
  toast('All data cleared','info','fa-trash');
  loadLearners();
}
async function populateSampleData(){
  const grade='7';const section='Sampaguita';
  const exists=await db.sections.where({gradeLevel:grade,sectionName:section}).first();
  if(!exists)await db.sections.add({gradeLevel:grade,sectionName:section});
  const names=['Reyes, Maria A.','Santos, Juan B.','Cruz, Ana C.','Lopez, Pedro D.','Garcia, Rosa E.',
    'Mendoza, Jose F.','Torres, Lila G.','Flores, Marco H.','Rivera, Pia I.','Gomez, Leo J.'];
  for(const name of names){
    const ex=await db.learners.where({fullname:name,section}).first();
    if(!ex)await db.learners.add({lrn:'',fullname:name,sex:Math.random()>.5?'M':'F',gradeLevel:grade,section});
  }
  const learners=await db.learners.where({gradeLevel:grade,section}).toArray();
  const today=new Date();
  const statuses=['present','present','present','absent','late','present','cutting','present','excused','present'];
  for(let d=1;d<=20;d++){
    const date=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if(isWeekend(today.getFullYear(),today.getMonth()+1,d))continue;
    for(const l of learners){
      const st=statuses[Math.floor(Math.random()*statuses.length)];
      const ex=await db.attendance.where({learnerId:l.id,date,section}).first();
      if(!ex)await db.attendance.add({learnerId:l.id,date,section,status:st,month:today.getMonth()+1});
    }
  }
  await db.schoolMeta.put({key:'schoolName',value:'Sample National High School'});
  await db.schoolMeta.put({key:'schoolId',value:'123456'});
  window._schoolMeta={schoolName:'Sample National High School',schoolId:'123456'};
  toast('Sample data loaded (Grade 7 — Sampaguita)','success','fa-database');
  loadGrades('att-grade');loadGrades('dash-grade');loadGrades('lr-grade');loadGrades('rpt-grade');loadGrades('int-grade');
}



/* ====================================================
   DASHBOARD HELPERS
==================================================== */

function loadDashboardSchoolYear() {
  const select = document.getElementById('dash-sy');
  if (!select) return;

  const sy = window._schoolMeta?.schoolYear;

  select.innerHTML = '';

  if (sy) {
    const option = document.createElement('option');
    option.value = sy;
    option.textContent = sy;
    option.selected = true;
    select.appendChild(option);
  } else {
    select.innerHTML = `<option>No School Year Found</option>`;
  }
}

function loadAttendanceSchoolYear() {
  const select = document.getElementById('att-sy');
  if (!select) return;

  const sy = window._schoolMeta?.schoolYear;

  select.innerHTML = '';

  if (sy) {
    const option = document.createElement('option');
    option.value = sy;
    option.textContent = sy;
    option.selected = true;
    select.appendChild(option);
  } else {
    select.innerHTML = `<option>No School Year Found</option>`;
  }
}

// ====================================================
//  KEYBOARD SHORTCUTS
// ====================================================
document.addEventListener('keydown',e=>{
  const tog=document.getElementById('tog-kbd');
  if(!tog||!tog.checked)return;
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT')return;
  const shortcuts={d:'dashboard',l:'learners',a:'attendance',r:'reports',c:'calendar',i:'interventions',s:'settings'};
  const k=e.key.toLowerCase();
  if(shortcuts[k]){const nav=document.querySelector(`[data-page="${shortcuts[k]}"]`);if(nav)showPage(shortcuts[k],nav);}
});

// ====================================================
//  RESPONSIVE
// ====================================================
function checkResponsive(){
  const btn=document.getElementById('mobile-menu-btn');
  if(window.innerWidth<768){btn.style.display='block';}
  else{btn.style.display='none';document.getElementById('sidebar').classList.remove('mobile-open');}
}
window.addEventListener('resize',checkResponsive);checkResponsive();


// ====================================================
//  INIT
// ====================================================

async function init(){
  await loadTheme();
  await loadSettings();

  const metas = await db.schoolMeta.toArray();
  window._schoolMeta = {};
  metas.forEach(m => window._schoolMeta[m.key] = m.value);

 
  loadDashboardSchoolYear();
	loadAttendanceSchoolYear();

  await loadGrades('dash-grade');
  await loadGrades('att-grade');
  await loadGrades('lr-grade');
  await loadGrades('rpt-grade');
  await loadGrades('int-grade');

  setCurrentMonth();
  renderCalendar();
  buildThemeGrid();
}
init();