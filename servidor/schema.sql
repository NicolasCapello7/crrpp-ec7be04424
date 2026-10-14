-- Cuentas de RRPP (Google), sesiones de la app y la lista pública de eventos de cada RRPP
CREATE TABLE IF NOT EXISTS users (
  sub TEXT PRIMARY KEY,          -- id de Google
  email TEXT NOT NULL,
  nombre TEXT,
  slug TEXT UNIQUE,              -- nombre en el link público
  creado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,   -- sha256 del token que guarda la app
  sub TEXT NOT NULL,
  expira INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_sub ON sessions (sub);

CREATE TABLE IF NOT EXISTS eventos (
  sub TEXT PRIMARY KEY,
  data TEXT NOT NULL,            -- JSON con la lista de eventos del RRPP
  actualizado TEXT NOT NULL
);

-- v2: redes del RRPP para la página pública
ALTER TABLE users ADD COLUMN instagram TEXT;
ALTER TABLE users ADD COLUMN whatsapp TEXT;
