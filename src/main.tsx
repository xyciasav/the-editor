import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type DarktableStatus = { available: boolean; path: string; version?: string };
type Photo = { name: string; path: string; type: string };
declare global { interface Window { editor?: { darktableStatus(): Promise<DarktableStatus>; chooseShoot(): Promise<{ folder: string; files: Photo[] } | null> } } }

function App() {
  const [darktable, setDarktable] = useState<DarktableStatus | null>(null);
  const [shoot, setShoot] = useState<{ folder: string; files: Photo[] } | null>(null);
  useEffect(() => { window.editor?.darktableStatus().then(setDarktable); }, []);
  const chooseShoot = async () => { const result = await window.editor?.chooseShoot(); if (result) setShoot(result); };
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
        <div className="fileGrid">{shoot.files.slice(0, 12).map((photo, i) => <article key={photo.path}><div className="placeholder"><span>{String(i + 1).padStart(2,"0")}</span></div><b>{photo.name}</b><small>{photo.type} · Ready for preview</small></article>)}</div>
        <footer><span>{shoot.files.length ? "Ready to create previews without changing originals." : "No supported photographs found in this folder."}</span><button className="primary" disabled={!shoot.files.length}>Create shoot →</button></footer>
      </div>}
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
