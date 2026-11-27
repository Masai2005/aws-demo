import { Database } from "bun:sqlite";
import { DEMO_USER } from "./shared/types";

export function openDb(file: string): Database {
  const db = new Database(file, { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS likes (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (post_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
  `);
  addParentColumn(db);
  seed(db);
  return db;
}

// Databases created before replies existed lack comments.parent_id.
function addParentColumn(db: Database) {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(comments)").all();
  if (!cols.some((c) => c.name === "parent_id")) {
    db.exec("ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id)");
}

function seed(db: Database) {
  const { n } = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get() ?? { n: 0 };
  if (n > 0) return;

  const addUser = db.query<{ id: number }, { username: string; hash: string }>(
    "INSERT INTO users (username, password_hash) VALUES ($username, $hash) RETURNING id",
  );
  const addPost = db.query<{ id: number }, { userId: number; body: string; at: string }>(
    "INSERT INTO posts (user_id, body, created_at) VALUES ($userId, $body, $at) RETURNING id",
  );
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  db.transaction(() => {
    const demo = addUser.get({ username: DEMO_USER.username, hash: Bun.password.hashSync(DEMO_USER.password) });
    // Second author so the feed has posts the demo user does not own. Nobody can log in as sam.
    const sam = addUser.get({ username: "sam", hash: Bun.password.hashSync(crypto.randomUUID()) });
    if (!demo || !sam) throw new Error("seed failed");

    const first = addPost.get({ userId: sam.id, body: "First post here. Say hi in the comments.", at: ago(90) });
    addPost.get({ userId: demo.id, body: "Trying out this little app. Likes and comments work.", at: ago(20) });
    if (!first) throw new Error("seed failed");

    db.query("INSERT INTO likes (post_id, user_id) VALUES (?, ?)").run(first.id, demo.id);
    db.query("INSERT INTO comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)").run(
      first.id, demo.id, "Hi Sam!", ago(60),
    );
  })();
}
