// Debug logging utility — only active in dev mode (NODE_ENV !== "production")
// Outputs are tagged with [DBG:tag] for easy grep/filter
const isDev = process.env.NODE_ENV !== "production";

const p2 = (n) => (n < 10 ? "0" + n : "" + n);
function ts() {
  const d = new Date();
  return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
}

export function dbg(tag, msg) {
  if (!isDev) return;
  console.log(`[${ts()}] 🐛 [DBG:${tag}] ${msg}`);
}

export const isDebugEnabled = isDev;
