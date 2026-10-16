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

-- v3: cuentas con mail y contraseña, códigos por mail, límites de intentos y traspaso de datos desde la app vieja
ALTER TABLE users ADD COLUMN google_sub TEXT;
ALTER TABLE users ADD COLUMN clave TEXT;              -- pbkdf2$iteraciones$sal$hash (nunca la contraseña)
UPDATE users SET google_sub = sub, email = lower(email);
CREATE UNIQUE INDEX IF NOT EXISTS users_google ON users (google_sub);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email);

CREATE TABLE IF NOT EXISTS codigos (
  email TEXT NOT NULL,
  tipo TEXT NOT NULL,            -- registro | olvide
  hash TEXT NOT NULL,            -- sha256 del código de 6 números
  datos TEXT,
  expira INTEGER NOT NULL,
  intentos INTEGER NOT NULL DEFAULT 0,
  enviado INTEGER NOT NULL,
  PRIMARY KEY (email, tipo)
);
CREATE TABLE IF NOT EXISTS limites (
  clave TEXT PRIMARY KEY,
  cuenta INTEGER NOT NULL,
  desde INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS traspasos (
  sub TEXT PRIMARY KEY,
  datos TEXT NOT NULL,
  creado INTEGER NOT NULL
);
