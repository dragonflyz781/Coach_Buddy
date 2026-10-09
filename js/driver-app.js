(function(){
  "use strict";

  /* ---------------- On-screen error diagnostics ---------------- */
  /* If anything throws, show it instead of failing silently — makes a
     broken load debuggable without needing dev tools. */
  var errBanner = null;
  function showError(msg){
    if(!errBanner){
      errBanner = document.createElement('div');
      errBanner.style.cssText = 'position:fixed;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom));z-index:9999;background:#b3391f;color:#fff;padding:10px 14px;border-radius:10px;font:13px -apple-system,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35);';
      document.body.appendChild(errBanner);
    }
    errBanner.textContent = msg;
    errBanner.style.display = 'block';
  }
  window.addEventListener('error', function(e){ showError('App error: '+(e.message||'unknown')); });
  window.addEventListener('unhandledrejection', function(e){
    var m = (e.reason && (e.reason.message||e.reason.code)) || String(e.reason);
    showError('App error: '+m);
  });

  /* Routes now come from Firestore (see js/main.js) via RoundTracker.setRoutes(). */

  /* ---------------- Theme ---------------- */
  var themeBtn = document.getElementById('themeBtn');
  function applyTheme(t){
    if(t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  var savedTheme = null;
  try{ savedTheme = localStorage.getItem('rt_theme'); }catch(e){}
  applyTheme(savedTheme);
  themeBtn.addEventListener('click', function(){
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : (cur === 'light' ? null : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark'));
    applyTheme(next);
    try{ localStorage.setItem('rt_theme', next || ''); }catch(e){}
  });

  /* ---------------- Map setup ---------------- */
  // Real street tiles load fine when this page is hosted normally (e.g.
  // GitHub Pages). Inside Claude's published-artifact sandbox, external
  // image loads are blocked, so we detect that and fall back gracefully
  // to a plain grid + "Open in Maps" links — no separate build needed.
  // Zoom control is a custom fixed +/- button pair (added further down)
  // instead of Leaflet's own, to match the app's styling.
  // rotate:true (from the leaflet-rotate plugin) turns on real heading-up
  // rotation, handled correctly inside Leaflet itself — it works out how
  // many tiles are needed to cover a rotated view and keeps dragging/zoom
  // working throughout, rather than the manual CSS-transform + overscan
  // approach this app used before (which is what caused all the clipping
  // and mis-sizing bugs). Markers default to staying upright regardless of
  // map rotation (rotateWithView:false), which is exactly what's wanted
  // for the live GPS dot.
  var map = L.map('map', {
    zoomControl:false, attributionControl:false,
    rotate:true, rotateControl:false, touchRotate:false, shiftKeyRotate:false
  }).setView([51.5, -0.12], 6);
  map.on('rotate', function(){
    var tick = document.getElementById('compassTick');
    if(tick) tick.style.transform = 'rotate('+map.getBearing()+'deg)';
  });

  var tilesConfirmed = false;
  // Plain street map (v8, checked): ONE standard OpenStreetMap base layer and nothing on top of it -
  // no school / college / POI overlay, no layer switcher. Don't add an education layer here.
  var tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'base-plain',
    attribution: '&copy; OpenStreetMap contributors',
    crossOrigin: true
  }).addTo(map);

  function markTilesWorking(){
    if(tilesConfirmed) return;
    tilesConfirmed = true;
    document.getElementById('map').classList.add('tiles-ok');
    var b = document.querySelector('.notile-banner');
    if(b) b.remove();
  }
  tileLayer.on('tileload', markTilesWorking);
  tileLayer.on('load', markTilesWorking);

  function showNoTilesBanner(){
    if(tilesConfirmed) return;
    try{ if(localStorage.getItem('rt_notile_seen')) return; }catch(e){}
    var banner = document.createElement('div');
    banner.className = 'notile-banner';
    banner.innerHTML = 'No street map imagery here (platform restriction) — route &amp; GPS position are accurate. Tap a marker for a link to open it in Maps.<button aria-label="Dismiss">&times;</button>';
    document.querySelector('.map-wrap').appendChild(banner);
    banner.querySelector('button').addEventListener('click', function(){
      banner.remove();
      try{ localStorage.setItem('rt_notile_seen','1'); }catch(e){}
    });
  }
  // Give tiles a few seconds to prove themselves before assuming they're blocked.
  setTimeout(function(){ if(!tilesConfirmed) showNoTilesBanner(); }, 3500);
  setTimeout(function(){ map.invalidateSize(); }, 150);

  function mapsLink(lat, lng){
    return 'https://www.google.com/maps/search/?api=1&query='+lat+','+lng;
  }

  var trackLine = null;
  var stopsGroup = L.layerGroup().addTo(map);
  var liveMarker = null;
  var watchId = null;
  var tracking = false;
  var lastFix = null;
  var followMe = true;

  function stopIcon(n){
    return L.divIcon({ className:'', html:'<div class="stop-marker"><span>'+n+'</span></div>', iconSize:[24,24], iconAnchor:[12,12] });
  }
  // Markers default to staying upright regardless of map rotation
  // (rotateWithView:false, from the plugin), so this wedge always points
  // toward the top of the screen — which, since the map rotates to face
  // your direction of travel, means it's naturally always pointing "ahead".
  var BUS_SVG = '<svg class="live-bus" viewBox="0 0 24 44" width="24" height="44" aria-hidden="true">'
    + '<rect x="2" y="1.5" width="20" height="41" rx="6" fill="#e0631a" stroke="#7a2f08" stroke-width="1.4"/>'
    + '<rect x="4.5" y="4" width="15" height="7" rx="2.5" fill="#cfeaf5" stroke="#7a2f08" stroke-width=".8"/>'
    + '<rect x="5" y="14" width="14" height="22" rx="2" fill="#f08a47" stroke="#b34a10" stroke-width=".8"/>'
    + '<rect x="8" y="17" width="8" height="4" rx="1" fill="#fbd3b3"/><rect x="8" y="24" width="8" height="4" rx="1" fill="#fbd3b3"/>'
    + '<rect x="4.5" y="37.5" width="15" height="3" rx="1.2" fill="#cfeaf5" stroke="#7a2f08" stroke-width=".6"/>'
    + '<rect x="0" y="9" width="2.6" height="4" rx="1" fill="#1b2326"/><rect x="21.4" y="9" width="2.6" height="4" rx="1" fill="#1b2326"/>'
    + '<circle cx="5.5" cy="2.8" r="1.2" fill="#ffe08a"/><circle cx="18.5" cy="2.8" r="1.2" fill="#ffe08a"/>'
    + '</svg>';
  var LIVE_ICON = L.divIcon({
    className:'live-marker-icon',
    html:'<div class="live-dot-wrap"><div class="heading-wedge"></div><div class="live-dot"></div>'+BUS_SVG+'</div>',
    iconSize:[24,44], iconAnchor:[12,22]
  });
  function liveIcon(){ return LIVE_ICON; }

  /* ---------------- Geometry helpers ---------------- */
  function toRad(d){ return d*Math.PI/180; }

  function haversineMeters(a,b){
    var R=6371000, dLat=toRad(b[0]-a[0]), dLon=toRad(b[1]-a[1]);
    var s = Math.sin(dLat/2)**2 + Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.min(1,Math.sqrt(s)));
  }
  // local flat-earth projection around a reference lat, for cheap point-to-segment math
  function project(pt, ref){
    var mPerDegLat = 111320;
    var mPerDegLon = 111320*Math.cos(toRad(ref[0]));
    return [ (pt[0]-ref[0])*mPerDegLat, (pt[1]-ref[1])*mPerDegLon ];
  }
  function distToSegment(p, a, b){
    var dx=b[0]-a[0], dy=b[1]-a[1];
    var len2 = dx*dx+dy*dy;
    if(len2===0) return Math.hypot(p[0]-a[0], p[1]-a[1]);
    var t = ((p[0]-a[0])*dx + (p[1]-a[1])*dy)/len2;
    t = Math.max(0, Math.min(1, t));
    var cx = a[0]+t*dx, cy = a[1]+t*dy;
    return Math.hypot(p[0]-cx, p[1]-cy);
  }
  function distanceToTrack(latlng, track){
    if(!track || track.length===0) return null;
    var ref = latlng;
    var p = [0,0];
    var best = Infinity;
    if(track.length===1){
      return haversineMeters(latlng, track[0]);
    }
    for(var i=0;i<track.length-1;i++){
      var a = project(track[i], ref);
      var b = project(track[i+1], ref);
      var d = distToSegment(p, a, b);
      if(d<best) best=d;
    }
    return best;
  }
  function nearestStop(latlng, stops){
    if(!stops || stops.length===0) return null;
    var bestI=-1, bestD=Infinity;
    for(var i=0;i<stops.length;i++){
      var d = haversineMeters(latlng, stops[i]);
      if(d<bestD){ bestD=d; bestI=i; }
    }
    return { index:bestI, dist:bestD };
  }
  function fmtDist(m){
    if(m==null) return {v:'–', u:''};
    if(m < 1000) return { v: Math.round(m), u:' m' };
    return { v: (m/1000).toFixed(1), u:' km' };
  }

  // ----- Turn-by-turn (computed purely from the GPX track's own geometry —
  // no routing/geocoding service involved, so this works with no network) -----
  function bearing(a,b){
    var lat1=toRad(a[0]), lat2=toRad(b[0]), dLon=toRad(b[1]-a[1]);
    var y=Math.sin(dLon)*Math.cos(lat2);
    var x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
    return (Math.atan2(y,x)*180/Math.PI+360)%360;
  }
  function angleDiff(a,b){ return ((b-a+540)%360)-180; }
  function findNearestTrackIndex(latlng, track){
    if(!track||track.length===0) return -1;
    var bestI=0, bestD=Infinity;
    for(var i=0;i<track.length;i++){
      var d=haversineMeters(latlng, track[i]);
      if(d<bestD){ bestD=d; bestI=i; }
    }
    return bestI;
  }
  // Direction of travel taken from the road itself rather than raw GPS
  // movement — the route's own shape doesn't jitter the way consecutive
  // GPS fixes do, so this gives a much steadier rotation whenever you're
  // actually on (or close to) the loaded route. Returns null when too far
  // from the track to trust its direction, so callers can fall back to
  // device/movement-based heading instead.
  function roadHeadingNear(latlng, track){
    if(!track || track.length<2) return null;
    var idx = findNearestTrackIndex(latlng, track);
    if(idx<0 || haversineMeters(latlng, track[idx]) > 65) return null;
    var startIdx = Math.max(0, idx-1);
    var endIdx = Math.min(track.length-1, idx+3);
    if(startIdx===endIdx) return null;
    return bearing(track[startIdx], track[endIdx]);
  }
  function computeTurns(track){
    if(!track || track.length<3) return [];
    var STEP=35; // metres between samples — smooths out raw GPS jitter
    var pts=[track[0]], acc=0;
    for(var i=1;i<track.length;i++){
      acc += haversineMeters(track[i-1], track[i]);
      if(acc>=STEP){ pts.push(track[i]); acc=0; }
    }
    if(pts[pts.length-1]!==track[track.length-1]) pts.push(track[track.length-1]);
    if(pts.length<3) return [];
    var turns=[];
    for(var j=1;j<pts.length-1;j++){
      var diff = angleDiff(bearing(pts[j-1],pts[j]), bearing(pts[j],pts[j+1]));
      if(Math.abs(diff)>=28) turns.push({ latlng:pts[j], dir: diff>0?'right':'left', angle:Math.abs(diff) });
    }
    var merged=[];
    turns.forEach(function(t){
      var last=merged[merged.length-1];
      if(last && haversineMeters(last.latlng,t.latlng)<70){ if(t.angle>last.angle) merged[merged.length-1]=t; }
      else merged.push(t);
    });
    merged.forEach(function(t){ t.trackIdx = findNearestTrackIndex(t.latlng, track); });
    return merged;
  }
  function seqStopTrackIdx(track, stops){
    var out = [], start = 0, n = track.length;
    if(!n) return stops.map(function(){ return -1; });
    for(var i=0;i<stops.length;i++){
      var idx = -1;
      for(var j=start;j<n;j++){ if(haversineMeters(stops[i], track[j]) <= 80){ idx = j; break; } }
      if(idx >= 0){
        while(idx+1 < n && haversineMeters(stops[i], track[idx+1]) < haversineMeters(stops[i], track[idx])) idx++;
      } else {
        var bd = Infinity;
        for(var k=start;k<n;k++){ var dk = haversineMeters(stops[i], track[k]); if(dk < bd){ bd = dk; idx = k; } }
        if(idx < 0) idx = start;
      }
      out.push(idx); start = idx;
    }
    return out;
  }
  function getRouteNav(r){
    if(!r) return null;
    if(!r._navReady){
      r._turns = computeTurns(r.track||[]);
      // v13: stops matched to the track IN ORDER (each search starts where the previous stop matched), so a
      // loop route whose last stop sits next to its first can't map stop 1 onto the end of the track.
      r._stopTrackIdx = seqStopTrackIdx(r.track||[], r.stops||[]);
      var cum=[0];
      for(var i=1;i<(r.track||[]).length;i++) cum.push(cum[i-1]+haversineMeters(r.track[i-1], r.track[i]));
      r._cum = cum;
      r._navReady = true;
    }
    return r;
  }

  /* ---------------- Route store (fed by RoundTracker.setRoutes) ---------------- */
  var routes = {};      // id -> {id,name,addedAt,track,stops}
  var activeId = null;

  /* ---------------- Passenger counter (per route, this device) ---------------- */
  function newPax(){
    return { stopsOn:{}, adhocOn:0, unmapped:{}, startedAt:null, incidents:[] };
  }
  var pax = newPax();
  // SINGLE SOURCE OF TRUTH for a run's passenger counts (what the run summary and the submitted run read).
  // Only BOARDINGS are counted - "passengers on the bus" = passengers boarded (nobody is tracked getting off).
  // stopsOn: r.stops index (0-based, = submitted stops[].index) -> number of passengers boarded at that stop.
  //   Written by BOTH the map-screen "+ Board" button (when the GPS position is within AT_STOP_RADIUS_M of a stop)
  //   AND the Schedule tab's per-row Onboard change + / - (the row is mapped to its stop index, see rowStopIndex()).
  //   "-" / "Undo" only correct a mistaken tap: they take one off the same count and never go below 0.
  // adhocOn: passengers boarded away from every stop ("unscheduled"; also Schedule rows that cannot be matched to a stop).
  // unmapped: Schedule-row key ("MORNING-3") -> {on}; display only, for rows that cannot be matched to a stop
  //   (those taps are already counted in adhocOn, so it is never added to the totals again).
  // startedAt: ms timestamp of the first tap / GPS start of the current run (null = run not started).
  // Older versions also stored stopsOff / adhocOff / unmapped[].off (alights) and byStop / byGpsStop / adhoc: loadPax()
  // ignores the alight fields, and migrateLegacyPax() folds the old boarding-only parts in once.
  var currentGpsStopIdx = null;
  var AT_STOP_RADIUS_M = 50;   // Board within this many metres of a stop is logged against that stop
  function paxKey(routeId){ return 'rt_pax_'+routeId; }
  function loadPax(routeId){
    var out = newPax();
    try{
      var raw = localStorage.getItem(paxKey(routeId));
      if(raw){
        var parsed = JSON.parse(raw);
        if(parsed && typeof parsed==='object'){
          out.adhocOn = Math.max(0, parsed.adhocOn|0);
          out.unmapped = {};   // keep only the boarded part of each row (old saves also had .off - ignored)
          Object.keys(parsed.unmapped && typeof parsed.unmapped==='object' ? parsed.unmapped : {}).forEach(function(k){ var u = parsed.unmapped[k]; var n = (u && u.on)|0; if(n>0) out.unmapped[k] = { on:n }; });
          var so = parsed.stopsOn && typeof parsed.stopsOn==='object' ? parsed.stopsOn : {};
          Object.keys(so).forEach(function(k){ var n = so[k]|0; if(n>0) out.stopsOn[k] = n; });
          out.startedAt = parsed.startedAt||null;
          out.incidents = cleanIncidents(parsed.incidents);      // v16: incidents flagged during this run
          if(parsed.byStop || parsed.byGpsStop || parsed.adhoc){
            out._legacy = { byStop:parsed.byStop||{}, byGpsStop:parsed.byGpsStop||{}, adhoc:parsed.adhoc||0 };
          }
        }
      }
    }catch(e){}
    return out;
  }
  function savePax(routeId){
    try{ localStorage.setItem(paxKey(routeId), JSON.stringify(pax)); }catch(e){}
  }
  function ensureRunStarted(){
    if(activeId && !pax.startedAt){ pax.startedAt = Date.now(); savePax(activeId); }
  }
  function paxTotal(){
    return sumVals(pax.stopsOn) + (pax.adhocOn|0);   // on the bus = everyone who boarded
  }
  function renderPax(){
    var total = paxTotal();
    var elMap = document.getElementById('paxCountMap');
    if(elMap) elMap.textContent = total;
    var elFs = document.getElementById('fsPaxCount');
    if(elFs) elFs.textContent = total;
    renderIncidentBtns();
    document.querySelectorAll('.sched-pax .n').forEach(function(el){
      var idx = +el.getAttribute('data-sidx'), on;
      if(idx >= 0){ on = pax.stopsOn[idx]|0; }
      else { var u = pax.unmapped[el.getAttribute('data-stop-idx')] || {}; on = u.on|0; }
      el.textContent = on;
      if(on > 0){ var dt = el.closest && el.closest('details.sched-gps'); if(dt && !dt.open) dt.open = true; }
    });
    markGpsHere();
  }
  // Schedule: highlight the map stop the driver is at right now (same index Board logs to)
  function markGpsHere(){
    document.querySelectorAll('#schedBody [data-gps-stop]').forEach(function(row){
      var here = currentGpsStopIdx!=null && +row.getAttribute('data-gps-stop')===currentGpsStopIdx;
      row.classList.toggle('here', here);
      if(here){ var dt = row.closest && row.closest('details.sched-gps'); if(dt && !dt.open) dt.open = true; }
    });
  }
  // (v7) The "At Stop n — taps log to this stop" / "Between stops" strip was removed: Board still logs to the stop
  // within AT_STOP_RADIUS_M (currentGpsStopIdx), and the Next-stop card already shows "AT STOP n OF m".
  // delta > 0: one more passenger boarded here. delta < 0 (Undo): take one back off the same count; never below 0.
  var lastBoardStopIdx = null;
  function paxAdjust(delta){
    if(delta>0) ensureRunStarted();
    if(currentGpsStopIdx!=null){
      var k = currentGpsStopIdx, cur = pax.stopsOn[k]|0;
      lastBoardStopIdx = k;   // so the Schedule tab can scroll to it even after Sat-Nav (and GPS) is ended
      var nv = delta>0 ? cur + 1 : Math.max(0, cur - 1);
      if(nv) pax.stopsOn[k] = nv; else delete pax.stopsOn[k];
    } else {
      pax.adhocOn = delta>0 ? (pax.adhocOn|0) + 1 : Math.max(0, (pax.adhocOn|0) - 1);
    }
    if(activeId) savePax(activeId);
    renderPax();
  }
  // Schedule-tab + / -: logged against the stop the timetable row belongs to (same store as the map button).
  // "-" only corrects a mistaken tap: it removes one boarded passenger from that stop and never goes below 0.
  function paxAdjustStop(stopIdx, delta, rowKey){
    if(delta>0) ensureRunStarted();
    if(stopIdx >= 0){
      var cur = pax.stopsOn[stopIdx]|0, nv = delta>0 ? cur + 1 : Math.max(0, cur - 1);
      if(nv) pax.stopsOn[stopIdx] = nv; else delete pax.stopsOn[stopIdx];
    } else {
      // timetable row that matches no stop -> unscheduled (and remembered per row so the row can show its own count)
      var u = pax.unmapped[rowKey] || (pax.unmapped[rowKey] = { on:0 });
      if(delta>0){ u.on += 1; pax.adhocOn = (pax.adhocOn|0) + 1; }
      else if(u.on>0){ u.on -= 1; pax.adhocOn = Math.max(0, (pax.adhocOn|0) - 1); }
    }
    if(activeId) savePax(activeId);
    renderPax();
  }
  // Which r.stops index does timetable row `rowIdx` of `rows` belong to? Match by stop name first (the
  // same way stopSchedTime() does it), else by position when the timetable has one row per stop, else -1.
  function rowStopIndex(r, rows, rowIdx){
    var stops = r.stops || [];
    var target = normName(rows[rowIdx] && rows[rowIdx].stop);
    if(target){
      for(var i=0;i<stops.length;i++){
        if(normName(stopName(r, i))===target || normName(r.stopNames && r.stopNames[i])===target) return i;
      }
      // looser: ignore punctuation / brackets ("Clydach (Post Office)" = "Clydach Post Office"); then a unique
      // "one name contains the other" match (>= 5 letters, never a generic "Stop 3")
      var loose = function(n){ return normName(n).replace(/[^a-z0-9\u00c0-\u024f ]+/g, ' ').replace(/\s+/g, ' ').trim(); };
      var generic = function(n){ return /^stop \d+$/.test(n); };
      var lt = loose(target), hit = -1, hits = 0;
      for(var j=0;j<stops.length;j++){ var ln = loose(r.stopNames && r.stopNames[j]); if(ln && ln===lt) return j; }
      if(lt.length >= 5 && !generic(lt)){
        for(var q=0;q<stops.length;q++){
          var nq = loose(r.stopNames && r.stopNames[q]);
          if(nq.length >= 5 && !generic(nq) && (nq.indexOf(lt) >= 0 || lt.indexOf(nq) >= 0)){ hit = q; hits++; }
        }
        if(hits===1) return hit;
      }
    }
    if(rows.length===stops.length && rowIdx < stops.length) return rowIdx;
    return -1;
  }
  // One-off: fold counts saved by an older version (Schedule taps in byStop keyed "MORNING-n", map taps as
  // net byGpsStop/adhoc) into the single per-stop store.
  function migrateLegacyPax(r){
    var lg = pax._legacy;
    if(!lg) return;
    delete pax._legacy;
    var tt = (r && r.timetable) || {};
    var fresh = !Object.keys(pax.stopsOn).length && !pax.adhocOn;
    if(fresh){            // saved before per-stop run counts existed: only net numbers are known (a negative net = old alight data: ignored)
      Object.keys(lg.byGpsStop).forEach(function(k){ var v = lg.byGpsStop[k]|0; if(v>0) pax.stopsOn[k] = v; });
      if(lg.adhoc>0) pax.adhocOn = lg.adhoc;
    }
    Object.keys(lg.byStop).forEach(function(key){
      var v = lg.byStop[key]|0, m = /^(MORNING|AFTERNOON)-(\d+)$/.exec(key);
      if(!v || !m) return;
      var rows = (m[1]==='MORNING' ? tt.morning : tt.afternoon) || [];
      var idx = rowStopIndex(r, rows, +m[2]);
      if(v<=0) return;      // old alight (negative) taps are ignored
      if(idx >= 0) pax.stopsOn[idx] = (pax.stopsOn[idx]|0) + v;
      else pax.adhocOn += v;
    });
    if(activeId) savePax(activeId);
  }
  function paxReset(){
    if(!confirm('Reset the onboard passenger count for this route?')) return;
    var keepInc = pax.incidents || [];            // v16: resetting the count never throws away flagged incidents
    pax = newPax(); pax.incidents = keepInc;
    if(activeId) savePax(activeId);
    renderPax();
  }
  document.querySelectorAll('[data-pax]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var action = btn.dataset.pax;
      if(action==='on') paxAdjust(1);
      else if(action==='undo') paxAdjust(-1);
      else if(action==='reset') paxReset();
    });
  });
  document.getElementById('fsPaxOn').addEventListener('click', function(){ paxAdjust(1); });
  document.getElementById('fsPaxUndo').addEventListener('click', function(){ paxAdjust(-1); });

  function renderEmptyState(){
    document.getElementById('emptyState').style.display = Object.keys(routes).length ? 'none' : 'flex';
  }

  /* ---------------- Route category tabs ---------------- */
  function hasMorning(r){
    return !!((r.timetable && r.timetable.morning && r.timetable.morning.length) || r.session==='AM' || r.session==='both');
  }
  function hasAfternoon(r){
    return !!((r.timetable && r.timetable.afternoon && r.timetable.afternoon.length) || r.session==='PM' || r.session==='both');
  }
  // A route's service (v9) = its serviceType, else its category (same rule as js/services.js routeService).
  function svcOf(r){
    if(['schools','colleges','rail','other'].indexOf(r.serviceType) >= 0) return r.serviceType;
    return r.category==='school' ? 'schools' : r.category==='college' ? 'colleges' : 'other';
  }
  var RT_TABS = [
    { key:'schools-am',  label:'Schools AM',  match:function(r){ return svcOf(r)==='schools'  && hasMorning(r); } },
    { key:'schools-pm',  label:'Schools PM',  match:function(r){ return svcOf(r)==='schools'  && hasAfternoon(r); } },
    { key:'colleges-am', label:'Colleges AM', match:function(r){ return svcOf(r)==='colleges' && hasMorning(r); } },
    { key:'colleges-pm', label:'Colleges PM', match:function(r){ return svcOf(r)==='colleges' && hasAfternoon(r); } },
    { key:'rail-am', label:'Rail AM', hideEmpty:true, match:function(r){ return svcOf(r)==='rail' && hasMorning(r); } },
    { key:'rail-pm', label:'Rail PM', hideEmpty:true, match:function(r){ return svcOf(r)==='rail' && hasAfternoon(r); } },
    { key:'other', label:'Other', match:function(r){
        return !RT_TABS.slice(0,6).some(function(t){ return t.match(r); });
      } }
  ];
  // What the driver is doing today (v9: picked on the welcome screen, e.g. "Schools AM"); main.js hands over
  // { label, match(route) -> bool | null (= every route), onChange() (= back to the welcome screen to pick again) }.
  // v11: the pick can be several combinations (e.g. "Schools AM + Colleges PM"): match = their union, and
  // tabs = the drawer tabs those combinations belong to (other tabs are hidden even if a "both" route would fit them).
  var svc = { label: '', match: null, onChange: null, tabs: null };
  var pendingFirstPick = false;
  function firstRankedId(ids){
    var ranked = ids.map(function(id){ var k = svc.rank ? svc.rank(routes[id]) : null; return { id:id, k:(k==null ? 1e9 : k), n:String(routes[id].name||'') }; });
    ranked.sort(function(a,b){ return (a.k - b.k) || a.n.localeCompare(b.n, undefined, { numeric:true, sensitivity:'base' }); });
    return ranked.length ? ranked[0].id : null;
  }
  /* v14/v15: today's jobs. Routes submitted today are remembered on this phone per company + London date
     (localStorage rt_done_<companyId>_<YYYY-MM-DD>), so the next job never loops back to one already done. */
  var allDone = false;
  // v15: keyed by the DUTY day (05:00 → 05:00 London) from js/services.js dutyDay(), handed over in configureRuns
  function today(){ return (runCfg && runCfg.dutyDay) ? runCfg.dutyDay() : new Date().toISOString().slice(0,10); }
  function doneKey(){ return 'rt_done_' + ((runCfg && runCfg.companyId) || 'local') + '_' + today(); }
  function doneIds(){
    try{ var a = JSON.parse(localStorage.getItem(doneKey()) || '[]'); return Array.isArray(a) ? a : []; }catch(e){ return []; }
  }
  function isDone(id){ return !!id && doneIds().indexOf(id) >= 0; }
  function markDone(id){
    if(!id) return;
    var a = doneIds(); if(a.indexOf(id) < 0) a.push(id);
    saveDone(a);
    if(runCfg && runCfg.onDone){ try{ runCfg.onDone(a.slice()); }catch(e){} }   // v15: also saved to the driver's day plan
  }
  function saveDone(a){
    try{
      localStorage.setItem(doneKey(), JSON.stringify(a));
      // tidy up earlier days for this company
      var pre = 'rt_done_' + ((runCfg && runCfg.companyId) || 'local') + '_';
      for(var i = localStorage.length-1; i >= 0; i--){ var k = localStorage.key(i); if(k && k.indexOf(pre) === 0 && k !== doneKey()) localStorage.removeItem(k); }
    }catch(e){}
  }
  // today's picked routes (in the welcome selection, with a rank) that are not submitted yet
  function openJobIds(){
    return visibleIds().filter(function(id){ return !isDone(id) && (!svc.rank || svc.rank(routes[id]) != null); });
  }
  function jobLabel(id){
    var r = routes[id]; if(!r) return '';
    var slot = svc.slotLabel ? svc.slotLabel(r) : '';
    return (slot ? slot + ' \u2013 ' : '') + (r.name || 'Route');
  }
  var drvToastTimer = null;
  function driverToast(msg){
    var t = document.getElementById('toast'); if(!t) return;
    t.textContent = msg;
    t.className = 'toast show drv';
    clearTimeout(drvToastTimer);
    drvToastTimer = setTimeout(function(){ t.className = 'toast drv'; }, 7000);
  }
  // every picked route is done: no route open, Sat-Nav ended, header says so; the drawer still lists every route
  function showAllDone(){
    if(document.body.classList.contains('satnav-mode')) endSatnav();
    else if(tracking) trackBtn.click();
    if(guiding) clearGuide();
    clearActiveRoute();
    allDone = true;
    try{ localStorage.removeItem('rt_active'); }catch(e){}
    document.getElementById('routeName').textContent = 'All today\u2019s runs done \u2714';
    document.getElementById('routeSub').textContent = 'Tap \u2630 to open another route';
    document.body.classList.add('all-done');
    renderRouteList();
    notifyAllDone();
  }
  // v18: tell main.js (end-of-duty defect report) - after the run dialog is closed, never on top of it
  var allDoneNotify = false;
  function notifyAllDone(){
    if(runModal && runModal.style.display === 'flex'){ allDoneNotify = true; return; }
    if(runCfg && runCfg.onAllDone){ try{ runCfg.onAllDone(); }catch(e){} }
  }
  var allDoneRoutesBtn = document.getElementById('allDoneRoutes');
  if(allDoneRoutesBtn) allDoneRoutesBtn.addEventListener('click', function(){ var m = document.getElementById('menuBtn'); if(m) m.click(); });
  // a fresh route to drive: violet guide to its stop 1 (trimming waits for stop 1 as usual)
  function guideToFirstStop(){
    try{ if(guiding) clearGuide(); if(firstStopBtn && !firstStopBtn.disabled) firstStopBtn.click(); }catch(e){}
  }
  // after a successful submit of the open route: open the next job of today's picked list (same order as the first route)
  function advanceAfterSubmit(run){
    markDone(run.routeId);
    if(run.routeId !== activeId || !svc.rank) return { kind:'none' };
    var ids = openJobIds();
    if(ids.length){
      var next = firstRankedId(ids);
      setActiveRoute(next);
      guideToFirstStop();
      return { kind:'next', id:next, label:jobLabel(next) };
    }
    showAllDone();
    return { kind:'alldone' };
  }
  function svcVisible(id){ return !svc.match || (routes[id] && svc.match(routes[id])); }
  function visibleIds(){ return Object.keys(routes).filter(svcVisible); }
  function tabOk(t){
    if(!svc.match || !svc.tabs) return true;
    if(svc.tabs.indexOf(t.key) >= 0) return true;
    // safety net: a visible route that fits none of the picked tabs keeps every tab available
    var allowed = RT_TABS.filter(function(x){ return svc.tabs.indexOf(x.key) >= 0; });
    return visibleIds().some(function(id){ return !allowed.some(function(x){ return x.match(routes[id]); }); });
  }
  function renderSvcBar(){
    var bar = document.getElementById('svcBar');
    if(!bar) return;
    if(!svc.label){ bar.style.display = 'none'; return; }
    bar.style.display = '';
    document.getElementById('svcToday').textContent = svc.label;
  }
  document.getElementById('svcChange').addEventListener('click', function(){ closeDrawer(); if(svc.onChange) svc.onChange(); });
  var drawerTab = 'schools-am';
  try{ drawerTab = localStorage.getItem('rt_drawer_tab') || 'schools-am'; }catch(e){}

  function renderRouteTabs(){
    var wrap = document.getElementById('rtTabs');
    wrap.innerHTML = '';
    renderSvcBar();
    RT_TABS.forEach(function(t){
      var n = visibleIds().filter(function(id){ return t.match(routes[id]); }).length;
      // with a service picked, hide the tabs that have nothing for it (the active one always stays)
      if((svc.match || t.hideEmpty) && !n && t.key !== drawerTab) return;
      if(!tabOk(t) && t.key !== drawerTab) return;
      var btn = document.createElement('button');
      btn.className = 'rt-tab' + (t.key===drawerTab ? ' active' : '');
      btn.innerHTML = t.label + (n ? ' <span class="count">'+n+'</span>' : '');
      btn.addEventListener('click', function(){
        drawerTab = t.key;
        try{ localStorage.setItem('rt_drawer_tab', t.key); }catch(e){}
        renderRouteList();
      });
      wrap.appendChild(btn);
    });
  }

  function renderRouteList(){
    var list = document.getElementById('routeList');
    var activeTab = RT_TABS.filter(function(t){ return t.key===drawerTab; })[0] || RT_TABS[0];
    // the remembered tab is empty for today's service but another tab has routes: show that one instead
    if(!tabOk(activeTab) || ((svc.match || activeTab.hideEmpty) && !visibleIds().some(function(id){ return activeTab.match(routes[id]); }))){
      var firstFull = RT_TABS.filter(function(t){ return tabOk(t) && visibleIds().some(function(id){ return t.match(routes[id]); }); })[0];
      if(firstFull){ drawerTab = firstFull.key; activeTab = firstFull; }
    }
    renderRouteTabs();
    var ids = visibleIds()
      .filter(function(id){ return activeTab.match(routes[id]); })
      .sort(function(a,b){ return (routes[b].addedAt||'').localeCompare(routes[a].addedAt||''); });
    if(ids.length===0){
      if(svc.match && Object.keys(routes).length && !visibleIds().length){
        list.innerHTML = '<div class="drawer-empty">No '+svc.label+' routes right now. Tap “Change” above to pick something else.</div>';
        return;
      }
      list.innerHTML = '<div class="drawer-empty">No routes in "'+activeTab.label+'" yet.'+
        (Object.keys(routes).length ? ' Try another tab.' : ' Your administrator has not added any routes yet.')+'</div>';
      return;
    }
    list.innerHTML = '';
    ids.forEach(function(id){
      var r = routes[id];
      var card = document.createElement('div');
      card.className = 'route-card' + (id===activeId ? ' active' : '');
      var initials = (r.name||'?').replace(/[^A-Za-z0-9]/g,'').slice(0,3).toUpperCase() || '?';
      var dateStr = '';
      try{ dateStr = r.addedAt ? new Date(r.addedAt).toLocaleDateString(undefined,{day:'numeric',month:'short'}) : ''; }catch(e){}
      card.innerHTML =
        '<div class="route-badge">'+initials+'</div>'+
        '<div class="route-meta"><div class="name"></div><div class="sub"></div></div>'+
        '<div class="route-actions">'+
          '<button class="chip-btn use">'+(id===activeId?'Viewing':'View')+'</button>'+
        '</div>';
      card.querySelector('.name').textContent = r.name || 'Untitled route';
      card.querySelector('.sub').textContent = (r.stops?r.stops.length:0)+' stops · '+(r.track?r.track.length:0)+' pts'+(dateStr?' · '+dateStr:'');
      card.querySelector('.use').addEventListener('click', function(){ setActiveRoute(id); closeDrawer(); });
      list.appendChild(card);
    });
  }

  function setActiveRoute(id){
    var r = routes[id];
    if(!r) return;
    var reopened = (id === activeId);      // same route again = the admin edited it while it is open
    if(!reopened){ lastBoardStopIdx = null; resetNavProgress(); finishPromptedFor = null; }
    activeId = id;
    allDone = false; document.body.classList.remove('all-done');
    getRouteNav(r);
    if(typeof clearGuide==='function' && guiding) clearGuide();
    try{ localStorage.setItem('rt_active', id); }catch(e){}
    document.getElementById('routeName').textContent = r.name || 'Round Tracker';
    document.getElementById('routeSub').textContent = (r.stops?r.stops.length:0)+' stops · '+(r.track?r.track.length:0)+' track points';

    if(trackLine) map.removeLayer(trackLine);
    if(typeof trackCasing!=='undefined' && trackCasing) map.removeLayer(trackCasing);
    trackLine = null; trackCasing = null;
    stopsGroup.clearLayers();

    if(r.track && r.track.length>1){
      drawTrackLine(r.track, drawnFromIdx(r));
    } else {
      trackLine = null; trackCasing = null;
    }
    (r.stops||[]).forEach(function(pt, i){
      var sname = (r.stopNames && r.stopNames[i]) ? ' \u2014 '+escapeHtml(r.stopNames[i]) : '';
      L.marker(pt, { icon: stopIcon(i+1) }).addTo(stopsGroup)
        .bindPopup('Stop '+(i+1)+sname+'<br><a class="maps-link" target="_blank" rel="noopener" href="'+mapsLink(pt[0],pt[1])+'">Open in Maps ↗</a>');
    });

    var bounds = null;
    if(r.track && r.track.length) bounds = L.latLngBounds(r.track);
    else if(r.stops && r.stops.length) bounds = L.latLngBounds(r.stops);
    // (skip while the driver view is hidden - the map has no size yet; show() fits it later)
    // (and don't yank the camera away while driving when the admin edits the open route)
    var driving = reopened && (tracking || document.body.classList.contains('satnav-mode'));
    if(bounds && map.getSize().x > 0 && !driving) map.fitBounds(bounds, { padding:[36,36] });

    renderRouteList();
    renderEmptyState();
    pax = loadPax(id);
    migrateLegacyPax(routes[id]);
    currentGpsStopIdx = null;
    // the same route re-opened after an admin edit while driving: keep logging to the stop we are at (don't wait for the next fix)
    if(lastFix && lastFix.latlng && r.stops && r.stops.length){
      var ns0 = nearestStop(lastFix.latlng, r.stops);
      if(ns0 && ns0.dist <= AT_STOP_RADIUS_M) currentGpsStopIdx = ns0.index;
    }
    renderPax();
    renderSchedule();
    renderRunUi();
    updateNextStop();
  }

  function getCss(varName){
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || '';
  }
  // High-contrast planned route on the map (strong orange) + dark casing so it stays readable on OSM greens/greys.
  // "Direct to first stop" uses a vivid violet so it never blends into the orange route line.
  var trackCasing = null;
  // v13 run progress along the active route (display only - the stored route is never changed):
  //   started  - false until the driver reaches stop 1 (same 50 m at-stop radius as boarding)
  //   stopIdx  - the last stop reached, in stop order (a missed stop may be skipped, never more than one)
  //   trackIdx - forward-only position on the track, searched only up to the stop after next
  var NAV_JOIN_M = 60;
  var navProg = { started:false, stopIdx:-1, trackIdx:0 };
  function resetNavProgress(){ navProg = { started:false, stopIdx:-1, trackIdx:0 }; }
  function drawTrackLine(fullTrack, fromIdx){
    if(trackLine){ map.removeLayer(trackLine); trackLine = null; }
    if(trackCasing){ map.removeLayer(trackCasing); trackCasing = null; }
    if(!fullTrack || fullTrack.length<2) return;
    var i = Math.max(0, Math.min(fromIdx|0, fullTrack.length-2));   // never fewer than 2 points -> never empty
    var pts = fullTrack.slice(i);
    trackCasing = L.polyline(pts, { color: getCss('--track-casing') || '#1a0a00', weight:8, opacity:.55, lineJoin:'round', lineCap:'round', interactive:false }).addTo(map);
    trackLine = L.polyline(pts, { color: getCss('--track') || '#e85d04', weight:5, opacity:.95, lineJoin:'round', lineCap:'round' }).addTo(map);
    trackLine._rtFrom = i; trackLine._rtFull = fullTrack.length;
  }
  // where the orange line should start: the whole route until stop 1 is reached / while not tracking
  function drawnFromIdx(r){
    var live = tracking || document.body.classList.contains('satnav-mode');
    return (live && navProg.started) ? Math.max(0, navProg.trackIdx - 1) : 0;
  }
  function redrawActiveTrack(){
    var r = activeId ? routes[activeId] : null;
    if(!r || !r.track || r.track.length<2) return;
    var from = drawnFromIdx(r);
    if(!trackLine || trackLine._rtFrom !== from || trackLine._rtFull !== r.track.length || !map.hasLayer(trackLine)) drawTrackLine(r.track, from);
  }
  function updateNavProgress(r, latlng){
    var stops = r.stops || [], n = stops.length;
    if(!n || !latlng) return;
    getRouteNav(r);
    var hasTrack = r.track && r.track.length > 1;
    if(!navProg.started){
      if(haversineMeters(latlng, stops[0]) <= AT_STOP_RADIUS_M){
        navProg.started = true; navProg.stopIdx = 0;
        navProg.trackIdx = hasTrack ? Math.max(0, r._stopTrackIdx[0]) : 0;
        if(guiding) clearGuide();                 // the violet guide was only "to stop 1"
      }
      return;
    }
    if(hasTrack){
      // forward-only along the track, limited to the stretch up to the stop after next, taking the FIRST
      // stretch within reach (then its closest point) - a loop or the last stop near the start can't jump ahead
      var lim = navProg.stopIdx+2 < n ? r._stopTrackIdx[navProg.stopIdx+2] : r.track.length-1;
      var j0 = -1;
      for(var j = navProg.trackIdx; j <= lim; j++){ if(haversineMeters(latlng, r.track[j]) <= NAV_JOIN_M){ j0 = j; break; } }
      if(j0 >= 0){
        var dPrev = haversineMeters(latlng, r.track[j0]);
        while(j0+1 <= lim){ var dn = haversineMeters(latlng, r.track[j0+1]); if(dn <= dPrev){ dPrev = dn; j0++; } else break; }
        if(j0 > navProg.trackIdx) navProg.trackIdx = j0;
      }
    }
    // the next stop (or the one after, if one was missed) within the at-stop radius - and only if the run has
    // actually got to that part of the route (within 400 m along the track), so a stop that sits near an earlier
    // part of a loop (e.g. the last stop by the depot) is never counted early
    for(var k = navProg.stopIdx+1; k <= Math.min(n-1, navProg.stopIdx+2); k++){
      if(haversineMeters(latlng, stops[k]) > AT_STOP_RADIUS_M) continue;
      if(hasTrack && (r._cum[r._stopTrackIdx[k]] - r._cum[navProg.trackIdx]) > 400) continue;
      navProg.stopIdx = k;
      if(hasTrack) navProg.trackIdx = Math.max(navProg.trackIdx, r._stopTrackIdx[k]);
      break;
    }
    if(!hasTrack) return;
    // an intermediate stop the bus drove past (e.g. set back from the road) counts as passed 60 m beyond it
    while(navProg.stopIdx+1 < n-1){
      var si = r._stopTrackIdx[navProg.stopIdx+1];
      if(navProg.trackIdx > si && (r._cum[navProg.trackIdx] - r._cum[si]) > 60) navProg.stopIdx++;
      else break;
    }
  }
  // track position to use for turns / ETA: the run progress once started, else the EARLIEST point of the
  // route within reach (so standing at the start of a loop never reads as being at its end)
  function navTrackIdx(r, latlng){
    if(navProg.started) return navProg.trackIdx;
    if(!r.track || !r.track.length || !latlng) return 0;
    for(var i=0;i<r.track.length;i++){ if(haversineMeters(latlng, r.track[i]) <= NAV_JOIN_M) return i; }
    return 0;
  }
  // test hook (read-only)
  function navState(){
    return { started:navProg.started, stopIdx:navProg.stopIdx, trackIdx:navProg.trackIdx, guiding:!!guiding,
             drawnFrom: trackLine ? trackLine._rtFrom : null, drawnPts: trackLine ? trackLine.getLatLngs().length : 0,
             fullPts: (activeId && routes[activeId] && routes[activeId].track) ? routes[activeId].track.length : 0,
             stopTrackIdx: (activeId && routes[activeId]) ? (getRouteNav(routes[activeId])._stopTrackIdx || []).slice() : [] };
  }

  /* ---------------- Tabs & live schedule ---------------- */
  var tabMapBtn = document.getElementById('tabMapBtn'), tabSchedBtn = document.getElementById('tabSchedBtn');
  var mapView = document.getElementById('mapView'), scheduleView = document.getElementById('scheduleView');
  function showTab(name){
    if(name==='schedule'){
      mapView.style.display = 'none'; scheduleView.style.display = 'flex';
      tabSchedBtn.classList.add('active'); tabMapBtn.classList.remove('active');
      renderSchedule();
      // At a stop (or just tapped Board at one, then ended Sat-Nav)? Bring that stop's row and its count into view.
      var hereIdx = currentGpsStopIdx!=null ? currentGpsStopIdx : lastBoardStopIdx;
      if(hereIdx!=null){
        var hereN = scheduleView.querySelector('.sched-pax .n[data-sidx="'+hereIdx+'"]');
        var hereRow = hereN && hereN.closest('.sched-row');
        if(hereRow && hereRow.scrollIntoView) hereRow.scrollIntoView({ block:'center' });
      }
    } else {
      scheduleView.style.display = 'none'; mapView.style.display = 'flex';
      tabMapBtn.classList.add('active'); tabSchedBtn.classList.remove('active');
      setTimeout(function(){ map.invalidateSize(); }, 0);
    }
  }
  tabMapBtn.addEventListener('click', function(){ showTab('map'); });
  tabSchedBtn.addEventListener('click', function(){ showTab('schedule'); });
  // Start on the Map tab (on narrow screens both panes were otherwise shown, with the map squashed to 0 height).
  showTab('map');

  function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  // Parse "HH:MM" against today's date (local time)
  function timeToday(hhmm){
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm||'').trim());
    if(!m) return null;
    var d = new Date();
    d.setHours(parseInt(m[1],10), parseInt(m[2],10), 0, 0);
    return d;
  }
  function fmtMinutes(ms){
    var mins = Math.round(Math.abs(ms)/60000);
    if(mins < 1) return 'under a minute';
    if(mins === 1) return '1 min';
    if(mins < 60) return mins+' min';
    var h = Math.floor(mins/60), m = mins%60;
    return h+'h'+(m?' '+m+'m':'');
  }

  function renderSchedule(){
    var r = activeId ? routes[activeId] : null;
    var body = document.getElementById('schedBody');
    if(!r){
      body.innerHTML = '<div class="sched-empty">No route selected. Open ☰ to pick a route.</div>';
      return;
    }
    var tt = r.timetable || {};
    var sections = [];
    if(tt.morning && tt.morning.length) sections.push({ label:'MORNING', rows:tt.morning, note:tt.morningNote });
    if(tt.afternoon && tt.afternoon.length) sections.push({ label:'AFTERNOON', rows:tt.afternoon, note:tt.afternoonNote });

    var html = '';
    var now = new Date();
    var matched = {};     // r.stops indices that some timetable row maps to (see rowStopIndex)

    if(sections.length===0){
      html += '<div class="sched-empty">No drop times saved for this route yet.</div>';
    }

    sections.forEach(function(sec){
      // build parsed times, find "now" index
      var times = sec.rows.map(function(row){ return timeToday(row.time); });
      var nowIdx = -1;
      for(var i=0;i<times.length;i++){
        if(times[i] && times[i].getTime() <= now.getTime()) nowIdx = i;
      }
      var tripDone = (times[times.length-1] && now.getTime() > times[times.length-1].getTime() + 10*60000);

      if(sections.length>1 || true){
        html += '<div class="sched-section"><h3>'+sec.label+'</h3>';
      }
      sec.rows.forEach(function(row, i){
        var cls = 'sched-row';
        var status = '';
        if(tripDone){
          cls += ' past'; status = 'Done';
        } else if(i < nowIdx){
          cls += ' past'; status = 'Passed';
        } else if(i === nowIdx){
          cls += ' now'; status = 'Due now';
        } else if(nowIdx===-1 && i===0){
          var t = times[0];
          status = t ? 'Starts in '+fmtMinutes(t.getTime()-now.getTime()) : 'Upcoming';
        } else {
          var t2 = times[i];
          status = t2 ? 'In '+fmtMinutes(t2.getTime()-now.getTime()) : 'Upcoming';
        }
        var stopKey = sec.label+'-'+i;
        var sidx = rowStopIndex(r, sec.rows, i);
        if(sidx >= 0) matched[sidx] = true;
        html += '<div class="'+cls+'"><div class="sched-dot"></div><div class="sched-info">'+
          '<div class="sched-stop">'+escapeHtml(row.stop)+'</div>'+
          '<div class="sched-status">'+escapeHtml(status)+'</div>'+
          '<div class="sched-pax">'+
            '<span class="sched-pax-label">Boarded:</span>'+
            '<button class="sched-pax-btn off" data-stopkey="'+stopKey+'" data-sidx="'+sidx+'" data-dir="-1" aria-label="Remove one boarded passenger (correct a mistake)">−</button>'+
            '<span class="n" data-stop-idx="'+stopKey+'" data-sidx="'+sidx+'">0</span>'+
            '<button class="sched-pax-btn on" data-stopkey="'+stopKey+'" data-sidx="'+sidx+'" data-dir="1" aria-label="Passenger got on">+</button>'+
          '</div>'+
          '</div><div class="sched-time">'+escapeHtml(row.time)+'</div></div>';
      });
      if(sec.note) html += '<div class="sched-note">'+escapeHtml(sec.note)+'</div>';
      html += '</div>';
    });

    // Map (GPS) stops that no timetable row maps to - e.g. a GPX with 21 waypoints called "Stop 1…21" but a timetable
    // of 4 named rows. "+ Board" at such a stop logs to its index, so it gets its own row here with the same count
    // (and − / + to correct it); otherwise the Board taps would be invisible on this page.
    var stopsN = (r.stops || []).length, others = [];
    for(var si=0; si<stopsN; si++) if(!matched[si]) others.push(si);
    if(others.length){
      var anyCount = others.some(function(k){ return (pax.stopsOn[k]|0) > 0; }) || (currentGpsStopIdx!=null && !matched[currentGpsStopIdx]);
      html += '<details class="sched-section sched-gps"'+(anyCount || !sections.length ? ' open' : '')+'><summary><h3>'+
        (sections.length ? 'OTHER STOPS ON THE MAP' : 'STOPS ON THE MAP')+' ('+others.length+')</h3></summary>'+
        '<div class="sched-gps-note muted">Passengers boarded at map stops'+(sections.length ? ' that have no timetable row' : '')+'.</div>';
      others.forEach(function(k){
        var key = 'GPS-'+k;
        html += '<div class="sched-row gps-stop" data-gps-stop="'+k+'"><div class="sched-dot"></div><div class="sched-info">'+
          '<div class="sched-stop">Stop '+(k+1)+(normName(stopName(r, k))!=='stop '+(k+1) ? ' — '+escapeHtml(stopName(r, k)) : '')+'</div>'+
          '<div class="sched-pax">'+
            '<span class="sched-pax-label">Boarded:</span>'+
            '<button class="sched-pax-btn off" data-stopkey="'+key+'" data-sidx="'+k+'" data-dir="-1" aria-label="Remove one boarded passenger (correct a mistake)">−</button>'+
            '<span class="n" data-stop-idx="'+key+'" data-sidx="'+k+'">0</span>'+
            '<button class="sched-pax-btn on" data-stopkey="'+key+'" data-sidx="'+k+'" data-dir="1" aria-label="Passenger boarded">+</button>'+
          '</div></div></div>';
      });
      html += '</details>';
    }

    if(r.note){
      html = '<div class="sched-banner">'+escapeHtml(r.note)+'</div>' + html;
    }

    if(r.operator){
      html += '<div class="sched-section"><h3>OPERATOR</h3><div class="sched-op">'+
        '<div>'+escapeHtml(r.operator.name)+'</div>'+
        (r.operator.address ? '<div class="muted">'+escapeHtml(r.operator.address)+'</div>' : '')+
        (r.operator.tel ? '<div class="muted">Tel: '+escapeHtml(r.operator.tel)+'</div>' : '')+
        (r.operator.email ? '<div class="muted">'+escapeHtml(r.operator.email)+'</div>' : '')+
        (r.capacity ? '<div class="muted">Capacity: '+escapeHtml(r.capacity)+'</div>' : '')+
        (r.contacts && r.contacts.length ? r.contacts.map(function(c){
          return '<div class="muted" style="margin-top:6px;">'+escapeHtml(c.label)+(c.tel?': '+escapeHtml(c.tel):'')+'</div>';
        }).join('') : '')+
        '</div></div>';
    }
    if(r.specifiedRoute){
      html += '<div class="sched-section"><h3>SPECIFIED ROUTE</h3><div class="sched-route-text">'+escapeHtml(r.specifiedRoute)+'</div></div>';
    }
    body.innerHTML = html;
    renderPax();
  }
  document.getElementById('schedBody').addEventListener('click', function(e){
    var btn = e.target.closest('.sched-pax-btn');
    if(!btn) return;
    paxAdjustStop(parseInt(btn.getAttribute('data-sidx'),10), parseInt(btn.getAttribute('data-dir'),10), btn.getAttribute('data-stopkey'));
  });
  // Refresh the live shading every 20s while the schedule tab is open
  setInterval(function(){
    renderSchedule();
  }, 20000);

  /* ---------------- Drawer open/close ---------------- */
  var drawer = document.getElementById('drawer'), scrim = document.getElementById('scrim');
  function openDrawer(){ drawer.classList.add('open'); scrim.classList.add('open'); }
  function closeDrawer(){ drawer.classList.remove('open'); scrim.classList.remove('open'); }
  document.getElementById('menuBtn').addEventListener('click', openDrawer);
  document.getElementById('drawerClose').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);

  /* ---------------- GPS tracking ---------------- */
  var trackBtn = document.getElementById('trackBtn');
  var satnavEnding = false, satnavHistPushed = false, satnavWantFullscreen = false;
  var navBtn = document.getElementById('navBtn');
  var firstStopBtn = document.getElementById('firstStopBtn');
  var gpsNote = document.getElementById('gpsNote');

  // Draws an in-app route to the first stop. Tries a free public road-routing
  // service (no key needed) so the line follows real streets; if that request
  // can't reach out — which is expected inside Claude's own sandbox, same
  // restriction that blocks map tiles there — it falls back to a straight-line
  // distance/bearing guide instead, computed entirely from the GPX data.
  var COACH_MAX_MPH = 62;
  var COACH_MAX_MPS = COACH_MAX_MPH * 0.44704;

  // OSRM estimates time assuming a car. We keep its road distance/geometry
  // (still the best guess at the actual path) but recompute the time using
  // each step's own implied speed, capped at the coach's max — so a
  // motorway-fast car estimate doesn't understate a coach's real trip time.
  function coachDurationFromSteps(steps, fallbackDuration){
    if(!steps || !steps.length) return fallbackDuration;
    var total = 0;
    steps.forEach(function(s){
      var d = s.distance||0, t = s.duration||0;
      var carMps = t>0 ? d/t : 0;
      var mps = carMps>0 ? Math.min(carMps, COACH_MAX_MPS) : COACH_MAX_MPS;
      total += mps>0 ? d/mps : 0;
    });
    return total || fallbackDuration;
  }

  function fetchOsrmRoute(origin, dest){
    var url = 'https://router.project-osrm.org/route/v1/driving/'+
      origin[1]+','+origin[0]+';'+dest[1]+','+dest[0]+'?overview=full&geometries=geojson&steps=true';
    var controller = (typeof AbortController!=='undefined') ? new AbortController() : null;
    var t = controller ? setTimeout(function(){ controller.abort(); }, 6000) : null;
    return fetch(url, controller ? { signal: controller.signal } : {})
      .then(function(res){
        if(t) clearTimeout(t);
        if(!res.ok) return null;
        return res.json();
      })
      .then(function(data){
        if(!data || data.code!=='Ok' || !data.routes || !data.routes.length) return null;
        var route = data.routes[0];
        var coords = route.geometry.coordinates.map(function(c){ return [c[1], c[0]]; });
        var steps = (route.legs && route.legs[0] && route.legs[0].steps) || [];
        var coachDuration = coachDurationFromSteps(steps, route.duration);
        return { coords:coords, distance:route.distance, duration:coachDuration, carDuration:route.duration };
      })
      .catch(function(){ if(t) clearTimeout(t); return null; });
  }
  function fmtDuration(sec){
    var m = Math.round(sec/60);
    if(m<60) return m+' min';
    var h=Math.floor(m/60), mm=m%60;
    return h+'h'+(mm?' '+mm+'m':'');
  }

  var guideLine = null, guiding = false;
  var guideNote = document.getElementById('guideNote');

  function clearGuide(){
    if(guideLine){ map.removeLayer(guideLine); guideLine=null; }
    guiding = false;
    firstStopBtn.classList.remove('on');
    firstStopBtn.textContent = '📍  Directions to first stop';
    guideNote.textContent = '';
  }
  // Trim the violet "direct to first stop" guide as you progress along it (same idea as the orange route).
  function trimGuideBehind(latlng){
    if(!guiding || !guideLine) return;
    var latlngs = guideLine.getLatLngs();
    if(!latlngs || latlngs.length<2) return;
    var pts = latlngs.map(function(ll){ return [ll.lat, ll.lng]; });
    var idx = findNearestTrackIndex(latlng, pts);
    if(idx<1 || haversineMeters(latlng, pts[idx]) > 80) return;
    var rest = pts.slice(Math.max(0, idx-1));
    if(rest.length<2){ clearGuide(); return; }
    guideLine.setLatLngs(rest);
  }

  firstStopBtn.addEventListener('click', function(){
    if(guiding){ clearGuide(); return; }

    var r = activeId ? routes[activeId] : null;
    var target = (r && r.stops && r.stops.length) ? r.stops[0] : (r && r.track && r.track.length ? r.track[0] : null);
    if(!target){ guideNote.textContent = 'No stops on this route yet.'; return; }

    firstStopBtn.disabled = true;
    guideNote.textContent = 'Finding your location…';
    var COACH_NOTE = ' Live road routing uses a car profile (not coach/HGV) and may suggest roads unsuitable for coaches — prefer the orange planned route once you join it.';

    function withOrigin(origin){
      // Soft mitigation: if you are already near the start of the recorded GPX/route track, draw along
      // that planned coach path instead of asking a car router for a new road path.
      var trackStart = (r && r.track && r.track.length) ? r.track[0] : null;
      var nearTrack = trackStart && haversineMeters(origin, trackStart) <= 120;
      if(nearTrack){
        if(guideLine){ map.removeLayer(guideLine); guideLine=null; }
        var along = r.track.slice(0, Math.min(r.track.length, 40));
        guideLine = L.polyline([origin].concat(along.slice(0,1)).concat([]), { color:getCss('--guide')||'#7c3aed', weight:5, opacity:.9, dashArray:'2,10' }).addTo(map);
        // short hop to the track start, then the planned track is already the orange line on the map
        guideLine = L.polyline([origin, trackStart], { color:getCss('--guide')||'#7c3aed', weight:6, opacity:.95, dashArray:'1,10', lineCap:'round' }).addTo(map);
        var fd0 = fmtDist(haversineMeters(origin, trackStart));
        guideNote.textContent = 'To the start of your planned route: '+fd0.v+fd0.u+' (using the recorded route — coach-safe). Follow the orange line.';
        map.fitBounds(L.latLngBounds([origin, trackStart]), { padding:[40,40] });
        guiding = true; firstStopBtn.disabled = false; firstStopBtn.classList.add('on');
        firstStopBtn.textContent = '✕  Clear guide to first stop';
        return;
      }
      guideNote.textContent = 'Working out a route to Stop 1…';
      fetchOsrmRoute(origin, target).then(function(res){
        if(guideLine){ map.removeLayer(guideLine); guideLine=null; }
        if(res){
          guideLine = L.polyline(res.coords, { color:getCss('--guide')||'#7c3aed', weight:6, opacity:.95, dashArray:'1,10', lineCap:'round' }).addTo(map);
          var fd = fmtDist(res.distance);
          guideNote.textContent = 'To Stop 1: '+fd.v+fd.u+' · about '+fmtDuration(res.duration)+' by road (coach pace, max '+COACH_MAX_MPH+' mph).'+COACH_NOTE;
        } else {
          var d = haversineMeters(origin, target);
          guideLine = L.polyline([origin, target], { color:getCss('--guide')||'#7c3aed', weight:5, opacity:.9, dashArray:'2,10' }).addTo(map);
          var fd2 = fmtDist(d);
          guideNote.textContent = 'To Stop 1: '+fd2.v+fd2.u+' as the crow flies (no road-routing service reachable here — straight line shown).'+COACH_NOTE;
        }
        map.fitBounds(guideLine.getBounds(), { padding:[40,40] });
        guiding = true;
        firstStopBtn.disabled = false;
        firstStopBtn.classList.add('on');
        firstStopBtn.textContent = '✕  Clear guide to first stop';
      });
    }

    if(tracking && lastFix){
      withOrigin(lastFix.latlng);
    } else if(navigator.geolocation){
      navigator.geolocation.getCurrentPosition(function(pos){
        withOrigin([pos.coords.latitude, pos.coords.longitude]);
      }, function(){
        firstStopBtn.disabled = false;
        guideNote.textContent = 'Could not get your location.';
      }, { enableHighAccuracy:true, timeout:12000 });
    } else {
      firstStopBtn.disabled = false;
      guideNote.textContent = 'This browser does not support GPS location.';
    }
  });

  navBtn.addEventListener('click', function(){
    var r = activeId ? routes[activeId] : null;
    var pts = (r && r.stops && r.stops.length>=2) ? r.stops : (r && r.track && r.track.length>=2 ? [r.track[0], r.track[r.track.length-1]] : null);
    if(!pts){
      gpsNote.textContent = 'No stops on this route to navigate to yet.';
      return;
    }
    // Google Maps' waypoints parameter tops out around 25 stops — thin
    // the list evenly if a route ever has more than that, keeping the
    // first and last stop fixed.
    var MAX = 25;
    var use = pts;
    if(pts.length > MAX){
      use = [pts[0]];
      var step = (pts.length-1)/(MAX-1);
      for(var i=1;i<MAX-1;i++) use.push(pts[Math.round(i*step)]);
      use.push(pts[pts.length-1]);
    }
    var origin = use[0], dest = use[use.length-1];
    var mid = use.slice(1,-1).map(function(p){ return p[0]+','+p[1]; }).join('|');
    var url = 'https://www.google.com/maps/dir/?api=1'+
      '&origin='+origin[0]+','+origin[1]+
      '&destination='+dest[0]+','+dest[1]+
      (mid ? '&waypoints='+encodeURIComponent(mid) : '')+
      '&travelmode=driving';
    window.open(url, '_blank', 'noopener');
  });

  var statSpeed = document.getElementById('statSpeed');
  var statDist = document.getElementById('statDist');
  var statDistUnit = document.getElementById('statDistUnit');
  var statStop = document.getElementById('statStop');
  var statStopDist = document.getElementById('statStopDist');

  // Smoothing for the *visual* marker/camera/bearing only — raw GPS fixes
  // are noisy enough on their own to make the marker and rotation feel
  // jumpy even when driving in a straight line. Every distance/off-route/
  // turn/stop calculation below still uses the real, unsmoothed fix — only
  // where something moves on screen does the smoothed value get used.
  var smoothLatLng = null, smoothHeading = null;   // what is drawn on screen right now
  var lastFixPos = null, lastFixPerf = 0;          // latest real GPS fix + when it arrived
  var velLat = 0, velLng = 0;                      // estimated velocity, degrees per ms
  var targetHeading = null;
  var POS_TAU_MS = 220;      // how quickly the drawn position catches up with the predicted one
  var HEAD_TAU_MS = 350;     // same for the map rotation
  var MAX_PREDICT_MS = 2500; // never guess further ahead than this if fixes stop arriving
  var fixHistory = [], lastTravelHeading = null, TRAVEL_MIN_M = 10; // metres moved before a direction counts
  var renderRunning = false, lastFrameT = 0, lastTileKick = 0;

  var MAX_PLAUSIBLE_MPS = 70, MAX_PREDICT_MPS = 40;   // ~155 mph = GPS jump; predict at most ~90 mph
  function degSpeedMps(vLa, vLn, lat){   // degrees per ms -> metres per second
    var mLa = vLa*111320, mLn = vLn*111320*Math.cos(lat*Math.PI/180);
    return Math.sqrt(mLa*mLa + mLn*mLn)*1000;
  }
  function angDiff(a, b){ return ((a - b + 540) % 360) - 180; }

  // Called for every real GPS fix: records where we are and how fast we're
  // going. Nothing is drawn here — the frame loop below does the drawing.
  function feedFix(latlng, ts, speedMps){
    var nowP = performance.now();
    if(lastFixPos && ts > lastFixPos.ts){
      var dtMs = ts - lastFixPos.ts;
      if(dtMs < 6000){
        var vLa = (latlng[0]-lastFixPos.latlng[0])/dtMs;
        var vLn = (latlng[1]-lastFixPos.latlng[1])/dtMs;
        if(degSpeedMps(vLa, vLn, latlng[0]) > MAX_PLAUSIBLE_MPS){
          // A GPS jump (re-acquired signal, bad fix): no bus moves that fast. Don't turn it
          // into a velocity — that used to fling the predicted dot (and the Sat-Nav camera)
          // hundreds of miles away. Just jump to the new fix and start again.
          velLat = 0; velLng = 0; smoothLatLng = latlng.slice();
        } else {
          velLat = velLat*0.4 + vLa*0.6;   // blend so one noisy fix can't fling the dot
          velLng = velLng*0.4 + vLn*0.6;
        }
      } else { velLat = 0; velLng = 0; smoothLatLng = latlng.slice(); }
    }
    // Never predict faster than a bus can go.
    var vs = degSpeedMps(velLat, velLng, latlng[0]);
    if(vs > MAX_PREDICT_MPS){ velLat *= MAX_PREDICT_MPS/vs; velLng *= MAX_PREDICT_MPS/vs; }
    // Standing still: GPS wobble looks like movement, so drop the velocity.
    if(speedMps!=null && !isNaN(speedMps) && speedMps < 0.6){ velLat = 0; velLng = 0; }
    lastFixPos = { latlng: latlng.slice(), ts: ts };
    lastFixPerf = nowP;
    if(!smoothLatLng) smoothLatLng = latlng.slice();
    startRenderLoop();
  }

  function startRenderLoop(){
    if(renderRunning) return;
    renderRunning = true;
    lastFrameT = performance.now();
    requestAnimationFrame(renderFrame);
  }

  // Runs on every screen refresh (~60 fps). Predicts where the vehicle is
  // *now* from the last fix plus its velocity, glides the dot and camera
  // toward that point and eases the rotation toward the current heading.
  // That's what makes the map move continuously like a real sat-nav rather
  // than hopping once per GPS update.
  function renderFrame(now){
    if(!tracking || !lastFixPos || !smoothLatLng){ renderRunning = false; return; }
    var dt = Math.min(100, Math.max(1, now - lastFrameT));
    lastFrameT = now;

    var ahead = Math.min(MAX_PREDICT_MS, now - lastFixPerf);
    var tgtLat = lastFixPos.latlng[0] + velLat*ahead;
    var tgtLng = lastFixPos.latlng[1] + velLng*ahead;
    var k = 1 - Math.exp(-dt/POS_TAU_MS);
    smoothLatLng = [
      smoothLatLng[0] + (tgtLat - smoothLatLng[0])*k,
      smoothLatLng[1] + (tgtLng - smoothLatLng[1])*k
    ];

    if(targetHeading!=null){
      if(smoothHeading==null) smoothHeading = targetHeading;
      else {
        var kh = 1 - Math.exp(-dt/HEAD_TAU_MS);
        smoothHeading = (smoothHeading + kh*angDiff(targetHeading, smoothHeading) + 360) % 360;
      }
      // Bearing first, then pan (the rotate plugin needs it in that order).
      // The rotate plugin's bearing turns the map clockwise, so to put the
      // direction of travel at the top of the screen the bearing must be
      // the opposite of the heading (heading 90 = east -> bearing 270).
      var mapBrg = (360 - smoothHeading) % 360;
      if(Math.abs(angDiff(mapBrg, map.getBearing())) > 0.05) map.setBearing(mapBrg);
    }

    if(liveMarker) liveMarker.setLatLng(smoothLatLng);

    if(followMe && !map._animatingZoom){
      // Cheap pan: shift the map pane by the tiny remaining offset instead of
      // calling setView every frame (which resets the whole view and is far
      // too heavy at 60 fps).
      // In sat-nav mode the vehicle sits low on the screen (like a real
      // sat-nav) so most of the map shows the road ahead.
      var sz = map.getSize();
      var aim = sz.divideBy(2);
      if(document.body.classList.contains('satnav-mode')) aim = L.point(sz.x/2, sz.y*0.64);
      var off = map.latLngToContainerPoint(smoothLatLng).subtract(aim);
      if(Math.abs(off.x) > 0.02 || Math.abs(off.y) > 0.02){
        map._rawPanBy(off);
        map.fire('move');
        // Every so often let Leaflet settle and load newly exposed tiles.
        if(now - lastTileKick > 400){ lastTileKick = now; map.fire('moveend'); }
      }
    }
    autoZoomTick(now);
    requestAnimationFrame(renderFrame);
  }
  function resetSmoothing(){
    smoothLatLng = null; smoothHeading = null; targetHeading = null;
    lastFixPos = null; velLat = 0; velLng = 0;
    fixHistory = []; lastTravelHeading = null;
    currentGpsStopIdx = null; lastFix = null;   // no live position any more -> taps are no longer "at a stop"
    updateNextStop();
  }

  function onPosition(pos){
    var c = pos.coords;
    var latlng = [c.latitude, c.longitude];
    feedFix(latlng, pos.timestamp || Date.now(), c.speed);
    var displayLatLng = smoothLatLng;

    if(!liveMarker){
      liveMarker = L.marker(displayLatLng, { icon: liveIcon(), zIndexOffset:1000 }).addTo(map);
      liveMarker.bindPopup('');
    }
    liveMarker.setPopupContent('You are here<br><a class="maps-link" target="_blank" rel="noopener" href="'+mapsLink(latlng[0],latlng[1])+'">Open in Maps ↗</a>');

    // Heading priority: (1) the road itself — steadiest, since the route's
    // shape doesn't jitter like GPS does, used whenever you're on/near the
    // loaded route; (2) the device's own coords.heading, which is often
    // null in practice (many phones only populate it above a speed
    // threshold); (3) the bearing between this GPS fix and the last one,
    // once you've moved far enough for that to be meaningful.
    //
    // IMPORTANT: bearing must be set BEFORE panning, not after. The
    // rotate plugin's pan/pixel-origin math is rotation-aware, but only
    // computes correctly when it already knows the target bearing —
    // panning first and rotating second (what this used to do) is exactly
    // what caused the map to visibly jump/jitter on every single update.
    // Heading = the direction you are actually travelling across the map:
    // the bearing from where you were a few metres back to where you are
    // now (ignores the phone's own compass/GPS heading). While you're
    // stopped or crawling it holds the last direction instead of spinning.
    var headingSrc = 'none';
    var heading = null;
    fixHistory.push({ latlng: latlng, t: pos.timestamp || Date.now() });
    if(fixHistory.length > 40) fixHistory.shift();
    for(var hi = fixHistory.length-2; hi >= 0; hi--){
      var dHist = haversineMeters(fixHistory[hi].latlng, latlng);
      if(dHist >= TRAVEL_MIN_M){
        heading = bearing(fixHistory[hi].latlng, latlng);
        headingSrc = 'travel';
        lastTravelHeading = heading;
        break;
      }
    }
    if(heading==null && lastTravelHeading!=null){ heading = lastTravelHeading; headingSrc = 'held'; }
    if(tracking && heading!=null){
      targetHeading = heading;   // the frame loop eases the map round to this
    }
    var hdgDebugEl = document.getElementById('hdgDebug');
    if(hdgDebugEl){
      hdgDebugEl.textContent = (heading!=null && smoothHeading!=null ? Math.round(smoothHeading)+'\u00b0' : '–') + ' ' + headingSrc + (tracking?'':' (off)');
    }
    if(liveMarker && liveMarker.getElement){
      var iconElForWedge = liveMarker.getElement();
      var wedgeEl = iconElForWedge && iconElForWedge.querySelector('.heading-wedge');
      if(wedgeEl) wedgeEl.style.opacity = heading!=null ? '1' : '0.3';
    }
    // (camera follow now happens every frame in renderFrame)

    var mph = null;
    if(c.speed!==null && c.speed!==undefined && !isNaN(c.speed)){
      mph = c.speed*2.23694;
    } else if(lastFix){
      var dt = (pos.timestamp - lastFix.timestamp)/1000;
      if(dt>0.5){
        var dm = haversineMeters(lastFix.latlng, latlng);
        mph = (dm/dt)*2.23694;
      }
    }
    statSpeed.textContent = mph===null ? '–' : Math.max(0, Math.round(mph));
    lastFix = { latlng:latlng, timestamp:pos.timestamp };
    snCurMph = mph===null ? null : Math.max(0, mph);
    updateSatnavSpeed();
    lookupSpeedLimit(latlng);

    var r = activeId ? routes[activeId] : null;
    if(r){
      var d = distanceToTrack(latlng, r.track && r.track.length>1 ? r.track : r.stops);
      var fd = fmtDist(d);
      statDist.textContent = fd.v; statDistUnit.textContent = fd.u;

      if(tracking || document.body.classList.contains('satnav-mode')) updateNavProgress(r, latlng);
      var ns = nearestStop(latlng, r.stops);
      // two stops in the same place (start/end of a loop): count Board taps at the one due next
      var expI = navProg.started ? navProg.stopIdx : 0;
      [expI, expI+1].forEach(function(k){ if(ns && r.stops[k] && k !== ns.index && haversineMeters(latlng, r.stops[k]) <= AT_STOP_RADIUS_M && ns.dist <= AT_STOP_RADIUS_M) ns = { index:k, dist:haversineMeters(latlng, r.stops[k]) }; });
      if(ns){
        statStop.textContent = '#'+(ns.index+1);
        var fs = fmtDist(ns.dist);
        statStopDist.textContent = fs.v+fs.u+' away';
        stopsGroup.eachLayer(function(m){});
      } else {
        statStop.textContent = '–'; statStopDist.textContent = '';
      }
      // "At a stop" for passenger-count purposes means genuinely close by —
      // a tight radius so Board taps don't get misattributed while
      // still moving between stops.
      currentGpsStopIdx = (ns && ns.dist<=AT_STOP_RADIUS_M) ? ns.index : null;
      markGpsHere();
      updateNextStop(latlng);
      updateNavBanner(r, latlng);
      // Sat-nav style: once stop 1 is reached, hide the path already travelled (display only)
      redrawActiveTrack();
      if(guiding) trimGuideBehind(latlng);
      maybePromptFinish(r);
    } else {
      statDist.textContent = '–'; statDistUnit.textContent = '';
      statStop.textContent = '–'; statStopDist.textContent = '';
      navBanner.style.display = 'none';
      satnavTop.style.display = 'none';
      satnavThen.style.display = 'none';
      currentGpsStopIdx = null;
      updateNextStop(latlng);
    }
    gpsNote.textContent = '';
  }

  var navBanner = document.getElementById('navBanner');
  var navTurnArrow = document.getElementById('navTurnArrow');
  var navTurnDist = document.getElementById('navTurnDist');
  var navStopDist = document.getElementById('navStopDist');
  var TURN_GLYPH = { left:'↰', right:'↱' };

  var satnavTop = document.getElementById('satnavTop');
  var satnavArrow = document.getElementById('satnavArrow');
  var satnavDist = document.getElementById('satnavDist');
  var satnavInstr = document.getElementById('satnavInstr');
  var satnavThen = document.getElementById('satnavThen');
  var sbEta = document.getElementById('sbEta');
  var sbRemaining = document.getElementById('sbRemaining');
  var sbSpeed = document.getElementById('sbSpeed');
  var sbStop = document.getElementById('sbStop');

  function updateNavBanner(r, latlng){
    if(!r.track || r.track.length<3){ navBanner.style.display='none'; satnavTop.style.display='none'; satnavThen.style.display='none'; return; }
    getRouteNav(r);
    var inSatnav = document.body.classList.contains('satnav-mode');
    navBanner.style.display = inSatnav ? 'none' : 'flex';
    satnavTop.style.display = inSatnav ? 'flex' : 'none';

    var progressIdx = navTrackIdx(r, latlng);

    var nextTurn = null, nextTurnPos = -1;
    for(var i=0;i<r._turns.length;i++){ if(r._turns[i].trackIdx >= progressIdx){ nextTurn = r._turns[i]; nextTurnPos = i; break; } }
    var thenTurn = (nextTurnPos>=0 && r._turns[nextTurnPos+1]) ? r._turns[nextTurnPos+1] : null;

    if(nextTurn){
      var glyph = TURN_GLYPH[nextTurn.dir] || '↑';
      var label = (nextTurn.dir==='left'?'Left':'Right')+(nextTurn.angle>=80?' turn':'');
      var td = fmtDist(haversineMeters(latlng, nextTurn.latlng));
      navTurnArrow.textContent = glyph;
      navTurnDist.textContent = label+' in '+td.v+td.u;
      satnavArrow.textContent = glyph;
      satnavDist.textContent = td.v+td.u;
      satnavInstr.textContent = label;
    } else {
      navTurnArrow.textContent = '🏁'; navTurnDist.textContent = 'No more turns';
      satnavArrow.textContent = '🏁'; satnavDist.textContent = '–'; satnavInstr.textContent = 'No more turns';
    }
    if(inSatnav && thenTurn){
      var thenGlyph = TURN_GLYPH[thenTurn.dir] || '↑';
      satnavThen.style.display = 'flex';
      satnavThen.innerHTML = 'Then <span class="then-arrow">'+thenGlyph+'</span> '+(thenTurn.dir==='left'?'left':'right');
    } else {
      satnavThen.style.display = 'none';
    }

    var nextStopI = -1;
    for(var j=0;j<r._stopTrackIdx.length;j++){ if(r._stopTrackIdx[j] >= progressIdx){ nextStopI = j; break; } }
    if(nextStopI>=0){
      var sd = fmtDist(haversineMeters(latlng, r.stops[nextStopI]));
      navStopDist.textContent = 'Stop '+(nextStopI+1)+' · '+sd.v+sd.u;
      sbStop.textContent = '#'+(nextStopI+1)+' '+sd.v+sd.u;
    } else {
      navStopDist.textContent = 'Route complete';
      sbStop.textContent = '–';
    }

    if(inSatnav){
      var remainM = Math.max(0, (r._cum[r._cum.length-1]||0) - (r._cum[progressIdx]||0));
      var rd = fmtDist(remainM);
      sbRemaining.textContent = rd.v+rd.u;
      var curMph = parseFloat(statSpeed.textContent);
      var planMph = (!isNaN(curMph) && curMph>5) ? Math.min(curMph, COACH_MAX_MPH) : Math.min(30, COACH_MAX_MPH);
      sbSpeed.textContent = isNaN(curMph) ? '–' : Math.round(curMph);
      var etaMinutes = Math.round((remainM/1609.34)/planMph*60);
      var etaDate = new Date(Date.now()+etaMinutes*60000);
      var hh = etaDate.getHours(), mm = etaDate.getMinutes();
      sbEta.textContent = (hh<10?'0':'')+hh+':'+(mm<10?'0':'')+mm;
    }
  }

  function onPositionError(err){
    var msg = 'GPS unavailable.';
    if(err && err.code===1) msg = 'Location permission denied — enable it in your browser settings to track your position.';
    else if(err && err.code===2) msg = 'Location signal unavailable right now.';
    else if(err && err.code===3) msg = 'Location request timed out — still trying…';
    gpsNote.textContent = msg;
  }

  trackBtn.addEventListener('click', function(){
    if(!tracking){
      if(!navigator.geolocation){
        gpsNote.textContent = 'This browser does not support GPS location.';
        return;
      }
      tracking = true;
      followMe = true;
      ensureRunStarted();
      trackBtn.classList.add('on');
      trackBtn.textContent = '■  Stop GPS tracking';
      gpsNote.textContent = 'Finding your location…';
      try{
        watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
          enableHighAccuracy:true, maximumAge:0, timeout:15000
        });
      }catch(e){
        gpsNote.textContent = 'Could not start GPS tracking.';
        tracking = false; trackBtn.classList.remove('on'); trackBtn.textContent = '▶  Start GPS tracking';
      }
    } else {
      tracking = false;
      trackBtn.classList.remove('on');
      trackBtn.textContent = '▶  Start GPS tracking';
      gpsNote.textContent = '';
      navBanner.style.display = 'none';
      map.setBearing(0);
      resetSmoothing();
      // Ending GPS from End Sat-Nav already owns teardown — don't recurse into endSatnav.
      if(document.body.classList.contains('satnav-mode') && !satnavEnding && typeof endSatnav==='function') endSatnav();
      if(watchId!==null && navigator.geolocation){ navigator.geolocation.clearWatch(watchId); watchId=null; }
      redrawActiveTrack();
    }
  });

  // Full-screen map: hides the top bar / tabs / bottom panel so the map
  // fills the screen. Also tries the browser's native Fullscreen API (hides
  // the browser chrome too) where the platform supports it — iOS Safari
  // generally doesn't, so this quietly no-ops there and the CSS-only
  // full-bleed layout still does the main job everywhere.
  var fsFab = document.getElementById('fsFab');
  var fsExit = document.getElementById('fsExit');
  function setFullscreen(on){
    document.body.classList.toggle('fs-mode', on);
    fsFab.classList.toggle('active', on);
    if(on){
      try{
        var el = document.documentElement;
        if(el.requestFullscreen) el.requestFullscreen().catch(function(){});
        else if(el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      }catch(e){}
    } else {
      try{
        if(document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function(){});
        else if(document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
      }catch(e){}
    }
    // The real Fullscreen API transition can take a moment to actually
    // finish resizing the viewport, so retry a couple of times.
    [120, 350].forEach(function(ms){ setTimeout(function(){ map.invalidateSize(); }, ms); });
  }
  fsFab.addEventListener('click', function(){
    if(document.body.classList.contains('satnav-mode')){ endSatnav(); return; }
    setFullscreen(!document.body.classList.contains('fs-mode'));
  });

  // Sat-Nav mode: one button that turns on everything a sat-nav view needs —
  // full screen, heading-based spin (which kicks in automatically once
  // tracking starts, per the spin logic above), and swaps the small
  // turn/stop cards for the big top instruction bar + bottom ETA bar.
  // Flat 2D throughout — no 3D tilt.
  var satnavBtn = document.getElementById('satnavBtn');
  // History: one pushState while Sat-Nav is open so Back exits Sat-Nav to the driver view only once.
  // Re-entering after backgrounding must NOT stack duplicate entries (that made Back overshoot / leave the SPA).
  function pushSatnavHistory(){
    if(satnavHistPushed) return;
    try{
      history.pushState({ rtSatnav: true }, '', location.href);
      satnavHistPushed = true;
    }catch(e){}
  }
  function popSatnavHistory(){
    if(!satnavHistPushed) return;
    satnavHistPushed = false;
    try{
      if(history.state && history.state.rtSatnav) history.back();
    }catch(e){}
  }
  function ensureGpsWatch(){
    if(tracking && watchId===null && navigator.geolocation){
      try{
        watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
          enableHighAccuracy:true, maximumAge:0, timeout:15000
        });
      }catch(e){}
    }
  }
  function startSatnav(){
    document.body.classList.add('satnav-mode');
    satnavBtn.classList.add('on');
    satnavBtn.textContent = '✕  End Sat-Nav mode';
    fsExit.textContent = '✕ End Sat-Nav';
    snWake(true); snAutoZoomAt = 0; snUserZoomUntil = 0;
    satnavWantFullscreen = true;
    setFullscreen(true);
    pushSatnavHistory();
    if(!tracking) trackBtn.click();
    else ensureGpsWatch();
    if(activeId && routes[activeId]) updateNavBanner(routes[activeId], lastFix ? lastFix.latlng : (map.getCenter?[map.getCenter().lat,map.getCenter().lng]:[0,0]));
    updateNextStop();
  }
  function endSatnav(fromPopstate){
    satnavEnding = true;
    satnavWantFullscreen = false;
    if(typeof previewActive!=='undefined' && previewActive){
      previewActive = false;
      restorePreviewProg();
      if(previewTimer){ clearInterval(previewTimer); previewTimer = null; }
      previewBtn.classList.remove('on');
      previewBtn.textContent = '🎬  Preview this route';
      tracking = false;
      map.setBearing(0);
      resetSmoothing();
    }
    snWake(false);
    if(tracking) trackBtn.click();   // GPS has no button of its own now, so ending Sat-Nav stops it
    document.body.classList.remove('satnav-mode');
    satnavBtn.classList.remove('on');
    satnavBtn.textContent = '🛰️  Start Sat-Nav mode';
    fsExit.textContent = '✕ Exit full screen';
    setFullscreen(false);
    satnavTop.style.display = 'none';
    satnavThen.style.display = 'none';
    document.getElementById('satnavBottom').style.display = 'none';
    redrawActiveTrack();             // v13: back to the whole route (and its stops) on the driver view
    updateNextStop();
    if(!fromPopstate) popSatnavHistory();
    else satnavHistPushed = false;
    satnavEnding = false;
    setTimeout(notifyIdle, 0);       // v15: a new duty day waiting for the end of the drive can start now
  }
  satnavBtn.addEventListener('click', function(){
    if(document.body.classList.contains('satnav-mode')) endSatnav(); else startSatnav();
  });
  window.addEventListener('popstate', function(ev){
    if(document.body.classList.contains('satnav-mode')){
      // Back while in Sat-Nav: leave Sat-Nav only (stay on the driver view)
      endSatnav(true);
    }
  });

  // Route preview — "drives" the loaded route by walking along its own
  // track at a steady simulated speed and feeding each point through the
  // exact same onPosition() function real GPS updates use. That means the
  // map pan, rotation (road-derived, since we're always exactly on the
  // track), big turn card, ETA bar and schedule shading all behave
  // identically to a real drive, with nothing duplicated or faked twice.
  var previewBtn = document.getElementById('previewBtn');
  var previewActive = false, previewTimer = null, previewDistance = 0, previewSavedProg = null;
  function restorePreviewProg(){ if(previewSavedProg){ navProg = previewSavedProg; previewSavedProg = null; } }
  var PREVIEW_SPEED_MPS = 13.4; // ~30 mph simulated
  var PREVIEW_TICK_MS = 500;

  function positionAtDistance(track, cum, dist){
    if(!track || !track.length) return null;
    if(dist<=0) return track[0];
    if(dist>=cum[cum.length-1]) return track[track.length-1];
    var i=0;
    while(i<cum.length-2 && cum[i+1]<dist) i++;
    var segStart=cum[i], segEnd=cum[i+1];
    var frac = segEnd>segStart ? (dist-segStart)/(segEnd-segStart) : 0;
    var a=track[i], b=track[i+1];
    return [ a[0]+(b[0]-a[0])*frac, a[1]+(b[1]-a[1])*frac ];
  }
  function previewTick(){
    var r = activeId ? routes[activeId] : null;
    if(!r || !r.track || r.track.length<2 || !previewActive){ stopPreview(); return; }
    getRouteNav(r);
    var total = r._cum[r._cum.length-1] || 0;
    if(previewDistance >= total){ stopPreview(); return; }
    var latlng = positionAtDistance(r.track, r._cum, previewDistance);
    previewDistance += PREVIEW_SPEED_MPS * (PREVIEW_TICK_MS/1000);
    onPosition({
      coords: { latitude:latlng[0], longitude:latlng[1], heading:null, speed:PREVIEW_SPEED_MPS, accuracy:5 },
      timestamp: Date.now()
    });
  }
  function startPreview(){
    var r = activeId ? routes[activeId] : null;
    if(!r || !r.track || r.track.length<2){ gpsNote.textContent = 'No route track to preview.'; return; }
    if(tracking) trackBtn.click(); // stop any real GPS tracking first, don't run both at once
    previewActive = true;
    previewDistance = 0;
    previewSavedProg = navProg; resetNavProgress();   // a preview drive never touches the real run's progress
    ensureRunStarted();
    tracking = true;   // reuses onPosition's normal tracking-gated rotation logic
    followMe = true;
    previewBtn.classList.add('on');
    previewBtn.textContent = '⏹  Stop preview';
    document.body.classList.add('satnav-mode');
    setFullscreen(true);
    previewTimer = setInterval(previewTick, PREVIEW_TICK_MS);
    previewTick();
  }
  function stopPreview(){
    previewActive = false;
    restorePreviewProg();
    tracking = false;
    if(previewTimer){ clearInterval(previewTimer); previewTimer = null; }
    previewBtn.classList.remove('on');
    previewBtn.textContent = '🎬  Preview this route';
    map.setBearing(0);
    resetSmoothing();
    endSatnav();
  }
  previewBtn.addEventListener('click', function(){
    if(previewActive) stopPreview(); else startPreview();
  });
  fsExit.addEventListener('click', function(){
    if(document.body.classList.contains('satnav-mode')) endSatnav(); else setFullscreen(false);
  });
  document.addEventListener('fullscreenchange', function(){
    setTimeout(function(){ map.invalidateSize(); }, 30);
    if(document.fullscreenElement) return;
    // Mobile browsers exit fullscreen when the app is backgrounded — that must NOT tear down Sat-Nav.
    if(document.hidden || document.visibilityState === 'hidden') return;
    if(document.body.classList.contains('satnav-mode')){
      // User left fullscreen while still wanting Sat-Nav: keep Sat-Nav CSS mode, drop only native fullscreen.
      // (fsExit / End Sat-Nav still call endSatnav intentionally.)
      if(satnavWantFullscreen && !satnavEnding){
        document.body.classList.add('fs-mode');
        return;
      }
      endSatnav();
    } else if(document.body.classList.contains('fs-mode')) setFullscreen(false);
  });


  /* ---------------- Sat-nav extras: clock, speed, speed limit, auto-zoom ---------------- */
  var snCurMph = null, snLimitMph = null;
  var snClock = document.getElementById('snClock');
  var snSpeed = document.getElementById('snSpeed');
  var snSpeedBox = document.getElementById('snSpeedBox');
  var snLimit = document.getElementById('snLimit');
  function tickClock(){
    var n = new Date(), h = n.getHours(), m = n.getMinutes();
    snClock.textContent = (h<10?'0':'')+h+':'+(m<10?'0':'')+m;
  }
  tickClock(); setInterval(tickClock, 1000);
  function updateSatnavSpeed(){
    snSpeed.textContent = snCurMph===null ? '–' : Math.round(snCurMph);
    snSpeedBox.classList.toggle('over', snLimitMph!=null && snCurMph!=null && Math.round(snCurMph) > snLimitMph + 2);
  }
  function showLimit(v){
    snLimitMph = v;
    snLimit.textContent = v==null ? '–' : v;
    snLimit.classList.toggle('unknown', v==null);
    updateSatnavSpeed();
  }
  // Speed limit comes from OpenStreetMap (via the free Overpass service):
  // the nearest road to you and its "maxspeed" tag. It only asks again after
  // you've moved ~50 m, and keeps the last answer while a lookup is running
  // or if there's no signal. Roads with no limit tagged show a dash.
  var limQueryPos = null, limBusy = false, limLastT = 0, limMisses = 0;
  function parseMaxspeed(t){
    if(!t) return null;
    var v = String(t).toLowerCase().trim();
    var m = v.match(/^(\d+)\s*mph$/);
    if(m) return parseInt(m[1],10);
    m = v.match(/^(\d+)$/);            // bare number in UK data means km/h; convert
    if(m) return Math.round(parseInt(m[1],10)/1.609);
    m = v.match(/^(\d+)\s*km\/h$/);
    if(m) return Math.round(parseInt(m[1],10)/1.609);
    if(v==='national' || v==='gb:nsl_single') return 60;
    if(v==='gb:nsl_dual' || v==='gb:motorway') return 70;
    return null;
  }
  function segDistM(p, a, b){
    var kx = Math.cos(p[0]*Math.PI/180)*111320, ky = 110540;
    var ax=(a.lon-p[1])*kx, ay=(a.lat-p[0])*ky, bx=(b.lon-p[1])*kx, by=(b.lat-p[0])*ky;
    var dx=bx-ax, dy=by-ay, L2=dx*dx+dy*dy, t = L2? Math.max(0,Math.min(1,-(ax*dx+ay*dy)/L2)) : 0;
    var px=ax+t*dx, py=ay+t*dy; return Math.sqrt(px*px+py*py);
  }
  function lookupSpeedLimit(latlng){
    if(limBusy) return;
    var now = Date.now();
    if(limQueryPos && haversineMeters(limQueryPos, latlng) < 50 && now - limLastT < 60000) return;
    if(now - limLastT < 4000) return;
    limBusy = true; limLastT = now; limQueryPos = latlng;
    var q = '[out:json][timeout:8];way(around:30,'+latlng[0].toFixed(6)+','+latlng[1].toFixed(6)+')[highway];out tags geom;';
    var ctl = (typeof AbortController!=='undefined') ? new AbortController() : null;
    var to = setTimeout(function(){ if(ctl) ctl.abort(); }, 9000);
    fetch('https://overpass-api.de/api/interpreter', { method:'POST', body:'data='+encodeURIComponent(q),
        headers:{'Content-Type':'application/x-www-form-urlencoded'}, signal: ctl?ctl.signal:undefined })
      .then(function(r){ return r.json(); })
      .then(function(j){
        var best = null, bestD = 1e9;
        (j.elements||[]).forEach(function(w){
          var g = w.geometry||[]; var t = w.tags||{};
          if(t.highway==='footway'||t.highway==='path'||t.highway==='cycleway'||t.highway==='steps'||t.highway==='service'&&!t.maxspeed) return;
          for(var i=0;i<g.length-1;i++){
            var d = segDistM(latlng, g[i], g[i+1]);
            if(d < bestD){ bestD = d; best = w; }
          }
        });
        var v = best ? parseMaxspeed(best.tags && best.tags.maxspeed) : null;
        if(v==null && best){
          // UK defaults for untagged roads would be guesswork, so only
          // say "unknown" after a couple of misses in a row.
          limMisses++; if(limMisses>=2) showLimit(null);
        } else { limMisses = 0; showLimit(v); }
      })
      .catch(function(){ /* keep last value */ })
      .then(function(){ clearTimeout(to); limBusy = false; });
  }

  // Auto-zoom: closer in when slow / in town, further out at speed, like a
  // sat-nav. Backs off for 25 s whenever you zoom the map yourself.
  var snAutoZoomAt = 0, snUserZoomUntil = 0, snAutoZooming = false;
  function autoZoomTick(now){
    if(!document.body.classList.contains('satnav-mode') || snCurMph==null) return;
    if(now < snUserZoomUntil || now - snAutoZoomAt < 6000 || map._animatingZoom) return;
    var mph = snCurMph, z;
    if(mph < 12) z = 18; else if(mph < 28) z = 17.5; else if(mph < 42) z = 17; else if(mph < 55) z = 16.5; else z = 16;
    if(Math.abs(map.getZoom() - z) < 0.4) return;
    snAutoZoomAt = now; snAutoZooming = true;
    map.setZoomAround(smoothLatLng, z, { animate:true });
    setTimeout(function(){ snAutoZooming = false; }, 700);
  }
  map.on('zoomstart', function(){ if(!snAutoZooming) snUserZoomUntil = performance.now() + 25000; });

  // Snap back to following you 8 s after you drag the map in sat-nav mode.
  var snRecenterTimer = null;
  map.on('dragstart', function(){
    if(!document.body.classList.contains('satnav-mode')) return;
    clearTimeout(snRecenterTimer);
    snRecenterTimer = setTimeout(function(){ followMe = true; }, 8000);
  });

  // Keep the screen on while navigating.
  var snWakeLock = null;
  function snWake(on){
    try{
      if(on && navigator.wakeLock){ navigator.wakeLock.request('screen').then(function(l){ snWakeLock = l; }).catch(function(){}); }
      else if(!on && snWakeLock){ snWakeLock.release(); snWakeLock = null; }
    }catch(e){}
  }
  document.addEventListener('visibilitychange', function(){
    if(document.hidden) return;
    // Returning from another app: keep Sat-Nav, restore wake lock + GPS watch, re-request fullscreen if we still want it.
    if(document.body.classList.contains('satnav-mode')){
      if(!snWakeLock) snWake(true);
      if(tracking) ensureGpsWatch();
      else if(typeof trackBtn !== 'undefined') trackBtn.click();
      if(satnavWantFullscreen && !document.fullscreenElement){
        try{
          var el = document.documentElement;
          if(el.requestFullscreen) el.requestFullscreen().catch(function(){});
          else if(el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        }catch(e){}
      }
      setTimeout(function(){ map.invalidateSize(); }, 120);
      if(activeId && routes[activeId] && lastFix) updateNextStop(lastFix.latlng);
    }
  });

  document.getElementById('zoomInFab').addEventListener('click', function(){ map.zoomIn(); });
  document.getElementById('zoomOutFab').addEventListener('click', function(){ map.zoomOut(); });

  document.getElementById('locateFab').addEventListener('click', function(){
    followMe = true;
    if(liveMarker) map.panTo(liveMarker.getLatLng(), { animate:true });
    else if(!tracking) trackBtn.click();
  });
  map.on('dragstart', function(){ followMe = false; });

  /* ---------------- Stop names, timetable times & the "Next stop" display ---------------- */
  function isGenericStopName(n){ return !n || /^stop\s*\d+$/i.test(String(n).trim()); }
  function normName(n){ return String(n||'').trim().toLowerCase().replace(/\s+/g,' '); }
  // Which timetable part applies now: the route's own session if it has one, else by time of day.
  function currentTimetableRows(r){
    var tt = (r && r.timetable) || {};
    var am = tt.morning || [], pm = tt.afternoon || [];
    var wantAm = r.session==='AM' ? true : r.session==='PM' ? false : (new Date().getHours() < 12);
    var rows = wantAm ? am : pm;
    if(!rows.length) rows = wantAm ? pm : am;
    return rows;
  }
  // Best available name: route.stops name -> timetable row (when rows line up with stops) -> "Stop N".
  function stopName(r, i){
    var n = String((r.stopNames && r.stopNames[i]) || '').trim();
    if(!isGenericStopName(n)) return n;
    var rows = currentTimetableRows(r), count = (r.stops||[]).length;
    if(rows.length && rows.length===count && rows[i] && String(rows[i].stop||'').trim()) return String(rows[i].stop).trim();
    return n || ('Stop '+(i+1));
  }
  // Scheduled time ("HH:MM") for stop i, if the timetable has one: match by name first, else by position.
  function stopSchedTime(r, i){
    var rows = currentTimetableRows(r);
    if(!rows.length) return '';
    var nm = normName(stopName(r, i)), raw = normName(r.stopNames && r.stopNames[i]);
    for(var k=0;k<rows.length;k++){
      var rn = normName(rows[k].stop);
      if(rn && (rn===nm || (raw && rn===raw)) && rows[k].time) return String(rows[k].time);
    }
    if(rows.length===(r.stops||[]).length && rows[i] && rows[i].time) return String(rows[i].time);
    return '';
  }

  var nextStopEl = document.getElementById('nextStop');
  var nsNum = document.getElementById('nsNum'), nsLbl = document.getElementById('nsLbl');
  var nsName = document.getElementById('nsName'), nsDist = document.getElementById('nsDist'), nsTime = document.getElementById('nsTime');
  var nsWait = document.getElementById('nsWait');
  var nsDue = '';      // "HH:MM" of the stop the card shows ('' = no timetable time)
  // Seconds since midnight on the Europe/London wall clock (the timetable's HH:MM are London times).
  function londonNowSec(){
    var d = new Date();
    try{
      var parts = new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/London', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(d);
      var g = function(t){ for(var k=0;k<parts.length;k++) if(parts[k].type===t) return +parts[k].value; return 0; };
      return (g('hour') % 24) * 3600 + g('minute') * 60 + g('second');
    }catch(e){ return d.getHours()*3600 + d.getMinutes()*60 + d.getSeconds(); }
  }
  // "HH:MM" due time -> seconds until it (negative = late). Same day; a gap of more than 12 h is taken as the
  // other side of midnight, so 23:55 vs 00:05 is 10 minutes, not 23 h 50.
  function secsUntilDue(hhmm){
    var m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm||''));
    if(!m) return null;
    var diff = (+m[1] * 3600 + +m[2] * 60) - londonNowSec();
    if(diff > 43200) diff -= 86400; else if(diff < -43200) diff += 86400;
    return diff;
  }
  // Early -> "Wait 4 min" (or "Wait 1 min 20 s" under 2 min), calm route colour. Late by >= 1 min -> "Late 3 min",
  // danger colour. On time (due within the last minute) or no timetable time -> nothing.
  function renderNsWait(){
    if(!nsWait) return;
    var d = nsDue ? secsUntilDue(nsDue) : null, txt = '', cls = '';
    if(d != null && d > 0){
      if(d < 120){ var mm = Math.floor(d / 60), ss = d % 60; txt = 'Wait ' + (mm ? mm + ' min ' : '') + ss + ' s'; }
      else txt = 'Wait ' + Math.ceil(d / 60) + ' min';
      cls = 'wait';
    } else if(d != null && d <= -60){
      txt = 'Late ' + Math.floor(-d / 60) + ' min'; cls = 'late';
    }
    nsWait.textContent = txt;
    nsWait.className = 'ns-wait' + (cls ? ' ' + cls : '');
  }
  // Sat-Nav: the Next-stop card sits right under the orange instruction bar (and the "Then…" pill when shown);
  // the End Sat-Nav / Finish buttons and the no-tiles banner go below the card (CSS var --sn-stack on the map).
  function layoutSatnavStack(){
    if(!nextStopEl) return;
    var wrap = nextStopEl.parentNode;
    if(!document.body.classList.contains('satnav-mode')){ nextStopEl.style.top = ''; if(wrap) wrap.style.removeProperty('--sn-stack'); return; }
    var top = 0;
    var st = document.getElementById('satnavTop'), th = document.getElementById('satnavThen');
    if(st && st.offsetParent && st.style.display !== 'none') top = st.offsetTop + st.offsetHeight;
    if(th && th.offsetParent && th.style.display !== 'none') top = Math.max(top, th.offsetTop + th.offsetHeight);
    var nsTop = top + 6;
    nextStopEl.style.top = nsTop + 'px';
    var stack = (nextStopEl.style.display !== 'none' ? nsTop + nextStopEl.offsetHeight : top) + 8;
    if(wrap) wrap.style.setProperty('--sn-stack', stack + 'px');
  }
  // once a second in Sat-Nav: keep the Wait / Late countdown, a live timetable edit and the card position current
  setInterval(function(){ if(document.body.classList.contains('satnav-mode')) updateNextStop(); }, 1000);
  // Which stop is the driver coming up to? At a stop (within AT_STOP_RADIUS_M) -> that stop. Otherwise, with a
  // track: the first stop not yet passed along the track (same progress logic as the turn banner);
  // without a track: the nearest stop. idx -1 = every stop has been passed.
  function computeNextStop(r, latlng){
    var stops = r.stops || [], n = stops.length;
    if(!n) return null;
    if(!latlng) return { idx:0, at:false, dist:null };
    var near = function(k){ return k >= 0 && k < n && haversineMeters(latlng, stops[k]) <= AT_STOP_RADIUS_M; };
    var idx;
    if(navProg.started){
      if(near(navProg.stopIdx)) return { idx:navProg.stopIdx, at:true, dist:haversineMeters(latlng, stops[navProg.stopIdx]) };
      idx = navProg.stopIdx + 1;
      if(idx < n && near(idx)) return { idx:idx, at:true, dist:haversineMeters(latlng, stops[idx]) };
      // standing at some other stop (display only - progress is unchanged): say so, it is where boardings go
      var nsA = nearestStop(latlng, stops);
      if(nsA && nsA.dist <= AT_STOP_RADIUS_M) return { idx:nsA.index, at:true, dist:nsA.dist };
      if(idx >= n) return { idx:-1, at:false, dist:null };          // every stop reached in order
    } else {
      // not started yet: never "route complete"; at any stop -> that stop, else the next one along the route
      if(near(0)) return { idx:0, at:true, dist:haversineMeters(latlng, stops[0]) };
      var ns = nearestStop(latlng, stops);
      if(ns && ns.dist <= AT_STOP_RADIUS_M) return { idx:ns.index, at:true, dist:ns.dist };
      idx = 0;
      if(r.track && r.track.length>=2){
        getRouteNav(r);
        var p = navTrackIdx(r, latlng);
        for(var j=0;j<r._stopTrackIdx.length;j++){ if(r._stopTrackIdx[j] >= p){ idx = j; break; } }
      }
    }
    return { idx:idx, at:false, dist: haversineMeters(latlng, stops[idx]) };
  }
  function updateNextStop(latlng){
    if(!nextStopEl) return;
    var r = activeId ? routes[activeId] : null;
    var show = !!r && r.stops && r.stops.length && document.body.classList.contains('satnav-mode');
    if(!show){ nextStopEl.style.display = 'none'; nsDue = ''; layoutSatnavStack(); return; }
    if(latlng===undefined) latlng = lastFix ? lastFix.latlng : null;
    var res = computeNextStop(r, latlng);
    nextStopEl.style.display = 'flex';
    nextStopEl.classList.toggle('at', !!(res && res.at));
    if(!res || res.idx<0){
      nextStopEl.setAttribute('data-stop', 'done');
      nsNum.textContent = '🏁'; nsLbl.textContent = 'ROUTE COMPLETE';
      nsName.textContent = 'All stops passed'; nsDist.textContent = ''; nsTime.textContent = '';
      nsDue = ''; renderNsWait(); layoutSatnavStack();
      return;
    }
    var i = res.idx, total = r.stops.length;
    var fd = fmtDist(res.dist);
    var nm = stopName(r, i), t = stopSchedTime(r, i);
    nextStopEl.setAttribute('data-stop', String(i+1));
    nsNum.textContent = String(i+1);
    nsLbl.textContent = (res.at ? 'AT STOP ' : 'NEXT STOP ') + (i+1) + ' OF ' + total;
    nsName.textContent = nm;
    nsDist.textContent = res.dist==null ? '–' : (fd.v + fd.u).replace(' ','\u00a0');
    nsTime.textContent = t ? ('Due ' + t) : '';
    nsDue = t || ''; renderNsWait();
    layoutSatnavStack();
  }

  /* ---------------- Finish & submit run ---------------- */
  // main.js supplies runCfg = { uid, companyId, newRunId(), submit(id, run) -> Promise } after sign-in.
  // The run's counts live in `pax` (localStorage) until a submit succeeds; a failed/offline submit is kept in
  // the 'rt_pending_runs' list (with its id, so a retry can never create a duplicate) and offers a Retry.
  var runCfg = null, selectedVehicle = null;
  var PENDING_KEY = 'rt_pending_runs';
  var runModal = document.getElementById('runModal');
  var runBody = document.getElementById('runBody'), runMsg = document.getElementById('runMsg');
  var runSubmitBtn = document.getElementById('runSubmit'), runCancelBtn = document.getElementById('runCancel');
  var finishBtn = document.getElementById('finishRunBtn'), snFinishBtn = document.getElementById('snFinishBtn');
  var runPendingEl = document.getElementById('runPending');
  var modalRun = null, modalRunId = null, modalBusy = false, modalDone = false;

  /* ---------------- v16: incidents ----------------
     One tap on "⚠️ Flag incident" (driver view or Sat-Nav) records { id, at (ms), lat?, lng?, stopIndex?, stopName? } in the
     in-progress run (pax.incidents -> localStorage with the counts, so it survives a reload / Sat-Nav exit / backgrounding).
     Nothing to type while driving: at Finish & submit each flag gets a card - type (required), description, CCTV yes/no. */
  var INC_MAX = 20, INC_NOTE_MAX = 1000;
  var INC_TYPES = [['passenger','Passenger issue'], ['road','Road user issue'], ['other','Other']];
  var incidentBtn = document.getElementById('incidentBtn'), snIncidentBtn = document.getElementById('snIncidentBtn');
  function cleanIncidents(a){
    if(!Array.isArray(a)) return [];
    return a.filter(function(x){ return x && typeof x === 'object' && x.at; }).slice(0, INC_MAX).map(function(x){
      var o = { id: String(x.id || ('i' + x.at)), at: +x.at, type: (x.type==='passenger'||x.type==='road'||x.type==='other') ? x.type : '',
                note: String(x.note || '').slice(0, INC_NOTE_MAX), cctv: !!x.cctv };
      if(typeof x.lat === 'number' && typeof x.lng === 'number'){ o.lat = x.lat; o.lng = x.lng; }
      if(typeof x.stopIndex === 'number' && x.stopIndex >= 0){ o.stopIndex = x.stopIndex; o.stopName = String(x.stopName || '').slice(0, 120); }
      if(x.added) o.added = true;
      return o;
    });
  }
  function ldnTime(ms){
    try{ return new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/London', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(ms)); }
    catch(e){ var d = new Date(ms); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); }
  }
  function incidentAt(r, latlng){
    // where: the stop we're at, else the next stop along the route (GPS needed); no GPS -> time only
    var o = {};
    if(!r || !r.stops || !r.stops.length || !latlng) return o;
    var idx = (currentGpsStopIdx != null) ? currentGpsStopIdx : null;
    if(idx == null){ var ns = computeNextStop(r, latlng); if(ns && ns.idx >= 0) idx = ns.idx; }
    if(idx == null){ var nr = nearestStop(latlng, r.stops); if(nr) idx = nr.index; }
    if(idx != null){ o.stopIndex = idx; o.stopName = stopName(r, idx); }
    return o;
  }
  function newIncident(added){
    var r = activeId ? routes[activeId] : null;
    var latlng = lastFix && lastFix.latlng ? lastFix.latlng : null;
    var inc = { id: 'i' + Date.now() + Math.floor(Math.random()*1000), at: Date.now(), type:'', note:'', cctv:false };
    if(latlng){ inc.lat = Math.round(latlng[0]*1e6)/1e6; inc.lng = Math.round(latlng[1]*1e6)/1e6; }
    var w = incidentAt(r, latlng);
    if(w.stopIndex != null){ inc.stopIndex = w.stopIndex; inc.stopName = w.stopName; }
    if(added) inc.added = true;
    return inc;
  }
  function flagIncident(){
    if(!activeId || !routes[activeId]){ driverToast('Open a route first'); return; }
    if(!pax.incidents) pax.incidents = [];
    if(pax.incidents.length >= INC_MAX){ driverToast('Up to ' + INC_MAX + ' incidents per run'); return; }
    ensureRunStarted();
    var inc = newIncident(false);
    pax.incidents.push(inc);
    savePax(activeId);
    renderIncidentBtns();
    driverToast('Incident flagged at ' + ldnTime(inc.at) + ' \u2013 you\u2019ll be asked about it when you finish');
    // not tracking (driver view): one quick position fix, if the phone allows it, to say where it happened
    if(inc.lat == null && navigator.geolocation){
      var rid = activeId;
      try{
        navigator.geolocation.getCurrentPosition(function(pos){
          if(activeId !== rid) return;
          var x = (pax.incidents || []).filter(function(y){ return y.id === inc.id; })[0]; if(!x || x.lat != null) return;
          var ll = [pos.coords.latitude, pos.coords.longitude];
          x.lat = Math.round(ll[0]*1e6)/1e6; x.lng = Math.round(ll[1]*1e6)/1e6;
          var w = incidentAt(routes[rid], ll);
          if(w.stopIndex != null && x.stopIndex == null){ x.stopIndex = w.stopIndex; x.stopName = w.stopName; }
          savePax(rid);
        }, function(){}, { enableHighAccuracy:true, maximumAge:60000, timeout:8000 });
      }catch(e){}
    }
  }
  function renderIncidentBtns(){
    var n = (pax && pax.incidents) ? pax.incidents.length : 0;
    var has = !!(activeId && routes[activeId]);
    [incidentBtn, snIncidentBtn].forEach(function(b){
      if(!b) return;
      b.textContent = '\u26a0\ufe0f Flag incident' + (n ? ' (' + n + ')' : '');
      b.classList.toggle('flagged', n > 0);
      b.classList.toggle('on', has);
      b.disabled = !has;
    });
  }
  if(incidentBtn) incidentBtn.addEventListener('click', flagIncident);
  if(snIncidentBtn) snIncidentBtn.addEventListener('click', flagIncident);

  // the incident cards inside the Finish & submit dialog (edits are saved straight away, so Cancel keeps them)
  function incidentCardsHtml(list){
    var h = '<div class="inc-wrap" id="incWrap">';
    if(list.length) h += '<div class="inc-title">\u26a0\ufe0f Incidents on this run (' + list.length + ')</div>';
    list.forEach(function(x, i){
      var where = (x.stopIndex != null) ? ('Stop ' + (x.stopIndex+1) + (x.stopName ? ' \u00b7 ' + escapeHtml(x.stopName) : '')) : (x.lat != null ? 'GPS position saved' : 'No GPS position');
      h += '<div class="inc-card" data-inc="' + escapeHtml(x.id) + '">' +
        '<div class="inc-head"><b>Incident ' + (i+1) + '</b><span class="inc-when">' + ldnTime(x.at) + ' \u00b7 ' + where + (x.added ? ' \u00b7 added at finish' : '') + '</span>' +
        '<button type="button" class="inc-del" data-act="inc-del" aria-label="Remove this incident">Remove</button></div>' +
        '<label class="inc-lbl">What was the issue? <span class="req">*</span>' +
          '<select class="inc-type" data-act="inc-type"><option value="">Choose\u2026</option>' +
          INC_TYPES.map(function(t){ return '<option value="' + t[0] + '"' + (x.type===t[0] ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') +
          '</select></label>' +
        '<label class="inc-lbl">Describe what happened' +
          '<textarea class="inc-note" data-act="inc-note" maxlength="' + INC_NOTE_MAX + '" rows="3" placeholder="What happened, who was involved (optional but helpful)">' + escapeHtml(x.note) + '</textarea></label>' +
        '<div class="inc-cctv"><span>Should CCTV be checked?</span><div class="inc-yn" role="group">' +
          '<button type="button" data-act="inc-cctv" data-v="no" aria-pressed="' + (!x.cctv) + '" class="' + (!x.cctv ? 'on' : '') + '">No</button>' +
          '<button type="button" data-act="inc-cctv" data-v="yes" aria-pressed="' + (!!x.cctv) + '" class="' + (x.cctv ? 'on' : '') + '">Yes</button>' +
        '</div></div></div>';
    });
    h += '<button type="button" class="inc-add" data-act="inc-add">+ Add incident</button></div>';
    return h;
  }
  var incEditable = false;      // cards shown for the open route's in-progress run (not for a saved retry)
  function renderIncidentCards(){
    var old = document.getElementById('incWrap');
    if(old) old.remove();
    if(!incEditable) return;
    runBody.insertAdjacentHTML('beforeend', incidentCardsHtml(pax.incidents || []));
  }
  function incById(id){ return (pax.incidents || []).filter(function(x){ return x.id === id; })[0]; }
  runBody.addEventListener('click', function(ev){
    var t = ev.target.closest('[data-act]'); if(!t || !incEditable || modalBusy || modalDone) return;
    var card = t.closest('.inc-card'), act = t.getAttribute('data-act');
    if(act === 'inc-del' && card){
      pax.incidents = (pax.incidents || []).filter(function(x){ return x.id !== card.getAttribute('data-inc'); });
      savePax(activeId); renderIncidentCards(); renderIncidentBtns();
    } else if(act === 'inc-add'){
      if((pax.incidents || []).length >= INC_MAX){ runMsg.textContent = 'Up to ' + INC_MAX + ' incidents per run.'; return; }
      if(!pax.incidents) pax.incidents = [];
      pax.incidents.push(newIncident(true)); savePax(activeId); renderIncidentCards(); renderIncidentBtns();
      var cards = runBody.querySelectorAll('.inc-card'); if(cards.length) cards[cards.length-1].scrollIntoView({ block:'nearest' });
    } else if(act === 'inc-cctv' && card){
      var x = incById(card.getAttribute('data-inc')); if(!x) return;
      x.cctv = t.getAttribute('data-v') === 'yes'; savePax(activeId);
      card.querySelectorAll('[data-act="inc-cctv"]').forEach(function(b){ var on = (b.getAttribute('data-v') === 'yes') === x.cctv; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    }
  });
  function onIncInput(ev){
    var t = ev.target; if(!incEditable || !t.matches) return;
    var card = t.closest('.inc-card'); if(!card) return;
    var x = incById(card.getAttribute('data-inc')); if(!x) return;
    if(t.matches('.inc-type')){ x.type = t.value; card.classList.toggle('missing', !x.type && card.classList.contains('missing')); }
    else if(t.matches('.inc-note')) x.note = t.value.slice(0, INC_NOTE_MAX);
    savePax(activeId);
  }
  runBody.addEventListener('change', onIncInput);
  runBody.addEventListener('input', onIncInput);
  // every kept incident needs its type before the run can be sent
  function incidentsReady(){
    var missing = (pax.incidents || []).filter(function(x){ return !x.type; });
    runBody.querySelectorAll('.inc-card').forEach(function(c){
      c.classList.toggle('missing', missing.some(function(x){ return x.id === c.getAttribute('data-inc'); }));
    });
    if(missing.length){
      var first = runBody.querySelector('.inc-card.missing'); if(first) first.scrollIntoView({ block:'nearest' });
      return false;
    }
    return true;
  }
  // what goes into the run document (the phone-only bits - id, "added" - stay behind)
  function incidentsForRun(){
    return (pax.incidents || []).map(function(x){
      var o = { at:x.at, type:x.type, note:String(x.note||'').slice(0, INC_NOTE_MAX), cctv:!!x.cctv };
      if(x.lat != null){ o.lat = x.lat; o.lng = x.lng; }
      if(x.stopIndex != null){ o.stopIndex = x.stopIndex; o.stopName = x.stopName || ''; }
      return o;
    });
  }
  // runs submitted without their incidents (rules not published yet): kept on this phone, never lost
  var UNSENT_INC_KEY = 'rt_unsent_incidents';
  function keepUnsentIncidents(id, run){
    try{
      var a = JSON.parse(localStorage.getItem(UNSENT_INC_KEY) || '[]'); if(!Array.isArray(a)) a = [];
      a.push({ runId:id, routeId:run.routeId, routeName:run.routeName, startedAt:run.startedAt, incidents:run.incidents, savedAt:Date.now() });
      localStorage.setItem(UNSENT_INC_KEY, JSON.stringify(a.slice(-50)));
    }catch(e){}
  }

  function readPending(){
    try{ var a = JSON.parse(localStorage.getItem(PENDING_KEY)||'[]'); return Array.isArray(a) ? a : []; }catch(e){ return []; }
  }
  function writePending(list){ try{ localStorage.setItem(PENDING_KEY, JSON.stringify(list)); }catch(e){} }
  function myPending(){
    return runCfg ? readPending().filter(function(p){ return p.uid===runCfg.uid && p.companyId===runCfg.companyId; }) : [];
  }
  function putPending(entry){
    var list = readPending().filter(function(p){ return p.id!==entry.id; });
    list.push(entry); writePending(list);
  }
  function dropPending(id){ writePending(readPending().filter(function(p){ return p.id!==id; })); }

  function runSession(r, startedAt){
    if(r.session==='AM' || r.session==='PM') return r.session;
    var h = new Date(startedAt || Date.now()).getHours();
    return h < 12 ? 'AM' : 'PM';
  }
  function sumVals(o){ var t=0; Object.keys(o||{}).forEach(function(k){ t += (o[k]|0); }); return t; }
  // Builds the run document body from the counts stored for the active route.
  function buildRun(r){
    var stops = r.stops || [], n = stops.length;
    var rows = stops.map(function(_, i){
      // alighted: always 0 - alighting is no longer tracked. The field is still written (as 0) only to keep the
      // run document shape unchanged for the published Firestore rules and old data. The UI never shows it.
      return { index:i, name:stopName(r, i), boarded:(pax.stopsOn[i]|0), alighted:0 };
    });
    var extraOn = 0;      // counts for stops that no longer exist (route edited mid-run) -> unscheduled
    Object.keys(pax.stopsOn||{}).forEach(function(k){ if(+k >= n) extraOn += pax.stopsOn[k]|0; });
    var uOn = (pax.adhocOn|0) + extraOn;
    var tb = uOn;
    rows.forEach(function(x){ tb += x.boarded; });
    var started = pax.startedAt || Date.now();
    var run = {
      routeId:activeId, routeName:r.name || 'Route', session:runSession(r, started), startedAt:started,
      // totalAlighted / unscheduledAlighted: always 0, kept only so the published Firestore rules still accept the run
      totalBoarded:tb, totalAlighted:0, unscheduledBoarded:uOn, unscheduledAlighted:0, stops:rows
    };
    if(selectedVehicle && selectedVehicle.reg) run.vehicleReg = String(selectedVehicle.reg).slice(0, 20);
    return run;
  }

  function renderRunUi(){
    var r = activeId ? routes[activeId] : null;
    var has = !!r && !!runCfg;
    var pend = myPending();
    if(finishBtn) finishBtn.style.display = has ? '' : 'none';
    renderIncidentBtns();
    if(snFinishBtn){
      snFinishBtn.classList.toggle('on', has);
      snFinishBtn.textContent = pend.length ? '⚠ Retry run upload' : '🏁 Finish & submit run';
      snFinishBtn.classList.toggle('warn', pend.length>0);
    }
    if(runPendingEl){
      runPendingEl.style.display = pend.length ? 'flex' : 'none';
      var t = document.getElementById('runPendingText');
      if(t) t.textContent = pend.length + (pend.length===1 ? ' finished run is' : ' finished runs are') + ' saved on this phone and not uploaded yet.';
    }
  }

  function summaryHtml(run){
    var h = '<div class="run-meta"><b>'+escapeHtml(run.routeName)+'</b> · '+escapeHtml(run.session)+(run.vehicleReg ? ' · 🚌 '+escapeHtml(run.vehicleReg) : '')+'</div>'+
      '<table class="run-table"><thead><tr><th>Stop</th><th class="n">Boarded</th></tr></thead><tbody>';
    run.stops.forEach(function(s){
      h += '<tr><td>'+(s.index+1)+'. '+escapeHtml(s.name)+'</td><td class="n">'+s.boarded+'</td></tr>';
    });
    h += '<tr class="unsched"><td>Unscheduled (not at a stop)</td><td class="n">'+run.unscheduledBoarded+'</td></tr>';
    h += '<tr class="tot"><td>Total</td><td class="n" id="runTotB">'+run.totalBoarded+'</td></tr></tbody></table>';
    return h;
  }
  function setModalState(state, msg){
    // state: 'confirm' | 'busy' | 'failed' | 'done'
    modalBusy = state==='busy'; modalDone = state==='done';
    runMsg.textContent = msg || '';
    runMsg.className = 'run-msg' + (state==='failed' ? ' err' : state==='done' ? ' ok' : '');
    runSubmitBtn.disabled = state==='busy';
    runCancelBtn.disabled = state==='busy';
    runSubmitBtn.textContent = state==='busy' ? 'Submitting…' : state==='failed' ? 'Retry' : state==='done' ? 'Done' : 'Submit';
    runCancelBtn.style.display = state==='done' ? 'none' : '';
    runCancelBtn.textContent = state==='failed' ? 'Close (keep on phone)' : 'Cancel';
  }
  // Auto-open Finish & submit when the last stop is reached / the route is complete (once per run).
  // Never silently submits — the driver still confirms passenger counts. Dismiss = finish manually later.
  var finishPromptedFor = null;
  function maybePromptFinish(r){
    if(!r || !runCfg || !document.body.classList.contains('satnav-mode') || previewActive) return;
    var n = (r.stops || []).length;
    // only after stop 1 was reached AND the final stop has been reached in sequence (never at the start of a loop)
    if(n < 2 || !navProg.started || navProg.stopIdx !== n-1) return;
    if(runModal && runModal.style.display === 'flex') return;
    var key = (activeId||'') + ':' + n;
    if(finishPromptedFor === key) return;
    finishPromptedFor = key;
    try{ openRunModal(false); setModalState('confirm', 'You are at the last stop — check your boardings and submit this run.'); }catch(e){}
  }
  function openRunModal(fromBanner){
    if(!runCfg) return;
    var pend = myPending();
    var r = activeId ? routes[activeId] : null;
    var target = null;                       // a saved-but-not-uploaded run to retry
    var builtNow = false;                    // v16: run rebuilt from the open route's counts (its incidents are editable)
    if(fromBanner===true && pend.length){
      target = pend.filter(function(p){ return p.run.routeId===activeId; })[0] || pend[0];
    }
    if(target && target.run.routeId!==activeId){
      modalRun = target.run; modalRunId = target.id;        // another route: resend exactly what was saved
    } else if(r){
      var same = target || pend.filter(function(p){ return p.run.routeId===activeId; })[0];
      modalRun = buildRun(r);                               // counts may have grown since the failed attempt
      builtNow = true;
      modalRunId = same ? same.id : runCfg.newRunId();
      if(same && same.run.startedAt) modalRun.startedAt = Math.min(same.run.startedAt, modalRun.startedAt);
    } else if(pend.length){
      modalRun = pend[0].run; modalRunId = pend[0].id;
    } else return;
    runBody.innerHTML = summaryHtml(modalRun);
    // v16: the incident cards belong to the open route's in-progress run (a saved retry already carries its incidents)
    incEditable = builtNow;
    renderIncidentCards();
    if(!incEditable && modalRun.incidents && modalRun.incidents.length){
      runBody.insertAdjacentHTML('beforeend', '<div class="inc-title">\u26a0\ufe0f ' + modalRun.incidents.length + ' incident' + (modalRun.incidents.length===1?'':'s') + ' saved with this run</div>');
    }
    runModal.style.display = 'flex';
    var isRetry = pend.some(function(p){ return p.id===modalRunId; });
    if(isRetry) setModalState('failed', 'This run is saved on your phone but is not uploaded yet. Tap Retry to upload it.');
    else setModalState('confirm', '');
  }
  var newDayAfterClose = false;
  function closeRunModal(){
    runModal.style.display = 'none'; modalBusy = false; renderRunUi();
    if(newDayAfterClose){ newDayAfterClose = false; if(document.body.classList.contains('satnav-mode')) endSatnav(); else if(tracking) trackBtn.click(); }
    if(allDoneNotify){ allDoneNotify = false; notifyAllDone(); }
    notifyIdle();
  }
  // v15: a run is in progress = the run dialog is open, Sat-Nav / preview is on, or the open route has boardings
  function runInProgress(){
    return (runModal && runModal.style.display === 'flex') || document.body.classList.contains('satnav-mode') || !!previewActive
        || (!!activeId && (paxTotal() > 0 || (pax.incidents && pax.incidents.length > 0)));
  }
  function notifyIdle(){ if(runCfg && runCfg.onIdle && !runInProgress()){ try{ runCfg.onIdle(); }catch(e){} } }

  function resetRunCounts(run){
    if(run.routeId===activeId){
      pax = newPax(); savePax(activeId); renderPax();
      resetNavProgress(); finishPromptedFor = null; redrawActiveTrack();
    } else {
      try{ localStorage.removeItem(paxKey(run.routeId)); }catch(e){}
    }
  }
  function doSubmitRun(){
    if(modalBusy || !modalRun || !runCfg) return;
    if(modalDone){ closeRunModal(); return; }
    var run = modalRun, id = modalRunId;
    if(incEditable){
      if(!incidentsReady()){
        setModalState('confirm', 'Choose what the issue was for each incident (or remove it).');
        runMsg.className = 'run-msg err';
        return;
      }
      var incs = incidentsForRun();
      if(incs.length) run.incidents = incs; else delete run.incidents;
    }
    setModalState('busy', 'Uploading…');
    putPending({ id:id, uid:runCfg.uid, companyId:runCfg.companyId, run:run, savedAt:Date.now() });   // safe copy first
    Promise.resolve().then(function(){ return runCfg.submit(id, run); }).then(function(res){
      var incDropped = !!(res && res.incidentsDropped);
      if(incDropped) keepUnsentIncidents(id, run);
      dropPending(id);
      resetRunCounts(run);
      var adv = { kind:'none' };
      // v15: 05:00 London passed during this run -> it was yesterday's last job; today's jobs are picked next
      var dayOver = false;
      try{ dayOver = !!(runCfg.dayOver && runCfg.dayOver()); }catch(e){}
      if(dayOver){ adv = { kind:'newday' }; newDayAfterClose = true; }
      else { try{ adv = advanceAfterSubmit(run); }catch(e){} }
      renderRunUi();
      incEditable = false; renderIncidentCards();
      if(incDropped){
        setModalState('done', 'Run submitted ✔ — but the incident was not saved. Ask your admin to update the rules (the incident is kept on this phone).' +
          (adv.kind === 'next' ? ' Next: ' + adv.label + '.' : ''));
        runMsg.className = 'run-msg err';
        driverToast('Incident not saved \u2013 ask your admin to update the rules');
        return;
      }
      if(adv.kind === 'newday'){
        setModalState('done', 'Run submitted ✔ — a new day has started (05:00). Tap Done to choose today\u2019s jobs.');
      } else if(adv.kind === 'next'){
        setModalState('done', 'Run submitted ✔ — Next: ' + adv.label + '. Boardings start again at 0.');
        driverToast('Run submitted. Next: ' + adv.label);
      } else if(adv.kind === 'alldone'){
        setModalState('done', 'Run submitted ✔ — All today\u2019s runs done.');
        driverToast('Run submitted. All today\u2019s runs done \u2714');
      } else {
        setModalState('done', 'Run submitted ✔ — passenger counts for this route have been reset.');
      }
    }, function(e){
      var why = (e && e.code==='offline') ? 'You appear to be offline.' : 'The upload failed (' + ((e && (e.code||e.message)) || 'unknown error') + ').';
      renderRunUi();
      setModalState('failed', why + ' The run is saved on this phone — tap Retry when you have signal.');
    });
  }
  if(finishBtn) finishBtn.addEventListener('click', function(){ openRunModal(false); });
  if(snFinishBtn) snFinishBtn.addEventListener('click', function(){ openRunModal(myPending().length>0); });
  if(runSubmitBtn) runSubmitBtn.addEventListener('click', doSubmitRun);
  if(runCancelBtn) runCancelBtn.addEventListener('click', function(){ if(!modalBusy) closeRunModal(); });
  var runPendingBtn = document.getElementById('runPendingRetry');
  if(runPendingBtn) runPendingBtn.addEventListener('click', function(){ openRunModal(true); });

  /* ---------------- Public API (used by js/main.js) ---------------- */
  function clearActiveRoute(){
    activeId = null;
    if(trackLine){ map.removeLayer(trackLine); trackLine=null; }
    stopsGroup.clearLayers();
    document.getElementById('routeName').textContent = 'Round Tracker';
    document.getElementById('routeSub').textContent = 'No route loaded';
    pax = newPax();
    renderPax();
    renderSchedule();
    renderRunUi();
    updateNextStop();
  }
  window.RoundTracker = {
    // fresh: { routeId: routeObject } for the signed-in user's company (real-time)
    setRoutes: function(fresh){
      var old = activeId ? routes[activeId] : null;
      // keep the already-prepared object (turn cache etc.) if that route did not change
      if(old && fresh[activeId] && fresh[activeId]._v === old._v) fresh[activeId] = old;
      routes = fresh;
      renderEmptyState();
      if(!Object.keys(routes).length){ clearActiveRoute(); renderRouteList(); return; }
      if(pendingFirstPick && svc.rank && visibleIds().length && !tracking && !document.body.classList.contains('satnav-mode')){
        pendingFirstPick = false;
        if(openJobIds().length) setActiveRoute(firstRankedId(openJobIds())); else showAllDone();
      } else if(allDone && !activeId){
        renderRouteList();          // all today's runs done: stay idle until the driver picks a route
      } else if(!activeId || !routes[activeId]){
        var saved = null;
        try{ saved = localStorage.getItem('rt_active'); }catch(e){}
        var pool = visibleIds().length ? visibleIds() : Object.keys(routes);
        setActiveRoute((saved && routes[saved] && pool.indexOf(saved) >= 0) ? saved : pool.sort(function(a,b){
          return (routes[b].addedAt||'').localeCompare(routes[a].addedAt||'');
        })[0]);
      } else if(!old || routes[activeId] !== old){
        setActiveRoute(activeId);   // the admin edited the route being viewed
      } else {
        renderRouteList();
      }
    },
    // call after the driver view becomes visible (map was hidden while sizing)
    // after sign-in: { uid, companyId, newRunId(), submit(id, run) -> Promise }  (see "Finish & submit run")
    configureRuns: function(cfg){ runCfg = cfg; renderRunUi(); },
    // { label, match(route)|null, onChange(), tabs: [tab keys]|null } - today's service x session picks (v11: a set)
    setService: function(cfg){
      svc = { label: cfg.label || '', match: cfg.match || null, onChange: cfg.onChange || null, tabs: cfg.tabs || null, rank: cfg.rank || null,
              slotLabel: cfg.slotLabel || null };
      var vis = visibleIds();
      var driving = tracking || document.body.classList.contains('satnav-mode');
      // a run with boardings not yet submitted on the open route, started this duty day (v15; was "last 12 h"), stays open
      // so counts are never stranded (v14: never for a route already submitted today, so it can't block the next job)
      var keepRun = activeId && svcVisible(activeId) && !isDone(activeId) && pax && pax.startedAt && paxTotal() > 0
                    && (!runCfg || !runCfg.dutyDay || runCfg.dutyDay(pax.startedAt) === runCfg.dutyDay());
      var jobs = svc.rank ? openJobIds() : [];
      var rankedVis = svc.rank ? vis.filter(function(id){ return svc.rank(routes[id]) != null; }) : [];
      if(svc.rank && rankedVis.length && !driving && !keepRun && !jobs.length){
        showAllDone();              // v14: every picked route already submitted today - don't reopen the first one
      } else if(svc.rank && jobs.length && !driving && !keepRun){
        // v13: a fresh welcome pick opens the FIRST route of the day (School AM -> College AM -> School PM ->
        // College PM -> Rail …, then the picked destination order, then name) - never in the middle of a drive;
        // v14: routes already submitted today are skipped
        setActiveRoute(firstRankedId(jobs));
      } else if(activeId && !svcVisible(activeId) && vis.length && !driving){
        // the route on screen is not part of today's service: open the newest one that is
        setActiveRoute(vis.sort(function(a,b){ return (routes[b].addedAt||'').localeCompare(routes[a].addedAt||''); })[0]);
      } else {
        if(svc.rank && !vis.length) pendingFirstPick = true;   // routes not here yet: pick when they arrive
        renderRouteList();
      }
    },
    // read-only progress snapshot for tests / diagnostics
    // v14: ids of the routes submitted today on this phone (read-only, for tests / diagnostics)
    doneToday: function(){ return doneIds(); },
    // v16: incidents flagged on the open route's in-progress run (read-only copy, for tests / diagnostics)
    incidents: function(){ return JSON.parse(JSON.stringify(pax.incidents || [])); },
    // v15: the day plan from the driver's account brings its submitted routes (added to this phone's list)
    setDoneToday: function(ids){
      var a = doneIds();
      (ids || []).forEach(function(id){ if(typeof id === 'string' && a.indexOf(id) < 0) a.push(id); });
      saveDone(a);
    },
    // v15: true while a run is under way (don't start a new duty day under the driver's feet)
    runInProgress: function(){ return runInProgress(); },
    navState: function(withTrack){
      var st = navState(), r = activeId ? routes[activeId] : null;
      if(withTrack && r && r.track) st.track = r.track.map(function(p){ return [p[0], p[1]]; });
      return st;
    },
    // v9: { id, reg, dims } or null – the vehicle picked on the welcome screen (shown in Finish & submit)
    setVehicle: function(v){ selectedVehicle = v || null; },
    getVehicle: function(){ return selectedVehicle; },
    show: function(){
      map.invalidateSize();
      var r = activeId ? routes[activeId] : null;
      if(r){
        var b = (r.track && r.track.length) ? L.latLngBounds(r.track) : ((r.stops && r.stops.length) ? L.latLngBounds(r.stops) : null);
        if(b) map.fitBounds(b, { padding:[36,36] });
      }
      renderSchedule();
      renderRunUi();
    }
  };

})();
