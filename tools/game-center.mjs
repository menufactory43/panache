#!/usr/bin/env node
/**
 * Game Center dans App Store Connect : les succès et les classements que le jeu envoie
 * (src/game/game-center.ts, mêmes identifiants), en français et en anglais, avec les médailles
 * d'art/game-center/raw/, et Game Center activé sur la version en préparation.
 * Reprend là où il en est : ce qui existe déjà est mis à jour, rien n'est créé deux fois.
 *
 *   node tools/game-center.mjs            # tout
 *   node tools/game-center.mjs etat       # ce qu'il y a dans App Store Connect
 */
import { createHash, createSign } from 'node:crypto'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = '6826780747'
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGES = join(RACINE, 'art/game-center/raw')

function jeton() {
  const cle = readFileSync(process.env.HOME + '/.appstoreconnect/private_keys/AuthKey_P2DPLW2SRN.p8')
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const t = Math.floor(Date.now() / 1000)
  const corps = `${b({ alg: 'ES256', kid: 'P2DPLW2SRN', typ: 'JWT' })}.${b({ iss: 'fb365280-db5a-48bb-84b3-98ae481c1235', iat: t, exp: t + 1100, aud: 'appstoreconnect-v1' })}`
  return `${corps}.${createSign('SHA256').update(corps).sign({ key: cle, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}
async function api(methode, chemin, donnees) {
  const r = await fetch('https://api.appstoreconnect.apple.com' + chemin, {
    method: methode, headers: { Authorization: `Bearer ${jeton()}`, 'Content-Type': 'application/json' },
    body: donnees ? JSON.stringify({ data: donnees }) : undefined,
  })
  const texte = await r.text()
  if (!r.ok) throw new Error(`${methode} ${chemin} → ${r.status} ${texte.slice(0, 900)}`)
  return texte ? JSON.parse(texte) : {}
}
const tout = async (chemin) => {
  const out = []
  let url = chemin
  while (url) {
    const r = await api('GET', url)
    out.push(...r.data)
    url = r.links?.next ? r.links.next.replace('https://api.appstoreconnect.apple.com', '') : null
  }
  return out
}
const rel = (type, id) => ({ data: { type, id } })

// [id, points, fr: [nom, avant, après], en: [nom, avant, après]] — « avant » : ce qu'il faut faire, « après » : ce qui a été fait
const SUCCES = [
  ['premier-jour', 10, ['Premier jour', "Terminer la première leçon de l'Instruction.", "Première leçon de l'Instruction terminée."], ['First Day', 'Finish the first lesson of Basic Training.', 'First lesson of Basic Training finished.']],
  ['deuxieme-jour', 10, ['Deuxième jour', "Terminer la seconde leçon de l'Instruction.", "Seconde leçon de l'Instruction terminée."], ['Second Day', 'Finish the second lesson of Basic Training.', 'Second lesson of Basic Training finished.']],
  ['premiere-victoire', 10, ['Premier sang', 'Gagner une escarmouche.', 'Une escarmouche gagnée.'], ['First Blood', 'Win a skirmish.', 'A skirmish won.']],
  ['acte-1', 40, ["L'Ultimatum", "Gagner les quatre missions de l'acte I de la Campagne de 1900.", "Acte I de la Campagne de 1900 gagné."], ['The Ultimatum', 'Win the four missions of Act I of the 1900 Campaign.', 'Act I of the 1900 Campaign won.']],
  ['acte-2', 50, ['La Guerre des cimes', "Gagner les quatre missions de l'acte II de la Campagne de 1900.", "Acte II de la Campagne de 1900 gagné."], ['War on the Peaks', 'Win the four missions of Act II of the 1900 Campaign.', 'Act II of the 1900 Campaign won.']],
  ['acte-3', 100, ['Paris !', 'Gagner toute la Campagne de 1900.', 'La Campagne de 1900 est gagnée. Vive la République !'], ['Paris!', 'Win the whole 1900 Campaign.', 'The 1900 Campaign is won.']],
  ['trente-six-etoiles', 100, ['Trente-six chandelles', 'Gagner les 36 étoiles de la Campagne de 1900 (en Normal).', 'Les 36 étoiles de la Campagne de 1900.'], ['Seeing Stars', 'Earn all 36 stars of the 1900 Campaign (on Normal).', 'All 36 stars of the 1900 Campaign.']],
  ['epreuves', 75, ['Vieux de la vieille', 'Réussir les 8 Épreuves classiques.', 'Les 8 Épreuves classiques réussies.'], ['Old Guard', 'Complete all 8 Classic Trials.', 'All 8 Classic Trials complete.']],
  ['difficile', 50, ['À la dure', 'Gagner une escarmouche en Difficile.', 'Une escarmouche gagnée en Difficile.'], ['The Hard Way', 'Win a skirmish on Hard.', 'A skirmish won on Hard.']],
  ['vingt-cinq-victoires', 50, ['Vingt-cinq victoires', 'Gagner 25 escarmouches.', '25 escarmouches gagnées.'], ['Twenty-Five Victories', 'Win 25 skirmishes.', '25 skirmishes won.']],
  ['lieutenant', 20, ['Lieutenant', 'Atteindre le grade de Lieutenant.', 'Lieutenant.'], ['Lieutenant', 'Reach the rank of Lieutenant.', 'Lieutenant.']],
  ['colonel', 50, ['Colonel', 'Atteindre le grade de Colonel.', 'Colonel.'], ['Colonel', 'Reach the rank of Colonel.', 'Colonel.']],
  ['marechal', 100, ['Bâton de maréchal', 'Atteindre le grade de Maréchal.', 'Maréchal de France.'], ["Marshal's Baton", 'Reach the rank of Marshal.', 'Marshal.']],
  ['resistant', 30, ['Résistant', 'Tenir 10 vagues en Survie.', '10 vagues tenues en Survie.'], ['Holdout', 'Hold out 10 waves in Last Stand.', '10 waves held in Last Stand.']],
  ['inebranlable', 60, ['Inébranlable', 'Tenir 20 vagues en Survie.', '20 vagues tenues en Survie.'], ['Unshakeable', 'Hold out 20 waves in Last Stand.', '20 waves held in Last Stand.']],
  ['dix-medailles', 50, ['Poitrine bien garnie', 'Obtenir 10 médailles différentes.', '10 médailles différentes.'], ['Chest Full of Medals', 'Earn 10 different medals.', '10 different medals.']],
  ['tueur-de-gargantua', 30, ['Tueur de Gargantua', 'Abattre un Gargantua ennemi en escarmouche.', 'Un Gargantua abattu.'], ['Gargantua Slayer', 'Bring down an enemy Gargantua in a skirmish.', 'A Gargantua brought down.']],
  ['voyage-dans-la-lune', 30, ['Voyage dans la Lune', "Gagner la médaille Voyage dans la Lune d'un seul Obus Méliès.", 'Dans l’œil !'], ['A Trip to the Moon', 'Earn the Trip to the Moon medal with a single Méliès Shell.', 'Right in the eye!']],
  ['sept-jours', 50, ['Une semaine au front', "Gagner l'Op du jour sept jours de suite.", "L'Op du jour gagnée sept jours de suite."], ['A Week at the Front', 'Win the Daily Op seven days in a row.', 'The Daily Op won seven days in a row.']],
  ['duel', 30, ['Sur le pré', 'Gagner un duel en ligne contre un autre joueur.', 'Un duel en ligne gagné.'], ['Pistols at Dawn', 'Win an online duel against another player.', 'An online duel won.']],
  ['eclair-gagne', 25, ['Coup de tonnerre', 'Gagner une partie Éclair.', 'Une partie Éclair gagnée.'], ['Thunderclap', 'Win a Lightning match.', 'A Lightning match won.']],
]

// [id, fr: [nom, suffixe, suffixe au singulier], en: [...]]
const CLASSEMENTS = [
  ['survie', ['Survie', ' vagues', ' vague'], ['Last Stand', ' waves', ' wave']],
  ['carriere', ['Carrière', ' XP', ' XP'], ['Career', ' XP', ' XP']],
  ['eclair', ['Éclair', ' points', ' point'], ['Lightning', ' points', ' point']],
]

async function envoyerImage(type, relation, fichier) {
  const taille = statSync(fichier).size
  const cree = await api('POST', `/v1/${type}`, { type, attributes: { fileName: basename(fichier), fileSize: taille }, relationships: relation })
  const contenu = readFileSync(fichier)
  for (const op of cree.data.attributes.uploadOperations) {
    const r = await fetch(op.url, { method: op.method, headers: Object.fromEntries(op.requestHeaders.map((h) => [h.name, h.value])), body: contenu.subarray(op.offset, op.offset + op.length) })
    if (!r.ok) throw new Error(`morceau ${op.offset} → ${r.status}`)
  }
  await api('PATCH', `/v1/${type}/${cree.data.id}`, { type, id: cree.data.id, attributes: { uploaded: true } })
}

async function detail() {
  try {
    const r = await api('GET', `/v1/apps/${APP}/gameCenterDetail`)
    if (r.data) return r.data.id
  } catch { /* pas encore */ }
  const r = await api('POST', '/v1/gameCenterDetails', { type: 'gameCenterDetails', relationships: { app: rel('apps', APP) } })
  console.log('✓ Game Center activé pour l’app')
  return r.data.id
}

async function succes(det) {
  const existants = await tout(`/v1/gameCenterDetails/${det}/gameCenterAchievements?limit=200`)
  const total = SUCCES.reduce((s, x) => s + x[1], 0)
  if (total > 1000) throw new Error(`${total} points : Apple en permet 1 000`)
  for (const [id, points, fr, en] of SUCCES) {
    const vendor = `panache.${id.replaceAll('-', '_')}`
    let a = existants.find((x) => x.attributes.vendorIdentifier === vendor)
    if (!a) {
      a = (await api('POST', '/v1/gameCenterAchievements', {
        type: 'gameCenterAchievements',
        attributes: { referenceName: fr[0], vendorIdentifier: vendor, points, showBeforeEarned: true, repeatable: false },
        relationships: { gameCenterDetail: rel('gameCenterDetails', det) },
      })).data
    } else if (a.attributes.points !== points || a.attributes.referenceName !== fr[0]) {
      await api('PATCH', `/v1/gameCenterAchievements/${a.id}`, { type: 'gameCenterAchievements', id: a.id, attributes: { points, referenceName: fr[0] } })
    }
    const locs = await tout(`/v1/gameCenterAchievements/${a.id}/localizations`)
    for (const [locale, [name, before, after]] of [['fr-FR', fr], ['en-US', en], ['en-GB', en]]) {
      const attributes = { name, beforeEarnedDescription: before, afterEarnedDescription: after }
      let l = locs.find((x) => x.attributes.locale === locale)
      if (!l) l = (await api('POST', '/v1/gameCenterAchievementLocalizations', { type: 'gameCenterAchievementLocalizations', attributes: { locale, ...attributes }, relationships: { gameCenterAchievement: rel('gameCenterAchievements', a.id) } })).data
      else await api('PATCH', `/v1/gameCenterAchievementLocalizations/${l.id}`, { type: 'gameCenterAchievementLocalizations', id: l.id, attributes })
      const img = join(IMAGES, `${id}.png`)
      if (!existsSync(img)) { console.log(`  (pas encore d'image : ${id})`); continue }
      let a2 = null
      try { a2 = (await api('GET', `/v1/gameCenterAchievementLocalizations/${l.id}/gameCenterAchievementImage`)).data } catch { /* aucune */ }
      if (a2 && a2.attributes.assetDeliveryState?.state === 'FAILED') { await api('DELETE', `/v1/gameCenterAchievementImages/${a2.id}`); a2 = null }
      if (!a2) await envoyerImage('gameCenterAchievementImages', { gameCenterAchievementLocalization: rel('gameCenterAchievementLocalizations', l.id) }, img)
    }
    console.log(`✓ succès ${vendor} (${points} pts)`)
  }
  console.log(`  ${total} points sur 1 000`)
}

async function classements(det) {
  const existants = await tout(`/v1/gameCenterDetails/${det}/gameCenterLeaderboards?limit=200`)
  for (const [id, fr, en] of CLASSEMENTS) {
    const vendor = `panache.${id.replaceAll('-', '_')}`
    let b = existants.find((x) => x.attributes.vendorIdentifier === vendor)
    if (!b) {
      b = (await api('POST', '/v1/gameCenterLeaderboards', {
        type: 'gameCenterLeaderboards',
        attributes: { referenceName: fr[0], vendorIdentifier: vendor, defaultFormatter: 'INTEGER', submissionType: 'BEST_SCORE', scoreSortType: 'DESC' },
        relationships: { gameCenterDetail: rel('gameCenterDetails', det) },
      })).data
    }
    const locs = await tout(`/v1/gameCenterLeaderboards/${b.id}/localizations`)
    for (const [locale, [name, suffix, singular]] of [['fr-FR', fr], ['en-US', en], ['en-GB', en]]) {
      const attributes = { name, formatterSuffix: suffix, formatterSuffixSingular: singular }
      const l = locs.find((x) => x.attributes.locale === locale)
      if (!l) await api('POST', '/v1/gameCenterLeaderboardLocalizations', { type: 'gameCenterLeaderboardLocalizations', attributes: { locale, ...attributes }, relationships: { gameCenterLeaderboard: rel('gameCenterLeaderboards', b.id) } })
      else await api('PATCH', `/v1/gameCenterLeaderboardLocalizations/${l.id}`, { type: 'gameCenterLeaderboardLocalizations', id: l.id, attributes })
    }
    console.log(`✓ classement ${vendor}`)
  }
}

async function version() {
  const v = (await api('GET', `/v1/apps/${APP}/appStoreVersions?filter[platform]=IOS`)).data.find((x) => x.attributes.appStoreState === 'PREPARE_FOR_SUBMISSION')
  if (!v) { console.log('✗ pas de version en préparation'); return }
  let gv = null
  try { gv = (await api('GET', `/v1/appStoreVersions/${v.id}/gameCenterAppVersion`)).data } catch { /* aucune */ }
  if (!gv) {
    gv = (await api('POST', '/v1/gameCenterAppVersions', { type: 'gameCenterAppVersions', relationships: { appStoreVersion: rel('appStoreVersions', v.id) } })).data
  }
  if (!gv.attributes.enabled) await api('PATCH', `/v1/gameCenterAppVersions/${gv.id}`, { type: 'gameCenterAppVersions', id: gv.id, attributes: { enabled: true } })
  console.log(`✓ Game Center activé sur la version ${v.attributes.versionString}`)
}

// « Releases » : ce qui sort avec la prochaine version validée (la partie Game Center de la page de version)
async function sorties(det) {
  for (const [genre, rel1, chemin] of [['gameCenterAchievement', 'gameCenterAchievements', 'gameCenterAchievements'], ['gameCenterLeaderboard', 'gameCenterLeaderboards', 'gameCenterLeaderboards']]) {
    const items = await tout(`/v1/gameCenterDetails/${det}/${chemin}?limit=200`)
    const deja = new Set((await tout(`/v1/gameCenterDetails/${det}/${genre === 'gameCenterAchievement' ? 'achievementReleases' : 'leaderboardReleases'}?limit=200&include=${genre}`)).map((r) => r.relationships?.[genre]?.data?.id))
    let n = 0
    for (const it of items) {
      if (deja.has(it.id)) continue
      await api('POST', `/v1/${genre}Releases`, { type: `${genre}Releases`, relationships: { gameCenterDetail: rel('gameCenterDetails', det), [genre]: rel(rel1, it.id) } })
      n++
    }
    console.log(`✓ ${items.length} ${chemin} prêts à sortir avec la version (${n} ajoutés)`)
  }
}

async function etat() {
  const det = (await api('GET', `/v1/apps/${APP}/gameCenterDetail`)).data
  const a = await tout(`/v1/gameCenterDetails/${det.id}/gameCenterAchievements?limit=200`)
  const b = await tout(`/v1/gameCenterDetails/${det.id}/gameCenterLeaderboards?limit=200`)
  console.log(`${a.length} succès (${a.reduce((s, x) => s + x.attributes.points, 0)} points), ${b.length} classements`)
  for (const x of a) console.log(' ', x.attributes.vendorIdentifier, x.attributes.points, x.attributes.archived ? '(archivé)' : '')
  for (const x of b) console.log(' ', x.attributes.vendorIdentifier)
}

const etape = process.argv[2]
if (etape === 'etat') await etat()
else {
  const det = await detail()
  await succes(det)
  await classements(det)
  await version()
  await sorties(det)
}
