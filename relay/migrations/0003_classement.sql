-- Le classement (src/classement.ts) : la cote de chaque compte, et les parties classées avec leurs deux rapports.
ALTER TABLE comptes ADD COLUMN cote INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE comptes ADD COLUMN joues INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comptes ADD COLUMN gagnes INTEGER NOT NULL DEFAULT 0;
CREATE INDEX comptes_cote ON comptes (cote) WHERE joues > 0;

CREATE TABLE parties (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  carte TEXT NOT NULL,
  bleu TEXT NOT NULL,
  rouge TEXT NOT NULL,
  debut INTEGER NOT NULL,
  -- ce que chaque camp dit de l'issue (blue, red, draw), puis l'issue retenue et ce qu'elle a fait aux cotes
  rapport_bleu TEXT,
  rapport_rouge TEXT,
  issue TEXT,
  fin INTEGER,
  delta_bleu INTEGER,
  delta_rouge INTEGER
);
CREATE INDEX parties_bleu ON parties (bleu, debut);
CREATE INDEX parties_rouge ON parties (rouge, debut);
