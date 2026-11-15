// Fluxo: séries do motor (presença e espera por minuto) + etapas e pontos de atenção da análise → HTML e SVG (sem biblioteca).
// Versão 1.0 — 15/11/2026 / Mudança: criação. Cores: 3 unidades da paleta categórica validada no escuro (CSI 1 azul, CSI 2 laranja, Pediatria verde-água; ΔE de daltonismo ≥ 9, tudo-contra-tudo) e a paleta de estado reservada para atenção, sempre com símbolo + palavra.
// Só funções puras que devolvem texto: testadas em node.
import {units,OPEN,clock,LIMIT_WAIT} from './engine.mjs';
import {LEVELS} from './analise.mjs';

export const UNIT_COLORS={csi1:'#3987e5',csi2:'#d95926',ped:'#199e70'};
export const INK={primary:'#ebf4f7',secondary:'#b7c8d1',muted:'#7f98a6',grid:'#35506a',surface:'#1e3041'};
export const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const nf=(n,d=0)=>Number(n??0).toLocaleString('pt-BR',{maximumFractionDigits:d});
const niceMax=value=>{
 if(value<=4)return 4;
 const step=value<=10?2:value<=30?5:value<=60?10:value<=150?25:50;
 return Math.ceil(value/step)*step;
};

// ---------- Linha do tempo: pessoas presentes por unidade (áreas empilhadas) + espera ----------
export function timelineChart({series,time,focus='all',best=null,incidents=[],end}){
 const W=1000,H=250,L=44,R=10,T=14,B=26;
 const active=Object.keys(units).filter(unit=>focus==='all'||focus===unit);
 const length=series.length;
 const stack=Array.from({length},(_,i)=>active.reduce((sum,unit)=>sum+series.present[unit][i],0));
 const waitingLine=Array.from({length},(_,i)=>active.reduce((sum,unit)=>sum+series.waiting[unit][i],0));
 const peak=Math.max(1,...stack);
 const top=niceMax(peak);
 const x=minute=>L+(W-L-R)*(minute-series.from)/Math.max(1,end-series.from);
 const y=value=>T+(H-T-B)*(1-value/top);
 // áreas empilhadas, sempre no mesmo passo de 3 min para o desenho ficar leve
 const step=3;
 const layers=[];
 let base=new Array(length).fill(0);
 for(const unit of active){
  const upper=base.map((b,i)=>b+series.present[unit][i]);
  let path='M'+x(series.from).toFixed(1)+' '+y(base[0]).toFixed(1);
  let back='';
  for(let i=0;i<length;i+=step){const m=series.from+i;path+='L'+x(m).toFixed(1)+' '+y(upper[i]).toFixed(1);}
  for(let i=length-1;i>=0;i-=step){const m=series.from+i;back+='L'+x(m).toFixed(1)+' '+y(base[i]).toFixed(1);}
  layers.push('<path d="'+path+back+'Z" fill="'+UNIT_COLORS[unit]+'" fill-opacity=".82" stroke="'+INK.surface+'" stroke-width="1.5" stroke-linejoin="round"><title>'+esc(units[unit])+'</title></path>');
  base=upper;
 }
 let waitPath='';
 let pen=false;
 for(let i=0;i<length;i+=step){
  if(!stack[i]){pen=false;continue;}
  waitPath+=(pen?'L':'M')+x(series.from+i).toFixed(1)+' '+y(waitingLine[i]).toFixed(1);pen=true;
 }
 const hours=[];
 for(let h=Math.ceil(series.from/60);h*60<=end;h++)hours.push(h);
 const every=hours.length>9?2:1;
 const grid=[0,.5,1].map(f=>{const v=Math.round(top*f);return '<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(v).toFixed(1)+'" y2="'+y(v).toFixed(1)+'" stroke="'+INK.grid+'" stroke-width="'+(f===0?1.2:.7)+'" '+(f===0?'':'stroke-dasharray="3 5"')+'/><text x="'+(L-6)+'" y="'+(y(v)+4).toFixed(1)+'" text-anchor="end" fill="'+INK.secondary+'" font-size="11">'+v+'</text>';}).join('');
 const ticks=hours.filter((_,i)=>i%every===0).map(h=>'<line x1="'+x(h*60).toFixed(1)+'" x2="'+x(h*60).toFixed(1)+'" y1="'+(H-B)+'" y2="'+(H-B+4)+'" stroke="'+INK.muted+'"/><text x="'+x(h*60).toFixed(1)+'" y="'+(H-8)+'" text-anchor="middle" fill="'+INK.secondary+'" font-size="11">'+String(h).padStart(2,'0')+'h</text>').join('');
 const window=best?'<rect x="'+x(best.start).toFixed(1)+'" y="'+T+'" width="'+(x(best.end)-x(best.start)).toFixed(1)+'" height="'+(H-T-B)+'" fill="#9be8d6" fill-opacity=".13"/><text x="'+((x(best.start)+x(best.end))/2).toFixed(1)+'" y="'+(T+11)+'" text-anchor="middle" fill="#9be8d6" font-size="10">melhor janela</text>':'';
 const pins=incidents.filter(r=>r.from>=series.from&&r.from<=end).slice(0,24).map(r=>'<path d="M'+x(r.from).toFixed(1)+' '+(H-B-1)+'l-5 -9h10z" fill="'+LEVELS.serious.color+'" stroke="'+INK.surface+'" stroke-width="1"><title>'+esc(clock(r.from)+' · '+(r.kind==='wait'?'espera acima de 30 min':r.kind==='exam'?'exame acima da referência':'estação parada'))+'</title></path>').join('');
 const peakAt=stack.indexOf(peak);
 const peakMark='<circle cx="'+x(series.from+peakAt).toFixed(1)+'" cy="'+y(peak).toFixed(1)+'" r="4" fill="'+INK.primary+'" stroke="'+INK.surface+'" stroke-width="2"/><text x="'+Math.min(W-R-40,Math.max(L+30,x(series.from+peakAt))).toFixed(1)+'" y="'+(y(peak)-8).toFixed(1)+'" text-anchor="middle" fill="'+INK.primary+'" font-size="11" font-weight="600">pico '+peak+' às '+clock(series.from+peakAt)+'</text>';
 const cursor='<line id="chartCursor" x1="'+x(time).toFixed(1)+'" x2="'+x(time).toFixed(1)+'" y1="'+T+'" y2="'+(H-B)+'" stroke="#fff" stroke-width="1.5" visibility="'+(time>=series.from&&time<=end?'visible':'hidden')+'"/><line id="chartHover" y1="'+T+'" y2="'+(H-B)+'" stroke="#9be8d6" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>';
 const svg='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-labelledby="tlTitle tlDesc" preserveAspectRatio="none" class="chart-svg"><title id="tlTitle">Pessoas presentes na clínica ao longo do dia</title><desc id="tlDesc">Áreas empilhadas por unidade e linha tracejada de quem espera atendimento. Pico de '+peak+' pessoas às '+clock(series.from+peakAt)+'.</desc>'+
  window+grid+layers.join('')+'<path d="'+waitPath+'" fill="none" stroke="'+INK.primary+'" stroke-width="2" stroke-dasharray="6 4" stroke-linejoin="round"/>'+pins+peakMark+ticks+cursor+'<rect id="chartHit" x="'+L+'" y="'+T+'" width="'+(W-L-R)+'" height="'+(H-T-B)+'" fill="transparent"/></svg>';
 const legend='<ul class="legend2">'+active.map(unit=>'<li><i style="background:'+UNIT_COLORS[unit]+'"></i>'+esc(units[unit])+'</li>').join('')+'<li><i class="dash"></i>esperando atendimento</li>'+(incidents.length?'<li><b style="color:'+LEVELS.serious.color+'">▲</b> ocorrência da ronda</li>':'')+'</ul>';
 return {svg,legend,geometry:{W,H,L,R,T,B},peak,minuteAt(fraction){return series.from+(fraction*W-L)/(W-L-R)*(end-series.from);},at(minute){
  const i=Math.max(0,Math.min(length-1,Math.round(minute-series.from)));
  const rows=active.map(unit=>({unit,n:series.present[unit][i],w:series.waiting[unit][i]}));
  return {minute:series.from+i,rows,total:rows.reduce((s,r)=>s+r.n,0),waiting:rows.reduce((s,r)=>s+r.w,0)};
 },x,tooltip(minute){
  const p=this.at(minute);
  return '<strong>'+clock(p.minute)+'</strong><br>'+p.rows.map(r=>'<span style="color:'+UNIT_COLORS[r.unit]+'">■</span> '+esc(units[r.unit])+': '+r.n+(r.w?' ('+r.w+' esperando)':'')).join('<br>')+'<br>Total: '+p.total+' · esperando: '+p.waiting;
 }};
}
// Tabela com a mesma informação do gráfico (acessibilidade)
export function timelineTable(series,focus='all'){
 const active=Object.keys(units).filter(unit=>focus==='all'||focus===unit);
 const rows=[];
 for(let h=Math.ceil(series.from/60);h*60<series.from+series.length;h++){
  const i=h*60-series.from;
  rows.push('<tr><td>'+String(h).padStart(2,'0')+'h</td>'+active.map(unit=>'<td>'+series.present[unit][i]+' <small>('+series.waiting[unit][i]+' esp.)</small></td>').join('')+'</tr>');
 }
 return '<table><thead><tr><th>Hora</th>'+active.map(unit=>'<th>'+esc(units[unit])+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table>';
}

// ---------- Espera por hora (P90 da chegada ao exame) ----------
export function waitChart(rows){
 if(!rows.length)return '<p class="muted">Sem atendimentos para medir a espera.</p>';
 const W=1000,H=190,L=44,R=10,T=14,B=26;
 const max=niceMax(Math.max(LIMIT_WAIT*1.4,...rows.map(r=>r.p90)));
 const hours=rows.map(r=>r.hour);
 const first=Math.min(...hours),last=Math.max(...hours),span=last-first+1,slot=(W-L-R)/span,bar=Math.min(46,slot*.6);
 const y=v=>T+(H-T-B)*(1-v/max);
 const color=v=>v>60?LEVELS.critical.color:v>LIMIT_WAIT?LEVELS.warning.color:UNIT_COLORS.csi1;
 const bars=rows.map(r=>{
  const cx=L+slot*(r.hour-first+.5),h=Math.max(2,(H-T-B)*r.p90/max);
  const flag=r.p90>LIMIT_WAIT?'<text x="'+cx.toFixed(1)+'" y="'+(y(r.p90)-5).toFixed(1)+'" text-anchor="middle" fill="'+INK.primary+'" font-size="11" font-weight="600">'+(r.p90>60?'▲ ':'● ')+Math.round(r.p90)+' min</text>':'';
  return '<path d="M'+(cx-bar/2).toFixed(1)+' '+(H-B)+'V'+(H-B-h+4).toFixed(1)+'a4 4 0 0 1 4 -4h'+(bar-8).toFixed(1)+'a4 4 0 0 1 4 4V'+(H-B)+'Z" fill="'+color(r.p90)+'"><title>'+String(r.hour).padStart(2,'0')+'h: P90 de '+Math.round(r.p90)+' min, máximo '+Math.round(r.max)+' min, '+r.n+' atendimentos</title></path>'+flag+
   '<text x="'+cx.toFixed(1)+'" y="'+(H-8)+'" text-anchor="middle" fill="'+INK.secondary+'" font-size="11">'+String(r.hour).padStart(2,'0')+'h</text>';
 }).join('');
 const grid=[0,.5,1].map(f=>{const v=Math.round(max*f);return '<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(v).toFixed(1)+'" y2="'+y(v).toFixed(1)+'" stroke="'+INK.grid+'" stroke-width="'+(f===0?1.2:.7)+'" '+(f===0?'':'stroke-dasharray="3 5"')+'/><text x="'+(L-6)+'" y="'+(y(v)+4).toFixed(1)+'" text-anchor="end" fill="'+INK.secondary+'" font-size="11">'+v+'</text>';}).join('');
 const meta='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(LIMIT_WAIT).toFixed(1)+'" y2="'+y(LIMIT_WAIT).toFixed(1)+'" stroke="'+LEVELS.warning.color+'" stroke-width="1.5" stroke-dasharray="8 5"/><text x="'+(W-R)+'" y="'+(y(LIMIT_WAIT)-5).toFixed(1)+'" text-anchor="end" fill="'+LEVELS.warning.color+'" font-size="11">meta: '+LIMIT_WAIT+' min</text>';
 return '<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Espera P90 por hora de chegada, em minutos" preserveAspectRatio="none" class="chart-svg">'+grid+meta+bars+'</svg>';
}
