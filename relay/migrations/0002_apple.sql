-- « Se connecter avec Apple » (src/apple.ts) : un compte peut avoir plusieurs jetons (un par appareil), et l'identifiant
-- stable du joueur chez Apple, qui le retrouve depuis un autre appareil.
CREATE TABLE jetons (
  empreinte TEXT PRIMARY KEY,
  compte TEXT NOT NULL REFERENCES comptes (id),
  cree INTEGER NOT NULL
);
INSERT INTO jetons (empreinte, compte, cree) SELECT empreinte, id, cree FROM comptes;
CREATE INDEX jetons_compte ON jetons (compte);
ALTER TABLE comptes ADD COLUMN apple TEXT;
CREATE UNIQUE INDEX comptes_apple ON comptes (apple);
