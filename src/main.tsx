import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type DarktableStatus = { available: boolean; path: string; version?: string };
type Photo = { name: string; path: string; type: string };
type CreatedShoot = { projectDir: string; previews: (Photo & { preview: string })[]; failures: { name: string; message: string }[]; total: number };
declare global { interface Window { editor?: { darktableStatus(): Promise<DarktableStatus>; chooseShoot(): Promise<{ folder: string; files: Photo[] } | null>; createShoot(shoot: { folder: string; files: Photo[] }): Promise<CreatedShoot> } } }

function App() {
  const [darktable, setDarktable] = useState<DarktableStatus | null>(null);
  const [shoot, setShoot] = useState<{ folder: string; files: Photo[] } | null>(null);
  const [created, setCreated] = useState<CreatedShoot | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { window.editor?.darktableStatus().then(setDarktable); }, []);
  const chooseShoot = async () => { const result = await window.editor?.chooseShoot(); if (result) { setShoot(result); setCreated(null); setError(""); } };
  const createShoot = async () => {
    if (!shoot || !window.editor) return;
    setProcessing(true); setError("");
    try { setCreated(await window.editor.createShoot(shoot)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Preview generation failed."); }
    finally { setProcessing(false); }
  };
  return <main>
    <aside>
      <div className="brand"><span className="mark">C</span><div><strong>THE EDITOR</strong><small>Capture the Chapter Studio</small></div></div>
      <nav><button className="active">⌂ <span>Shoots</span></button><button>◫ <span>Editing profiles</span></button><button>◇ <span>Watermarks</span></button><button>⇩ <span>Export presets</span></button></nav>
      <div className="engine"><span className={darktable?.available ? "dot good" : "dot"}/><div><b>{darktable?.available ? `darktable ${darktable.version}` : "Checking darktable"}</b><small>{darktable?.available ? "RAW engine ready" : "RAW engine unavailable"}</small></div></div>
    </aside>
    <section className="content">
      <header><div><p className="eyebrow">LOCAL WORKSPACE</p><h1>Your shoots</h1></div><button className="primary" onClick={chooseShoot}>＋ New shoot</button></header>
      {!shoot ? <div className="hero">
        <div className="aperture">◉</div><p className="eyebrow">FROM CARD TO CLIENT GALLERY</p><h2>Spend less time editing.<br/><em>Keep your signature look.</em></h2>
        <p className="lede">Import a session, approve a representative look, and let Darktable process every photograph non-destructively.</p>
        <button className="primary large" onClick={chooseShoot}>Choose a shoot folder <span>→</span></button>
        <div className="promise"><span>✓ Originals stay untouched</span><span>✓ Local processing</span><span>✓ Clean + watermarked export</span></div>
      </div> : <div className="shoot">
        <div className="shootHead"><div><p className="eyebrow">NEW SHOOT</p><h2>{shoot.folder.split(/[\\/]/).pop()}</h2><p>{shoot.folder}</p></div><div className="count"><strong>{shoot.files.length}</strong><span>photographs found</span></div></div>
        <div className="fileGrid">{(created?.previews || shoot.files.slice(0, 12)).map((photo, i) => <article key={photo.path}>{"preview" in photo ? <img src={photo.preview} alt={photo.name}/> : <div className="placeholder"><span>{String(i + 1).padStart(2,"0")}</span></div>}<b>{photo.name}</b><small>{photo.type} · {"preview" in photo ? "Preview ready" : "Ready for preview"}</small></article>)}</div>
        {error && <div className="notice error"><b>Could not create previews</b><span>{error}</span></div>}
        {created && <div className="notice success"><b>Shoot created</b><span>{created.previews.length} previews generated{created.failures.length ? ` · ${created.failures.length} could not be processed` : ""}. Originals were not changed.</span></div>}
        <footer><span>{processing ? "Darktable is creating previews. Large RAW shoots can take a few minutes…" : created ? `Local project: ${created.projectDir}` : shoot.files.length ? "Ready to create previews without changing originals." : "No supported photographs found in this folder."}</span><button className="primary" onClick={createShoot} disabled={!shoot.files.length || processing || !!created}>{processing ? "Creating previews…" : created ? "Shoot created ✓" : "Create shoot →"}</button></footer>
      </div>}
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
