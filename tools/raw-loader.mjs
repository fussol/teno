// vite `?raw` import 的 Node 等價物（gsat 還原測試用；build 走 vite 不經此檔）
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?raw')) {
    const r = await next(specifier.slice(0, -'?raw'.length), context);
    return { url: r.url + '?raw', shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith('?raw')) {
    const file = fileURLToPath(url.slice(0, url.indexOf('?')));
    return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(fs.readFileSync(file, 'utf8')) };
  }
  return next(url, context);
}
