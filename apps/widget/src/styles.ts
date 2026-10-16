const FONT = '14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

/**
 * Shadow-DOM stylesheet. Every container sets its own font and colour, so nothing depends on
 * inheritance from the host element (which the host page's CSS could otherwise influence).
 */
export const CSS = `
:host{all:initial}
*{box-sizing:border-box}
[hidden]{display:none!important}
button,textarea{font:inherit;color:inherit}
button{cursor:pointer;padding:8px 14px;border:1px solid #cbd5e1;border-radius:10px;background:#fff}
button:disabled{opacity:.6;cursor:default}
button.primary{background:#4f46e5;border-color:#4f46e5;color:#fff;font-weight:600}
button.icon{padding:2px 6px;border:0;background:none;font-size:16px;line-height:1;color:#64748b}
button:focus-visible,textarea:focus-visible{outline:2px solid #4f46e5;outline-offset:2px}
.pill{position:fixed;right:16px;bottom:16px;z-index:2147483000;height:40px;padding:0 16px;border:0;border-radius:999px;background:#111827;font:${FONT};color:#fff;font-weight:600;box-shadow:0 6px 20px rgba(0,0,0,.25)}
.pill.pulse{animation:hp-pulse 1.2s ease-out 1}
.sheet{position:fixed;right:16px;bottom:68px;z-index:2147483001;width:min(360px,calc(100vw - 32px));max-height:calc(100vh - 100px);overflow:auto;padding:16px;background:#fff;font:${FONT};color:#111827;border-radius:14px;box-shadow:0 16px 48px rgba(15,23,42,.28);animation:hp-in .18s ease-out}
.sheet header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
h2{margin:0;font-size:15px;font-weight:650}
textarea{display:block;width:100%;min-height:96px;resize:vertical;padding:10px;border:1px solid #cbd5e1;border-radius:10px;background:#fff}
.count{margin-top:4px;text-align:right;font-size:12px;color:#64748b}
.checks{margin:10px 0 0;padding:10px 12px;list-style:none;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;font-size:13px}
.checks li{margin:3px 0}
.err{margin:8px 0 0;color:#b91c1c;font-size:13px}
.err:empty,.status:empty{display:none}
.status{margin:6px 0 0;color:#475569}
.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.toast{position:fixed;left:0;right:0;bottom:68px;z-index:2147483002;margin:0 auto;width:max-content;max-width:calc(100vw - 32px);display:flex;align-items:center;gap:10px;padding:10px 10px 10px 16px;background:#111827;font:${FONT};color:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);animation:hp-in .18s ease-out}
.toast button{padding:2px 6px;border:0;background:none;color:#e5e7eb}
@keyframes hp-pulse{from{box-shadow:0 0 0 0 rgba(79,70,229,.55)}to{box-shadow:0 0 0 16px rgba(79,70,229,0)}}
@keyframes hp-in{from{opacity:0;transform:translateY(8px)}}
@media (max-width:499.98px){
.sheet{left:0;right:0;bottom:0;width:auto;max-height:85vh;border-radius:16px 16px 0 0;padding-bottom:calc(16px + env(safe-area-inset-bottom))}
.toast{bottom:76px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
