-- Les comptes de Panache (src/comptes.ts) : un identifiant, l'empreinte de son jeton, et quand il a été vu.
CREATE TABLE comptes (
  id TEXT PRIMARY KEY,
  empreinte TEXT NOT NULL,
  cree INTEGER NOT NULL,
  vu INTEGER NOT NULL
);

-- La sauvegarde d'un compte (src/game/save.ts côté jeu) et sa révision, qui avance d'un à chaque envoi.
CREATE TABLE sauvegardes (
  compte TEXT PRIMARY KEY REFERENCES comptes (id),
  rev INTEGER NOT NULL,
  donnees TEXT NOT NULL,
  maj INTEGER NOT NULL
);
