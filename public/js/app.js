'use strict';
let currentFilter='all',currentVendor='',currentCarrier='',currentProject='',currentView='calendar',currentSort='desc',allShipments=[],allGroups=[],allProjects=[],pushSubscription=null,editingId=null,pendingVendor=null;

const DEFAULT_VENDORS=['ADI','Lutron','Savant','Sonance','Amazon','Ubiquiti','Snap AV','Snap One Partner Store','aspectLED','Super Bright LEDs','B&H Photo','My Cable Mart','FITUEYES','eBay'];
const VENDOR_KEYWORDS={'ADI':['adiglobal','adi global','adi order'],'Lutron':['lutron'],'Savant':['savant'],'Sonance':['sonance'],'Amazon':['amazon'],'Ubiquiti':['ubiquiti','ubnt','unifi','ubiquiti store'],'Snap AV':['snapav','snap av','snap-av'],'Snap One Partner Store':['snapone','snap one'],'aspectLED':['aspectled'],'Super Bright LEDs':['super bright leds','superbrightleds'],'B&H Photo':['bhphotovideo','b&h photo'],'My Cable Mart':['mycablemart','my cable mart'],'FITUEYES':['fitueyes'],'eBay':['ebay']};
const VENDOR_LOGOS={'ADI':'https://www.google.com/s2/favicons?domain=adiglobal.com&sz=32','Lutron':'https://www.google.com/s2/favicons?domain=lutron.com&sz=32','Savant':'https://www.google.com/s2/favicons?domain=savant.com&sz=32','Sonance':'https://www.google.com/s2/favicons?domain=sonance.com&sz=32','Amazon':'https://www.google.com/s2/favicons?domain=amazon.com&sz=32','Ubiquiti':'https://www.google.com/s2/favicons?domain=ui.com&sz=32','Snap AV':'https://www.google.com/s2/favicons?domain=snapav.com&sz=32','Snap One Partner Store':'https://www.google.com/s2/favicons?domain=snapone.com&sz=32','aspectLED':'https://www.google.com/s2/favicons?domain=aspectled.com&sz=32','Super Bright LEDs':'https://www.google.com/s2/favicons?domain=superbrightleds.com&sz=32','B&H Photo':'https://www.google.com/s2/favicons?domain=bhphotovideo.com&sz=32','My Cable Mart':'https://www.google.com/s2/favicons?domain=mycablemart.com&sz=32','FITUEYES':'https://www.google.com/s2/favicons?domain=fitueyes.com&sz=32','eBay':'https://www.google.com/s2/favicons?domain=ebay.com&sz=32'};
const CARRIER_LOGOS={ups:'https://www.google.com/s2/favicons?domain=ups.com&sz=32',fedex:'https://www.google.com/s2/favicons?domain=fedex.com&sz=32',usps:'https://www.google.com/s2/favicons?domain=usps.com&sz=32',amazon:'https://www.google.com/s2/favicons?domain=amazon.com&sz=32',dhl:'https://www.google.com/s2/favicons?domain=dhl.com&sz=32'};

function getVendors(){try{const v=localStorage.getItem('vendors');return v?JSON.parse(v):[...DEFAULT_VENDORS];}catch(e){return[...DEFAULT_VENDORS];}}
function saveVendors(list){localStorage.setItem('vendors',JSON.stringify(list));}
function toTitle(s){if(!s)return "";return s.toLowerCase().replace(/\b\w/g,function(c){return c.toUpperCase();});}

function detectVendor(s){
  const h=[s.sender||'',s.description||'',s.account_email||'',s.shipper||''].join(' ').toLowerCase();
  for(const v of getVendors()){const kw=VENDOR_KEYWORDS[v]||[v.toLowerCase()];if(kw.some(k=>h.includes(k)))return v;}
  return null;
}

function checkNewVendor(s){
  if(s._vendor)return;
  const shipper=s.shipper||'';
  if(!shipper||shipper.length<3)return;
  const ignored=JSON.parse(localStorage.getItem('ignored_vendors')||'[]');
  if(ignored.includes(shipper))return;
  pendingVendor=shipper;
  document.getElementById('vendor-toast-body').textContent='Found "'+shipper+'" - would you like to add it as a vendor?';
  document.getElementById('vendor-toast').style.display='block';
}

function addVendorFromToast(){
  if(!pendingVendor)return;
  const vendors=getVendors();
  if(!vendors.includes(pendingVendor)){vendors.push(pendingVendor);saveVendors(vendors);}
  document.getElementById('vendor-toast').style.display='none';
  buildVendorSidebar();
  allShipments.forEach(s=>{s._vendor=detectVendor(s);});
  allGroups=groupShipments(allShipments);
  updateVendorCounts();
  applyFilters();
  showToast('Added '+pendingVendor+' as vendor');
  pendingVendor=null;
}

function dismissVendorToast(){
  const ignored=JSON.parse(localStorage.getItem('ignored_vendors')||'[]');
  if(pendingVendor&&!ignored.includes(pendingVendor)){ignored.push(pendingVendor);localStorage.setItem('ignored_vendors',JSON.stringify(ignored));}
  document.getElementById('vendor-toast').style.display='none';
  pendingVendor=null;
}

function buildTrackingUrl(carrier,t,description,sender){const c=(carrier||'').toLowerCase(),tr=(t||'').trim(),s=(sender||'').toLowerCase(),d=(description||'').toLowerCase();if(c==='ups'||s.includes('ups')){if(tr)return'https://www.ups.com/track?tracknum='+tr;}if(c==='fedex'||s.includes('fedex')){if(tr)return'https://www.fedex.com/fedextrack/?trknbr='+tr;}if(c==='usps'||s.includes('usps')){if(tr)return'https://tools.usps.com/go/TrackConfirmAction?tLabels='+tr;}if(c==='amazon'||s.includes('amazon')){const om=d.match(/#?(\d{3}-\d{7}-\d{7})/);if(om)return'https://www.amazon.com/gp/your-account/order-details?orderID='+om[1];return'https://www.amazon.com/gp/your-account/order-history';}if(c==='dhl'){if(tr)return'https://www.dhl.com/us-en/home/tracking.html?tracking-id='+tr;}if(tr){if(/^1Z/i.test(tr))return'https://www.ups.com/track?tracknum='+tr;if(/^\d{12,15}$/.test(tr))return'https://www.fedex.com/fedextrack/?trknbr='+tr;if(/^(9[2-5]|\d{20,22})/.test(tr))return'https://tools.usps.com/go/TrackConfirmAction?tLabels='+tr;}return null;}

function parseETA(eta){if(!eta)return null;let m;m=eta.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(m)return new Date(+m[3],+m[1]-1,+m[2]);m=eta.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s,]+(\d{1,2}),?\s*(\d{4})?/i);if(m){const yr=m[3]||new Date().getFullYear();return new Date(m[1]+' '+m[2]+' '+yr);}m=eta.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i);if(m)return new Date(m[1]+' '+m[2]+' '+new Date().getFullYear());return null;}

function chipHTML(carrier,vendor){const c=(carrier||'').toLowerCase();const label={ups:'UPS',fedex:'FedEx',usps:'USPS',amazon:'AMZN',dhl:'DHL'}[c]||(vendor?vendor.substring(0,5):(carrier||'?'));const cls='carrier-chip '+((['ups','fedex','usps','amazon','dhl'].includes(c))?c:'other');const logo=CARRIER_LOGOS[c]||(vendor&&VENDOR_LOGOS[vendor])||null;if(logo)return '<div class="'+cls+'"><img src="'+logo+'" width="22" height="22" alt="'+esc(label)+'" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'inline\'"><span style="display:none;font-size:9px;font-weight:700;">'+esc(label)+'</span></div>';return '<div class="'+cls+'" style="font-size:9px;font-weight:700;">'+esc(label)+'</div>';}

function groupShipments(shipments){const groups={};const priority={delivered:4,transit:3,shipped:2,pending:1};shipments.forEach(s=>{let key;if(s.order_number)key=s.account_email+'|ord|'+s.order_number.toLowerCase().trim();else if(s.tracking_number)key=s.account_email+'|trk|'+s.tracking_number.toLowerCase().replace(/\s+/g,'');else key=s.account_email+'|thread|'+s.thread_id;if(!groups[key]){groups[key]={key,shipments:[],best:s};}groups[key].shipments.push(s);if((priority[s.status]||0)>(priority[groups[key].best.status]||0))groups[key].best=s;});return Object.values(groups);}

function getGroupProject(g){const s=g.best;if(s.project_id)return s.project_id;if(s.po_number){const proj=allProjects.find(p=>p.name.toLowerCase()===s.po_number.toLowerCase().trim());if(proj)return proj.id;}return null;}

document.addEventListener('DOMContentLoaded',async()=>{buildVendorSidebar();await loadAll();registerServiceWorker();handleURLParams();});
async function loadAll(){await Promise.all([loadStats(),loadAccounts(),loadShipments(),loadProjects()]);}
function handleURLParams(){const p=new URLSearchParams(location.search);if(p.get('connected'))showToast('Connected '+p.get('connected'));if(p.get('error'))showToast(p.get('error'),true);if(p.has('connected')||p.has('error'))history.replaceState({},'','/');}

async function loadStats(){try{const s=await api('/api/stats');document.getElementById('stat-total').textContent=s.total||0;document.getElementById('stat-transit').textContent=(s.in_transit||0)+(s.shipped||0);document.getElementById('stat-delivered').textContent=s.delivered||0;document.getElementById('count-all').textContent=s.total||0;document.getElementById('count-pending').textContent=s.pending||0;document.getElementById('count-transit').textContent=s.in_transit||0;document.getElementById('count-shipped').textContent=s.shipped||0;document.getElementById('count-delivered').textContent=s.delivered||0;document.getElementById('count-received').textContent=s.received||0;}catch(e){console.error(e);}}

async function loadAccounts(){try{const accounts=await api('/api/accounts');document.getElementById('accounts-list').innerHTML=accounts.map(a=>'<div class="account-chip"><span class="dot"></span><span class="email" title="'+esc(a.email)+'">'+esc(a.email)+'</span><button class="remove" onclick="disconnectAccount(\''+esc(a.email)+'\')">x</button></div>').join('');const latest=accounts.reduce((m,a)=>Math.max(m,a.last_scanned||0),0);document.getElementById('last-scan').textContent=latest?'Last scan: '+timeAgo(latest):'';}catch(e){console.error(e);}}
async function disconnectAccount(email){if(!confirm('Disconnect '+email+'?'))return;await api('/auth/disconnect',{method:'POST',body:{email}});showToast('Disconnected '+email);await loadAll();}

async function loadShipments(retryCount=0){try{allShipments=await api('/api/shipments');
  // Auto-retry up to 3 times if we get 0 shipments but have connected accounts
  if(allShipments.length===0&&retryCount<3){
    const accounts=await api('/api/accounts');
    if(accounts.length>0){
      setTimeout(()=>loadShipments(retryCount+1),2000);
      return;
    }
  }allShipments.forEach(s=>{s._vendor=detectVendor(s);});allGroups=groupShipments(allShipments);updateVendorCounts();populateCarrierFilter();applyFilters();// Check for new vendors
const unknownShippers=allShipments.filter(s=>!s._vendor&&s.shipper&&s.shipper.length>2);if(unknownShippers.length>0)setTimeout(()=>checkNewVendor(unknownShippers[0]),2000);}catch(e){console.error(e);}}

async function loadProjects(){
  try{
    var result=await api('/api/projects/auto-create',{method:'POST',body:{}});
    allProjects=await api('/api/projects');
    buildProjectSidebar();
    populateProjectDropdown();
    if(result.pending&&result.pending.length>0){
      setTimeout(function(){showPendingProject(result.pending,0);},1000);
    }
  }catch(e){console.error(e);}
}

var _pendingPOs=[];
var _pendingIdx=0;

function showPendingProject(pending,idx){
  _pendingPOs=pending;_pendingIdx=idx;
  if(idx>=pending.length)return;
  var po=pending[idx];
  var existing=document.querySelector('.pending-project-toast');
  if(existing)existing.remove();
  var opts=allProjects.map(function(p){return'<option value="'+p.id+'">'+esc(toTitle(p.name))+'</option>';}).join('');
  var toast=document.createElement('div');
  toast.className='pending-project-toast';
  toast.dataset.po=po;
  toast.dataset.idx=idx;
  toast.innerHTML='<div class="ppt-title">New project found</div>'+
    '<div class="ppt-body">PO <strong>'+esc(po)+'</strong> detected. What would you like to do?</div>'+
    '<div class="ppt-select"><select class="ppt-sel"><option value="">-- Assign to existing project --</option>'+opts+'</select></div>'+
    '<div class="ppt-actions">'+
      '<button class="ppt-btn-ignore">Ignore forever</button>'+
      '<button class="ppt-btn-assign">Assign to existing</button>'+
      '<button class="ppt-btn-add">Add as new</button>'+
    '</div>';
  toast.querySelector('.ppt-btn-ignore').addEventListener('click',function(){ignorePendingPO(po,toast);});
  toast.querySelector('.ppt-btn-assign').addEventListener('click',function(){assignPendingPO(po,toast);});
  toast.querySelector('.ppt-btn-add').addEventListener('click',function(){addPendingPO(po,toast);});
  document.body.appendChild(toast);
}

function nextPendingPO(){
  var next=_pendingIdx+1;
  if(next<_pendingPOs.length)setTimeout(function(){showPendingProject(_pendingPOs,next);},500);
}

async function addPendingPO(po,toast){
  try{
    await api('/api/projects',{method:'POST',body:{name:po}});
    toast.remove();await loadProjects();applyFilters();
    showToast('Project added: '+po);nextPendingPO();
  }catch(e){showToast('Failed',true);}
}

async function ignorePendingPO(po,toast){
  try{
    await api('/api/projects/ignore-po',{method:'POST',body:{po}});
    toast.remove();showToast('Ignored: '+po);nextPendingPO();
  }catch(e){showToast('Failed',true);}
}

async function assignPendingPO(po,toast){
  var sel=toast.querySelector('.ppt-sel');
  var projectId=sel?sel.value:'';
  if(!projectId){showToast('Please select a project first',true);return;}
  try{
    var matching=allShipments.filter(function(s){return s.po_number&&s.po_number.toLowerCase().trim()===po.toLowerCase().trim();});
    await Promise.all(matching.map(function(s){return api('/api/shipments/'+s.id+'/assign',{method:'POST',body:{project_id:projectId}});}));
    await api('/api/projects/ignore-po',{method:'POST',body:{po}});
    toast.remove();await loadProjects();applyFilters();
    showToast('Assigned '+matching.length+' shipments');nextPendingPO();
  }catch(e){showToast('Failed',true);}
}

// ── Section collapse ──────────────────────────────────────────────────────────
function toggleSection(id){const el=document.getElementById(id);const isCollapsed=el.classList.toggle('collapsed');const toggle=document.getElementById(id.replace('-section','-toggle'));if(toggle)toggle.textContent=isCollapsed?'▸':'▾';}

// ── Search ────────────────────────────────────────────────────────────────────
function getSearchQuery(){return(document.getElementById('search-input').value||'').toLowerCase().trim();}

// ── Filtering ─────────────────────────────────────────────────────────────────
function getFilteredGroups(){
  const q=getSearchQuery();
  let groups=[...allGroups];
  if(currentFilter==='received')groups=groups.filter(g=>g.best.received);
  else if(currentFilter!=='all')groups=groups.filter(g=>g.best.status===currentFilter);
  if(currentVendor)groups=groups.filter(g=>g.best._vendor===currentVendor);
  if(currentCarrier)groups=groups.filter(g=>g.best.carrier===currentCarrier);
  if(currentProject)groups=groups.filter(g=>getGroupProject(g)===currentProject);
  if(q)groups=groups.filter(g=>{const s=g.best;return[s.description,s.shipper,s.tracking_number,s.po_number,s.order_number,s.ship_to,s.carrier,s._vendor].some(v=>(v||'').toLowerCase().includes(q));});
  return groups;
}

function applyFilters(){const groups=getFilteredGroups();if(currentView==='calendar')renderCalendar(groups);else if(currentView==='list')renderList(groups);else renderProjectsView();}

// ── Calendar ──────────────────────────────────────────────────────────────────
function renderCalendar(groups){
  const content=document.getElementById('main-content');
  if(!groups.length){content.innerHTML=emptyHTML();return;}
  const months={};const today=new Date();today.setHours(0,0,0,0);
  groups.forEach(function(g){
    var etaDate=parseETA(g.best.eta);var emailDate=g.best.email_date?new Date(g.best.email_date*1000):null;var d=etaDate||emailDate;if(!d)return;
    var mk=d.getFullYear()+'-'+(d.getMonth()+1).toString().padStart(2,'0');var dk=d.toDateString();
    if(!months[mk])months[mk]={label:d.toLocaleDateString('en-US',{month:'long',year:'numeric'}),days:{}};
    if(!months[mk].days[dk])months[mk].days[dk]={date:new Date(d),groups:[]};
    months[mk].days[dk].groups.push(g);
  });
  var sortedMonths=Object.keys(months).sort(currentSort==='asc'?function(a,b){return a.localeCompare(b);}:function(a,b){return b.localeCompare(a);});
  var html='';
  for(var mi=0;mi<sortedMonths.length;mi++){
    var mk=sortedMonths[mi];var month=months[mk];html+='<div class="calendar-month"><div class="calendar-month-title">'+esc(month.label)+'</div>';
    var sortedDays=Object.keys(month.days).sort(function(a,b){var diff=month.days[a].date-month.days[b].date;return currentSort==='asc'?diff:-diff;});
    for(var di=0;di<sortedDays.length;di++){
      var dk=sortedDays[di];var day=month.days[dk];var d2=new Date(day.date);d2.setHours(0,0,0,0);var isToday=d2.getTime()===today.getTime();
      var weekday=day.date.toLocaleDateString('en-US',{weekday:'short'}).toUpperCase();var daynum=day.date.getDate();
      html+='<div class="calendar-day"><div class="calendar-day-label'+(isToday?' today-label':'')+'"><span class="cal-weekday">'+weekday+'</span><span class="cal-daynum'+(isToday?' today-num':'')+'">'+daynum+'</span></div><div class="calendar-day-cards">';
      for(var gi=0;gi<day.groups.length;gi++){html+=cardHTML(day.groups[gi]);}
      html+='</div></div>';
    }
    html+='</div>';
  }
  content.innerHTML=html;
}

// ── List ──────────────────────────────────────────────────────────────────────
function renderList(groups){const content=document.getElementById('main-content');if(!groups.length){content.innerHTML=emptyHTML();return;}const sorted=[...groups].sort((a,b)=>currentSort==='asc'?(a.best.email_date||0)-(b.best.email_date||0):(b.best.email_date||0)-(a.best.email_date||0));content.innerHTML='<div class="list-view">'+sorted.map(cardHTML).join('')+'</div>';}

// ── Projects view ─────────────────────────────────────────────────────────────
function renderProjectsView(){
  const content=document.getElementById('main-content');
  const projects=currentProject?allProjects.filter(p=>p.id===currentProject):allProjects;
  if(!projects.length){content.innerHTML='<div class="projects-grid"><div class="empty-state"><div class="empty-icon">&#128203;</div><p>No projects yet</p><button class="connect-btn-large" onclick="showAddProject()" style="border:none;cursor:pointer;margin-top:8px;">+ Add project</button></div></div>';return;}
  const html='<div class="projects-grid">'+projects.sort((a,b)=>a.name.localeCompare(b.name)).map(p=>{
    const pGroups=allGroups.filter(g=>getGroupProject(g)===p.id);
    const total=pGroups.length,delivered=pGroups.filter(g=>g.best.status==='delivered'||g.best.received).length;
    const transit=pGroups.filter(g=>g.best.status==='transit').length,shipped=pGroups.filter(g=>g.best.status==='shipped').length;
    const pct=total?Math.round(delivered/total*100):0;
    const filtered=currentFilter==='all'?pGroups:pGroups.filter(g=>currentFilter==='received'?g.best.received:g.best.status===currentFilter);
    return'<div class="project-card">'+
      '<div class="project-header" onclick="toggleProjectCard(\'proj-'+p.id+'\')">'+
        '<div><div class="project-name">'+esc(toTitle(p.name))+'</div><div class="project-meta">'+total+' shipment'+(total!==1?'s':'')+' &middot; '+pct+'% delivered</div></div>'+
        '<div class="project-stats">'+
          (transit?'<span class="project-stat transit">'+transit+' in transit</span>':'')+
          (shipped?'<span class="project-stat shipped">'+shipped+' shipped</span>':'')+
          (delivered?'<span class="project-stat delivered">'+delivered+' delivered</span>':'')+
          '<button class="project-rename-btn" onclick="event.stopPropagation();renameProject(\''+p.id+'\',\''+esc(p.name)+'\')" title="Rename">&#9998;</button><button class="project-delete-btn" onclick="event.stopPropagation();deleteProjectEl(this)" data-pid="'+p.id+'" data-pname="'+esc(p.name)+'">x</button>'+
        '</div>'+
      '</div>'+
      '<div class="project-progress"><div class="project-progress-fill" style="width:'+pct+'%"></div></div>'+
      '<div id="proj-'+p.id+'" class="project-shipments">'+
        (filtered.length?filtered.map(cardHTML).join(''):'<div class="project-empty">No shipments match current filter</div>')+
      '</div></div>';
  }).join('')+'</div>';
  content.innerHTML=html;
}
function toggleProjectCard(id){const el=document.getElementById(id);if(el)el.style.display=el.style.display==='none'?'flex':'none';}

// ── Card ──────────────────────────────────────────────────────────────────────
function cardHTML(g){
  const s=g.best;
  const priority={delivered:4,transit:3,shipped:2,pending:1};
  const statusNames={delivered:'Delivered',transit:'In transit',shipped:'Shipped',pending:'Pending'};
  const uniqueStatuses=[...new Set(g.shipments.map(x=>x.status).sort((a,b)=>(priority[a]||0)-(priority[b]||0)))];
  const timelineHTML=uniqueStatuses.length>1?'<div class="status-timeline">'+uniqueStatuses.map((st,i)=>{const isLast=i===uniqueStatuses.length-1;return'<span class="tl-step '+(isLast?st:'done')+'">'+statusNames[st]+'</span>'+(i<uniqueStatuses.length-1?'<span class="tl-arrow"> > </span>':'');}).join('')+'</div>':'';
  const tu=buildTrackingUrl(s.carrier,s.tracking_number,s.description,s.sender);
  const tb=tu?'<a class="track-btn" href="'+esc(tu)+'" target="_blank" rel="noopener">Track</a>':'';
  const isReceived=!!s.received;
  const receivedBtn=!isReceived?'<button class="receive-btn" onclick="markReceived('+s.id+')">Mark received</button>':'';
  const statusLabel=isReceived?'Received':statusNames[s.status]||s.status;
  const statusClass=isReceived?'received':s.status;
  const cardClass='card status-'+s.status+(isReceived?' received-card':'');
  const projId=getGroupProject(g);const proj=projId?allProjects.find(p=>p.id===projId):null;
  const tags=[];
  if(s.ship_to)tags.push('<span class="dtag shipto-tag">To: '+esc(s.ship_to)+'</span>');
  if(proj)tags.push('<span class="dtag project-tag">'+esc(toTitle(proj.name))+'</span>');
  if(s.shipper)tags.push('<span class="dtag shipper-tag">'+esc(s.shipper)+'</span>');
  if(s._vendor)tags.push('<span class="dtag vendor-tag">'+esc(s._vendor)+'</span>');
  if(s.po_number)tags.push('<span class="dtag po-tag">PO: '+esc(s.po_number)+'</span>');
  if(s.order_number)tags.push('<span class="dtag order-tag">Order: '+esc(s.order_number)+'</span>');
  if(s.tracking_number)tags.push('<span class="dtag tracking-tag">'+esc(s.tracking_number)+'</span>');
  const cleanEta=s.eta?(s.eta.replace(/removed.*/i,'').replace(/track\s*yo.*/i,'').trim()):'';
  if(cleanEta&&s.status!=='delivered')tags.push('<span class="dtag eta-tag">ETA: '+esc(cleanEta)+'</span>');
  if(s.email_date)tags.push('<span class="dtag date-tag">Email: '+formatDate(s.email_date)+'</span>');
  return'<div class="'+cardClass+'">'+chipHTML(s.carrier,s._vendor)+
    '<div class="card-body">'+
      '<div class="card-desc">'+(s.thread_id?'<a class="card-desc-link" href="https://mail.google.com/mail/u/'+(s.account_email&&s.account_email.includes('mjfllc')?'1':'0')+'/#all/'+s.thread_id+'" target="_blank" title="View in Gmail">'+esc(s.description)+'</a>':esc(s.description))+'</div>'+
      (tags.length?'<div class="card-tags">'+tags.join('')+'</div>':'')+
      timelineHTML+
    '</div>'+
    '<div class="card-right">'+
      '<span class="status-pill '+statusClass+'">'+statusLabel+'</span>'+
      '<div class="card-actions">'+tb+receivedBtn+
        '<button class="edit-btn" onclick="openEditModal('+s.id+')">Edit</button>'+
        '<button class="delete-btn" onclick="deleteShipment('+s.id+')">x</button>'+
      '</div>'+
    '</div>'+
  '</div>';
}

function emptyHTML(){return'<div class="empty-state"><div class="empty-icon">&#128237;</div><p>No packages found</p>'+(currentFilter==='all'&&!currentVendor&&!currentCarrier&&!currentProject&&!getSearchQuery()?'<a href="/auth/connect" class="connect-btn-large">Add email account</a>':'')+'</div>';}

// ── Actions ───────────────────────────────────────────────────────────────────
async function deleteShipment(id){if(!confirm('Remove this shipment?'))return;try{await api('/api/shipments/'+id,{method:'DELETE'});allShipments=allShipments.filter(s=>s.id!==id);allGroups=groupShipments(allShipments);applyFilters();loadStats();showToast('Removed');}catch(e){showToast('Failed',true);}}

async function markReceived(id){try{await api('/api/shipments/'+id+'/receive',{method:'POST',body:{}});const group=allGroups.find(g=>g.shipments.some(s=>s.id===id));if(group){group.shipments.forEach(s=>{s.received=true;const idx=allShipments.findIndex(x=>x.id===s.id);if(idx>=0)allShipments[idx].received=true;});group.best.received=true;}allGroups=groupShipments(allShipments);applyFilters();const receivedCount=allShipments.filter(s=>s.received).length;document.getElementById('count-received').textContent=receivedCount;showToast('Marked as received!');}catch(e){showToast('Failed',true);}}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function buildVendorSidebar(){const vendors=getVendors().slice().sort((a,b)=>a.localeCompare(b));const nav=document.getElementById('vendor-filters');nav.innerHTML='<button class="filter-item active-vendor" onclick="setVendor(\'\',this)"><span class="filter-dot vendor"></span>All vendors<span class="filter-count" id="vcount-all">-</span></button>'+vendors.map(v=>'<button class="filter-item" onclick="setVendor(\''+esc(v)+'\',this)"><span class="filter-dot vendor"></span>'+esc(v)+'<span class="filter-count" id="vcount-'+v.replace(/[\s&]/g,'_')+'">-</span></button>').join('');}
function updateVendorCounts(){const vendors=getVendors();document.getElementById('vcount-all').textContent=allGroups.length;vendors.forEach(v=>{const count=allGroups.filter(g=>g.best._vendor===v).length;const el=document.getElementById('vcount-'+v.replace(/[\s&]/g,'_'));if(el)el.textContent=count||'0';});}

function buildProjectSidebar(){
  var nav=document.getElementById('project-filters');
  if(!nav)return;
  var html='<button class="filter-item active-project" onclick="setProject(\'\',this)">';
  html+='<span class="filter-dot" style="background:#0078d4"></span>';
  html+='All projects<span class="filter-count">'+allProjects.length+'</span></button>';
  var sorted=allProjects.slice().sort(function(a,b){return a.name.localeCompare(b.name);});
  sorted.forEach(function(p){
    var count=allGroups.filter(function(g){return getGroupProject(g)===p.id;}).length;
    html+='<button class="filter-item" onclick="setProject(\''+p.id+'\',this)">';
    html+='<span class="filter-dot" style="background:#0078d4"></span>';
    html+=esc(toTitle(p.name));
    html+='<span class="filter-count">'+count+'</span>';
    html+='</button>';
  });
  nav.innerHTML=html;
}

function populateCarrierFilter(){const nav=document.getElementById('carrier-filters');if(!nav)return;const carriers=[...new Set(allShipments.map(s=>s.carrier))].sort();nav.innerHTML='<button class="filter-item active-carrier" onclick="setCarrier(\'\',this)"><span class="filter-dot" style="background:#0078d4"></span>All carriers<span class="filter-count">'+allGroups.length+'</span></button>'+carriers.map(c=>{const count=allGroups.filter(g=>g.best.carrier===c).length;return'<button class="filter-item" onclick="setCarrier(\''+esc(c)+'\',this)">'+chipHTML(c)+'<span style="margin-left:4px;">'+esc(c)+'</span><span class="filter-count">'+count+'</span></button>';}).join('');}

function populateProjectDropdown(){const sel=document.getElementById('edit-project');if(!sel)return;sel.innerHTML='<option value="">No project</option>'+allProjects.sort((a,b)=>a.name.localeCompare(b.name)).map(p=>'<option value="'+p.id+'">'+esc(toTitle(p.name))+'</option>').join('');}

// ── Controls ──────────────────────────────────────────────────────────────────
function setCarrier(c,btn){currentCarrier=c;document.querySelectorAll('#carrier-filters .filter-item').forEach(b=>b.classList.remove('active-carrier'));btn.classList.add('active-carrier');applyFilters();}
function setVendor(v,btn){currentVendor=v;document.querySelectorAll('#vendor-filters .filter-item').forEach(b=>b.classList.remove('active-vendor'));btn.classList.add('active-vendor');applyFilters();}
function setProjectById(id,btn){setProject(id,btn);}
function setProject(p,btn){currentProject=p;document.querySelectorAll('#project-filters .filter-item').forEach(b=>b.classList.remove('active-project'));btn.classList.add('active-project');if(currentView==='projects')renderProjectsView();else applyFilters();}
function setView(view,btn){currentView=view;document.querySelectorAll('.view-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');document.getElementById('page-title').textContent=view==='projects'?'Projects':'All packages';applyFilters();}
function setSort(s,btn){currentSort=s;document.querySelectorAll('.sort-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');applyFilters();}
function setFilter(f,btn){currentFilter=f;document.querySelectorAll('.filter-item[data-filter]').forEach(b=>b.classList.remove('active'));btn.classList.add('active');const titles={all:'All packages',pending:'Pending',transit:'In transit',shipped:'Shipped',delivered:'Delivered',received:'Received'};document.getElementById('page-title').textContent=titles[f]||'Packages';applyFilters();}

function showAddVendor(){document.getElementById('add-vendor-form').style.display='block';document.getElementById('new-vendor-input').focus();}
function cancelAddVendor(){document.getElementById('add-vendor-form').style.display='none';document.getElementById('new-vendor-input').value='';}
function saveNewVendor(){const name=document.getElementById('new-vendor-input').value.trim();if(!name)return;const vendors=getVendors();if(!vendors.includes(name)){vendors.push(name);saveVendors(vendors);}cancelAddVendor();buildVendorSidebar();allShipments.forEach(s=>{s._vendor=detectVendor(s);});allGroups=groupShipments(allShipments);updateVendorCounts();showToast('Added '+name);}

function showAddProject(){document.getElementById('add-project-form').style.display='block';document.getElementById('new-project-input').focus();}
function cancelAddProject(){document.getElementById('add-project-form').style.display='none';document.getElementById('new-project-input').value='';}
async function saveNewProject(){const name=document.getElementById('new-project-input').value.trim();if(!name)return;await api('/api/projects',{method:'POST',body:{name}});cancelAddProject();await loadProjects();showToast('Project added: '+name);}
async function renameProject(id, currentName) {
  const newName = prompt('Rename project:', currentName);
  if (!newName || newName.trim() === currentName) return;
  try {
    await api('/api/projects/' + encodeURIComponent(id), {method:'PATCH', body:{name:newName.trim()}});
    await loadProjects();
    applyFilters();
    showToast('Project renamed');
  } catch(e) { showToast('Rename failed', true); }
}
function deleteProjectEl(btn){deleteProject(btn.dataset.pid,btn.dataset.pname);}
async function deleteProject(id,name){if(!confirm('Delete project "'+name+'"?'))return;try{const res=await fetch('/api/projects/'+encodeURIComponent(id),{method:'DELETE'});if(!res.ok)throw new Error('HTTP '+res.status);await loadProjects();showToast('Project deleted');}catch(e){console.error('Delete failed:',e);showToast('Delete failed: '+e.message,true);}}

// ── Edit modal ────────────────────────────────────────────────────────────────
function openEditModal(id){const s=allShipments.find(s=>s.id===id);if(!s)return;editingId=id;document.getElementById('edit-desc').value=s.description||'';document.getElementById('edit-tracking').value=s.tracking_number||'';document.getElementById('edit-po').value=s.po_number||'';document.getElementById('edit-order').value=s.order_number||'';document.getElementById('edit-shipto').value=s.ship_to||'';const sel=document.getElementById('edit-project');if(sel){populateProjectDropdown();const grp=allGroups.find(g=>g.shipments.some(x=>x.id===id));sel.value=grp?getGroupProject(grp)||'':""; }const statusSel=document.getElementById('edit-status');if(statusSel){statusSel.value=s.received?'received':s.status||'';}document.getElementById('edit-modal').style.display='flex';}
function closeEditModal(e){if(e&&e.target!==document.getElementById('edit-modal'))return;document.getElementById('edit-modal').style.display='none';editingId=null;}
async function saveEdit(){if(!editingId)return;const tracking_number=document.getElementById('edit-tracking').value.trim();const po_number=document.getElementById('edit-po').value.trim();const order_number=document.getElementById('edit-order').value.trim();const description=document.getElementById('edit-desc').value.trim();const ship_to=document.getElementById('edit-shipto').value.trim();const project_id=document.getElementById('edit-project').value||null;const statusVal=document.getElementById('edit-status').value;const body={tracking_number,po_number,order_number,description,ship_to};if(statusVal==='received'){body.received=true;}else if(statusVal==='unreceive'){body.received=false;}else if(statusVal){body.status=statusVal;body.received=false;}try{const updated=await api('/api/shipments/'+editingId,{method:'PATCH',body});if(project_id!==undefined)await api('/api/shipments/'+editingId+'/assign',{method:'POST',body:{project_id}});const idx=allShipments.findIndex(s=>s.id===editingId);if(idx>=0){allShipments[idx]={...allShipments[idx],...updated,_vendor:allShipments[idx]._vendor,project_id};}allGroups=groupShipments(allShipments);document.getElementById('edit-modal').style.display='none';editingId=null;await loadProjects();applyFilters();await loadStats();showToast('Shipment updated');}catch(e){showToast('Save failed',true);}}

// ── Notifications / scan ──────────────────────────────────────────────────────
async function triggerScan(){const btn=document.getElementById('scan-btn');btn.classList.add('scanning');showToast('Scanning your inboxes...');try{await api('/api/scan',{method:'POST'});// Poll for updates every 5 seconds for 60 seconds
let polls=0;const poll=setInterval(async()=>{polls++;await loadAll();if(polls>=12){clearInterval(poll);btn.classList.remove('scanning');showToast('Scan complete');}},5000);}catch(e){btn.classList.remove('scanning');showToast('Scan failed',true);}}
async function registerServiceWorker(){if(!('serviceWorker'in navigator)||!('PushManager'in window))return;try{const reg=await navigator.serviceWorker.register('/sw.js');const existing=await reg.pushManager.getSubscription();if(existing){pushSubscription=existing;updateNotifyButton(true);}}catch(e){}}
async function toggleNotifications(){if(!('serviceWorker'in navigator)){showToast('Push not supported',true);return;}if(pushSubscription){await pushSubscription.unsubscribe();await api('/api/push/unsubscribe',{method:'POST',body:{endpoint:pushSubscription.endpoint}});pushSubscription=null;updateNotifyButton(false);showToast('Notifications disabled');return;}try{const{key}=await api('/api/vapid-public-key');if(!key){showToast('Push not configured',true);return;}const perm=await Notification.requestPermission();if(perm!=='granted'){showToast('Permission denied',true);return;}const reg=await navigator.serviceWorker.ready;const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(key)});pushSubscription=sub;await api('/api/push/subscribe',{method:'POST',body:{endpoint:sub.endpoint,keys:{p256dh:sub.toJSON().keys.p256dh,auth:sub.toJSON().keys.auth}}});updateNotifyButton(true);showToast('Notifications enabled');}catch(e){showToast('Could not enable',true);}}
function updateNotifyButton(active){const btn=document.getElementById('notify-btn');btn.textContent=active?'Notifications on':'Enable notifications';btn.classList.toggle('active',active);}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function api(url,opts={}){const res=await fetch(url,{method:opts.method||'GET',headers:opts.body?{'Content-Type':'application/json'}:{},body:opts.body?JSON.stringify(opts.body):undefined});if(!res.ok)throw new Error('HTTP '+res.status);return res.json();}
function showToast(msg,isError=false){const el=document.getElementById('toast');el.textContent=msg;el.style.background=isError?'#a4262c':'';el.classList.add('show');setTimeout(()=>el.classList.remove('show'),3000);}
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function formatDate(u){if(!u)return'';return new Date(u*1000).toLocaleDateString('en-US',{month:'short',day:'numeric'});}
function timeAgo(u){const d=Math.floor(Date.now()/1000)-u;if(d<60)return'just now';if(d<3600)return Math.floor(d/60)+'m ago';if(d<86400)return Math.floor(d/3600)+'h ago';return Math.floor(d/86400)+'d ago';}
function urlBase64ToUint8Array(b){const pad='='.repeat((4-b.length%4)%4);const base64=(b+pad).replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from([...atob(base64)].map(c=>c.charCodeAt(0)));}

// ── Mobile functions ──────────────────────────────────────────────────────────
function isMobile(){return window.innerWidth<=768;}

function setMobileView(view,btn){
  setView(view,document.querySelector('.view-btn:nth-child('+(view==='calendar'?1:view==='list'?2:3)+')'));
  document.querySelectorAll('.mobile-nav-btn').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
}

function setMobileFilter(filter,btn){
  setFilter(filter,document.querySelector('.filter-item[data-filter="'+filter+'"]')||{classList:{add:()=>{},remove:()=>{}}});
  currentFilter=filter;
  document.querySelectorAll('.mobile-filter-chip').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  applyFilters();
  closeMobileFilter();
}

function toggleMobileFilter(){
  var overlay=document.getElementById('mobile-filter-overlay');
  var drawer=document.getElementById('mobile-filter-drawer');
  var isOpen=drawer.classList.contains('open');
  if(isOpen){closeMobileFilter();}
  else{overlay.classList.add('open');drawer.classList.add('open');}
}

function closeMobileFilter(){
  document.getElementById('mobile-filter-overlay').classList.remove('open');
  document.getElementById('mobile-filter-drawer').classList.remove('open');
}

// Override search to also check mobile search input
var origGetSearchQuery=getSearchQuery;
getSearchQuery=function(){
  var desktop=document.getElementById('search-input');
  var mobile=document.getElementById('mobile-search-input');
  if(isMobile()&&mobile)return(mobile.value||'').toLowerCase().trim();
  return desktop?(desktop.value||'').toLowerCase().trim():'';
};

// Sync mobile scan fab
var origTriggerScan=triggerScan;
triggerScan=async function(){
  var fab=document.getElementById('mobile-scan-fab');
  if(fab)fab.classList.add('scanning');
  await origTriggerScan();
  if(fab)setTimeout(()=>fab.classList.remove('scanning'),5500);
};
