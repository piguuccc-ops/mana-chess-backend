// The backend's two pages: a short "what is this" at `/` of the backend, and the control panel
// (served only on the control panel's own port).
import type { ServerInfo } from '../src/net/protocol';
import { adminApp } from './adminApp';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Shared look: dark wood, parchment ink, brass and mana-blue – the game's colours, plainly set. */
const CSS = `
:root{color-scheme:dark;--bg:#120c0a;--panel:#1d140f;--panel2:#2a1b15;--line:#3d2a1f;--ink:#efdcb2;--ink2:#c9b089;--ink3:#8f7a5c;--gold:#e6bf4c;--brass:#b78a2b;--mana:#4fa0e0;--red:#d0544a;--green:#71b24e;--warn:#fbc254}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{background:var(--bg) radial-gradient(ellipse at top,#2a1b15 0,#120c0a 60%) fixed;color:var(--ink);font:15px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:'Palatino Linotype','Book Antiqua',Palatino,Georgia,serif;font-weight:700;margin:0;color:var(--ink);text-wrap:balance}
h1{font-size:26px}h2{font-size:18px;margin-bottom:10px}h3{font-size:18px;margin-bottom:12px}
a{color:var(--gold)}
.mono{font-family:ui-monospace,'Cascadia Mono',Consolas,monospace;font-variant-numeric:tabular-nums}
.hint{color:var(--ink3);font-size:13px;margin:4px 0 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.stack{display:flex;flex-direction:column;gap:16px}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.row.between{justify-content:space-between;margin-bottom:10px}.row.between h2{margin:0}
.btn{appearance:none;border:1px solid var(--line);background:var(--panel2);color:var(--ink);border-radius:8px;padding:9px 14px;font:600 14px/1 inherit;cursor:pointer;transition:filter .12s,transform .12s}
.btn:hover:not(:disabled){filter:brightness(1.15)}.btn:active:not(:disabled){transform:translateY(1px)}.btn:disabled{opacity:.45;cursor:not-allowed}
.btn-primary{background:linear-gradient(#e6bf4c,#b78a2b);border-color:#7c5a1c;color:#1d140f}
.btn-danger{background:#5a1a1c;border-color:#7d1f22;color:#ffd9d2}
.btn-ghost{background:transparent}.btn-sm{padding:6px 10px;font-size:13px}.btn-wide{width:100%;padding:12px}
input,select{font:inherit;color:var(--ink);background:#0d0907;border:1px solid var(--line);border-radius:8px;padding:9px 11px;min-width:0}
input:focus-visible,select:focus-visible,.btn:focus-visible,.tab:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
input[type=checkbox],input[type=radio]{accent-color:var(--gold);width:18px;height:18px;padding:0}
.field{display:flex;flex-direction:column;gap:6px;margin:0 0 12px}.field-label{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink2)}
.msg{margin:0 0 12px;padding:9px 12px;border-radius:8px;font-size:14px}.msg-error{background:rgba(208,84,74,.12);border:1px solid rgba(208,84,74,.5);color:#ffb4a8}
.brand{display:flex;align-items:center;gap:10px}.brand b{display:block;font-family:'Palatino Linotype',Palatino,Georgia,serif;font-size:17px}.brand small{color:var(--ink3);font-size:12px}
.crest{display:grid;place-items:center;width:38px;height:38px;border-radius:9px;background:linear-gradient(#e6bf4c,#b78a2b);color:#1d140f;font-size:22px}
.auth{min-height:100vh;display:grid;place-items:center;padding:24px 16px}
.auth-card{width:min(420px,100%)}.auth-card h1{margin:18px 0 6px}.auth-card .lead{color:var(--ink2);margin:0 0 18px}.auth-card .link-login{margin-top:10px;color:var(--ink2)}
.top{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;padding:12px max(16px,env(safe-area-inset-left));background:rgba(18,12,10,.92);border-bottom:1px solid var(--line);backdrop-filter:blur(6px)}
.tabs{display:flex;gap:4px;flex:1;overflow-x:auto;scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}
.tab{appearance:none;border:0;background:transparent;color:var(--ink2);font:600 14px/1 inherit;padding:10px 12px;border-radius:8px;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:6px}
.tab:hover{color:var(--ink);background:var(--panel)}.tab.is-on{color:#1d140f;background:var(--gold)}
.badge{min-width:20px;padding:2px 6px;border-radius:10px;background:var(--red);color:#fff;font-size:12px;line-height:16px;text-align:center}.tab.is-on .badge{background:#7d1f22}
.who{display:flex;align-items:center;gap:8px;color:var(--ink2)}
.page{width:min(1180px,100%);margin:0 auto;padding:20px 16px 60px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{appearance:none;text-align:left;font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:2px}
button.stat{cursor:pointer}button.stat:hover{border-color:var(--brass)}
.stat b{font-size:28px;font-variant-numeric:tabular-nums;font-family:'Palatino Linotype',Palatino,Georgia,serif}.stat span{color:var(--ink3);font-size:13px}
.stat.is-hot{border-color:var(--gold)}.stat.is-hot b{color:var(--gold)}.stat.is-mana b{color:var(--mana)}.stat.is-warn b{color:var(--warn)}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:0}.facts dt{color:var(--ink3)}.facts dd{margin:0;overflow-wrap:anywhere}
.table{width:100%;border-collapse:collapse;font-size:14px}.table th{text-align:left;color:var(--ink3);font-weight:600;font-size:12px;letter-spacing:.06em;text-transform:uppercase;padding:8px 10px;border-bottom:1px solid var(--line)}
.table td{padding:10px;border-bottom:1px solid rgba(61,42,31,.6);vertical-align:middle}.table tr:last-child td{border-bottom:0}
.table .num{font-variant-numeric:tabular-nums}.table .actions{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.table tr.is-pending td{background:rgba(230,191,76,.06)}
.pill{display:inline-block;margin-left:6px;padding:2px 8px;border-radius:10px;border:1px solid var(--line);font-size:12px;color:var(--ink2);white-space:nowrap}
.pill-hot{border-color:var(--gold);color:var(--gold)}.pill-warn{border-color:var(--warn);color:var(--warn)}.pill-mana{border-color:var(--mana);color:#9fd2f5}.pill-gold{background:rgba(230,191,76,.15);border-color:var(--brass);color:var(--gold)}
.seg{display:flex;flex-wrap:wrap;gap:4px}.seg-btn{appearance:none;border:1px solid var(--line);background:transparent;color:var(--ink2);border-radius:8px;padding:7px 10px;font:600 13px/1 inherit;cursor:pointer}.seg-btn.is-on{background:var(--panel2);color:var(--ink);border-color:var(--brass)}
.inline-form .row input{flex:1 1 160px}.check{display:flex;align-items:center;gap:8px;color:var(--ink2);white-space:nowrap}
.check.big{align-items:flex-start;white-space:normal}.check.big span{display:flex;flex-direction:column;gap:2px}.check.big small{color:var(--ink3)}
.choices{display:grid;gap:8px}.choice{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border:1px solid var(--line);border-radius:10px;cursor:pointer}
.choice:has(input:checked){border-color:var(--gold);background:rgba(230,191,76,.07)}.choice span{display:flex;flex-direction:column;gap:2px}.choice small{color:var(--ink3)}
.sticky-save{position:sticky;bottom:0;z-index:4;display:flex;justify-content:flex-end;align-items:center;gap:14px;margin:0 -16px;padding:12px 16px calc(12px + env(safe-area-inset-bottom));background:rgba(18,12,10,.94);border-top:1px solid var(--line);backdrop-filter:blur(6px)}
.save-note{color:var(--ink3);font-size:13px}.sticky-save.is-dirty .save-note{color:var(--warn)}
.ok-note{color:var(--green);margin:6px 0 0}
.log{margin:0;padding:0;list-style:none;font:13px/1.5 ui-monospace,'Cascadia Mono',Consolas,monospace;max-height:70vh;overflow:auto}.log li{padding:3px 0;border-bottom:1px solid rgba(61,42,31,.5);color:var(--ink2);overflow-wrap:anywhere}
.modal{position:fixed;inset:0;z-index:20;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.6)}
.modal-card{width:min(440px,100%);background:var(--panel);border:1px solid var(--brass);border-radius:12px;padding:18px}.modal-card input{width:100%;margin-top:8px}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.flash{position:fixed;left:50%;bottom:calc(78px + env(safe-area-inset-bottom));z-index:30;transform:translateX(-50%);max-width:min(560px,92vw);padding:11px 16px;border-radius:10px;font-weight:600;box-shadow:0 10px 30px rgba(0,0,0,.5)}
.flash-ok{background:#24512b;color:#dff5d8;border:1px solid #3e7f3a}.flash-error{background:#5a1a1c;color:#ffd9d2;border:1px solid #b3322c}
.landing{min-height:100vh;display:grid;place-items:center;padding:24px 16px}.landing .card{width:min(560px,100%)}.landing p{color:var(--ink2)}.landing .addr{display:block;margin:8px 0;padding:10px 12px;border-radius:8px;background:#0d0907;border:1px solid var(--line);color:var(--gold);user-select:all;overflow-wrap:anywhere}
@media (max-width:760px){
 .top{padding:10px 12px 0;gap:8px 12px}.who{margin-left:auto}.who span{display:none}
 .tabs{order:3;flex:1 0 100%;margin:0 -12px;padding:0 12px 8px}
 .page{padding-inline:12px}.sticky-save{margin-inline:-12px;padding-inline:12px}
 .table.users thead{display:none}.table.users tr{display:grid;gap:6px;padding:10px 0;border-bottom:1px solid var(--line)}.table.users td{border:0;padding:2px 0}
 .table.users td[data-label]::before{content:attr(data-label);display:block;color:var(--ink3);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
 .table.users .actions{justify-content:flex-start}.facts{grid-template-columns:1fr}.facts dt{margin-top:6px}
}
`;

export function adminPage(nonce: string): string {
  return `<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex"><meta name="theme-color" content="#120c0a"><title>Mana Chess – vezérlőpult</title><style>${CSS}</style></head><body><div id="app"></div><script nonce="${nonce}">(${adminApp.toString()})();</script></body></html>`;
}

export function landingPage(nonce: string, info: ServerInfo): string {
  return `<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="theme-color" content="#120c0a"><title>${esc(info.name)} – Mana Chess szerver</title><style>${CSS}</style></head><body><main class="landing"><section class="card">
<div class="brand"><span class="crest">♜</span><div><b>${esc(info.name)}</b><small>Mana Chess szerver · ${esc(info.build)}</small></div></div>
<h1 style="margin:18px 0 8px">A szerver fut.</h1>
<p>Ez a játék háttérszervere (backend): itt vannak a fiókok, a paklik, a barátok és a szobák. A játékot a játékoldal címén (frontend) vagy a <b>mana-chess.html</b> fájllal nyisd meg, és az <b>Online</b> résznél add meg ennek a szervernek a címét:</p>
<span class="addr mono" id="here"></span>
<p class="hint">Regisztráció: ${info.registration === 'open' ? 'nyitott' : info.registration === 'approval' ? 'jóváhagyással' : 'zárva'} · Vendégjáték: ${info.guests ? 'engedélyezve' : 'tiltva'}</p>
</section></main><script nonce="${nonce}">document.getElementById('here').textContent = location.origin;</script></body></html>`;
}
