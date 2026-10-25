// Panache dans App Store Connect, par son API (la clé de tools/ios-testflight.sh) :
//   node tools/ios-store.mjs etat        → l'app, ses builds et ses groupes de test
//   node tools/ios-store.mjs testflight  → le groupe de test interne « Équipe » (tous les builds), les membres du compte dedans
//   node tools/ios-store.mjs fiche       → la fiche (ios/store/fiche.json) : catégories, textes fr/en, URLs, classement par âge
//   node tools/ios-store.mjs captures    → les captures (ios/store/shots/<langue>/*.jpg, tools/store-shots.mjs)
//   node tools/ios-store.mjs apercu      → la vidéo d'aperçu (ios/store/previews/<langue>.mp4, tools/store-preview.mjs)
// Rien ici ne soumet l'app à la revue d'Apple : la soumission se fait à la main, quand on le décide.
// L'app doit exister dans App Store Connect (l'API ne sait pas la créer) : Apps → + → Nouvelle app, identifiant de
// lot io.github.menufactory43.panache.
import { createHash, createSign } from "node:crypto";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const KEY_ID = process.env.ASC_KEY_ID ?? "P2DPLW2SRN";
const ISSUER = process.env.ASC_ISSUER ?? "fb365280-db5a-48bb-84b3-98ae481c1235";
const BUNDLE = "io.github.menufactory43.panache";
const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, "../ios/store");

const key = readFileSync(`${process.env.HOME}/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8`, "utf8");
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: "ES256", kid: KEY_ID, typ: "JWT" });
  const p = b64({ iss: ISSUER, iat: now, exp: now + 1100, aud: "appstoreconnect-v1" });
  return `${h}.${p}.${createSign("SHA256").update(`${h}.${p}`).sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
async function api(method, path, body) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: { authorization: `Bearer ${jwt()}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = new Error(`${method} ${path} → ${res.status} ${json?.errors?.map((x) => `${x.title}: ${x.detail}`).join(" ; ") ?? text}`);
    e.status = res.status;
    throw e;
  }
  return json;
}
const say = (m) => console.log(m);
const warn = (m) => console.log(`⚠ ${m}`);

async function theApp() {
  const r = await api("GET", `/v1/apps?filter[bundleId]=${BUNDLE}`);
  const app = r.data[0];
  if (!app) {
    console.error(`L'app ${BUNDLE} n'existe pas encore dans App Store Connect : Apps → + → Nouvelle app (l'API ne sait pas la créer).`);
    process.exit(1);
  }
  return app;
}

async function etat() {
  const app = await theApp();
  say(`app ${app.attributes.name} (${app.id}) · ${app.attributes.primaryLocale}`);
  const builds = await api("GET", `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=5&fields[builds]=version,processingState,uploadedDate,expired`);
  for (const b of builds.data) say(`  build ${b.attributes.version} · ${b.attributes.processingState} · ${b.attributes.uploadedDate}${b.attributes.expired ? " · expiré" : ""}`);
  const groups = await api("GET", `/v1/apps/${app.id}/betaGroups`);
  for (const g of groups.data) say(`  groupe « ${g.attributes.name} » ${g.attributes.isInternalGroup ? "interne" : "externe"}`);
}

async function testflight() {
  const app = await theApp();
  const groups = await api("GET", `/v1/apps/${app.id}/betaGroups`);
  let group = groups.data.find((g) => g.attributes.isInternalGroup);
  if (!group) {
    group = (
      await api("POST", "/v1/betaGroups", {
        data: { type: "betaGroups", attributes: { name: "Équipe", isInternalGroup: true, hasAccessToAllBuilds: true }, relationships: { app: { data: { type: "apps", id: app.id } } } }
      })
    ).data;
    say(`groupe interne « Équipe » créé`);
  } else say(`groupe interne « ${group.attributes.name} » déjà là`);
  // the account's members (App Store Connect users) as internal testers
  const users = await api("GET", "/v1/users?limit=50");
  const inGroup = await api("GET", `/v1/betaGroups/${group.id}/betaTesters?limit=200`);
  const have = new Set(inGroup.data.map((t) => t.attributes.email?.toLowerCase()));
  for (const u of users.data) {
    const email = u.attributes.username;
    if (have.has(email.toLowerCase())) {
      say(`  ${u.attributes.firstName} : déjà testeur`);
      continue;
    }
    try {
      await api("POST", "/v1/betaTesters", {
        data: {
          type: "betaTesters",
          attributes: { email, firstName: u.attributes.firstName, lastName: u.attributes.lastName },
          relationships: { betaGroups: { data: [{ type: "betaGroups", id: group.id }] } }
        }
      });
      say(`  ${u.attributes.firstName} ajouté au groupe`);
    } catch (e) {
      warn(`${u.attributes.firstName} : ${e.message}`);
    }
  }
}

async function fiche() {
  const f = JSON.parse(readFileSync(join(STORE, "fiche.json"), "utf8"));
  const app = await theApp();
  // the app info (category, age rating, name/subtitle/privacy per language): the one still editable
  const infos = await api("GET", `/v1/apps/${app.id}/appInfos`);
  const info = infos.data.find((i) => !["READY_FOR_DISTRIBUTION", "REPLACED_WITH_NEW_INFO"].includes(i.attributes.appStoreState ?? i.attributes.state)) ?? infos.data[0];
  try {
    await api("PATCH", `/v1/appInfos/${info.id}`, {
      data: {
        type: "appInfos",
        id: info.id,
        relationships: {
          primaryCategory: { data: { type: "appCategories", id: f.categorie } },
          primarySubcategoryOne: { data: { type: "appCategories", id: f.sousCategories[0] } },
          primarySubcategoryTwo: { data: { type: "appCategories", id: f.sousCategories[1] } }
        }
      }
    });
    say("catégorie : Jeux · Stratégie, Action");
  } catch (e) {
    warn(`catégorie : ${e.message}`);
  }
  const infoLocs = await api("GET", `/v1/appInfos/${info.id}/appInfoLocalizations`);
  for (const [locale, t] of Object.entries(f.langues)) {
    const attrs = { name: t.nom, subtitle: t.sousTitre, privacyPolicyUrl: f.urls.confidentialite };
    const cur = infoLocs.data.find((l) => l.attributes.locale === locale);
    try {
      if (cur) await api("PATCH", `/v1/appInfoLocalizations/${cur.id}`, { data: { type: "appInfoLocalizations", id: cur.id, attributes: attrs } });
      else await api("POST", "/v1/appInfoLocalizations", { data: { type: "appInfoLocalizations", attributes: { locale, ...attrs }, relationships: { appInfo: { data: { type: "appInfos", id: info.id } } } } });
      say(`${locale} : nom, sous-titre, confidentialité`);
    } catch (e) {
      warn(`${locale} (infos) : ${e.message}`);
    }
  }
  // the age rating
  try {
    const decl = await api("GET", `/v1/appInfos/${info.id}/ageRatingDeclaration`);
    const attributes = Object.fromEntries(Object.entries(f.ageRating).filter(([k]) => k !== "_"));
    await api("PATCH", `/v1/ageRatingDeclarations/${decl.data.id}`, { data: { type: "ageRatingDeclarations", id: decl.data.id, attributes } });
    say("classement par âge : réponses envoyées");
  } catch (e) {
    warn(`classement par âge : ${e.message}`);
  }
  // the version being prepared: its texts and the review notes
  const version = await editableVersion(app);
  const locs = await api("GET", `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`);
  for (const [locale, t] of Object.entries(f.langues)) {
    const attrs = { description: t.description, keywords: t.motsCles, promotionalText: t.promo, supportUrl: f.urls.assistance, marketingUrl: f.urls.marketing };
    const cur = locs.data.find((l) => l.attributes.locale === locale);
    try {
      if (cur) await api("PATCH", `/v1/appStoreVersionLocalizations/${cur.id}`, { data: { type: "appStoreVersionLocalizations", id: cur.id, attributes: attrs } });
      else await api("POST", "/v1/appStoreVersionLocalizations", { data: { type: "appStoreVersionLocalizations", attributes: { locale, ...attrs }, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } } } });
      say(`${locale} : description, mots-clés, texte promotionnel, URLs`);
    } catch (e) {
      warn(`${locale} (version) : ${e.message}`);
    }
  }
  try {
    await api("PATCH", `/v1/appStoreVersions/${version.id}`, { data: { type: "appStoreVersions", id: version.id, attributes: { copyright: f.copyright } } });
  } catch (e) {
    warn(`copyright : ${e.message}`);
  }
  try {
    const rd = await api("GET", `/v1/appStoreVersions/${version.id}/appStoreReviewDetail`).catch(() => null);
    const attributes = { notes: f.revue.notes, demoAccountRequired: false };
    if (rd?.data) await api("PATCH", `/v1/appStoreReviewDetails/${rd.data.id}`, { data: { type: "appStoreReviewDetails", id: rd.data.id, attributes } });
    else await api("POST", "/v1/appStoreReviewDetails", { data: { type: "appStoreReviewDetails", attributes, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } } } });
    say("notes pour la revue");
  } catch (e) {
    warn(`notes pour la revue : ${e.message}`);
  }
}

async function editableVersion(app) {
  const vs = await api("GET", `/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=10`);
  const open = vs.data.find((v) => ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"].includes(v.attributes.appStoreState));
  if (open) return open;
  return (await api("POST", "/v1/appStoreVersions", { data: { type: "appStoreVersions", attributes: { platform: "IOS", versionString: "1.0" }, relationships: { app: { data: { type: "apps", id: app.id } } } } })).data;
}

async function captures() {
  const app = await theApp();
  const version = await editableVersion(app);
  const locs = await api("GET", `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`);
  // the iPhone 6,9" (2868 × 1320), the iPad 13" (2732 × 2048), the iPhone Duo's outer screen (2034 × 1398)
  const screens = [["shots", "APP_IPHONE_67"], ["shots-ipad", "APP_IPAD_PRO_3GEN_129"], ["shots-duo", "APP_IPHONE_DUO"]];
  for (const [shots, displayType] of screens)
  for (const [dir, locale] of [["fr", "fr-FR"], ["en", "en-US"], ["en", "en-GB"]]) {
    const folder = join(STORE, shots, dir);
    const loc = locs.data.find((l) => l.attributes.locale === locale);
    if (!existsSync(folder) || !loc) {
      warn(`${locale} : ${loc ? "pas de captures" : "pas de fiche (lancer « fiche » d'abord)"}`);
      continue;
    }
    // the set, emptied then filled in file order
    const sets = await api("GET", `/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets`);
    let set = sets.data.find((s) => s.attributes.screenshotDisplayType === displayType);
    if (set) {
      const old = await api("GET", `/v1/appScreenshotSets/${set.id}/appScreenshots`);
      for (const s of old.data) await api("DELETE", `/v1/appScreenshots/${s.id}`);
    } else
      set = (await api("POST", "/v1/appScreenshotSets", { data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: displayType }, relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: loc.id } } } } })).data;
    for (const name of readdirSync(folder).filter((n) => /\.(png|jpe?g)$/.test(n)).sort()) {
      const file = join(folder, name);
      const bytes = readFileSync(file);
      const shot = (
        await api("POST", "/v1/appScreenshots", { data: { type: "appScreenshots", attributes: { fileName: name, fileSize: statSync(file).size }, relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: set.id } } } } })
      ).data;
      for (const op of shot.attributes.uploadOperations) {
        const part = bytes.subarray(op.offset, op.offset + op.length);
        const res = await fetch(op.url, { method: op.method, headers: Object.fromEntries(op.requestHeaders.map((h) => [h.name, h.value])), body: part });
        if (!res.ok) throw new Error(`envoi de ${name} : ${res.status}`);
      }
      await api("PATCH", `/v1/appScreenshots/${shot.id}`, { data: { type: "appScreenshots", id: shot.id, attributes: { uploaded: true, sourceFileChecksum: createHash("md5").update(bytes).digest("hex") } } });
      say(`${locale} ${displayType} : ${name}`);
    }
  }
}

async function apercu() {
  const app = await theApp();
  const version = await editableVersion(app);
  const locs = await api("GET", `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`);
  for (const [dir, locale] of [["fr", "fr-FR"], ["en", "en-US"], ["en", "en-GB"]]) {
    const file = join(STORE, "previews", `${dir}.mp4`);
    const loc = locs.data.find((l) => l.attributes.locale === locale);
    if (!existsSync(file) || !loc) {
      warn(`${locale} : ${loc ? "pas de vidéo (tools/store-preview.mjs)" : "pas de fiche (lancer « fiche » d'abord)"}`);
      continue;
    }
    // the 6.9" set (1920 × 886), emptied then given the one video
    const sets = await api("GET", `/v1/appStoreVersionLocalizations/${loc.id}/appPreviewSets`);
    let set = sets.data.find((s) => s.attributes.previewType === "IPHONE_67");
    if (set) {
      const old = await api("GET", `/v1/appPreviewSets/${set.id}/appPreviews`);
      for (const s of old.data) await api("DELETE", `/v1/appPreviews/${s.id}`);
    } else
      set = (await api("POST", "/v1/appPreviewSets", { data: { type: "appPreviewSets", attributes: { previewType: "IPHONE_67" }, relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: loc.id } } } } })).data;
    const bytes = readFileSync(file);
    const name = `panache-${dir}.mp4`;
    const prev = (
      await api("POST", "/v1/appPreviews", { data: { type: "appPreviews", attributes: { fileName: name, fileSize: bytes.length, mimeType: "video/mp4", previewFrameTimeCode: "00:00:08:00" }, relationships: { appPreviewSet: { data: { type: "appPreviewSets", id: set.id } } } } })
    ).data;
    for (const op of prev.attributes.uploadOperations) {
      const part = bytes.subarray(op.offset, op.offset + op.length);
      const res = await fetch(op.url, { method: op.method, headers: Object.fromEntries(op.requestHeaders.map((h) => [h.name, h.value])), body: part });
      if (!res.ok) throw new Error(`envoi de ${name} : ${res.status}`);
    }
    await api("PATCH", `/v1/appPreviews/${prev.id}`, { data: { type: "appPreviews", id: prev.id, attributes: { uploaded: true, sourceFileChecksum: createHash("md5").update(bytes).digest("hex") } } });
    say(`${locale} : ${name} envoyée (Apple la traite quelques minutes)`);
  }
}

const cmd = process.argv[2];
const run = { etat, testflight, fiche, captures, apercu }[cmd];
if (!run) {
  console.error("usage: node tools/ios-store.mjs etat|testflight|fiche|captures|apercu");
  process.exit(2);
}
await run();
