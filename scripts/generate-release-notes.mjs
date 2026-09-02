#!/usr/bin/env node
// generate-release-notes.mjs — bouwt server/release-notes.json uit git-historie.
//
// Gebruik:
//   node scripts/generate-release-notes.mjs --new 2026.0902.1030
//       Voegt een blok toe voor de release die NU gemaakt wordt (range =
//       laatste v*-tag..HEAD). Draait vanuit release.sh vóór de release-commit.
//   node scripts/generate-release-notes.mjs --backfill 4
//       Herbouwt het bestand voor de laatste N bestaande tags (eenmalig).
//   node scripts/generate-release-notes.mjs --selftest
//       Zelfcheck van de commit-classificatie.
//
// Bestand: { releases: [ { version, date, sections: { dashboard, app, admin,
// firmware, server } } ] } — nieuwste eerst, maximaal 10 releases. De server
// serveert dit op /api/dashboard/release-notes; het dashboard toont het in de
// release-notes-popup naast het versienummer.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'server', 'release-notes.json');
const MAX_RELEASES = 10;

const SECTIONS = ['dashboard', 'app', 'admin', 'firmware', 'server'];

/** Classificeer één commit-subject. Retourneert {section, text} of null (ruis).
 *  Zelfde filterfilosofie als de app-release-notes in release-app.sh. */
export function classify(subject) {
  if (/^Merge /.test(subject)) return null;
  if (/^(release|chore|test|tests|docs|ci|build|style|refactor|cleanup)([(:])/i.test(subject)) return null;

  // Twee stijlen in deze repo: conventional ("fix(app): ...") én kale
  // gebiedsprefixen ("app: dag-skip UI", "schedules: ..."). Beide meenemen;
  // subjects zonder prefix zijn meestal merge-/release-achtige ruis en vallen af.
  let scope = '';
  let text = '';
  const conv = subject.match(/^(fix|feat|perf|tweak)(?:\(([^)]*)\))?:\s*(.+)$/);
  const bare = subject.match(/^([a-z][a-z0-9_+-]*):\s*(.+)$/);
  if (conv) {
    scope = (conv[2] ?? '').toLowerCase();
    text = conv[3];
  } else if (bare) {
    scope = bare[1].toLowerCase();
    text = bare[2];
  } else {
    return null;
  }

  text = text.trim().replace(/\s*\(#\d+(\s+#\d+)*\)\s*$/, '');
  text = text.charAt(0).toUpperCase() + text.slice(1);

  let section = 'server';
  if (/dashboard/.test(scope)) section = 'dashboard';
  else if (/^app$|\bapp\b|i18n/.test(scope)) section = 'app';
  else if (/admin/.test(scope)) section = 'admin';
  else if (/firmware|mower|stm32/.test(scope)) section = 'firmware';
  return { section, text };
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

const MAX_BULLETS_PER_SECTION = 20;

function sectionsForRange(range) {
  let subjects = git('log', '--pretty=format:%s', range).split('\n').filter(Boolean);

  // Reverts binnen dezelfde range strepen hun doel weg: een teruggedraaide
  // feature is niet geleverd en hoort dus ook niet in de notes (les van de
  // containerbeheer-revert in de 0831-release).
  const reverted = subjects
    .map(s => s.match(/^Revert "(.+)"$/)?.[1])
    .filter(Boolean);
  for (const target of reverted) {
    const i = subjects.indexOf(target);
    if (i !== -1) subjects.splice(i, 1);
  }

  const sections = Object.fromEntries(SECTIONS.map(s => [s, []]));
  for (const s of subjects) {
    const c = classify(s);
    if (c) sections[c.section].push(c.text);
  }
  // Lange releases (weken werk) worden anders onleesbaar: aftoppen met teller.
  for (const k of SECTIONS) {
    if (sections[k].length > MAX_BULLETS_PER_SECTION) {
      const extra = sections[k].length - MAX_BULLETS_PER_SECTION;
      sections[k] = sections[k].slice(0, MAX_BULLETS_PER_SECTION);
      sections[k].push(`… plus ${extra} kleinere wijzigingen`);
    }
  }
  // Lege secties weglaten houdt het JSON klein; de popup toont toch alleen wat er is.
  for (const k of SECTIONS) if (sections[k].length === 0) delete sections[k];
  return sections;
}

function loadExisting() {
  try {
    return JSON.parse(readFileSync(OUT, 'utf8'));
  } catch {
    return { releases: [] };
  }
}

function save(data) {
  data.releases = data.releases.slice(0, MAX_RELEASES);
  writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n');
  console.log(`${OUT}: ${data.releases.length} release(s), nieuwste ${data.releases[0]?.version ?? '-'}`);
}

function serverTags() {
  // Alleen server-release-tags (vJJJJ.MMDD.UUMM), geen app-v* e.d.
  return git('tag', '--list', 'v20*', '--sort=-creatordate').split('\n').filter(Boolean);
}

const mode = process.argv[2];

if (mode === '--selftest') {
  const assert = (cond, label) => { if (!cond) { console.error(`FAIL: ${label}`); process.exitCode = 1; } };
  assert(classify('fix(dashboard): iets')?.section === 'dashboard', 'dashboard scope');
  assert(classify('feat(app): iets')?.section === 'app', 'app scope');
  assert(classify('fix(activity): iets')?.section === 'server', 'onbekende scope -> server');
  assert(classify('fix: kaal')?.section === 'server', 'ongescoped -> server');
  assert(classify('fix(firmware-build): x')?.section === 'firmware', 'firmware-build -> firmware');
  assert(classify('chore: opruimen') === null, 'chore genegeerd');
  assert(classify('release: v2026') === null, 'release genegeerd');
  assert(classify('Merge feat/x') === null, 'merge genegeerd');
  assert(classify('fix(server): iets (#95)')?.text === 'Iets', 'issue-ref gestript + hoofdletter');
  assert(classify('app: dag-skip UI + weekweergave')?.section === 'app', 'kale app-prefix');
  assert(classify('schedules: dag-skip backend')?.section === 'server', 'kale onbekende prefix -> server');
  assert(classify('OpenNova v1.0.0-beta zonder prefix') === null, 'geen prefix genegeerd');
  console.log(process.exitCode ? 'GEFAALD' : 'selftest OK');
} else if (mode === '--new') {
  const version = process.argv[3];
  if (!version) { console.error('gebruik: --new <versie>'); process.exit(1); }
  const prev = serverTags()[0];
  const range = prev ? `${prev}..HEAD` : 'HEAD';
  const data = loadExisting();
  data.releases = data.releases.filter(r => r.version !== version);
  data.releases.unshift({
    version,
    date: new Date().toISOString().slice(0, 10),
    sections: sectionsForRange(range),
  });
  save(data);
} else if (mode === '--backfill') {
  const n = parseInt(process.argv[3] ?? '4', 10);
  const tags = serverTags().slice(0, n + 1); // +1: oudste dient alleen als ondergrens
  const data = { releases: [] };
  for (let i = 0; i < Math.min(n, tags.length); i++) {
    const tag = tags[i];
    const lower = tags[i + 1];
    const range = lower ? `${lower}..${tag}` : tag;
    data.releases.push({
      version: tag.replace(/^v/, ''),
      date: git('log', '-1', '--format=%cd', '--date=short', tag),
      sections: sectionsForRange(range),
    });
  }
  save(data);
} else {
  console.error('gebruik: --new <versie> | --backfill [N] | --selftest');
  process.exit(1);
}
