#!/usr/bin/env node
// Stages this app's static files plus the shared package into ./dist,
// so each app can be deployed as an independent Vercel project without
// depending on Vercel's cross-root-directory file access at request time.
'use strict';

const fs = require('fs');
const path = require('path');

const appDir = process.cwd();
const repoRoot = path.resolve(appDir, '..', '..');
const distDir = path.join(appDir, 'dist');
const sharedSrc = path.join(repoRoot, 'packages', 'shared');

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

for (const entry of fs.readdirSync(appDir)) {
  if (['dist', 'node_modules', 'build.js', 'package.json', 'package-lock.json', 'vercel.json'].includes(entry)) {
    continue;
  }
  copyRecursive(path.join(appDir, entry), path.join(distDir, entry));
}

copyRecursive(sharedSrc, path.join(distDir, 'shared'));

console.log(`[build-app] staged ${appDir} -> ${distDir} (shared copied from ${sharedSrc})`);
