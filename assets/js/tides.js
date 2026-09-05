
  import { config } from './config.mjs';
  import { buildStormGlassUrl, dateKey, fetchNoaaTides, interpolateTide, normalizeStormGlass } from './tide-data.mjs';

  /* ───────────────────────── GLOBAL CONFIG ───────────────────────── */
  let displayDate = new Date();

  /* Santa Cruz lat/lng for Storm Glass & sun times */
  const santaCruzLat = 36.9583,
        santaCruzLng = -122.0170;

  /* Storm Glass is called through the serverless API so the credential never
     ships to browsers. */
  const stormGlassEndpoint = config.stormGlassEndpoint;

  const maxFutureDays = 7,
        maxPastDays   = 30;

  /* ───────────────────────── DOM REFS ───────────────────────── */
  const chartDateEl       = document.getElementById('chartDate'),
        prevDayBtn        = document.getElementById('prevDayBtn'),
        nextDayBtn        = document.getElementById('nextDayBtn'),
        dateDropdownEl    = document.getElementById('dateDropdown'),
        loadingMessageEl  = document.getElementById('loadingMessage'),
        errorMessageEl    = document.getElementById('errorMessage'),
        tideChartCanvas   = document.getElementById('tideChart'),
        hoverTideInfoEl   = document.getElementById('hoverTideInfo');

  let tideChartInstance   = null,
      currentTimeInterval = null,
      isInitialLoad       = true,
      tideRequestId       = 0,
      tideAbortController = null;

  /* ───────────────────────── DATE NAV ───────────────────────── */
  function updateDateDisplayAndDropdown() {
    chartDateEl.textContent = displayDate.toLocaleDateString('en-US',{
      weekday:'long',month:'long',day:'numeric',year:'numeric'
    });
    populateDateDropdown();
  }
  function populateDateDropdown() {
    dateDropdownEl.innerHTML = '';
    for (let i=-3;i<=3;i++){
      const d=new Date(displayDate);
      d.setDate(d.getDate()+i);
      const btn=document.createElement('button');
      btn.textContent = d.toLocaleDateString('en-US',{month:'short',day:'numeric',weekday:'short'});
      if (i===0) btn.classList.add('font-bold','text-blue-700','bg-blue-100');
      btn.onclick=()=>{
        isInitialLoad=false;
        displayDate=new Date(d);
        updateDateDisplayAndDropdown();
        clampButtons();
        fetchAndRenderTides();
        dateDropdownEl.classList.add('hidden');
      };
      dateDropdownEl.appendChild(btn);
    }
  }
  function clampButtons() {
    const today=new Date(), diff=(displayDate-today)/86400000;
    prevDayBtn.disabled = diff < -maxPastDays;
    nextDayBtn.disabled = diff >  maxFutureDays;
  }
  prevDayBtn.onclick = ()=>{ isInitialLoad=false; displayDate.setDate(displayDate.getDate()-1); updateDateDisplayAndDropdown(); clampButtons(); fetchAndRenderTides(); };
  nextDayBtn.onclick = ()=>{ isInitialLoad=false; displayDate.setDate(displayDate.getDate()+1); updateDateDisplayAndDropdown(); clampButtons(); fetchAndRenderTides(); };
  chartDateEl.onclick = ()=> dateDropdownEl.classList.toggle('hidden');
  document.addEventListener('click',e=>{ if(!document.getElementById('dateDisplayContainer').contains(e.target)) dateDropdownEl.classList.add('hidden'); });

  /* ───────────────────────── UTILITIES ───────────────────────── */
  function formatTime24(t){ const d=new Date(t); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
  function interpolate(target,preds){
    return interpolateTide(target, preds);
  }

  /* ───────────────────────── ERROR DISPLAY ───────────────────────── */
  function showError(msg){
    errorMessageEl.textContent = `Error: ${msg}.`;
    errorMessageEl.classList.remove('hidden');
    loadingMessageEl.classList.add('hidden');
    tideChartCanvas.parentElement.classList.add('hidden');
  }

  /* ───────────────────────── CHART.JS PLUGINS (stubs) ───────────────────────── */
  Chart.register({id:'verticalLineWithHoverData',beforeDraw(){},afterEvent(){}});
  Chart.register({id:'backgroundShading',beforeDraw(){}});
  Chart.register({id:'horizontalBands',beforeDraw(){}});

  /* ───────────────────────── FETCH & RENDER ───────────────────────── */
  async function fetchAndRenderTides(){
    if(currentTimeInterval){ clearInterval(currentTimeInterval); currentTimeInterval=null; }
    if(tideAbortController) tideAbortController.abort();
    const requestId = ++tideRequestId;
    tideAbortController = new AbortController();
    const { signal } = tideAbortController;
    loadingMessageEl.classList.remove('hidden');
    errorMessageEl.classList.add('hidden');
    tideChartCanvas.parentElement.classList.add('hidden');
    hoverTideInfoEl.innerHTML='&nbsp;';

    const dateISO=dateKey(displayDate),
          source=document.querySelector('input[name="dataSource"]:checked').value;

    // fetch sun/sunset
    let sunTimes=null;
    try{
      const r=await fetch(`https://api.sunrise-sunset.org/json?lat=${santaCruzLat}&lng=${santaCruzLng}&date=${dateISO}&formatted=0`, { signal });
      if(r.ok){
        const s=await r.json();
        if(s.status==='OK'){
          sunTimes={
            sunrise: new Date(s.results.sunrise),
            sunset:  new Date(s.results.sunset),
            astronomical_twilight_begin:new Date(s.results.astronomical_twilight_begin),
            astronomical_twilight_end:  new Date(s.results.astronomical_twilight_end)
          };
        }
      }
    }catch{}

    try{
      let curve=[], hiLo=[];

      if(source==='noaa'){
        ({ curve, hiLo } = await fetchNoaaTides(dateISO, { signal }));
      } else {
        const urlSG=buildStormGlassUrl(dateISO, stormGlassEndpoint);
        const rSG = await fetch(urlSG, { signal });
        if(!rSG.ok) throw new Error(`Storm Glass HTTP ${rSG.status}`);
        const dataSG=await rSG.json();
        if(!dataSG.hours?.length) throw new Error('Storm Glass: no data');
        ({ curve, hiLo } = normalizeStormGlass(dataSG));
      }

      if (requestId !== tideRequestId) return;

      // render
      loadingMessageEl.classList.add('hidden');
      tideChartCanvas.parentElement.classList.remove('hidden');

      const labels=curve.map(p=>new Date(p.t)),
            vals=curve.map(p=>p.v),
            hlpts=hiLo.map(p=>({ x:new Date(p.t), y:p.v, type:p.type })),
            datasets=[
              { label:'Tide Height (ft)', data:vals, borderColor:'rgb(59,130,246)',
                backgroundColor:'rgba(59,130,246,.1)', fill:true, tension:.3,
                pointRadius:0, pointHitRadius:10, order:1 },
              { label:'High Tides', type:'scatter', data:hlpts.filter(p=>p.type==='H'),
                pointStyle:'line', radius:8, borderWidth:3,
                borderColor:'rgb(239,68,68)', backgroundColor:'rgb(239,68,68)',
                showLine:false, order:2 },
              { label:'Low Tides', type:'scatter', data:hlpts.filter(p=>p.type==='L'),
                pointStyle:'line', radius:8, borderWidth:3,
                borderColor:'rgb(245,158,11)', backgroundColor:'rgb(245,158,11)',
                showLine:false, order:2 }
            ];

      if(displayDate.toDateString()===new Date().toDateString()){
        const now=new Date(), ct=new Date(displayDate);
        ct.setHours(now.getHours(),now.getMinutes(),now.getSeconds());
        const vNow=interpolate(ct,curve);
        if(vNow!=null){
          datasets.push({
            label:`Current: ${formatTime24(ct)} - Tide: ${vNow.toFixed(2)} ft`,
            type:'scatter', data:[{x:ct,y:vNow}],
            pointBackgroundColor:'rgba(0,128,0,.8)',pointBorderColor:'rgba(0,100,0,1)',
            pointRadius:7, pointHoverRadius:9, order:3
          });
        }
      }

      const bands=[
        {yMin:-Infinity,yMax:0,color:'rgba(255,0,0,.15)'},
        {yMin:0,yMax:.5,color:'rgba(255,165,0,.15)'},
        {yMin:.5,yMax:1,color:'rgba(255,255,0,.15)'},
        {yMin:1,yMax:1.5,color:'rgba(144,238,144,.2)'},
        {yMin:1.5,yMax:2.5,color:'rgba(0,100,0,.25)'},
        {yMin:2.5,yMax:3,color:'rgba(144,238,144,.2)'},
        {yMin:3,yMax:3.5,color:'rgba(255,255,0,.15)'},
        {yMin:3.5,yMax:4,color:'rgba(255,165,0,.15)'},
        {yMin:4,yMax:Infinity,color:'rgba(255,0,0,.15)'}
      ];

      if(tideChartInstance) tideChartInstance.destroy();
      const ctx=tideChartCanvas.getContext('2d'),
            xMin=new Date(displayDate).setHours(0,0,0,0),
            xMax=new Date(displayDate).setHours(24,0,0,0);

      tideChartInstance=new Chart(ctx,{
        type:'line',
        data:{ labels, datasets },
        options:{
          responsive:true, maintainAspectRatio:false,
          animation:isInitialLoad?{duration:0}:{},
          scales:{
            x:{
              type:'time',
              time:{ unit:'hour', displayFormats:{hour:'HH'}, tooltipFormat:'MMM d, HH:mm' },
              grid:{ color:'rgba(200,200,200,0.2)' },
              title:{ display:true, text:'Time', font:{ size:16 } },
              min:xMin,max:xMax
            },
            y:{
              beginAtZero:false,
              title:{ display:true, text:'Tide (ft)', font:{ size:16 } },
              grid:{ color:'rgba(200,200,200,0.2)' }
            }
          },
          plugins:{
            legend:{ display:false },
            tooltip:{ mode:'index', intersect:false, callbacks:{
              title: items => items.length
                ? new Date(items[0].parsed.x).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})
                : '',
              label: ctx => {
                const lbl=ctx.dataset.label||'';
                if(lbl.startsWith('Current:')) return lbl;
                if(lbl==='Tide Height (ft)') return `Tide: ${ctx.parsed.y.toFixed(2)} ft`;
                if(lbl==='High Tides'||lbl==='Low Tides'){
                  const d=ctx.raw;
                  return `${d.type==='H'?'High':'Low'}: ${d.y.toFixed(2)} ft @ ${formatTime24(d.x)}`;
                }
                return lbl;
              }
            }},
            verticalLineWithHoverData:{},
            backgroundShading:{ nightColor:'rgba(0,0,50,0.2)', twilightColor:'rgba(70,70,100,0.2)', sunTimes, sCurrentDate:new Date(displayDate) },
            horizontalBands:{ bands }
          },
          interaction:{ mode:'index', axis:'x', intersect:false }
        }
      });
      tideChartCanvas.style.height='450px';

      if(displayDate.toDateString()===new Date().toDateString()){
        currentTimeInterval=setInterval(()=>{
          const idx=tideChartInstance.data.datasets.findIndex(ds=>ds.label.startsWith('Current:'));
          if(idx>-1){
            const now=new Date(), ct=new Date(displayDate);
            ct.setHours(now.getHours(),now.getMinutes(),now.getSeconds(),now.getMilliseconds());
            const v=interpolate(ct,curve);
            if(v!=null){
              tideChartInstance.data.datasets[idx].data[0]={x:ct,y:v};
              tideChartInstance.data.datasets[idx].label=`Current: ${formatTime24(ct)} - Tide: ${v.toFixed(2)} ft`;
              tideChartInstance.update('none');
            }
          }
        },60000);
      }

      isInitialLoad=false;
    }
    catch(err){
      if (err?.name === 'AbortError' || requestId !== tideRequestId) return;
      console.error(err);
      showError(err.message.includes('No predictions')?'No tide data available':err.message);
    }
  }

  /* ───────────────────────── INIT ───────────────────────── */
  function init(){
    updateDateDisplayAndDropdown();
    clampButtons();
    document.querySelectorAll('input[name="dataSource"]').forEach(el=>{
      el.addEventListener('change',fetchAndRenderTides);
    });
    fetchAndRenderTides();
  }
  window.onload=init;
  
