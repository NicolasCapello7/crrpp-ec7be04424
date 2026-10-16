-- Base aparte (rrpp-copias): copia diaria de users, eventos y rendimiento; se guardan los últimos 30 días.
-- Cada fila es una fila de la base principal en JSON, con el día de la copia. Al eliminar una cuenta se borra también de acá.
CREATE TABLE IF NOT EXISTS copias (
  dia TEXT NOT NULL,             -- AAAA-MM-DD (hora de Argentina)
  tabla TEXT NOT NULL,           -- users | eventos | rendimiento
  clave TEXT NOT NULL,           -- sub de la cuenta
  data TEXT NOT NULL,            -- la fila completa, en JSON
  PRIMARY KEY (dia, tabla, clave)
);
CREATE INDEX IF NOT EXISTS copias_clave ON copias (clave);
