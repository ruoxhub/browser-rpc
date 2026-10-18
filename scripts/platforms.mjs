import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGeneratedDrift, syncGeneratedFiles } from './platforms/files.mjs';
import { loadPlatformDescriptors, validatePlatformDescriptors } from './platforms/model.mjs';
import { renderGeneratedFilesIn } from './platforms/render.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function generatedFiles() {
  const descriptors = loadPlatformDescriptors(rootDir);
  validatePlatformDescriptors(descriptors, rootDir);
  const baseManifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'browser-rpc', 'manifest.base.json'), 'utf8'));
  return renderGeneratedFilesIn(rootDir, baseManifest, descriptors);
}

function sync() {
  syncGeneratedFiles(rootDir, generatedFiles());
}

function check() {
  const drift = findGeneratedDrift(rootDir, generatedFiles());
  for (const relativePath of drift) console.log(relativePath);
  if (drift.length > 0) process.exitCode = 1;
}

function watch() {
  console.log('Watching browser-rpc/content/ and browser-rpc/manifest.base.json for changes...');
  let timeout = null;
  const triggerSync = () => {
    try {
      sync();
      console.log(`[${new Date().toLocaleTimeString()}] Successfully synced platform files.`);
    } catch (error) {
      console.error(`[${new Date().toLocaleTimeString()}] Sync error:`, error.message);
    }
  };
  triggerSync();

  const contentDir = path.join(rootDir, 'browser-rpc', 'content');
  const manifestBase = path.join(rootDir, 'browser-rpc', 'manifest.base.json');
  const onChange = () => {
    clearTimeout(timeout);
    timeout = setTimeout(triggerSync, 100);
  };

  fs.watch(contentDir, { recursive: true }, onChange);
  if (fs.existsSync(manifestBase)) fs.watch(manifestBase, onChange);
}

function usageAndExit() {
  console.error('Usage: node browser-rpc/scripts/platforms.mjs sync|check|watch|new <id>|new-py <id>');
  process.exitCode = 1;
}

const args = process.argv.slice(2);
const command = args[0];
if (command === 'sync' && args.length === 1) sync();
else if (command === 'check' && args.length === 1) check();
else if (command === 'watch' && args.length === 1) watch();
else if (command === 'new' && args.length === 2) {
  try {
    const { scaffoldPlatform } = await import('./platforms/scaffold.mjs');
    for (const relativePath of scaffoldPlatform(rootDir, args[1])) console.log(relativePath);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else if (command === 'new-py' && args.length === 2) {
  try {
    const { scaffoldPyappPlatform } = await import('./platforms/scaffold.mjs');
    for (const relativePath of scaffoldPyappPlatform(rootDir, args[1])) console.log(relativePath);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else usageAndExit();
