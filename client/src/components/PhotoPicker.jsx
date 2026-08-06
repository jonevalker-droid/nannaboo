import { useRef, useState } from 'react';
import { fileToPhoto } from '../lib/photo';

// Profile photo control (same-initial icon fix): camera roll or a fresh
// camera shot, center-cropped to a 200×200 circle. The photo stays on this
// device (localStorage) and is relayed live to the group over the socket —
// it is never written to the server's database. Always skippable; the
// colored-initial icon stays the fallback.
export default function PhotoPicker({ photo, name, onChange }) {
  const libraryRef = useRef(null);
  const cameraRef = useRef(null);
  const [error, setError] = useState(null);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    try {
      setError(null);
      onChange(await fileToPhoto(file));
    } catch {
      setError("Couldn't read that photo — try a different one");
    }
  };

  return (
    <div className="photo-picker">
      <div className="photo-preview" aria-hidden="true">
        {photo
          ? <img src={photo} alt="" />
          : <span>{(name?.[0] ?? '?').toUpperCase()}</span>}
      </div>
      <div className="photo-actions">
        <button type="button" className="mini-btn" onClick={() => libraryRef.current?.click()}>
          🖼 Choose photo
        </button>
        <button type="button" className="mini-btn" onClick={() => cameraRef.current?.click()}>
          📷 Take photo
        </button>
        {photo && (
          <button type="button" className="mini-btn" onClick={() => onChange(null)}>
            Remove
          </button>
        )}
      </div>
      {error && <p className="photo-err">{error}</p>}
      <input ref={libraryRef} type="file" accept="image/*" hidden onChange={pick} />
      <input ref={cameraRef} type="file" accept="image/*" capture="user" hidden onChange={pick} />
    </div>
  );
}
