#!/usr/bin/env node

// Install an exported TensorFlow.js layers model as the website's immutable
// built-in model. Usage:
//   node scripts/install-model.js ./exported-model [display name]
//   node scripts/install-model.js ./exported-model/model.json [display name]
//
// The input directory must contain model.json and every file referenced by
// its weightsManifest. The script copies only those declared artifacts into
// models/default and rewrites manifest paths to safe, local basenames.
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipEntries } from '../utils/zip.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(projectRoot, 'models', 'default');
const sourcePath = process.argv[2] && resolve(process.argv[2]);
const displayName = process.argv.slice(3).join(' ') || 'Installed model';

if (!sourcePath) {
  console.error('Usage: node scripts/install-model.js <model-directory-or-json> [display name]');
  process.exit(2);
}

const isZip = sourcePath.toLowerCase().endsWith('.zip');
const sourceDir = sourcePath.endsWith('.json') || isZip ? dirname(sourcePath) : sourcePath;
const modelPath = sourcePath.endsWith('.json') || isZip ? sourcePath : join(sourceDir, 'model.json');
let model;
let archive = null;
try {
  if (isZip) {
    archive = unzipEntries(await readFile(modelPath));
    const modelEntry = archive.get('model.json');
    if (!modelEntry) throw new Error('ZIP does not contain model.json');
    model = JSON.parse(new TextDecoder().decode(modelEntry));
  } else model = JSON.parse(await readFile(modelPath, 'utf8'));
} catch (err) {
  throw new Error(`could not read ${modelPath}: ${err.message}`);
}

if (!model.modelTopology || !Array.isArray(model.weightsManifest) || !model.weightsManifest.length) {
  throw new Error('model.json must contain modelTopology and a non-empty weightsManifest');
}

const weightFiles = [];
for (const group of model.weightsManifest) {
  if (!Array.isArray(group.paths) || !group.paths.length) throw new Error('weightsManifest contains an empty group');
  const rewritten = [];
  for (const path of group.paths) {
    const source = resolve(sourceDir, path);
    if (!source.startsWith(`${sourceDir}/`) && source !== sourceDir) {
      throw new Error(`weight path escapes the model directory: ${path}`);
    }
    const name = basename(source);
    weightFiles.push({ source, name, archiveData: archive?.get(name) });
    rewritten.push(name);
  }
  group.paths = rewritten;
}

const inputShape = findInputShape(model.modelTopology);
await mkdir(destination, { recursive: true });
for (const { source, name, archiveData } of weightFiles) {
  if (archiveData) await writeFile(join(destination, name), archiveData);
  else await copyFile(source, join(destination, name));
}
await writeFile(join(destination, 'model.json'), `${JSON.stringify(model, null, 2)}\n`);
await writeFile(join(destination, 'manifest.json'), `${JSON.stringify({
  installed: true,
  name: displayName,
  source: 'website',
  input: inputShape ? `${inputShape[1]}×${inputShape[2]}` : '',
}, null, 2)}\n`);
console.log(`Installed ${displayName} in ${destination}`);

function findInputShape(topology) {
  const layers = topology.config?.layers || [];
  const input = layers.find(layer => layer.class_name === 'InputLayer');
  return input?.config?.batch_input_shape || input?.config?.batchInputShape || null;
}
