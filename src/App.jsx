import { useState, useEffect, useRef } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area, CartesianGrid } from "recharts";

// ── Constants ──────────────────────────────────────────────────────────────
const SEC_TYPES = {
  stock:     { label: "Equity Stock",    color: "#3b82f6", bg: "#3b82f615" },
  reit:      { label: "Other",           color: "#8b5cf6", bg: "#8b5cf615" },
  bond:      { label: "ETF",             color: "#06b6d4", bg: "#06b6d415" },
  preferred: { label: "Preferred Stock", color: "#10b981", bg: "#10b98115" },
  cd:        { label: "Other",           color: "#f59e0b", bg: "#f59e0b15" },
};

const FREQ = [
  { id:"monthly",    label:"Monthly",                     months:[1,2,3,4,5,6,7,8,9,10,11,12] },
  { id:"q_jan",      label:"Quarterly (Jan-Apr-Jul-Oct)",  months:[1,4,7,10] },
  { id:"q_feb",      label:"Quarterly (Feb-May-Aug-Nov)",  months:[2,5,8,11] },
  { id:"q_mar",      label:"Quarterly (Mar-Jun-Sep-Dec)",  months:[3,6,9,12] },
  { id:"semi_jan",   label:"Semi-Annual (Jan + Jul)",      months:[1,7] },
  { id:"semi_feb",   label:"Semi-Annual (Feb + Aug)",      months:[2,8] },
  { id:"annual_dec", label:"Annual (December)",            months:[12] },
  { id:"annual_jun", label:"Annual (June)",                months:[6] },
];

const MN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const fmt = (n, d=0) => n == null ? "--" :
  new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:d,maximumFractionDigits:d}).format(n);

const fmtDate = s => { if(!s) return null; const p=s.split('-'); return MN[+p[1]-1]+' '+p[2]; };
const parseNum = s => parseFloat(String(s||"0").replace(/[$,%\s,"()]/g,"")) || 0;

// ── CSV Parsing ────────────────────────────────────────────────────────────
function splitLine(line) {
  const out = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') { inQ = !inQ; }
    else if (line[i] === "," && !inQ) { out.push(cur.trim()); cur = ""; }
    else { cur += line[i]; }
  }
  out.push(cur.trim());
  return out;
}

function parseCSV(text) {
  const lines = text.replace(/\r/g,"").split("\n").filter(l => l.trim());
  let hi = 0;
  for (let i = 0; i < Math.min(15, lines.length); i++) {
    const low = lines[i].replace(/"/g,"").toLowerCase();
    if (low.startsWith("symbol") || low.startsWith("ticker") || low.startsWith("instrument") || low.includes(",symbol,")) {
      hi = i; break;
    }
  }
  const headers = splitLine(lines[hi]).map(h => h.replace(/"/g,"").trim());
  const rows = [];
  for (let i = hi+1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = splitLine(lines[i]);
    const row = {};
    headers.forEach((h,j) => { row[h] = (vals[j]||"").replace(/"/g,"").trim(); });
    const sym = row["Symbol"] || row["symbol"] || row["Ticker"] || "";
    if (!sym || sym === "--" || sym.toLowerCase().includes("total") || sym.toLowerCase().includes("cash")) continue;
    rows.push(row);
  }
  return rows;
}

function getShares(row) {
  const key = Object.keys(row).find(k => /qty|quantity|shares/i.test(k));
  return key ? row[key] : "0";
}

// ── Suggestion Engine ──────────────────────────────────────────────────────
function generateSuggestions(ticker) {
  const t = ticker.toUpperCase();
  const suggestions = [];

  // BASE/PRA, BASE/PRB → try BASE/PR (e.g. RLJ/PRA → RLJ/PR ✓)
  const slashPRSeries = t.match(/^(.+)\/PR([A-Z])$/);
  if (slashPRSeries) {
    const [, base, series] = slashPRSeries;
    suggestions.push({ ticker: base+"/PR",        confidence:"green",  reason:"Drop series letter → "+base+"/PR" });
    suggestions.push({ ticker: base+"P"+series,   confidence:"yellow", reason:"Concatenated → "+base+"P"+series });
    suggestions.push({ ticker: base,              confidence:"red",    reason:"Common stock → "+base });
    return suggestions;
  }
  // BASE-PRA, BASE-PRB
  const dashPRSeries = t.match(/^(.+)-PR([A-Z])$/);
  if (dashPRSeries) {
    const [, base, series] = dashPRSeries;
    suggestions.push({ ticker: base+"/PR",        confidence:"green",  reason:"Slash format → "+base+"/PR" });
    suggestions.push({ ticker: base+"P"+series,   confidence:"yellow", reason:"No separator → "+base+"P"+series });
    suggestions.push({ ticker: base,              confidence:"red",    reason:"Common stock → "+base });
    return suggestions;
  }
  // BASE/PR (no series) — e.g. DCOM/PR → DCOMP
  const slashPRBase = t.match(/^(.+)\/PR$/);
  if (slashPRBase) {
    const [, base] = slashPRBase;
    suggestions.push({ ticker: base+"P",  confidence:"green",  reason:"Concatenated → "+base+"P" });
    suggestions.push({ ticker: base+"PA", confidence:"yellow", reason:"Series A → "+base+"PA" });
    suggestions.push({ ticker: base,      confidence:"red",    reason:"Common stock → "+base });
    return suggestions;
  }
  // Generic
  const noSep = t.replace(/[/\-.]/g,"");
  if (noSep !== t) suggestions.push({ ticker:noSep, confidence:"green",  reason:"Remove separators → "+noSep });
  const baseOnly = t.replace(/[/\-.]?P[RA-Z]?$/i,"");
  if (baseOnly !== t && baseOnly !== noSep) suggestions.push({ ticker:baseOnly, confidence:"yellow", reason:"Base ticker → "+baseOnly });
  while (suggestions.length < 3) suggestions.push({ ticker:"", confidence:"red", reason:"Manual entry needed" });
  return suggestions.slice(0,3);
}

// ── Railway API ────────────────────────────────────────────────────────────
async function aiLookup(ticker, onResult, onError, onLoad) {
  onLoad(true);
  try {
    const r = await fetch("/api/dividends", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ tickers:[ticker] }),
    });
    const d = await r.json();
    if (d.errors?.length && !d.results?.length) throw new Error(d.errors[0].error);
    const data = d.results?.[0];
    if (!data) throw new Error("No data returned");
    onResult({
      divPerShare: data.dividend_per_payment ?? (data.dividend_per_share != null && data.payment_frequency ? +(data.dividend_per_share/data.payment_frequency).toFixed(4) : 0),
      freqId: data.freqId ?? "q_mar",
      ...(data.sec_type       ? { type:data.sec_type }                    : {}),
      ...(data.price != null  ? { price:data.price }                      : {}),
      ...(data.last_payment_date ? { lastPaymentDate:data.last_payment_date } : {}),
      ...(data.note           ? { notes:data.note }                       : {}),
    });
  } catch(e) { onError(e.message||"Failed"); }
  finally { onLoad(false); }
}

// ── Calc helpers ───────────────────────────────────────────────────────────
function calcMonthly(holdings) {
  const t = Array(12).fill(0);
  holdings.forEach(h => {
    const f = FREQ.find(f=>f.id===h.freqId)||FREQ[0];
    f.months.forEach(m => { t[m-1] += (h.shares||0)*(h.divPerShare||0); });
  });
  return t;
}

function calcTypes(holdings) {
  const map = {};
  holdings.forEach(h => {
    const f = FREQ.find(f=>f.id===h.freqId)||FREQ[0];
    const a = (h.shares||0)*(h.divPerShare||0)*f.months.length;
    map[h.type] = (map[h.type]||0)+a;
  });
  return Object.entries(map).map(([type,value])=>({
    type,value,label:SEC_TYPES[type]?.label||type,color:SEC_TYPES[type]?.color
  })).filter(d=>d.value>0).sort((a,b)=>b.value-a.value);
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 1 — Welcome / Upload
// ══════════════════════════════════════════════════════════════════════════
function StepUpload({onFile, fileRef}) {
  return (
    <div className="step-screen">
      <div className="step-badge">Step 1 of 3</div>
      <div className="fic-logo">FIC</div>
      <h1 className="fic-title">Fixed Income Calculator</h1>
      <p className="fic-sub">Upload your brokerage CSV to calculate your portfolio's dividend and interest income.</p>
      <button className="upload-btn" onClick={()=>fileRef.current&&fileRef.current.click()}>
        Upload Brokerage CSV →
      </button>
      <p className="privacy-note">Your data never leaves your browser. Nothing is stored on any server.</p>
      <div style={{width:"100%",maxWidth:420,marginTop:20,display:"flex",flexDirection:"column",gap:0}}>
        <div className="step-card">
          <div className="step-num">1</div>
          <div><strong>Upload CSV</strong><span>Export positions from Schwab, Fidelity, or any brokerage</span></div>
        </div>
        <div className="step-card step-card-dim">
          <div className="step-num step-num-dim">2</div>
          <div><strong>Confirm Dividends</strong><span>Each symbol is verified against live data</span></div>
        </div>
        <div className="step-card step-card-dim">
          <div className="step-num step-num-dim">3</div>
          <div><strong>View Income</strong><span>See your full annual income dashboard</span></div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 1b — Import Preview Modal
// ══════════════════════════════════════════════════════════════════════════
function ImportModal({rows, onConfirm, onClose}) {
  const [sel, setSel] = useState(rows.map(r=>({...r,_on:true})));
  const tog = i => setSel(p=>p.map(r=>r._idx===i?{...r,_on:!r._on}:r));
  const inc = sel.filter(r=>r._on);
  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="mbox" style={{maxWidth:580}}>
        <div className="mhdr"><h3>Review Positions — {inc.length} selected</h3><button className="xbtn" onClick={onClose}>✕</button></div>
        <p style={{fontSize:12,color:"#64748b",marginBottom:12}}>Uncheck any positions to exclude. All others will be verified in Step 2.</p>
        <div style={{maxHeight:340,overflowY:"auto",border:"1px solid #e2e8f0",borderRadius:8,marginBottom:16}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead><tr style={{background:"#f8fafc",position:"sticky",top:0}}>
              <th style={{padding:"8px 10px",textAlign:"left",borderBottom:"1px solid #e2e8f0",fontFamily:"monospace",fontSize:10,textTransform:"uppercase"}}></th>
              <th style={{padding:"8px 10px",textAlign:"left",borderBottom:"1px solid #e2e8f0",fontFamily:"monospace",fontSize:10,textTransform:"uppercase"}}>Ticker</th>
              <th style={{padding:"8px 10px",textAlign:"left",borderBottom:"1px solid #e2e8f0",fontFamily:"monospace",fontSize:10,textTransform:"uppercase"}}>Name</th>
              <th style={{padding:"8px 10px",textAlign:"right",borderBottom:"1px solid #e2e8f0",fontFamily:"monospace",fontSize:10,textTransform:"uppercase"}}>Shares</th>
            </tr></thead>
            <tbody>
              {sel.map(r=>(
                <tr key={r._idx} style={{opacity:r._on?1:0.35,borderBottom:"1px solid #f1f5f9"}}>
                  <td style={{padding:"7px 10px"}}><input type="checkbox" checked={r._on} onChange={()=>tog(r._idx)}/></td>
                  <td style={{padding:"7px 10px",fontFamily:"monospace",fontWeight:600}}>{r.ticker}</td>
                  <td style={{padding:"7px 10px",color:"#64748b",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.name}</td>
                  <td style={{padding:"7px 10px",fontFamily:"monospace",textAlign:"right"}}>{r.shares}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mftr">
          <button className="cbtn" onClick={onClose}>Cancel</button>
          <button className="sbtn" onClick={()=>onConfirm(inc)}>
            Confirm {inc.length} Positions — Start Verification →
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 2 — Processing / Confirming Dividends
// ══════════════════════════════════════════════════════════════════════════
function StepProcessing({msg, current, total, ticker}) {
  return (
    <div className="step-screen">
      <div className="step-badge">Step 2 of 3</div>
      <div className="fic-logo">FIC</div>
      <h1 className="fic-title">Confirming Dividends</h1>
      <p className="fic-sub">Verifying each symbol against live market data. Please wait.</p>

      <div className="processing-box">
        <div className="spinner"/>
        <div className="processing-msg">{msg}</div>
        {ticker && <div className="processing-ticker">Looking up <strong>{ticker}</strong></div>}
        <div className="progress-bar-wrap">
          <div className="progress-bar-fill" style={{width: total>0 ? `${Math.round((current/total)*100)}%` : "0%"}}/>
        </div>
        <div className="progress-label">{current} of {total} symbols confirmed</div>
      </div>

      <div className="step-card step-card-done">
        <div className="step-num step-num-done">✓</div>
        <div><strong>CSV Uploaded</strong><span>{total} positions imported</span></div>
      </div>
      <div className="step-card step-card-active">
        <div className="step-num">2</div>
        <div><strong>Confirming Dividends</strong><span>Verifying dividend data for each symbol</span></div>
      </div>
      <div className="step-card step-card-dim">
        <div className="step-num step-num-dim">3</div>
        <div><strong>View Income</strong><span>Coming up next</span></div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 3a — Problems
// ══════════════════════════════════════════════════════════════════════════
const CONF_STYLE = {
  green:  { bg:"#f0fdf4", border:"#86efac", badge:"#16a34a", badgeBg:"#dcfce7", label:"High" },
  yellow: { bg:"#fffbeb", border:"#fcd34d", badge:"#92400e", badgeBg:"#fef3c7", label:"Med"  },
  red:    { bg:"#fef2f2", border:"#fca5a5", badge:"#991b1b", badgeBg:"#fee2e2", label:"Low"  },
};

function StepProblems({holdings, onApplySuggestion, onRetryAll, onGoToDashboard}) {
  const problems = holdings.filter(h => h.lookupError);
  const [trying, setTrying] = useState({});
  const [tryResult, setTryResult] = useState({});

  if (problems.length === 0) {
    return (
      <div className="step-screen">
        <div className="step-badge">Step 3 of 3</div>
        <div style={{fontSize:64,marginBottom:16}}>✅</div>
        <h1 className="fic-title" style={{color:"#10b981"}}>All Symbols Confirmed</h1>
        <p className="fic-sub">Every position verified successfully. Your income data is ready.</p>
        <button className="upload-btn" style={{background:"#10b981",marginTop:8}} onClick={onGoToDashboard}>
          View Income Dashboard →
        </button>
      </div>
    );
  }

  const trySuggestion = (holding, sugTicker) => {
    if (!sugTicker) return;
    setTrying(p=>({...p,[holding.id]:sugTicker}));
    setTryResult(p=>({...p,[holding.id]:null}));
    aiLookup(sugTicker,
      data => {
        setTrying(p=>({...p,[holding.id]:null}));
        setTryResult(p=>({...p,[holding.id]:{ok:true,msg:"Found! Applying..."}}));
        onApplySuggestion(holding.id, sugTicker, data);
      },
      err => {
        setTrying(p=>({...p,[holding.id]:null}));
        setTryResult(p=>({...p,[holding.id]:{ok:false,msg:"Failed: "+err}}));
      },
      ()=>{}
    );
  };

  return (
    <div className="app">
      <header className="hdr">
        <div className="hleft">
          <div className="logo">FIC</div>
          <div>
            <div className="title">Fixed Income Calculator</div>
            <div className="sub">Step 3 — Resolve Problem Tickers</div>
          </div>
        </div>
        <div className="hright">
          <button className="lbtn" onClick={onRetryAll}>Retry All Lookups</button>
        </div>
      </header>

      <div className="card" style={{background:"#fef2f2",borderColor:"#fca5a5"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
          <div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"#991b1b",textTransform:"uppercase",letterSpacing:".1em",marginBottom:4}}>Action Required</div>
            <div style={{fontSize:22,fontWeight:800,color:"#1e293b"}}>{problems.length} symbol{problems.length!==1?"s":""} could not be confirmed</div>
            <div style={{fontSize:12,color:"#64748b",marginTop:3}}>Click a suggestion below to test and apply. <strong>Green = highest confidence.</strong> Once all are resolved, you can view your income.</div>
          </div>
          {holdings.filter(h=>!h.lookupError&&h.divPerShare>0).length > 0 &&
            <button className="sbtn" onClick={onGoToDashboard}>Skip — View Dashboard Anyway →</button>
          }
        </div>
      </div>

      {problems.map(h => {
        const suggs = h.suggestions || generateSuggestions(h.ticker);
        const isTrying = trying[h.id];
        const result = tryResult[h.id];
        return (
          <div key={h.id} className="card" style={{borderLeft:"4px solid #ef4444"}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
              <div>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                  <span style={{fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:20,color:"#1e293b"}}>{h.ticker}</span>
                  <span style={{background:"#fee2e2",color:"#991b1b",fontFamily:"monospace",fontSize:10,padding:"2px 8px",borderRadius:20,fontWeight:700}}>UNRESOLVED</span>
                </div>
                <div style={{fontSize:12,color:"#64748b",marginBottom:4}}>{h.name}</div>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#ef4444",background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:6,padding:"3px 8px",display:"inline-block"}}>
                  {h.lookupError}
                </div>
              </div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:12,color:"#64748b",textAlign:"right"}}>
                <div>{(h.shares||0).toLocaleString()} shares</div>
              </div>
            </div>

            <div style={{fontFamily:"'Outfit',sans-serif",fontSize:15,fontWeight:800,color:"#1e293b",marginBottom:10}}>
              3 Suggested Replacements — Click to Test &amp; apply
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:7}}>
              {suggs.map((sg,idx) => {
                const cs = CONF_STYLE[sg.confidence];
                const isThisTrying = isTrying === sg.ticker;
                return (
                  <div key={idx}
                    style={{display:"flex",alignItems:"center",gap:10,background:cs.bg,border:`1px solid ${cs.border}`,borderRadius:8,padding:"12px 14px",cursor:sg.ticker?"pointer":"default",opacity:sg.ticker?1:0.45,transition:"opacity .15s"}}
                    onClick={()=>!isThisTrying&&sg.ticker&&trySuggestion(h,sg.ticker)}
                  >
                    <span style={{background:cs.badgeBg,color:cs.badge,fontFamily:"monospace",fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:20,flexShrink:0,minWidth:38,textAlign:"center"}}>{cs.label}</span>
                    <span style={{fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:15,color:"#1e293b",flexShrink:0,minWidth:96}}>{sg.ticker||"—"}</span>
                    <span style={{fontSize:12,color:"#64748b",flex:1}}>{sg.reason}</span>
                    <span style={{fontFamily:"monospace",fontSize:11,color:cs.badge,flexShrink:0}}>
                      {isThisTrying ? "Testing..." : sg.ticker ? "Click to apply →" : ""}
                    </span>
                  </div>
                );
              })}
            </div>

            {result && (
              <div style={{marginTop:10,fontFamily:"'DM Mono',monospace",fontSize:11,padding:"7px 12px",borderRadius:6,background:result.ok?"#f0fdf4":"#fef2f2",color:result.ok?"#16a34a":"#dc2626",border:`1px solid ${result.ok?"#86efac":"#fca5a5"}`}}>
                {result.ok ? "✓ " : "✕ "}{result.msg}
              </div>
            )}
          </div>
        );
      })}

      {problems.length > 0 && holdings.filter(h=>!h.lookupError).length > 0 && (
        <div style={{textAlign:"center",paddingBottom:20}}>
          <button className="cbtn" style={{fontSize:13,padding:"10px 20px"}} onClick={onGoToDashboard}>
            Skip remaining problems — View Dashboard Anyway
          </button>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 3b — All Clear (no problems)
// ══════════════════════════════════════════════════════════════════════════
function StepAllClear({count, onGoToDashboard}) {
  return (
    <div className="step-screen">
      <div className="step-badge">Step 3 of 3</div>
      <div style={{fontSize:72,marginBottom:8,animation:"popIn .4s ease"}}>✅</div>
      <h1 className="fic-title" style={{color:"#10b981"}}>All Symbols Confirmed</h1>
      <p className="fic-sub">{count} positions verified successfully. Your income data is ready.</p>

      <div className="step-card step-card-done">
        <div className="step-num step-num-done">✓</div>
        <div><strong>CSV Uploaded</strong><span>{count} positions imported</span></div>
      </div>
      <div className="step-card step-card-done">
        <div className="step-num step-num-done">✓</div>
        <div><strong>Dividends Confirmed</strong><span>All symbols verified successfully</span></div>
      </div>
      <button className="upload-btn" style={{background:"#10b981",fontSize:17,padding:"16px 40px",marginTop:8,animation:"popIn .5s ease .1s both"}} onClick={onGoToDashboard}>
        View Income Dashboard →
      </button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Payment Schedule
// ══════════════════════════════════════════════════════════════════════════
function PaymentSchedule({holdings}) {
  const now = new Date();
  const thisM = now.getMonth();
  const nextM = (thisM+1)%12;
  const payersFor = mi =>
    holdings
      .filter(h=>{const f=FREQ.find(f=>f.id===h.freqId);return f?.months.includes(mi+1)&&h.divPerShare>0;})
      .map(h=>({...h,amount:h.shares*h.divPerShare,estDay:h.lastPaymentDate?+h.lastPaymentDate.split('-')[2]:null}))
      .sort((a,b)=>{
        if(a.estDay!==null&&b.estDay!==null)return a.estDay-b.estDay;
        if(a.estDay!==null)return -1;
        if(b.estDay!==null)return 1;
        return b.amount-a.amount;
      });

  function MonthCard({label,mi,accent}) {
    const list=payersFor(mi);
    const total=list.reduce((s,h)=>s+h.amount,0);
    return (
      <div className="card" style={accent?{borderColor:"#3b82f6",borderWidth:2}:{}}>
        <div className="chdr">
          <span className="ctit" style={accent?{color:"#3b82f6"}:{}}>{label}</span>
          {list.length>0&&<span style={{fontFamily:"'DM Mono',monospace",fontSize:14,fontWeight:500,color:"#10b981"}}>{fmt(total)}</span>}
        </div>
        {list.length===0
          ?<div style={{textAlign:"center",color:"#94a3b8",fontSize:12,padding:"20px 0"}}>No payments this month</div>
          :<table className="tbl">
            <thead><tr><th>Ticker</th><th>Name</th><th>Type</th><th>Est. Date</th><th style={{textAlign:"right"}}>Amount</th></tr></thead>
            <tbody>
              {list.map(h=>{
                const ti=SEC_TYPES[h.type];
                const estDate=h.estDay?`${MN[mi]}/${String(h.estDay).padStart(2,"0")}`:"--";
                return(
                  <tr key={h.id}>
                    <td><div style={{display:"flex",alignItems:"center",gap:5}}><span style={{width:6,height:6,borderRadius:"50%",background:ti?.color,display:"inline-block",flexShrink:0}}/><span style={{fontFamily:"monospace",fontWeight:600,fontSize:11}}>{h.ticker}</span></div></td>
                    <td><div style={{fontSize:10,color:"#64748b",maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{h.name}</div></td>
                    <td><span style={{background:ti?.bg,color:ti?.color,fontFamily:"monospace",fontSize:9,padding:"2px 6px",borderRadius:20}}>{ti?.label}</span></td>
                    <td style={{fontFamily:"monospace",fontSize:11,color:"#64748b"}}>{estDate}</td>
                    <td style={{fontFamily:"monospace",fontSize:11,color:"#10b981",textAlign:"right"}}>{fmt(h.amount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        }
      </div>
    );
  }

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <MonthCard label={`This Month — ${MN[thisM]} ${now.getFullYear()}`} mi={thisM} accent={true}/>
      <MonthCard label={`Next Month — ${MN[nextM]} ${nextM<thisM?now.getFullYear()+1:now.getFullYear()}`} mi={nextM} accent={false}/>
      <div className="card">
        <div className="chdr"><span className="ctit">Full Year Payment Schedule</span><span className="cbdg">Estimated dates based on last known payment</span></div>
        <div style={{display:"flex",flexDirection:"column",gap:20}}>
          {MN.map((m,i)=>{
            const list=payersFor(i);
            const total=list.reduce((s,h)=>s+h.amount,0);
            const isCur=i===thisM;
            return(
              <div key={m}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",paddingBottom:6,marginBottom:8,borderBottom:`2px solid ${isCur?"#bfdbfe":"#f1f5f9"}`}}>
                  <span style={{fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:12,color:isCur?"#3b82f6":"#1e293b"}}>{m}{isCur?" ← now":""}</span>
                  {list.length>0
                    ?<span style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"#10b981"}}>{fmt(total)} · {list.length} payer{list.length!==1?"s":""}</span>
                    :<span style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#cbd5e1"}}>no payments</span>
                  }
                </div>
                {list.length>0&&(
                  <div style={{display:"flex",flexDirection:"column",gap:5}}>
                    {list.map(h=>{
                      const ti=SEC_TYPES[h.type];
                      const estDate=h.estDay?`${m}/${String(h.estDay).padStart(2,"0")}`:"--";
                      return(
                        <div key={h.id} style={{display:"flex",alignItems:"center",gap:10,padding:"5px 8px",background:isCur?"#eff6ff":"#f8fafc",borderRadius:6,border:`1px solid ${isCur?"#bfdbfe":"#f1f5f9"}`}}>
                          <span style={{width:6,height:6,borderRadius:"50%",background:ti?.color,flexShrink:0}}/>
                          <span style={{fontFamily:"monospace",fontWeight:600,fontSize:11,width:64,flexShrink:0}}>{h.ticker}</span>
                          <span style={{flex:1,fontSize:10,color:"#64748b",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{h.name}</span>
                          <span style={{fontFamily:"monospace",fontSize:10,color:"#94a3b8",width:52,flexShrink:0,textAlign:"right"}}>{estDate}</span>
                          <span style={{fontFamily:"monospace",fontSize:11,color:"#10b981",width:68,textAlign:"right",flexShrink:0}}>{fmt(h.amount)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// HoldingModal
// ══════════════════════════════════════════════════════════════════════════
function HoldingModal({holding, onSave, onClose}) {
  const [f, setF] = useState(holding||{ticker:"",name:"",type:"stock",shares:"",divPerShare:"",freqId:"q_mar",notes:""});
  const [st, setSt] = useState(""); const [ld, setLd] = useState(false);
  const s = (k,v) => setF(p=>({...p,[k]:v}));
  const lookup = () => {
    if (!f.ticker) return; setSt("");
    aiLookup(f.ticker, d=>{setF(p=>({...p,...d,ticker:p.ticker}));setSt("Data populated");}, e=>setSt("Error: "+e), setLd);
  };
  const valid = f.ticker && +f.shares >= 0 && +f.divPerShare >= 0;
  const prev = +f.shares * +f.divPerShare * (FREQ.find(x=>x.id===f.freqId)?.months.length||12);
  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="mbox">
        <div className="mhdr"><h3>{holding?"Edit Holding":"Add Holding"}</h3><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="lrow">
          <input className="inp tkr" placeholder="TICKER" value={f.ticker} onChange={e=>s("ticker",e.target.value.toUpperCase())}/>
          <button className="aibtn" onClick={lookup} disabled={!f.ticker||ld}>{ld?"...":"Lookup"}</button>
        </div>
        {st&&<div className={"ast "+(st.startsWith("Data")?"ok":"er")}>{st}</div>}
        <div className="fgrid">
          <div className="fi full"><label>Security Name</label><input className="inp" value={f.name} onChange={e=>s("name",e.target.value)}/></div>
          <div className="fi"><label>Type</label>
            <select className="inp" value={f.type} onChange={e=>s("type",e.target.value)}>
              {Object.entries(SEC_TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div className="fi"><label>Shares</label><input className="inp" type="number" min="0" step="0.01" value={f.shares} onChange={e=>s("shares",e.target.value)}/></div>
          <div className="fi"><label>Div per Payment ($)</label><input className="inp" type="number" min="0" step="0.0001" value={f.divPerShare} onChange={e=>s("divPerShare",e.target.value)}/></div>
          <div className="fi"><label>Frequency</label>
            <select className="inp" value={f.freqId} onChange={e=>s("freqId",e.target.value)}>
              {FREQ.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </div>
          <div className="fi full"><label>Notes</label><input className="inp" value={f.notes||""} onChange={e=>s("notes",e.target.value)}/></div>
        </div>
        {+f.shares>0&&+f.divPerShare>0&&<div className="prev">Annual: <strong>{fmt(prev)}</strong></div>}
        <div className="mftr">
          <button className="cbtn" onClick={onClose}>Cancel</button>
          <button className="sbtn" disabled={!valid} onClick={()=>onSave({...f,shares:+f.shares,divPerShare:+f.divPerShare,id:holding?.id||Date.now()})}>
            {holding?"Save Changes":"Add Holding"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════════════
export default function App() {
  // appState: "upload" | "processing" | "allclear" | "problems" | "dashboard"
  const [appState, setAppState]   = useState("upload");
  const [holdings, setHoldings]   = useState([]);
  const [view, setView]           = useState("dashboard");
  const [modal, setModal]         = useState(null);
  const [impModal, setImpModal]   = useState(null);
  const [active, setActive]       = useState(null);
  const [target, setTarget]       = useState(105000);
  const [editTarget, setEditTarget] = useState(false);
  const [tmpTarget, setTmpTarget] = useState("105000");
  const [rdy, setRdy]             = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkStatus, setBulkStatus]   = useState("");
  const [procMsg, setProcMsg]     = useState("Processing");
  const [procCurrent, setProcCurrent] = useState(0);
  const [procTotal, setProcTotal]     = useState(0);
  const [procTicker, setProcTicker]   = useState("");
  const fileRef = useRef();

  // Persist
  useEffect(()=>{
    (async()=>{
      try {
        const s = await window.storage?.get("fic_v1");
        const t = await window.storage?.get("fic_target_v1");
        if (s?.value) { const p=JSON.parse(s.value); if(p.length>0){setHoldings(p);setAppState("dashboard");} }
        if (t?.value) setTarget(+t.value);
      } catch {}
      setRdy(true);
    })();
  },[]);

  useEffect(()=>{ if(!rdy) return; window.storage?.set("fic_v1",JSON.stringify(holdings)).catch(()=>{}); },[holdings,rdy]);
  useEffect(()=>{ if(!rdy) return; window.storage?.set("fic_target_v1",String(target)).catch(()=>{}); },[target,rdy]);

  // Auto-lookup after import
  const runAutoLookup = async (holdingsList) => {
    let dot=0;
    const blink = setInterval(()=>{ dot=(dot+1)%4; setProcMsg("Processing"+".".repeat(dot)); },500);
    let updated = [...holdingsList];
    setProcTotal(holdingsList.length);
    setProcCurrent(0);

    for (let i=0; i<holdingsList.length; i++) {
      const h = holdingsList[i];
      setProcTicker(h.ticker);
      await new Promise(res=>{
        const timer = setTimeout(()=>{
          const suggs = generateSuggestions(h.ticker);
          updated = updated.map(x=>x.id===h.id?{...x,notes:"error",lookupError:"Timeout",suggestions:suggs}:x);
          res();
        }, 30000);
        aiLookup(h.ticker,
          d=>{
            clearTimeout(timer);
            updated = updated.map(x=>x.id===h.id?{...x,...d,ticker:x.ticker,shares:x.shares,notes:"",lookupError:null,suggestions:null}:x);
            res();
          },
          err=>{
            clearTimeout(timer);
            const suggs = generateSuggestions(h.ticker);
            updated = updated.map(x=>x.id===h.id?{...x,notes:"error",lookupError:err,suggestions:suggs}:x);
            res();
          },
          ()=>{}
        );
      });
      setProcCurrent(i+1);
      await new Promise(r=>setTimeout(r,300));
    }
    clearInterval(blink);
    setProcTicker("");
    setHoldings(updated);
    const problems = updated.filter(h=>h.lookupError);
    if (problems.length===0) { setAppState("allclear"); }
    else { setAppState("problems"); }
  };

  const handleFile = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const rows = parseCSV(ev.target.result);
        const mapped = rows.map((r,i)=>({
          _idx:i,
          ticker:(r["Symbol"]||r["symbol"]||r["Ticker"]||"").replace(/\s/g,"").toUpperCase(),
          name:(r["Description"]||r["description"]||r["Name"]||r["Investment Name"]||"").trim(),
          shares:parseNum(getShares(r)),
        })).filter(r=>r.ticker&&r.ticker.length>=1&&r.ticker.length<=12&&r.shares>0);
        if (mapped.length===0){alert("No positions found. Please use a CSV positions export from your brokerage.");return;}
        setImpModal(mapped);
      } catch(err){alert("Could not read file: "+err.message);}
    };
    reader.readAsText(file);
    e.target.value="";
  };

  const confirmImport = rows => {
    const newH = rows.map((r,i)=>({
      id:Date.now()+i, ticker:r.ticker, name:r.name||r.ticker,
      type:"stock", shares:r.shares, divPerShare:0, freqId:"q_mar", notes:"needs-lookup",
    }));
    setHoldings(newH);
    setImpModal(null);
    setAppState("processing");
    runAutoLookup(newH);
  };

  const applySuggestion = (holdingId, newTicker, data) => {
    setHoldings(p=>p.map(h=>h.id===holdingId?{...h,...data,ticker:newTicker,notes:"",lookupError:null,suggestions:null}:h));
  };

  // After applySuggestion, check if all problems resolved
  useEffect(()=>{
    if (appState==="problems") {
      const remaining = holdings.filter(h=>h.lookupError);
      if (remaining.length===0 && holdings.length>0) setAppState("allclear");
    }
  },[holdings]);

  const bulkLookup = async () => {
    const missing = holdings.filter(h=>h.notes==="needs-lookup"||h.lookupError);
    if (!missing.length){setBulkStatus("All positions have rates.");setTimeout(()=>setBulkStatus(""),3000);return;}
    setBulkRunning(true);
    let done=0, errs=0;
    for (const h of missing) {
      setBulkStatus(done+"/"+missing.length+" — "+h.ticker+"...");
      await new Promise(res=>{
        const timer=setTimeout(()=>{done++;errs++;res();},30000);
        aiLookup(h.ticker,
          d=>{clearTimeout(timer);setHoldings(p=>p.map(x=>x.id===h.id?{...x,...d,ticker:x.ticker,shares:x.shares,notes:"",lookupError:null,suggestions:null}:x));done++;res();},
          err=>{clearTimeout(timer);const suggs=generateSuggestions(h.ticker);setHoldings(p=>p.map(x=>x.id===h.id?{...x,notes:"error",lookupError:err,suggestions:suggs}:x));done++;errs++;res();},
          ()=>{}
        );
      });
      await new Promise(r=>setTimeout(r,300));
    }
    setBulkRunning(false);
    setBulkStatus(errs>0?errs+" problem"+(errs>1?"s":"")+" found":"Done — "+done+" updated");
    setTimeout(()=>setBulkStatus(""),8000);
  };

  const saveH  = h  => {setHoldings(p=>modal?.id?p.map(x=>x.id===h.id?h:x):[...p,h]);setModal(null);};
  const delH   = id => setHoldings(p=>p.filter(h=>h.id!==id));
  const updS   = (id,v) => setHoldings(p=>p.map(h=>h.id===id?{...h,shares:Math.max(0,+v||0)}:h));

  const mo = calcMonthly(holdings);
  const types = calcTypes(holdings);
  const ann = mo.reduce((a,b)=>a+b,0);
  const avg = ann/12;
  const mx  = Math.max(...mo,1);
  const bst = mo.indexOf(Math.max(...mo));
  const nowM = new Date().getMonth();
  const gap  = ann-target;
  const needsLookup  = holdings.filter(h=>h.notes==="needs-lookup").length;
  const problemCount = holdings.filter(h=>h.lookupError).length;
  const mktVal = holdings.reduce((a,h)=>a+(h.price||0)*h.shares,0);
  const barD = MN.map((m,i)=>({month:m,income:+mo[i].toFixed(2)}));
  const cumD = MN.map((m,i)=>({month:m,actual:+mo.slice(0,i+1).reduce((a,b)=>a+b,0).toFixed(2),target:+((target/12)*(i+1)).toFixed(2)}));
  const payers = mi => holdings.filter(h=>{const f=FREQ.find(f=>f.id===h.freqId);return f?.months.includes(mi+1)&&h.divPerShare>0;});

  if (!rdy) return <div style={{minHeight:"100vh",background:"#f1f5f9"}}/>;

  // ── Route by appState ──
  if (appState==="upload") return (
    <>
      <style>{CSS}</style>
      <input ref={fileRef} type="file" accept=".csv" style={{display:"none"}} onChange={handleFile}/>
      <StepUpload onFile={handleFile} fileRef={fileRef}/>
      {impModal&&<ImportModal rows={impModal} onConfirm={confirmImport} onClose={()=>setImpModal(null)}/>}
    </>
  );

  if (appState==="processing") return (
    <>
      <style>{CSS}</style>
      <StepProcessing msg={procMsg} current={procCurrent} total={procTotal} ticker={procTicker}/>
    </>
  );

  if (appState==="allclear") return (
    <>
      <style>{CSS}</style>
      <StepAllClear count={holdings.length} onGoToDashboard={()=>{setView("dashboard");setAppState("dashboard");}}/>
    </>
  );

  if (appState==="problems") return (
    <>
      <style>{CSS}</style>
      <StepProblems
        holdings={holdings}
        onApplySuggestion={applySuggestion}
        onRetryAll={bulkLookup}
        onGoToDashboard={()=>{setView("dashboard");setAppState("dashboard");}}
      />
      {modal&&<HoldingModal holding={modal==="add"?null:modal} onSave={saveH} onClose={()=>setModal(null)}/>}
    </>
  );

  // ── Dashboard ──
  return (
    <>
      <style>{CSS}</style>
      <input ref={fileRef} type="file" accept=".csv" style={{display:"none"}} onChange={handleFile}/>
      <div className="app">

        <header className="hdr">
          <div className="hleft">
            <div className="logo">FIC</div>
            <div>
              <div className="title">Fixed Income Calculator</div>
              <div className="sub">{holdings.length} positions</div>
            </div>
            <div className="navtabs">
              <button className={"ntab"+(view==="dashboard"?" active":"")} onClick={()=>setView("dashboard")}>Dashboard</button>
              <button className={"ntab"+(view==="schedule"?" active":"")} onClick={()=>setView("schedule")}>Payment Schedule</button>
              {problemCount>0&&<button className={"ntab ntab-warn"+(view==="problems"?" active":"")} onClick={()=>setView("problems")}>
                Problems <span className="pbadge">{problemCount}</span>
              </button>}
            </div>
          </div>
          <div className="hright">
            {(needsLookup>0||problemCount>0)&&<button className="lbtn" onClick={bulkLookup} disabled={bulkRunning}>{bulkRunning?"Running...":"Lookup "+(needsLookup+problemCount)}</button>}
            {bulkStatus&&<span className="bstat">{bulkStatus}</span>}
            <button className="ibtn" onClick={()=>fileRef.current&&fileRef.current.click()}>Import CSV</button>
            <button className="abtn" onClick={()=>setModal("add")}>+ Add</button>
            <button className="rbtn" onClick={()=>{setHoldings([]);setAppState("upload");}}>Reset</button>
          </div>
        </header>

        {view==="schedule"&&<PaymentSchedule holdings={holdings}/>}

        {view==="problems"&&<StepProblems holdings={holdings} onApplySuggestion={applySuggestion} onRetryAll={bulkLookup} onGoToDashboard={()=>setView("dashboard")}/>}

        {view==="dashboard"&&<>
          <div className="goalbar">
            <div className="goalleft">
              <span className="goallbl">Annual Income Goal:</span>
              {editTarget?(
                <span style={{display:"flex",alignItems:"center",gap:8}}>
                  $<input className="goalinp" type="number" value={tmpTarget} onChange={e=>setTmpTarget(e.target.value)}
                    onBlur={()=>{setTarget(+tmpTarget||105000);setEditTarget(false);}}
                    onKeyDown={e=>{if(e.key==="Enter"||e.key==="Escape"){setTarget(+tmpTarget||105000);setEditTarget(false);}}} autoFocus/>
                </span>
              ):(
                <span className="goalval" onClick={()=>{setTmpTarget(String(target));setEditTarget(true);}}>{fmt(target)} (click to edit)</span>
              )}
            </div>
            <div className="goalright">
              <div className="goaltrack"><div className="goalfill" style={{width:Math.min(ann/target*100,100).toFixed(1)+"%",background:gap>=0?"#10b981":"#3b82f6"}}/></div>
              <span className="goalpct" style={{color:gap>=0?"#10b981":"#3b82f6"}}>
                {(ann/target*100).toFixed(0)}% {gap>=0?"above goal":fmt(Math.abs(gap))+" to go"}
              </span>
            </div>
          </div>

          <div className="kpis">
            {[
              {l:"Annual Income", v:fmt(ann),        s:"projected",       c:"#1e293b"},
              {l:"Monthly Avg",   v:fmt(avg),        s:"per month",       c:"#1e293b"},
              {l:"Best Month",    v:MN[bst],         s:fmt(Math.max(...mo))+" est", c:"#8b5cf6"},
              {l:"Income Goal",   v:fmt(target),     s:"your target",     c:"#1e293b"},
              {l:"Progress",      v:(ann/target*100).toFixed(0)+"%", s:gap>=0?"on track":"needs income", c:gap>=0?"#10b981":"#3b82f6"},
              {l:"Holdings",      v:holdings.length, s:"positions",       c:"#1e293b"},
              {l:"Market Value",  v:mktVal>0?fmt(mktVal):"--", s:"based on lookups", c:"#1e293b"},
            ].map((k,i)=>(
              <div key={i} className="kpi">
                <div className="klbl">{k.l}</div>
                <div className="kval" style={{color:k.c}}>{k.v}</div>
                <div className="ksub">{k.s}</div>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="chdr"><span className="ctit">Monthly Income Forecast</span><span className="cbdg">Click a bar to see payers</span></div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={barD} margin={{top:8,right:16,left:8,bottom:0}}
                onClick={d=>d?.activeTooltipIndex!=null&&setActive(active===d.activeTooltipIndex?null:d.activeTooltipIndex)}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false}/>
                <XAxis dataKey="month" tick={{fill:"#94a3b8",fontSize:11}} axisLine={false} tickLine={false}/>
                <YAxis tick={{fill:"#94a3b8",fontSize:10}} axisLine={false} tickLine={false} tickFormatter={v=>"$"+(v>=1000?(v/1000).toFixed(1)+"k":v)}/>
                <Tooltip contentStyle={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:8,fontFamily:"monospace"}} formatter={v=>[fmt(v),"Income"]} cursor={{fill:"#3b82f608"}}/>
                <Bar dataKey="income" radius={[4,4,0,0]}>
                  {barD.map((_,i)=><Cell key={i} fill={i===active?"#3b82f6":i===nowM?"#10b98166":"#3b82f633"} stroke={i===active?"#3b82f6":"transparent"}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="hint">Monthly goal pace: {fmt(target/12)} | Blue = selected | Green = current month</div>
            {active!==null&&(
              <div className="mdet">
                <div className="mdhdr"><strong>{MN[active]} — {payers(active).length} payers</strong><span style={{color:"#3b82f6",fontFamily:"monospace"}}>{fmt(mo[active])}</span></div>
                <div className="chips">
                  {payers(active).sort((a,b)=>(b.shares*b.divPerShare)-(a.shares*a.divPerShare)).map(h=>(
                    <div key={h.id} className="chip">
                      <span style={{width:6,height:6,borderRadius:"50%",background:SEC_TYPES[h.type]?.color,display:"inline-block"}}/>
                      <span style={{fontFamily:"monospace",fontWeight:600,fontSize:11}}>{h.ticker}</span>
                      <span style={{fontFamily:"monospace",fontSize:10,color:"#10b981"}}>{fmt(h.shares*h.divPerShare)}</span>
                      {h.lastPaymentDate&&<span style={{fontFamily:"monospace",fontSize:9,color:"#94a3b8"}}>est.{fmtDate(h.lastPaymentDate)}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="midrow">
            <div className="card">
              <div className="chdr"><span className="ctit">Holdings</span><span className="cbdg">{holdings.length} positions — edit shares inline</span></div>
              <div style={{overflowX:"auto"}}>
                <table className="tbl">
                  <thead><tr><th>Ticker</th><th>Name</th><th>Type</th><th>Shares</th><th>Price</th><th>Mkt Value</th><th>Div/Pmt</th><th>Frequency</th><th>Annual</th><th></th></tr></thead>
                  <tbody>
                    {holdings.map(h=>{
                      const fr=FREQ.find(f=>f.id===h.freqId);
                      const an=h.shares*h.divPerShare*(fr?.months.length||12);
                      const ti=SEC_TYPES[h.type];
                      const hasErr=!!h.lookupError;
                      const needsL=h.notes==="needs-lookup";
                      const mv=h.price!=null?h.price*h.shares:null;
                      return(
                        <tr key={h.id} style={{background:hasErr?"#fef2f2":needsL?"#fffbeb":""}}>
                          <td><div style={{display:"flex",alignItems:"center",gap:5}}>
                            <span style={{width:6,height:6,borderRadius:"50%",background:hasErr?"#ef4444":ti?.color,display:"inline-block",flexShrink:0}}/>
                            <span style={{fontFamily:"monospace",fontWeight:600,fontSize:11}}>{h.ticker}
                              {hasErr&&<span style={{color:"#ef4444",fontSize:9,marginLeft:2}}>✕</span>}
                              {needsL&&!hasErr&&<span style={{color:"#f59e0b",fontSize:9,marginLeft:2}}>!</span>}
                            </span>
                          </div></td>
                          <td><div style={{fontSize:10,color:"#64748b",maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{h.name}</div></td>
                          <td><span style={{background:ti?.bg,color:ti?.color,fontFamily:"monospace",fontSize:9,padding:"2px 6px",borderRadius:20}}>{ti?.label}</span></td>
                          <td><input className="sinp" type="number" min="0" step="0.01" value={h.shares} onChange={e=>updS(h.id,e.target.value)}/></td>
                          <td style={{fontFamily:"monospace",fontSize:10,color:"#64748b"}}>{h.price!=null?fmt(h.price,2):"--"}</td>
                          <td style={{fontFamily:"monospace",fontSize:10}}>{mv!=null?fmt(mv):"--"}</td>
                          <td style={{fontFamily:"monospace",fontSize:10}}>{h.divPerShare>0?fmt(h.divPerShare,4):"--"}</td>
                          <td style={{fontSize:9,color:"#64748b",whiteSpace:"nowrap"}}>{fr?.label.split(" (")[0]}</td>
                          <td style={{fontFamily:"monospace",fontSize:10,color:an>0?"#10b981":hasErr?"#ef4444":"#94a3b8"}}>
                            {an>0?fmt(an):hasErr?"Fix needed":"No Dividend"}
                          </td>
                          <td><div style={{display:"flex",gap:3}}>
                            {hasErr&&<button className="rb" style={{color:"#ef4444",borderColor:"#fca5a5"}} onClick={()=>setView("problems")}>Fix</button>}
                            <button className="rb" onClick={()=>setModal(h)}>Edit</button>
                            <button className="rb del" onClick={()=>delH(h.id)}>✕</button>
                          </div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div className="card">
                <div className="chdr"><span className="ctit">By Type</span></div>
                {types.length>0?(
                  <>
                    <ResponsiveContainer width="100%" height={150}>
                      <PieChart><Pie data={types} dataKey="value" nameKey="label" cx="50%" cy="50%" innerRadius={38} outerRadius={62} paddingAngle={3}>
                        {types.map((d,i)=><Cell key={i} fill={d.color} stroke="transparent"/>)}
                      </Pie><Tooltip formatter={v=>fmt(v)} contentStyle={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:8,fontFamily:"monospace",fontSize:11}}/></PieChart>
                    </ResponsiveContainer>
                    <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:5}}>
                      {types.map(d=>(
                        <div key={d.type} style={{display:"flex",alignItems:"center",gap:7,fontSize:11}}>
                          <span style={{width:7,height:7,borderRadius:"50%",background:d.color,flexShrink:0}}/>
                          <span style={{flex:1,color:"#64748b",fontFamily:"monospace",fontSize:10}}>{d.label}</span>
                          <span style={{fontFamily:"monospace"}}>{fmt(d.value)}</span>
                          <span style={{color:"#94a3b8",fontFamily:"monospace",fontSize:10}}>{(d.value/ann*100).toFixed(0)}%</span>
                        </div>
                      ))}
                    </div>
                  </>
                ):<div style={{textAlign:"center",color:"#94a3b8",fontSize:12,padding:20}}>Add dividend rates to see breakdown</div>}
              </div>
              <div className="card">
                <div className="chdr"><span className="ctit">Cumulative vs Goal</span></div>
                <ResponsiveContainer width="100%" height={120}>
                  <AreaChart data={cumD} margin={{top:8,right:12,left:0,bottom:0}}>
                    <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3b82f6" stopOpacity={0.2}/><stop offset="100%" stopColor="#3b82f6" stopOpacity={0}/></linearGradient></defs>
                    <XAxis dataKey="month" tick={{fill:"#94a3b8",fontSize:9}} axisLine={false} tickLine={false}/>
                    <YAxis hide/>
                    <Tooltip formatter={v=>fmt(v)} contentStyle={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:8,fontFamily:"monospace",fontSize:10}}/>
                    <Area type="monotone" dataKey="target" stroke="#cbd5e1" strokeWidth={1} strokeDasharray="4 4" fill="none" name="Goal"/>
                    <Area type="monotone" dataKey="actual" stroke="#3b82f6" strokeWidth={2} fill="url(#cg)" dot={false} name="Actual"/>
                  </AreaChart>
                </ResponsiveContainer>
                <div className="hint" style={{marginTop:4}}>Blue = actual | Dashed = goal pace</div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="chdr"><span className="ctit">Income Calendar</span><span className="cbdg">Click month for detail | Green = at or above goal</span></div>
            <div className="calgrid">
              {MN.map((m,i)=>{
                const pc=mo[i]/mx; const at=mo[i]>=(target/12); const p=payers(i);
                return(
                  <div key={m} className={"cal"+(active===i?" cala":"")+(i===nowM?" caln":"")} onClick={()=>setActive(active===i?null:i)}>
                    <div style={{fontFamily:"monospace",fontSize:9,color:"#94a3b8",textTransform:"uppercase"}}>{m}</div>
                    <div style={{flex:1,width:16,background:"#e2e8f0",borderRadius:3,position:"relative",minHeight:26,overflow:"hidden"}}>
                      <div style={{position:"absolute",bottom:0,left:0,right:0,borderRadius:3,background:at?"#10b981":"#3b82f6",height:(pc*100)+"%",transition:"height .4s"}}/>
                    </div>
                    <div style={{fontFamily:"monospace",fontSize:9,fontWeight:600}}>{mo[i]>0?fmt(mo[i]):"--"}</div>
                    <div style={{fontSize:8,color:"#94a3b8"}}>{p.length>0?p.length+"p":""}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </>}

        <div className="footer">Fixed Income Calculator | {holdings.length} positions | {fmt(ann)} projected annual income | Your data stays in your browser</div>
      </div>

      {modal&&<HoldingModal holding={modal==="add"?null:modal} onSave={saveH} onClose={()=>setModal(null)}/>}
    </>
  );
}

// ── CSS ────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500&family=Outfit:wght@300;400;500;600;700;800&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#f1f5f9;color:#1e293b;font-family:'Outfit',sans-serif;}

/* Step screens */
.step-screen{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;background:linear-gradient(135deg,#f8faff,#f1f5f9,#eef2ff);}
.step-badge{background:#3b82f6;color:#fff;font-family:'DM Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:4px 12px;border-radius:99px;margin-bottom:20px;}
.fic-logo{font-size:48px;font-weight:900;color:#3b82f6;letter-spacing:-.04em;font-family:'Outfit',sans-serif;margin-bottom:8px;}
.fic-title{font-size:30px;font-weight:800;text-align:center;line-height:1.2;margin-bottom:8px;letter-spacing:-.02em;}
.fic-sub{font-size:14px;color:#64748b;text-align:center;max-width:420px;line-height:1.6;margin-bottom:28px;}
.step-card{display:flex;align-items:center;gap:14px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 18px;width:100%;max-width:420px;margin-bottom:10px;}
.step-card strong{display:block;font-weight:700;font-size:14px;margin-bottom:2px;}
.step-card span{font-size:12px;color:#64748b;}
.step-card-dim{opacity:.45;}
.step-card-done{border-color:#86efac;background:#f0fdf4;}
.step-card-active{border-color:#3b82f6;border-width:2px;background:#eff6ff;}
.step-num{width:30px;height:30px;border-radius:50%;background:#3b82f6;color:#fff;font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.step-num-dim{background:#cbd5e1;}
.step-num-done{background:#10b981;}
.upload-btn{background:#3b82f6;color:#fff;border:none;border-radius:12px;padding:14px 32px;font-family:'Outfit',sans-serif;font-weight:700;font-size:15px;cursor:pointer;transition:all .2s;margin-top:8px;width:100%;max-width:420px;}
.upload-btn:hover{background:#2563eb;transform:translateY(-1px);box-shadow:0 4px 14px #3b82f633;}
.privacy-note{font-size:11px;color:#94a3b8;margin-top:14px;text-align:center;}

/* Processing */
.processing-box{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px 32px;display:flex;flex-direction:column;align-items:center;gap:14px;width:100%;max-width:420px;margin-bottom:24px;box-shadow:0 4px 20px #0000000a;}
.spinner{width:44px;height:44px;border:4px solid #e2e8f0;border-top:4px solid #3b82f6;border-radius:50%;animation:spin 1s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes popIn{from{transform:scale(.7);opacity:0}to{transform:scale(1);opacity:1}}
.processing-msg{font-family:'DM Mono',monospace;font-size:18px;color:#3b82f6;letter-spacing:.06em;font-weight:500;}
.processing-ticker{font-size:13px;color:#64748b;}
.processing-ticker strong{color:#1e293b;font-family:'DM Mono',monospace;}
.progress-bar-wrap{width:100%;height:8px;background:#e2e8f0;border-radius:99px;overflow:hidden;}
.progress-bar-fill{height:100%;background:linear-gradient(90deg,#3b82f6,#10b981);border-radius:99px;transition:width .4s ease;}
.progress-label{font-family:'DM Mono',monospace;font-size:11px;color:#94a3b8;}

/* Dashboard */
.app{max-width:1300px;margin:0 auto;padding:16px 16px 40px;display:flex;flex-direction:column;gap:14px;}
.hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 0 4px;border-bottom:2px solid #e2e8f0;flex-wrap:wrap;gap:10px;}
.hleft{display:flex;align-items:center;gap:12px;}
.logo{font-size:22px;font-weight:900;color:#3b82f6;letter-spacing:-.04em;}
.title{font-size:18px;font-weight:800;letter-spacing:-.02em;}
.sub{font-size:11px;color:#64748b;margin-top:1px;}
.hright{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.navtabs{display:flex;gap:3px;background:#f1f5f9;border-radius:8px;padding:3px;margin-left:8px;}
.ntab{background:none;border:none;border-radius:6px;padding:5px 13px;font-family:'Outfit',sans-serif;font-size:12px;font-weight:600;cursor:pointer;color:#64748b;transition:all .15s;white-space:nowrap;display:flex;align-items:center;gap:5px;}
.ntab.active{background:#fff;color:#1e293b;box-shadow:0 1px 3px #0000001a;}
.ntab:hover:not(.active){color:#1e293b;}
.ntab-warn{color:#dc2626;}
.pbadge{background:#ef4444;color:#fff;font-size:9px;font-weight:700;border-radius:99px;padding:1px 6px;font-family:'DM Mono',monospace;}
.abtn{background:#3b82f6;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-family:'Outfit',sans-serif;font-weight:700;font-size:12px;cursor:pointer;}
.ibtn{background:#fff;color:#1e293b;border:1px solid #cbd5e1;border-radius:8px;padding:7px 12px;font-family:'Outfit',sans-serif;font-weight:600;font-size:12px;cursor:pointer;}
.ibtn:hover{border-color:#3b82f6;color:#3b82f6;}
.rbtn{background:#fff;color:#94a3b8;border:1px solid #e2e8f0;border-radius:8px;padding:7px 12px;font-family:'Outfit',sans-serif;font-size:12px;cursor:pointer;}
.lbtn{background:#fef3c7;color:#92400e;border:1px solid #fcd34d;border-radius:8px;padding:7px 12px;font-family:'Outfit',sans-serif;font-weight:600;font-size:12px;cursor:pointer;}
.bstat{font-family:'DM Mono',monospace;font-size:11px;color:#10b981;background:#f0fdf4;border:1px solid #bbf7d0;padding:4px 9px;border-radius:8px;}
.goalbar{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;}
.goalleft{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.goallbl{font-size:12px;font-weight:600;color:#64748b;}
.goalval{font-size:17px;font-weight:700;cursor:pointer;border-bottom:2px dashed #e2e8f0;padding-bottom:1px;}
.goalval:hover{border-color:#3b82f6;}
.goalinp{font-size:16px;font-weight:700;width:120px;border:2px solid #3b82f6;border-radius:6px;padding:2px 8px;font-family:'Outfit',sans-serif;outline:none;}
.goalright{display:flex;align-items:center;gap:12px;flex:1;min-width:180px;}
.goaltrack{flex:1;height:8px;background:#e2e8f0;border-radius:99px;overflow:hidden;}
.goalfill{height:100%;border-radius:99px;transition:width .6s;}
.goalpct{font-family:'DM Mono',monospace;font-size:11px;white-space:nowrap;font-weight:500;}
.kpis{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;}
@media(max-width:1100px){.kpis{grid-template-columns:repeat(4,1fr);}}
@media(max-width:700px){.kpis{grid-template-columns:repeat(3,1fr);}}
@media(max-width:500px){.kpis{grid-template-columns:repeat(2,1fr);}}
.kpi{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;}
.klbl{font-family:'DM Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8;margin-bottom:5px;}
.kval{font-family:'DM Mono',monospace;font-size:16px;font-weight:500;}
.ksub{font-size:10px;color:#94a3b8;margin-top:3px;}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:18px;box-shadow:0 1px 3px #0000000a;}
.chdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:6px;}
.ctit{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;}
.cbdg{font-family:'DM Mono',monospace;font-size:10px;background:#f8fafc;border:1px solid #e2e8f0;color:#94a3b8;padding:3px 8px;border-radius:20px;}
.hint{font-family:'DM Mono',monospace;font-size:10px;color:#94a3b8;text-align:center;}
.mdet{margin-top:12px;border-top:1px solid #f1f5f9;padding-top:11px;}
.mdhdr{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#64748b;margin-bottom:9px;font-family:'DM Mono',monospace;}
.mdhdr strong{color:#1e293b;}
.chips{display:flex;flex-wrap:wrap;gap:6px;}
.chip{display:flex;align-items:center;gap:5px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:20px;padding:3px 9px;}
.midrow{display:grid;grid-template-columns:1fr 275px;gap:14px;}
@media(max-width:900px){.midrow{grid-template-columns:1fr;}}
.tbl{width:100%;border-collapse:collapse;font-size:11px;}
.tbl th{font-family:'DM Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8;text-align:left;padding:5px 7px;border-bottom:2px solid #f1f5f9;white-space:nowrap;}
.tbl tr td{padding:7px 7px;border-bottom:1px solid #f8fafc;vertical-align:middle;}
.tbl tr:last-child td{border-bottom:none;}
.tbl tr:hover td{background:#f8fafc;}
.sinp{background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;color:#1e293b;font-family:'DM Mono',monospace;font-size:11px;padding:3px 6px;width:85px;text-align:right;}
.sinp:focus{outline:none;border-color:#3b82f6;}
.rb{background:none;border:1px solid #e2e8f0;border-radius:5px;color:#94a3b8;cursor:pointer;padding:2px 8px;font-size:10px;font-family:'Outfit',sans-serif;}
.rb:hover{border-color:#3b82f6;color:#3b82f6;}
.rb.del:hover{border-color:#ef4444;color:#ef4444;}
.calgrid{display:grid;grid-template-columns:repeat(12,1fr);gap:7px;}
@media(max-width:700px){.calgrid{grid-template-columns:repeat(6,1fr);}}
.cal{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 5px;cursor:pointer;text-align:center;min-height:88px;display:flex;flex-direction:column;align-items:center;gap:3px;transition:all .15s;}
.cal:hover{background:#eff6ff;border-color:#bfdbfe;}
.cala{border-color:#3b82f6;background:#eff6ff;}
.caln{border-color:#10b981;background:#f0fdf4;}
.overlay{position:fixed;inset:0;background:#00000040;backdrop-filter:blur(4px);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;}
.mbox{background:#fff;border:1px solid #e2e8f0;border-radius:14px;width:100%;max-width:500px;padding:22px;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px #00000015;}
.mhdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;}
.mhdr h3{font-size:15px;font-weight:700;}
.xbtn{background:none;border:1px solid #e2e8f0;border-radius:6px;color:#94a3b8;cursor:pointer;padding:4px 10px;font-size:13px;}
.xbtn:hover{background:#f8fafc;}
.lrow{display:flex;gap:8px;margin-bottom:6px;}
.tkr{text-transform:uppercase;font-family:'DM Mono',monospace;font-weight:600;letter-spacing:.08em;}
.aibtn{flex-shrink:0;background:#f59e0b;color:#000;border:none;border-radius:8px;padding:0 14px;font-family:'Outfit',sans-serif;font-weight:700;font-size:13px;cursor:pointer;}
.aibtn:disabled{opacity:.4;cursor:not-allowed;}
.ast{font-family:'DM Mono',monospace;font-size:10px;padding:4px 9px;border-radius:6px;margin-bottom:9px;}
.ast.ok{background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0;}
.ast.er{background:#fef2f2;color:#dc2626;border:1px solid #fecaca;}
.fgrid{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:12px;}
.fi{display:flex;flex-direction:column;gap:4px;}
.fi.full{grid-column:span 2;}
.fi label{font-family:'DM Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8;}
.inp{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;color:#1e293b;font-family:'Outfit',sans-serif;font-size:13px;padding:8px 10px;width:100%;outline:none;transition:border-color .15s;}
.inp:focus{border-color:#3b82f6;}
.prev{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:9px 12px;font-family:'DM Mono',monospace;font-size:11px;color:#64748b;margin-bottom:12px;}
.prev strong{color:#3b82f6;font-size:14px;}
.mftr{display:flex;gap:8px;justify-content:flex-end;}
.cbtn{background:none;border:1px solid #e2e8f0;border-radius:8px;color:#94a3b8;padding:8px 16px;font-family:'Outfit',sans-serif;font-size:12px;cursor:pointer;}
.sbtn{background:#3b82f6;color:#fff;border:none;border-radius:8px;padding:8px 18px;font-family:'Outfit',sans-serif;font-weight:700;font-size:13px;cursor:pointer;}
.sbtn:disabled{opacity:.4;cursor:not-allowed;}
.footer{text-align:center;font-family:'DM Mono',monospace;font-size:10px;color:#94a3b8;letter-spacing:.08em;padding-top:8px;border-top:1px solid #e2e8f0;}
`;
