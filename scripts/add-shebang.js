// scripts/add-shebang.js
import fs from 'fs';
const filePath = new URL('../dist/server.js', import.meta.url);
const code = fs.readFileSync(filePath, 'utf-8');

if (!code.startsWith('#!')) {
  fs.writeFileSync(filePath, '#!/usr/bin/env node\n' + code);
}
