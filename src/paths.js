import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root (the folder with package.json). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
