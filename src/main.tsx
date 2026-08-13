import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type DarktableStatus = { available: boolean; path: string; version?: string };
type Photo = { name: string; path: string; type: string };
type CreatedShoot = { projectDir: string; previews: (Photo & { preview: string })[]; failures: { name: string; message: string }[]; total: number };
type Operation = { id: string; label: string; detail: string; action: "Auto Retouch" | "Suggested" | "Review" | "Preserve"; enabled: boolean };
declare global { interface Window { editor?: { darktableStatus(): Promise<DarktableStatus>; chooseShoot(): Promise<{ folder: string; files: Photo[] } | null>; createShoot(shoot: { folder: string; files: Photo[] }): Promise<CreatedShoot>; saveRetouchPlan(plan: unknown): Promise<{path:string}> } } }

const strengthNames = ["None", "Cleanup", "Natural Portrait", "Polished Portrait", "Editorial / Beauty"];
const baseOperations: Operation[] = [
  { id:"temporary", label:"Temporary blemish cleanup", detail:"Pimples, small scratches, temporary redness and sensor spots", action:"Auto Retouch", enabled:true },
  { id:"under-eye", label:"Under-eye light reduction", detail:"Reduce shadows by 25%; retain natural facial structure", action:"Suggested", enabled:true },
  { id:"tone", label:"Subtle skin tone evening", detail:"Texture-aware correction; pores and natural texture preserved", action:"Suggested", enabled:true },
  { id:"flyaway", label:"Isolated flyaway cleanup", detail:"Only obvious hairs against simple backgrounds", action:"Review", enabled:false },
  { id:"identity", label:"Moles, freckles, scars & birthmarks", detail:"Identity-defining and uncertain features remain untouched", action:"Preserve", enabled:false },
  { id:"teeth", label:"Teeth brightness", detail:"Optional mild brightness and yellow-cast reduction", action:"Review", enabled:false },
];

function App() {
  const [darktable, setDarktable] = useState<DarktableStatus | null>(null);
  const [shoot, setShoot] = useState<{ folder: string; files: Photo[] } | null>(null);
  const [created, setCreated] = useState<CreatedShoot | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [stage, setStage] = useState<"shoots"|"retouch">("shoots");
  const [selected, setSelected] = useState(0);
  const [compare, setCompare] = useState<"Original"|"Edited"|"Retouched">("Retouched");
  const [strength, setStrength] = useState(2);
  const [operations, setOperations] = useState(baseOperations);
  const [saved, setSaved] = useState("");
  useEffect(() => { window.editor?.darktableStatus().then(setDarktable); }, []);
  const chooseShoot = async () => { const result = await window.editor?.chooseShoot(); if (result) { setShoot(result); setCreated(null); setError(""); setStage("shoots"); } };
  const createShoot = async () => { if (!shoot || !window.editor) return; setProcessing(true); setError(""); try { setCreated(await window.editor.createShoot(shoot)); } catch (reason) { setError(reason instanceof Error ? reason.message : "Preview generation failed."); } finally { setProcessing(false); } };
  const toggleOperation = (id:string) => setOperations(items => items.map(item => item.id === id && item.action !== "Preserve" ? {...item,enabled:!item.enabled} : item));
  const savePlan = async () => { if (!created || !window.editor) return; const result = await window.editor.saveRetouchPlan({projectDir:created.projectDir,strength,operations}); setSaved(`Saved locally · ${result.path}`); };
  const current = created?.previews[selected];

  return <main>
    <aside><div className="brand"><span className="mark">C</span><div><strong>THE EDITOR</strong><small>Capture the Chapter Studio</small></div></div><nav><button className={stage==="shoots"?"active":""} onClick={()=>setStage("shoots")}>⌂ <span>Shoots</span></button><button className={stage==="retouch"?"active":""} disabled={!created} onClick={()=>created&&setStage("retouch")}>✦ <span>Retouch review</span></button><button>◫ <span>Editing profiles</span></button><button>◇ <span>Watermarks</span></button><button>⇩ <span>Export presets</span></button></nav><div className="engine"><span className={darktable?.available ? "dot good" : "dot"}/><div><b>{darktable?.available ? `darktable ${darktable.version}` : "Checking darktable"}</b><small>{darktable?.available ? "RAW engine ready" : "RAW engine unavailable"}</small></div></div></aside>
    <section className="content">
      {stage==="retouch" && created ? <div className="retouch">
        <header><div><p className="eyebrow">RETOUCH ANALYSIS · NON-DESTRUCTIVE</p><h1>Natural portrait review</h1></div><div className="compare">{(["Original","Edited","Retouched"] as const).map(mode=><button className={compare===mode?"selected":""} onClick={()=>setCompare(mode)} key={mode}>{mode}</button>)}</div></header>
        <div className="retouchLayout"><div className="canvasPanel">{current ? <><div className={`photoView mode-${compare.toLowerCase()}`}><img src={current.preview} alt={current.name}/>{compare==="Retouched"&&<span className="previewBadge">Retouch preview</span>}</div><div className="photoMeta"><b>{current.name}</b><span>{selected+1} of {created.previews.length}</span></div></>:<div className="placeholder">No preview available</div>}</div>
        <div className="controls"><p className="eyebrow">RETOUCH STRENGTH</p><div className="strengthName"><strong>Level {strength}</strong><span>{strengthNames[strength]}</span></div><input aria-label="Retouch strength" type="range" min="0" max="4" value={strength} onChange={e=>setStrength(Number(e.target.value))}/><p className="hint">Level 2 is recommended. Level 4 always requires explicit selection and approval.</p><div className="operationHead"><b>Retouch plan</b><span>{operations.filter(o=>o.enabled).length} enabled</span></div><div className="operations">{operations.map(op=><button key={op.id} className={`operation ${op.enabled?"on":""} ${op.action==="Preserve"?"locked":""}`} onClick={()=>toggleOperation(op.id)}><span className="check">{op.action==="Preserve"?"◆":op.enabled?"✓":""}</span><span><b>{op.label}</b><small>{op.detail}</small></span><em>{op.action}</em></button>)}</div><button className="primary save" onClick={savePlan}>Approve & save retouch plan</button>{saved&&<small className="saved">{saved}</small>}</div></div>
        <div className="filmstrip">{created.previews.map((photo,i)=><button key={photo.path} className={i===selected?"selected":""} onClick={()=>setSelected(i)}><img src={photo.preview} alt=""/><span>{i+1}</span></button>)}</div>
      </div> : <><header><div><p className="eyebrow">LOCAL WORKSPACE</p><h1>Your shoots</h1></div><button className="primary" onClick={chooseShoot}>＋ New shoot</button></header>
      {!shoot ? <div className="hero"><div className="aperture">◉</div><p className="eyebrow">FROM CARD TO CLIENT GALLERY</p><h2>Spend less time editing.<br/><em>Keep your signature look.</em></h2><p className="lede">Import a session, approve a representative look, and let Darktable process every photograph non-destructively.</p><button className="primary large" onClick={chooseShoot}>Choose a shoot folder <span>→</span></button><div className="promise"><span>✓ Originals stay untouched</span><span>✓ Local processing</span><span>✓ Clean + watermarked export</span></div></div> : <div className="shoot"><div className="shootHead"><div><p className="eyebrow">NEW SHOOT</p><h2>{shoot.folder.split(/[\\/]/).pop()}</h2><p>{shoot.folder}</p></div><div className="count"><strong>{shoot.files.length}</strong><span>photographs found</span></div></div><div className="fileGrid">{(created?.previews || shoot.files.slice(0,12)).map((photo,i)=><article key={photo.path}>{"preview" in photo?<img src={photo.preview} alt={photo.name}/>:<div className="placeholder"><span>{String(i+1).padStart(2,"0")}</span></div>}<b>{photo.name}</b><small>{photo.type} · {"preview" in photo?"Preview ready":"Ready for preview"}</small></article>)}</div>{error&&<div className="notice error"><b>Could not create previews</b><span>{error}</span></div>}{created&&<div className={created.previews.length?"notice success":"notice error"}><b>{created.previews.length?"Shoot created":"Preview generation failed"}</b><span>{created.previews.length} previews generated{created.failures.length?` · ${created.failures.length} could not be processed`:""}. Originals were not changed.{created.failures[0]?` First error: ${created.failures[0].message}`:""}</span></div>}<footer><span>{processing?"Darktable is creating previews…":created?`Local project: ${created.projectDir}`:shoot.files.length?"Ready to create previews without changing originals.":"No supported photographs found."}</span>{created?.previews.length?<button className="primary" onClick={()=>setStage("retouch")}>Retouch review →</button>:<button className="primary" onClick={createShoot} disabled={!shoot.files.length||processing}>{processing?"Creating previews…":"Create shoot →"}</button>}</footer></div>}</>}
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
