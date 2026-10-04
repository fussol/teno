// settings 頁原始碼單點讀法：拆檔後 harness 只改這個檔案的 SETTINGS_PATHS，不用逐顆補
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

export const SETTINGS_PATHS = [
  'src/pages/settings.js',
  'src/pages/settings/sections.js',
  'src/pages/settings/webdav.js',
  'src/pages/settings/backup.js',
  'src/pages/settings/deck-manager.js',
  'src/pages/settings/_shared.js',
];

export function settingsSrc(root = ROOT) {
  return SETTINGS_PATHS.map((f) => readFileSync(path.join(root, f), 'utf8')).join('\n');
}
