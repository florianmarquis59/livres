/* Ma bibliothèque — PWA
 * Données gardées sur le téléphone (localStorage) + synchronisées avec Google Sheets via Apps Script.
 */
'use strict';

// ------------------------------------------------------------------ Stockage local
const CLES = { config: 'livres.config', data: 'livres.data', attente: 'livres.attente', export: 'livres.export', ui: 'livres.ui' };

function lireLS(cle, defaut) {
  try { const v = localStorage.getItem(cle); return v ? JSON.parse(v) : defaut; } catch (e) { return defaut; }
}
function ecrireLS(cle, val) {
  try { localStorage.setItem(cle, JSON.stringify(val)); return true; } catch (e) { toast('Stockage du téléphone indisponible'); return false; }
}

const etat = {
  config: lireLS(CLES.config, { url: '', cle: '' }),
  data: lireLS(CLES.data, { livres: [], auteurs: [], serveur: '', dernierSync: '' }),
  attente: lireLS(CLES.attente, {}),        // id -> livre modifié en attente d'envoi
  ui: Object.assign({ vue: 'livres', filtre: 'tous', tri: 'auteur', recherche: '' }, lireLS(CLES.ui, {})),
  sync: 'idle',                               // idle | en-cours | erreur | hors-ligne
  erreurSync: '',
};

const ANNEE = new Date().getFullYear();
const PRIO_RANG = { Haute: 0, Moyenne: 1, Faible: 2, '': 3, Aucune: 4 };
const STATUTS = ['Non lu', 'En cours', 'Lu', 'Abandonné'];
const PRIORITES = ['Aucune', 'Faible', 'Moyenne', 'Haute'];

function sauverData() { ecrireLS(CLES.data, etat.data); }
function sauverUI() { ecrireLS(CLES.ui, { vue: etat.ui.vue, filtre: etat.ui.filtre, tri: etat.ui.tri }); }
function connecte() { return !!(etat.config.url && etat.config.cle); }

// ------------------------------------------------------------------ Utilitaires
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const vrai = (v) => v === true || String(v).toUpperCase() === 'TRUE' || v === 'VRAI';
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/œ/g, 'oe');
const nouvelId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, '').slice(0, 10);
const fmtNote = (n) => (n === '' || n == null || isNaN(Number(n)) ? '' : Number(n).toFixed(2).replace('.', ','));
const fmtOrdre = (o) => (o === '' || o == null ? '' : String(o).replace('.', ','));
const nomNaturel = (nom) => {
  const mots = String(nom).trim().split(/\s+/); const fam = [];
  while (mots.length > 1 && mots[0] === mots[0].toUpperCase() && !mots[0].includes('.') && /[A-ZÀ-Ý]/.test(mots[0])) fam.push(mots.shift());
  const f = fam.join(' ').toLowerCase().replace(/(^|[\s'-])\S/g, (m) => m.toUpperCase());
  return (mots.join(' ') + ' ' + f).trim();
};
const joursDepuis = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : Infinity);
const dateCourte = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }); };

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('visible'), ms);
}

// ------------------------------------------------------------------ Accès aux données
function livresVisibles() { return etat.data.livres.filter((l) => !vrai(l.supprime)); }
function livre(id) { return etat.data.livres.find((l) => l.id === id); }

function trierLivres(liste, tri) {
  const parAuteur = (a, b) => a.auteur.localeCompare(b.auteur, 'fr') || (a.saga || '').localeCompare(b.saga || '', 'fr') ||
    (Number(a.ordre) || 999) - (Number(b.ordre) || 999) || (Number(a.annee_pub) || 9999) - (Number(b.annee_pub) || 9999) ||
    String(a.titre).localeCompare(String(b.titre), 'fr');
  const fns = {
    auteur: parAuteur,
    note: (a, b) => (Number(b.note) || 0) - (Number(a.note) || 0) || parAuteur(a, b),
    priorite: (a, b) => (PRIO_RANG[a.priorite] ?? 3) - (PRIO_RANG[b.priorite] ?? 3) || (Number(b.note) || 0) - (Number(a.note) || 0),
    titre: (a, b) => String(a.titre).localeCompare(String(b.titre), 'fr'),
    recent: (a, b) => String(b.maj || '').localeCompare(String(a.maj || '')),
  };
  return liste.slice().sort(fns[tri] || parAuteur);
}

/** Livres pris en compte partout, sauf ceux marqués « non intéressé ». */
function livresActifs() { return livresVisibles().filter((l) => !vrai(l.non_interesse)); }
/** Tomes contenus dans un volume (intégrale). */
function enfants(id) { return livresVisibles().filter((l) => l.contenu_dans === id); }
/** Possession réelle : un tome est possédé si l'intégrale qui le contient l'est. */
function possede(l) {
  if (l.possede === 'Oui') return 'Oui';
  const p = l.contenu_dans ? livre(l.contenu_dans) : null;
  return p && !vrai(p.supprime) && p.possede === 'Oui' ? 'Oui' : l.possede;
}

const FILTRES = [
  { id: 'tous', nom: 'Tous', f: () => true },
  { id: 'biblio', nom: 'Ma bibliothèque', f: (l) => possede(l) === 'Oui' },
  { id: 'alire', nom: 'À lire', f: (l) => possede(l) === 'Oui' && (l.statut === 'Non lu' || !l.statut) && !enfants(l.id).length },
  { id: 'acheter', nom: 'Pas possédés', f: (l) => possede(l) === 'Non' },
  { id: 'encours', nom: 'En cours', f: (l) => l.statut === 'En cours' },
  { id: 'lus', nom: 'Lus', f: (l) => l.statut === 'Lu' },
  { id: 'objectif', nom: 'Objectif ' + ANNEE, f: (l) => Number(l.objectif) === ANNEE },
  { id: 'prio', nom: 'Priorité haute', f: (l) => l.priorite === 'Haute' },
  { id: 'vendre', nom: 'À vendre', f: (l) => vrai(l.a_vendre) },
  { id: 'pretes', nom: 'Prêtés / ailleurs', f: (l) => !!String(l.emplacement || '').trim() },
  { id: 'doute', nom: 'Possession ?', f: (l) => possede(l) === '?' },
  { id: 'sansnote', nom: 'Sans note', f: (l) => l.note === '' || l.note == null },
  { id: 'nouveaux', nom: 'Importés (à trier)', f: (l) => l.origine === 'Bibliographie' && l.possede !== 'Oui' && l.statut !== 'Lu' },
  { id: 'pasroman', nom: 'Pas des romans', f: (l) => !!l.type_oeuvre && l.type_oeuvre !== 'Roman' },
  { id: 'nonint', nom: 'Non intéressés', f: (l) => vrai(l.non_interesse), inclutNonInteresses: true },
];

/** Applique des modifications locales et les met en file d'attente pour le serveur. */
function modifierLivres(liste) {
  liste.forEach((l) => {
    const i = etat.data.livres.findIndex((x) => x.id === l.id);
    if (i >= 0) etat.data.livres[i] = l; else etat.data.livres.push(l);
    etat.attente[l.id] = l;
  });
  sauverData(); ecrireLS(CLES.attente, etat.attente);
  majDatalists();
  synchroniser();
}
function modifierLivre(l) { modifierLivres([l]); }

// ------------------------------------------------------------------ Synchronisation
async function appel(action, params = {}) {
  if (!connecte()) throw new Error('App non connectée (voir Réglages)');
  const r = await fetch(etat.config.url, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ key: etat.config.cle, action }, params)),
  });
  if (!r.ok) throw new Error('Serveur HTTP ' + r.status);
  let j;
  try { j = await r.json(); } catch (e) { throw new Error('Réponse illisible : vérifiez l\'URL du déploiement'); }
  if (!j.ok) throw new Error(j.erreur || 'Erreur serveur');
  return j;
}

let syncEnCours = null;
function synchroniser() {
  if (!connecte()) { afficherEtat(); return Promise.resolve(); }
  if (syncEnCours) { syncEnCours.relancer = true; return syncEnCours.p; }
  const ctx = { relancer: false };
  ctx.p = (async () => {
    if (!navigator.onLine) { etat.sync = 'hors-ligne'; afficherEtat(); return; }
    etat.sync = 'en-cours'; afficherEtat();
    try {
      do {
        ctx.relancer = false;
        const envoi = Object.values(etat.attente);
        if (envoi.length) {
          const r = await appel('enregistrer', { livres: envoi });
          envoi.forEach((l) => { if (etat.attente[l.id] === l) delete etat.attente[l.id]; });
          ecrireLS(CLES.attente, etat.attente);
          (r.livres || []).forEach((l) => fusionnerServeur(l));
        }
        const tout = await appel('tout');
        etat.data.livres = tout.livres;
        etat.data.auteurs = tout.auteurs;
        Object.values(etat.attente).forEach((l) => fusionnerServeur(l, true)); // modifs faites pendant l'appel
        etat.data.serveur = tout.serveur;
        etat.data.dernierSync = new Date().toISOString();
        sauverData();
      } while (ctx.relancer);
      etat.sync = 'idle'; etat.erreurSync = '';
    } catch (e) {
      etat.sync = navigator.onLine ? 'erreur' : 'hors-ligne';
      etat.erreurSync = e.message;
    } finally {
      syncEnCours = null;
      afficherEtat(); majDatalists(); rendre(true);
    }
  })();
  syncEnCours = ctx;
  return ctx.p;
}

function fusionnerServeur(l, local) {
  const i = etat.data.livres.findIndex((x) => x.id === l.id);
  if (i >= 0) etat.data.livres[i] = local ? Object.assign({}, etat.data.livres[i], l) : l; else etat.data.livres.push(l);
}

function afficherEtat() {
  const b = $('#etat-sync');
  const n = Object.keys(etat.attente).length;
  b.classList.toggle('erreur', etat.sync === 'erreur');
  if (!connecte()) b.textContent = 'Mode local';
  else if (etat.sync === 'en-cours') b.textContent = '⟳ Synchro…';
  else if (etat.sync === 'hors-ligne') b.textContent = n ? `Hors ligne · ${n} en attente` : 'Hors ligne';
  else if (etat.sync === 'erreur') b.textContent = '⚠ Erreur';
  else b.textContent = n ? `${n} en attente` : '✓ À jour';
  b.title = etat.erreurSync || (etat.data.dernierSync ? 'Dernière synchro : ' + new Date(etat.data.dernierSync).toLocaleString('fr-FR') : '');
}

// ------------------------------------------------------------------ Rendu général
function rendre(garderScroll) {
  const y = window.scrollY;
  const vues = { livres: vueLivres, sagas: vueSagas, auteurs: vueAuteurs, reglages: vueReglages };
  const titres = { livres: 'Ma bibliothèque', sagas: 'Sagas', auteurs: 'Auteurs', reglages: 'Réglages' };
  document.querySelectorAll('.onglets button').forEach((b) => b.classList.toggle('actif', b.dataset.vue === etat.ui.vue));
  $('#titre-vue').textContent = titres[etat.ui.vue];
  $('#fab').hidden = etat.ui.vue !== 'livres';
  if (etat.ui.vue === 'reglages' && garderScroll && document.activeElement && document.activeElement.closest('#vue')) return; // ne pas effacer une saisie
  const rechercheActive = document.activeElement && document.activeElement.id === 'recherche' ? document.activeElement.selectionStart : null;
  (vues[etat.ui.vue] || vueLivres)($('#vue'));
  rendreBandeau();
  if (garderScroll) window.scrollTo(0, y);
  if (rechercheActive !== null && $('#recherche')) { const r = $('#recherche'); r.focus(); r.setSelectionRange(rechercheActive, rechercheActive); }
}

function rendreBandeau() {
  const b = $('#bandeau');
  const j = joursDepuis(lireLS(CLES.export, ''));
  if (etat.data.livres.length && j > 7) {
    b.hidden = false;
    b.innerHTML = `<span>💾 ${j === Infinity ? 'Aucun export de sauvegarde sur ce téléphone.' : `Dernier export il y a ${j} jours.`}</span>
      <button class="btn petit" type="button" id="bandeau-export">Exporter</button>`;
    $('#bandeau-export').onclick = exporterJSON;
  } else {
    b.hidden = true;
  }
}

function majDatalists() {
  const uniques = (f) => [...new Set(livresVisibles().map(f).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'fr'));
  const opt = (v) => `<option value="${esc(v)}">`;
  $('#dl-auteurs').innerHTML = [...new Set([...etat.data.auteurs.map((a) => a.nom), ...uniques((l) => l.auteur)])].sort().map(opt).join('');
  $('#dl-sagas').innerHTML = uniques((l) => l.saga).map(opt).join('');
  $('#dl-emplacements').innerHTML = uniques((l) => l.emplacement).map(opt).join('');
}

// ------------------------------------------------------------------ Vue Livres
function badgesLivre(l) {
  const b = [];
  const p = possede(l);
  const vol = l.contenu_dans ? livre(l.contenu_dans) : null;
  if (vrai(l.non_interesse)) b.push('<span class="badge">🚫 Non intéressé</span>');
  if (p === 'Oui') b.push(`<span class="badge ok">Possédé${l.possede !== 'Oui' ? ' (intégrale)' : ''}</span>`);
  else if (p === '?') b.push('<span class="badge alerte">Possédé ?</span>');
  if (vol) b.push(`<span class="badge info">📦 ${esc(String(vol.titre).split('/')[0].trim())}…</span>`);
  const nbTomes = enfants(l.id).length;
  if (nbTomes) b.push(`<span class="badge info">📦 Intégrale · ${nbTomes} tomes</span>`);
  if (l.type_oeuvre && l.type_oeuvre !== 'Roman') b.push(`<span class="badge">${esc(l.type_oeuvre)}</span>`);
  if (l.titre && l.titre === l.titre_vo && l.origine === 'Bibliographie') b.push('<span class="badge">Titre VO</span>');
  if (l.statut === 'Lu') b.push(`<span class="badge ok">Lu${l.annee_lecture ? ' ' + esc(l.annee_lecture) : ''}</span>`);
  else if (l.statut === 'En cours') b.push('<span class="badge info">En cours</span>');
  else if (l.statut === 'Abandonné') b.push(`<span class="badge">Abandonné${l.annee_lecture ? ' ' + esc(l.annee_lecture) : ''}</span>`);
  if (l.priorite && l.priorite !== 'Aucune') b.push(`<span class="badge${l.priorite === 'Haute' ? ' alerte' : ''}">Priorité ${esc(l.priorite.toLowerCase())}</span>`);
  if (l.objectif) b.push(`<span class="badge info">🎯 ${esc(l.objectif)}</span>`);
  if (l.emplacement) b.push(`<span class="badge alerte">📍 ${esc(l.emplacement)}</span>`);
  if (vrai(l.a_vendre)) b.push('<span class="badge alerte">À vendre</span>');
  if (etat.attente[l.id]) b.push('<span class="badge">⟳ non envoyé</span>');
  return b.join('');
}

function carteLivre(l, avecAuteur) {
  const sous = [];
  if (avecAuteur) sous.push(esc(nomNaturel(l.auteur)));
  if (l.saga) sous.push(esc(l.saga) + (l.ordre !== '' && l.ordre != null ? ` #${esc(fmtOrdre(l.ordre))}` : ''));
  else if (l.annee_pub) sous.push(esc(l.annee_pub));
  const note = fmtNote(l.note);
  return `<button class="livre${possede(l) === 'Non' || vrai(l.non_interesse) ? ' fantome' : ''}" type="button" data-id="${esc(l.id)}">
    <span class="t">${esc(l.titre || (l.saga ? `${l.saga} — tome ${fmtOrdre(l.ordre)}` : 'Sans titre'))}</span>
    <span class="note">${note ? '★ ' + note : ''}${note ? `<small>${esc(l.note_source || '')}${l.note_votes ? ' · ' + esc(l.note_votes) : ''}</small>` : ''}</span>
    <span class="s">${sous.join(' · ')}</span>
    ${l.commentaire ? `<span class="com">💬 ${esc(l.commentaire)}</span>` : ''}
    <span class="badges">${badgesLivre(l)}</span>
  </button>`;
}

function blocObjectif() {
  const obj = livresActifs().filter((l) => Number(l.objectif) === ANNEE);
  const lusAnnee = livresActifs().filter((l) => l.statut === 'Lu' && Number(l.annee_lecture) === ANNEE).length;
  if (!obj.length && !lusAnnee) return '';
  const faits = obj.filter((l) => l.statut === 'Lu').length;
  const pct = obj.length ? Math.round((faits / obj.length) * 100) : 0;
  return `<div class="objectif">
    <div class="ligne"><strong>🎯 Objectif ${ANNEE}</strong><span>${faits} / ${obj.length} lus · ${lusAnnee} lu${lusAnnee > 1 ? 's' : ''} en ${ANNEE}</span></div>
    ${obj.length ? `<div class="barre-prog"><span style="width:${pct}%"></span></div>` : ''}
  </div>`;
}

function vueLivres(el) {
  const filtre = FILTRES.find((f) => f.id === etat.ui.filtre) || FILTRES[0];
  const q = norm(etat.ui.recherche).trim();
  let liste = (filtre.inclutNonInteresses ? livresVisibles() : livresActifs()).filter(filtre.f);
  if (q) liste = liste.filter((l) => norm([l.titre, l.titre_vo, l.auteur, nomNaturel(l.auteur), l.saga, l.emplacement, l.commentaire].join(' ')).includes(q));
  liste = trierLivres(liste, etat.ui.tri);

  let html = '';
  if (etat.ui.tri === 'auteur') {
    let courant = null;
    liste.forEach((l) => {
      if (l.auteur !== courant) { if (courant !== null) html += '</div>'; courant = l.auteur; html += `<div class="groupe">${esc(nomNaturel(l.auteur))}</div><div class="liste">`; }
      html += carteLivre(l, false);
    });
    if (courant !== null) html += '</div>';
  } else {
    html = `<div class="liste">${liste.map((l) => carteLivre(l, true)).join('')}</div>`;
  }

  const vide = !etat.data.livres.length
    ? `<div class="vide"><p>Aucun livre pour l'instant.</p><p><button class="btn principal" type="button" data-aller="reglages">Connecter l'app ou importer une sauvegarde</button></p></div>`
    : `<div class="vide">Aucun livre ne correspond.</div>`;

  el.innerHTML = `
    ${etat.ui.filtre === 'objectif' || etat.ui.filtre === 'tous' ? blocObjectif() : ''}
    <input class="recherche" type="search" id="recherche" placeholder="Titre, auteur, saga…" value="${esc(etat.ui.recherche)}" autocomplete="off">
    <div class="puces">${FILTRES.map((f) => `<button class="puce${f.id === filtre.id ? ' actif' : ''}" type="button" data-filtre="${f.id}">${esc(f.nom)}</button>`).join('')}</div>
    <div class="outils"><span>${liste.length} livre${liste.length > 1 ? 's' : ''}</span>
      <select id="tri" aria-label="Trier">
        ${[['auteur', 'Auteur / saga'], ['note', 'Meilleure note'], ['priorite', 'Priorité'], ['titre', 'Titre'], ['recent', 'Modifiés récemment']]
          .map(([v, n]) => `<option value="${v}"${v === etat.ui.tri ? ' selected' : ''}>${n}</option>`).join('')}
      </select></div>
    ${liste.length ? html : vide}`;

  const r = $('#recherche', el);
  r.oninput = () => { etat.ui.recherche = r.value; const pos = r.selectionStart; vueLivres(el); const r2 = $('#recherche', el); r2.focus(); r2.setSelectionRange(pos, pos); };
  el.querySelectorAll('[data-filtre]').forEach((b) => (b.onclick = () => { etat.ui.filtre = b.dataset.filtre; sauverUI(); vueLivres(el); }));
  $('#tri', el).onchange = (e) => { etat.ui.tri = e.target.value; sauverUI(); vueLivres(el); };
  el.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => ouvrirLivre(b.dataset.id)));
  el.querySelectorAll('[data-aller]').forEach((b) => (b.onclick = () => allerA(b.dataset.aller)));
}

// ------------------------------------------------------------------ Fiche livre
function segment(nom, valeurs, actuelle) {
  return `<div class="segment" data-seg="${nom}">${valeurs.map((v) => `<button type="button" data-v="${esc(v)}" class="${String(actuelle) === v ? 'actif' : ''}">${esc(v || '—')}</button>`).join('')}</div>`;
}

function lienRechercheBabelio(l) {
  return 'https://www.google.com/search?q=' + encodeURIComponent('site:babelio.com/livres ' + [l.titre || l.titre_vo, nomNaturel(l.auteur || '')].join(' ').trim());
}

function ouvrirLivre(id, preRempli) {
  const existant = id ? livre(id) : null;
  const l = Object.assign({
    id: nouvelId(), auteur: '', saga: '', titre: '', titre_vo: '', ordre: '', possede: 'Oui', statut: 'Non lu', annee_lecture: '',
    priorite: '', objectif: '', emplacement: '', a_vendre: false, commentaire: '', non_interesse: false, contenu_dans: '',
    type_oeuvre: '', ordre_source: '', annee_pub: '', note: '', note_votes: '', note_source: '',
    note_url: '', babelio_url: '', note_maj: '', origine: 'Manuel', wikidata: '', maj: '', supprime: false,
  }, existant || {}, preRempli || {});
  const f = $('#feuille');
  const lienFiche = l.note_url || l.babelio_url;
  const tomes = existant ? trierLivres(enfants(l.id), 'auteur') : [];
  // volumes possibles (même auteur, pas lui-même ni un de ses tomes) ; les intégrales d'abord
  const volumes = livresVisibles().filter((x) => x.auteur === l.auteur && x.id !== l.id && x.contenu_dans !== l.id && !x.contenu_dans)
    .sort((a, b) => (enfants(b.id).length - enfants(a.id).length) || (b.titre.includes('/') - a.titre.includes('/')) || a.titre.localeCompare(b.titre, 'fr'));
  const ordreAuto = { Wikidata: 'de parution (Wikidata)', 'Estimé': "estimé d'après l'année de parution", Excel: 'repris de votre Excel' }[l.ordre_source] || '';

  f.innerHTML = `
    <div class="entete">
      <button class="btn petit" type="button" data-fermer>✕</button>
      <h2>${existant ? esc(l.titre || 'Livre') : 'Nouveau livre'}</h2>
      <button class="btn principal petit" type="button" id="f-ok">Enregistrer</button>
    </div>
    <form class="corps" id="f-form" autocomplete="off">
      <label class="champ">Titre<input name="titre" value="${esc(l.titre)}" required></label>
      <label class="champ">Auteur (NOM Prénom)<input name="auteur" list="dl-auteurs" value="${esc(l.auteur)}" placeholder="THILLIEZ Franck" required></label>
      <div class="deux">
        <label class="champ">Saga<input name="saga" list="dl-sagas" value="${esc(l.saga)}"></label>
        <label class="champ">Ordre de lecture<input name="ordre" type="number" step="0.5" min="0" inputmode="decimal" value="${esc(l.ordre)}"></label>
      </div>
      ${ordreAuto ? `<p class="aide">Ordre ${esc(ordreAuto)}. Si vous le modifiez, l'import ne le remplacera plus.</p>` : ''}

      <label class="champ">💬 Commentaire<textarea name="commentaire" placeholder="Vos notes : à lire après…, édition, avis…">${esc(l.commentaire)}</textarea></label>

      <label class="case"><input type="checkbox" name="non_interesse" ${vrai(l.non_interesse) ? 'checked' : ''}> 🚫 Non intéressé</label>
      <p class="aide" style="margin-top:-8px">Masqué partout, sauf avec le filtre « Non intéressés ». L'import ne le recrée pas.</p>

      <div class="titre-champ">Je le possède</div>
      ${segment('possede', ['Oui', 'Non', '?'], l.possede)}
      ${l.contenu_dans && possede(l) === 'Oui' && l.possede !== 'Oui' ? `<p class="aide">Possédé via l'intégrale (voir plus bas).</p>` : ''}

      <div class="titre-champ">Lecture</div>
      ${segment('statut', STATUTS, l.statut || 'Non lu')}
      <label class="champ" id="z-annee">Année de lecture<input name="annee_lecture" type="number" inputmode="numeric" min="1950" max="2100" value="${esc(l.annee_lecture)}" placeholder="${ANNEE}"></label>

      <div class="titre-champ">Priorité</div>
      ${segment('priorite', PRIORITES, l.priorite || 'Aucune')}
      <div class="deux">
        <label class="champ">Objectif de lecture (année)<input name="objectif" type="number" inputmode="numeric" min="2000" max="2100" value="${esc(l.objectif)}"></label>
        <div style="align-self:end;margin-bottom:12px"><button class="btn" type="button" id="f-obj">🎯 ${ANNEE}</button></div>
      </div>

      <label class="champ">Où est le livre ? (prêt, cadeau…)<input name="emplacement" list="dl-emplacements" value="${esc(l.emplacement)}" placeholder="Bibliothèque salon, Prêt à …"></label>
      <label class="case"><input type="checkbox" name="a_vendre" ${vrai(l.a_vendre) ? 'checked' : ''}> À vendre</label>

      <div class="sep"></div>
      <div class="titre-champ">📦 Intégrale (volume qui regroupe plusieurs tomes)</div>
      ${tomes.length ? `<div class="carte tomes"><p><strong>Ce volume contient ${tomes.length} tome${tomes.length > 1 ? 's' : ''}.</strong> Ils héritent de sa possession, et sa lecture leur est reportée.</p>
        <ol>${tomes.map((t) => `<li><button type="button" class="lien" data-tome="${esc(t.id)}">${t.ordre !== '' ? '#' + esc(fmtOrdre(t.ordre)) + ' ' : ''}${esc(t.titre)}</button></li>`).join('')}</ol></div>` : `
        <label class="champ">Ce livre est un tome contenu dans le volume :
        <select name="contenu_dans"><option value="">— aucun (livre séparé) —</option>
        ${volumes.map((v) => `<option value="${esc(v.id)}"${v.id === l.contenu_dans ? ' selected' : ''}>${esc(v.titre)}${enfants(v.id).length ? ` (${enfants(v.id).length} tomes)` : ''}</option>`).join('')}
        </select></label>
        <p class="aide">Exemple : vous possédez une intégrale des tomes 1 à 3 : rattachez-y chaque tome, ils seront comptés comme possédés.</p>`}

      <div class="sep"></div>
      <div class="bloc-note">
        <div class="grande">${fmtNote(l.note) ? '★ ' + fmtNote(l.note) : '—'}</div>
        <div class="src">${l.note_source ? esc(l.note_source) : 'Pas encore de note'}${l.note_votes ? ` · ${esc(l.note_votes)} votes` : ''}
          ${l.note_maj ? `<br>mise à jour ${esc(dateCourte(l.note_maj))}` : ''}
          ${lienFiche ? `<br><a href="${esc(lienFiche)}" target="_blank" rel="noopener">Voir la fiche</a>` : ''}</div>
      </div>
      <label class="champ">Lien Babelio du livre (facultatif, trouvé automatiquement si l'auteur a son lien)
        <input name="babelio_url" type="url" inputmode="url" value="${esc(l.babelio_url)}" placeholder="https://www.babelio.com/livres/…"></label>
      <div class="btns">
        <a class="btn petit" href="${esc(lienRechercheBabelio(l))}" target="_blank" rel="noopener">🔎 Chercher sur Babelio</a>
        ${existant && connecte() ? '<button class="btn petit" type="button" id="f-note">↻ Actualiser la note</button>' : ''}
      </div>

      <div class="sep"></div>
      <div class="deux">
        <label class="champ">Titre original<input name="titre_vo" value="${esc(l.titre_vo)}"></label>
        <label class="champ">Année de parution<input name="annee_pub" type="number" inputmode="numeric" value="${esc(l.annee_pub)}"></label>
      </div>
      <p class="aide">Origine : ${esc(l.origine || '—')}${l.type_oeuvre ? ' · ' + esc(l.type_oeuvre) : ''}${l.wikidata ? ` · <a href="https://www.wikidata.org/wiki/${esc(l.wikidata)}" target="_blank" rel="noopener">Wikidata</a>` : ''}</p>
      ${existant ? '<button class="btn danger petit" type="button" id="f-suppr">Supprimer (doublon, erreur de saisie)</button>' : ''}
    </form>`;

  const form = $('#f-form', f);
  const segs = {};
  f.querySelectorAll('[data-seg]').forEach((s) => {
    segs[s.dataset.seg] = s.querySelector('.actif')?.dataset.v ?? '';
    s.querySelectorAll('button').forEach((b) => (b.onclick = () => {
      s.querySelectorAll('button').forEach((x) => x.classList.toggle('actif', x === b));
      segs[s.dataset.seg] = b.dataset.v;
      if (s.dataset.seg === 'statut') majAnnee();
    }));
  });
  const majAnnee = () => {
    const z = $('#z-annee', f);
    const montre = segs.statut === 'Lu' || segs.statut === 'Abandonné';
    z.hidden = !montre;
    if (montre && !form.annee_lecture.value) form.annee_lecture.value = ANNEE;
  };
  majAnnee();
  $('#f-obj', f).onclick = () => { form.objectif.value = ANNEE; };
  f.querySelector('[data-fermer]').onclick = () => f.close();
  f.querySelectorAll('[data-tome]').forEach((b) => (b.onclick = () => ouvrirLivre(b.dataset.tome)));

  const lireForm = () => {
    const num = (v) => (v === '' ? '' : Number(String(v).replace(',', '.')));
    const n = Object.assign({}, l, {
      titre: form.titre.value.trim(), auteur: form.auteur.value.trim().replace(/\s+/g, ' '), saga: form.saga.value.trim(),
      ordre: num(form.ordre.value), possede: segs.possede, statut: segs.statut,
      annee_lecture: (segs.statut === 'Lu' || segs.statut === 'Abandonné') ? num(form.annee_lecture.value) : '',
      priorite: segs.priorite === 'Aucune' && !existant ? '' : segs.priorite, objectif: num(form.objectif.value),
      emplacement: form.emplacement.value.trim(), a_vendre: form.a_vendre.checked, commentaire: form.commentaire.value.trim(),
      non_interesse: form.non_interesse.checked,
      contenu_dans: form.contenu_dans ? form.contenu_dans.value : l.contenu_dans,
      babelio_url: form.babelio_url.value.trim(), titre_vo: form.titre_vo.value.trim(), annee_pub: num(form.annee_pub.value),
    });
    if (existant && existant.priorite === '' && segs.priorite === 'Aucune') n.priorite = '';
    if (String(n.ordre) !== String(l.ordre)) n.ordre_source = n.ordre === '' ? '' : 'Manuel';
    return n;
  };

  $('#f-ok', f).onclick = () => {
    const n = lireForm();
    if (!n.titre || !n.auteur) { toast('Titre et auteur obligatoires'); return; }
    if (n.babelio_url && !/^https:\/\/www\.babelio\.com\/livres\//.test(n.babelio_url)) { toast('Le lien Babelio doit commencer par https://www.babelio.com/livres/'); return; }
    if (!existant) n.maj = '';
    const lot = [n];
    // Intégrale : sa possession et sa lecture sont reportées sur ses tomes
    if (tomes.length && (n.possede !== l.possede || n.statut !== l.statut || n.annee_lecture !== l.annee_lecture)) {
      tomes.forEach((t) => lot.push(Object.assign({}, t, {
        possede: n.possede !== l.possede ? n.possede : t.possede,
        statut: n.statut !== l.statut ? n.statut : t.statut,
        annee_lecture: n.statut !== l.statut || n.annee_lecture !== l.annee_lecture ? n.annee_lecture : t.annee_lecture,
      })));
    }
    modifierLivres(lot);
    f.close();
    toast(existant ? (lot.length > 1 ? `Enregistré (+ ${lot.length - 1} tomes)` : 'Enregistré') : 'Livre ajouté');
  };
  form.onsubmit = (e) => { e.preventDefault(); $('#f-ok', f).click(); };

  const suppr = $('#f-suppr', f);
  if (suppr) suppr.onclick = () => {
    if (!confirm(`Supprimer « ${l.titre} » ?\nPour un livre qui ne vous intéresse pas, préférez la case « Non intéressé ».`)) return;
    const lot = [Object.assign({}, l, { supprime: true })];
    tomes.forEach((t) => lot.push(Object.assign({}, t, { contenu_dans: '' })));
    modifierLivres(lot);
    f.close(); toast('Livre supprimé');
  };
  const bNote = $('#f-note', f);
  if (bNote) bNote.onclick = async () => {
    bNote.disabled = true; bNote.textContent = '… recherche (≈10 s)';
    try {
      if (etat.attente[l.id]) await synchroniser();
      const r = await appel('actualiserNote', { id: l.id });
      fusionnerServeur(r.livre); sauverData();
      toast(r.livre.note ? `Note : ${fmtNote(r.livre.note)} (${r.livre.note_source})` : 'Aucune note trouvée' + (r.bilan.erreurs[0] ? ' — ' + r.bilan.erreurs[0] : ''), 5000);
      f.close(); ouvrirLivre(l.id); rendre(true);
    } catch (e) { toast(e.message, 5000); bNote.disabled = false; bNote.textContent = '↻ Actualiser la note'; }
  };

  if (!f.open) f.showModal();
  f.scrollTop = 0;
}

// ------------------------------------------------------------------ Vue Sagas
function vueSagas(el) {
  const groupes = {};
  livresActifs().filter((l) => l.saga).forEach((l) => {
    const k = l.auteur + '§' + l.saga;
    (groupes[k] = groupes[k] || { auteur: l.auteur, saga: l.saga, livres: [] }).livres.push(l);
  });
  const liste = Object.values(groupes).sort((a, b) => a.auteur.localeCompare(b.auteur, 'fr') || a.saga.localeCompare(b.saga, 'fr'));
  if (!liste.length) { el.innerHTML = '<div class="vide">Aucune saga pour l\'instant.</div>'; return; }
  const icone = (l) => (l.statut === 'Lu' ? '✅' : l.statut === 'En cours' ? '📖' : l.statut === 'Abandonné' ? '✖️' : possede(l) === 'Oui' ? '📕' : possede(l) === '?' ? '❔' : '🛒');

  el.innerHTML = `<p class="aide" style="margin:4px 0 12px">✅ lu · 📖 en cours · 📕 possédé, à lire · 🛒 pas possédé · ❔ à vérifier · 📦 dans une intégrale</p>` +
    liste.map((g, gi) => {
      // les intégrales ne sont pas des tomes : on les affiche à part
      const integrales = g.livres.filter((l) => enfants(l.id).length);
      const ls = trierLivres(g.livres.filter((l) => !integrales.includes(l)), 'auteur');
      if (!ls.length) return '';
      const lus = ls.filter((l) => l.statut === 'Lu').length;
      const poss = ls.filter((l) => possede(l) === 'Oui').length;
      const prochain = ls.find((l) => l.statut !== 'Lu' && l.statut !== 'Abandonné');
      return `<details class="saga">
        <summary>
          <div class="nom">${esc(g.saga)}</div>
          <div class="auteur">${esc(nomNaturel(g.auteur))} · ${ls.length} tome${ls.length > 1 ? 's' : ''}</div>
          <div class="progs">
            <span>Lus ${lus}/${ls.length}</span><div class="barre-prog"><span style="width:${(lus / ls.length) * 100}%"></span></div>
            <span>Possédés ${poss}/${ls.length}</span><div class="barre-prog possede"><span style="width:${(poss / ls.length) * 100}%"></span></div>
          </div>
          ${prochain && lus < ls.length ? `<div class="prochain">Prochain : <strong>${esc(prochain.titre || 'tome ' + fmtOrdre(prochain.ordre))}</strong>${possede(prochain) !== 'Oui' ? ' <span class="badge alerte">à se procurer</span>' : ''}</div>` : ''}
        </summary>
        ${integrales.map((v) => `<p class="integrale"><button type="button" class="lien" data-id="${esc(v.id)}">📦 ${esc(v.titre)}</button> — ${enfants(v.id).length} tomes</p>`).join('')}
        <ol>${ls.map((l) => `<li><span class="num">${l.ordre !== '' && l.ordre != null ? '#' + esc(fmtOrdre(l.ordre)) : '–'}</span>
          <button type="button" data-id="${esc(l.id)}">${esc(l.titre || 'Tome ' + fmtOrdre(l.ordre))}${l.contenu_dans ? ' <span class="aide">📦</span>' : ''}${l.commentaire ? ' <span class="aide">💬</span>' : ''}</button>
          <span class="note">${fmtNote(l.note) ? '★ ' + fmtNote(l.note) : ''}</span><span class="st">${icone(l)}</span></li>`).join('')}</ol>
        <div class="btns" style="padding:0 14px 12px"><button class="btn petit" type="button" data-renommer="${gi}">✏️ Renommer la saga</button></div>
      </details>`;
    }).join('');
  el.querySelectorAll('[data-id]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); ouvrirLivre(b.dataset.id); }));
  el.querySelectorAll('[data-renommer]').forEach((b) => (b.onclick = () => {
    const g = liste[Number(b.dataset.renommer)];
    const nouveau = (prompt(`Nouveau nom pour « ${g.saga} » :`, g.saga) || '').trim();
    if (!nouveau || nouveau === g.saga) return;
    const lot = livresVisibles().filter((l) => l.auteur === g.auteur && l.saga === g.saga).map((l) => Object.assign({}, l, { saga: nouveau }));
    modifierLivres(lot);
    toast(`Saga renommée (${lot.length} livres)`); rendre(true);
  }));
}

// ------------------------------------------------------------------ Vue Auteurs
function vueAuteurs(el) {
  const noms = new Set([...etat.data.auteurs.map((a) => a.nom), ...livresVisibles().map((l) => l.auteur)]);
  const liste = [...noms].sort((a, b) => a.localeCompare(b, 'fr')).map((nom) => {
    const a = etat.data.auteurs.find((x) => x.nom === nom) || { nom, biblio_statut: '' };
    const ls = livresActifs().filter((l) => l.auteur === nom && !enfants(l.id).length);
    return { a, total: ls.length, poss: ls.filter((l) => possede(l) === 'Oui').length, lus: ls.filter((l) => l.statut === 'Lu').length };
  });
  el.innerHTML = `
    <div class="btns" style="margin-bottom:12px"><button class="btn principal" type="button" id="aj-auteur">＋ Ajouter un auteur</button></div>
    ${liste.map(({ a, total, poss, lus }) => `<button class="auteur-carte" type="button" data-nom="${esc(a.nom)}">
      <div><div class="n">${esc(nomNaturel(a.nom))}</div>
      <div class="d">${a.biblio_statut === 'Importé' ? (/^(Auteur introuvable|0 romans)/.test(a.message || '') ? '⚠ Aucun roman trouvé — ajoutez ses livres à la main' : 'Bibliographie importée') : a.biblio_statut === 'Erreur' ? '⚠ ' + esc(a.message || 'Erreur') : a.biblio_statut === 'À importer' ? '⏳ Bibliographie en attente' : ''}${a.babelio_url ? ' · Babelio ✓' : ''}</div></div>
      <div class="chiffres">${poss} possédé${poss > 1 ? 's' : ''}<br>${lus}/${total} lus</div>
    </button>`).join('')}`;
  $('#aj-auteur', el).onclick = ouvrirAjoutAuteur;
  el.querySelectorAll('[data-nom]').forEach((b) => (b.onclick = () => ouvrirAuteur(b.dataset.nom)));
}

function ouvrirAjoutAuteur() {
  const f = $('#feuille');
  f.innerHTML = `
    <div class="entete"><button class="btn petit" type="button" data-fermer>✕</button><h2>Ajouter un auteur</h2></div>
    <form class="corps" id="aa-form">
      <label class="champ">Nom de l'auteur<input name="nom" required placeholder="Robin Hobb ou HOBB Robin" autocomplete="off"></label>
      <label class="champ">Lien de sa page Babelio (facultatif, pour les notes)<input name="babelio" type="url" inputmode="url" placeholder="https://www.babelio.com/auteur/…"></label>
      <div class="btns" style="margin-bottom:12px"><a class="btn petit" id="aa-cherche" target="_blank" rel="noopener" href="https://www.babelio.com/">🔎 Chercher l'auteur sur Babelio</a></div>
      <p style="font-size:13px;color:var(--texte-2)">Ses romans sont importés depuis Wikidata (titres français, ordre des sagas) et ajoutés avec « Possède : Non ».</p>
      <button class="btn principal" type="submit" ${connecte() ? '' : 'disabled'}>Ajouter et importer sa bibliographie</button>
      ${connecte() ? '' : '<p>Connectez d\'abord l\'app (Réglages).</p>'}
      <p id="aa-res"></p>
    </form>`;
  f.querySelector('[data-fermer]').onclick = () => f.close();
  const form = $('#aa-form', f);
  form.nom.oninput = () => { $('#aa-cherche', f).href = 'https://www.google.com/search?q=' + encodeURIComponent('site:babelio.com/auteur ' + form.nom.value.trim()); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const url = form.babelio.value.trim();
    if (url && !/^https:\/\/www\.babelio\.com\/auteur\//.test(url)) { toast('Le lien doit commencer par https://www.babelio.com/auteur/'); return; }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Import en cours (jusqu\'à 30 s)…';
    try {
      const r = await appel('ajouterAuteur', { nom: form.nom.value.trim(), babelio_url: url });
      etat.data.livres = r.toutes.livres; etat.data.auteurs = r.toutes.auteurs; sauverData(); majDatalists();
      f.close(); toast(`${nomNaturel(r.auteur)} : ${r.message}`, 6000);
      etat.ui.vue = 'auteurs'; rendre();
    } catch (err) { toast(err.message, 5000); btn.disabled = false; btn.textContent = 'Ajouter et importer sa bibliographie'; }
  };
  f.showModal();
  form.nom.focus();
}

function ouvrirAuteur(nom) {
  const a = etat.data.auteurs.find((x) => x.nom === nom) || { nom, babelio_url: '', message: '' };
  const ls = trierLivres(livresVisibles().filter((l) => l.auteur === nom), 'auteur');
  const f = $('#feuille');
  f.innerHTML = `
    <div class="entete"><button class="btn petit" type="button" data-fermer>✕</button><h2>${esc(nomNaturel(nom))}</h2></div>
    <div class="corps">
      <div class="carte">
        <p>${a.message ? esc(a.message) : 'Bibliographie pas encore importée.'}${a.biblio_maj ? ` (${esc(dateCourte(a.biblio_maj))})` : ''}</p>
        <label class="champ">Page Babelio de l'auteur (sert à trouver les notes de ses livres)
          <input id="au-babelio" type="url" inputmode="url" value="${esc(a.babelio_url || '')}" placeholder="https://www.babelio.com/auteur/…"></label>
        <div class="btns">
          <a class="btn petit" target="_blank" rel="noopener" href="https://www.google.com/search?q=${encodeURIComponent('site:babelio.com/auteur ' + nomNaturel(nom))}">🔎 Chercher sur Babelio</a>
          <button class="btn petit principal" type="button" id="au-save" ${connecte() ? '' : 'disabled'}>Enregistrer le lien</button>
          <button class="btn petit" type="button" id="au-reimp" ${connecte() ? '' : 'disabled'}>↻ Réimporter la bibliographie</button>
        </div>
      </div>
      <div class="liste">${ls.map((l) => carteLivre(l, false)).join('') || '<div class="vide">Aucun livre.</div>'}</div>
    </div>`;
  f.querySelector('[data-fermer]').onclick = () => f.close();
  f.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => ouvrirLivre(b.dataset.id)));
  $('#au-save', f).onclick = async () => {
    const url = $('#au-babelio', f).value.trim();
    if (url && !/^https:\/\/www\.babelio\.com\/auteur\//.test(url)) { toast('Le lien doit commencer par https://www.babelio.com/auteur/'); return; }
    try {
      const r = await appel('majAuteur', { nom, champs: { babelio_url: url } });
      const i = etat.data.auteurs.findIndex((x) => x.nom === nom);
      if (i >= 0) etat.data.auteurs[i] = r.auteur; else etat.data.auteurs.push(r.auteur);
      sauverData(); toast('Lien enregistré — notes mises à jour cette nuit');
    } catch (e) { toast(e.message, 5000); }
  };
  $('#au-reimp', f).onclick = async (ev) => {
    const b = ev.currentTarget; b.disabled = true; b.textContent = 'Import…';
    try {
      const r = await appel('reimporterAuteur', { nom });
      etat.data.livres = r.toutes.livres; etat.data.auteurs = r.toutes.auteurs; sauverData();
      toast(r.message, 6000); ouvrirAuteur(nom); rendre(true);
    } catch (e) { toast(e.message, 5000); b.disabled = false; b.textContent = '↻ Réimporter la bibliographie'; }
  };
  if (!f.open) f.showModal();
}

// ------------------------------------------------------------------ Vue Réglages
function vueReglages(el) {
  const exp = lireLS(CLES.export, '');
  const nb = livresVisibles().length;
  el.innerHTML = `
    <div class="carte">
      <h2>Connexion à Google Sheets</h2>
      <p>URL du déploiement Apps Script et clé affichée par le menu « Bibliothèque » du Sheet.</p>
      <label class="champ">URL de l'application Web<input id="cfg-url" type="url" inputmode="url" value="${esc(etat.config.url)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
      <label class="champ">Clé<input id="cfg-cle" type="password" value="${esc(etat.config.cle)}" autocomplete="off"></label>
      <div class="btns">
        <button class="btn principal" type="button" id="cfg-save">Enregistrer et tester</button>
        ${connecte() ? '<button class="btn" type="button" id="cfg-sync">Synchroniser</button>' : ''}
      </div>
      <p>${etat.data.dernierSync ? 'Dernière synchro : ' + esc(new Date(etat.data.dernierSync).toLocaleString('fr-FR')) : 'Jamais synchronisé.'}
      ${etat.erreurSync ? '<br>⚠ ' + esc(etat.erreurSync) : ''}</p>
    </div>

    <div class="carte">
      <h2>Sauvegarde</h2>
      <p>Les données sont dans votre Google Sheet, et une copie .xlsx est faite chaque dimanche dans Drive (dossier « Livres - Sauvegardes »). Vous pouvez aussi exporter un fichier depuis ce téléphone.</p>
      <p><strong>Dernier export :</strong> ${exp ? esc(dateCourte(exp)) : 'jamais'}</p>
      <div class="btns">
        <button class="btn principal" type="button" id="exp-json">💾 Exporter (sauvegarde complète)</button>
        <button class="btn" type="button" id="exp-csv">📄 Exporter pour Excel (.csv)</button>
      </div>
      <div class="sep"></div>
      <label class="champ">Restaurer une sauvegarde (.json)<input id="imp-json" type="file" accept=".json,application/json"></label>
    </div>

    <div class="carte">
      <h2>Statistiques</h2>
      <p>${nb} livres · ${livresVisibles().filter((l) => l.possede === 'Oui').length} possédés · ${livresVisibles().filter((l) => l.statut === 'Lu').length} lus · ${new Set(livresVisibles().map((l) => l.auteur)).size} auteurs</p>
      <p>Lus par année : ${Object.entries(livresVisibles().filter((l) => l.statut === 'Lu' && l.annee_lecture).reduce((m, l) => { m[l.annee_lecture] = (m[l.annee_lecture] || 0) + 1; return m; }, {}))
        .sort((a, b) => b[0] - a[0]).map(([an, n]) => `${an} : ${n}`).join(' · ') || '—'}</p>
    </div>

    <div class="carte">
      <h2>Apparence</h2>
      ${segment('theme', ['Auto', 'Clair', 'Sombre'], { '': 'Auto', light: 'Clair', dark: 'Sombre' }[lireLS('livres.theme', '')] || 'Auto')}
    </div>`;

  $('#cfg-save', el).onclick = async () => {
    etat.config = { url: $('#cfg-url', el).value.trim(), cle: $('#cfg-cle', el).value.trim() };
    if (etat.config.url && !/^https:\/\/script\.google(usercontent)?\.com\//.test(etat.config.url)) { toast('L\'URL doit commencer par https://script.google.com/'); return; }
    ecrireLS(CLES.config, etat.config);
    try {
      await appel('ping');
      toast('Connexion OK — synchronisation…');
      await synchroniser();
      if (etat.sync === 'idle') toast(`Synchronisé : ${livresVisibles().length} livres`);
    } catch (e) { toast(e.message, 5000); }
    document.activeElement?.blur(); rendre();
  };
  const bs = $('#cfg-sync', el); if (bs) bs.onclick = () => { document.activeElement?.blur(); synchroniser(); };
  $('#exp-json', el).onclick = exporterJSON;
  $('#exp-csv', el).onclick = exporterCSV;
  $('#imp-json', el).onchange = (e) => restaurerFichier(e.target.files[0]);
  el.querySelectorAll('[data-seg="theme"] button').forEach((b) => (b.onclick = () => {
    const v = { Auto: '', Clair: 'light', Sombre: 'dark' }[b.dataset.v];
    ecrireLS('livres.theme', v); appliquerTheme(); document.activeElement?.blur(); rendre();
  }));
}

function appliquerTheme() {
  const t = lireLS('livres.theme', '');
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}

// ------------------------------------------------------------------ Export / restauration
function telecharger(nom, contenu, type) {
  const url = URL.createObjectURL(new Blob([contenu], { type }));
  const a = document.createElement('a'); a.href = url; a.download = nom; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

async function exporterJSON() {
  const jour = new Date().toISOString().slice(0, 10);
  const contenu = JSON.stringify({ format: 'livres-v2', exporte_le: new Date().toISOString(), livres: etat.data.livres, auteurs: etat.data.auteurs }, null, 1);
  const nom = `Livres_${jour}.json`;
  // Sur Android, le menu de partage permet d'envoyer directement vers Drive, OneDrive, e-mail…
  try {
    const fichier = new File([contenu], nom, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [fichier] })) {
      await navigator.share({ files: [fichier], title: 'Sauvegarde Ma bibliothèque' });
    } else {
      telecharger(nom, contenu, 'application/json');
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    telecharger(nom, contenu, 'application/json');
  }
  ecrireLS(CLES.export, new Date().toISOString());
  toast('Sauvegarde exportée'); rendre(true);
}

function exporterCSV() {
  const cols = [['auteur', 'Auteur'], ['saga', 'Saga'], ['titre', 'Titre'], ['ordre', 'Ordre de lecture'], ['possede', 'Possède'], ['statut', 'Lecture'],
    ['annee_lecture', 'Année de lecture'], ['priorite', 'Priorité'], ['objectif', 'Objectif'], ['note', 'Note'], ['note_source', 'Source note'],
    ['note_votes', 'Votes'], ['emplacement', 'Où est le livre ?'], ['a_vendre', 'À vendre'], ['commentaire', 'Commentaire'], ['non_interesse', 'Non intéressé'], ['type_oeuvre', 'Type'], ['titre_vo', 'Titre original'], ['annee_pub', 'Parution']];
  const cell = (v) => { let s = v === true ? 'Oui' : v === false ? '' : String(v ?? ''); if (/^\d+\.\d+$/.test(s)) s = s.replace('.', ','); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lignes = [cols.map((c) => c[1]).join(';'), ...trierLivres(livresVisibles(), 'auteur').map((l) => cols.map(([k]) => cell(k === 'a_vendre' ? vrai(l[k]) : l[k])).join(';'))];
  telecharger(`Livres_${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + lignes.join('\r\n'), 'text/csv;charset=utf-8');
}

async function restaurerFichier(fichier) {
  if (!fichier) return;
  let d;
  try { d = JSON.parse(await fichier.text()); } catch (e) { toast('Fichier illisible'); return; }
  if (!d || !Array.isArray(d.livres)) { toast('Ce fichier n\'est pas une sauvegarde de l\'app'); return; }
  const msg = connecte()
    ? `Restaurer ${d.livres.length} livres (sauvegarde du ${dateCourte(d.exporte_le)}) ?\nLes livres de la sauvegarde remplaceront ceux du Google Sheet ayant le même identifiant.`
    : `Charger ${d.livres.length} livres sur ce téléphone (mode local, sans Google Sheets) ?`;
  if (!confirm(msg)) return;
  if (connecte()) {
    try {
      const r = await appel('restaurer', { livres: d.livres, auteurs: d.auteurs || [] });
      etat.data.livres = r.livres; etat.data.auteurs = r.auteurs;
      etat.attente = {}; ecrireLS(CLES.attente, etat.attente);
    } catch (e) { toast(e.message, 5000); return; }
  } else {
    etat.data.livres = d.livres; etat.data.auteurs = d.auteurs || [];
  }
  sauverData(); majDatalists(); toast(`${d.livres.length} livres restaurés`); etat.ui.vue = 'livres'; rendre();
}

// ------------------------------------------------------------------ Navigation & démarrage
function allerA(vue) {
  etat.ui.vue = vue; sauverUI(); window.scrollTo(0, 0); rendre();
}

function demarrer() {
  appliquerTheme();
  document.querySelectorAll('.onglets button').forEach((b) => (b.onclick = () => allerA(b.dataset.vue)));
  $('#fab').onclick = () => ouvrirLivre(null, etat.ui.recherche && !livresVisibles().some((l) => norm(l.titre).includes(norm(etat.ui.recherche))) ? { titre: etat.ui.recherche } : null);
  $('#etat-sync').onclick = () => { if (connecte()) { synchroniser(); if (etat.erreurSync) toast(etat.erreurSync, 5000); } else allerA('reglages'); };
  $('#feuille').addEventListener('close', () => rendre(true));
  window.addEventListener('online', synchroniser);
  window.addEventListener('offline', () => { etat.sync = 'hors-ligne'; afficherEtat(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && joursDepuis(etat.data.dernierSync) >= 0 && Date.now() - new Date(etat.data.dernierSync || 0).getTime() > 5 * 60000) synchroniser(); });

  majDatalists(); afficherEtat(); rendre();
  if (connecte()) synchroniser();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

demarrer();
