import type { Database } from "bun:sqlite";
import type { BunRequest } from "bun";
import { MAX_TEXT_LENGTH, type Comment, type Ok, type Post, type User } from "./shared/types";

const SESSION_COOKIE = "sid";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const fail = (status: number, error: string) => Response.json({ error }, { status });
const ok = (): Response => Response.json({ ok: true } satisfies Ok);

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= MAX_TEXT_LENGTH ? text : null;
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

type PostRow = {
  id: number; body: string; created_at: string; author_id: number; author_name: string;
  like_count: number; liked_by_me: number; comment_count: number;
};
type CommentRow = { id: number; post_id: number; parent_id: number | null; body: string; created_at: string; author_id: number; author_name: string };

const toPost = (r: PostRow): Post => ({
  id: r.id,
  author: { id: r.author_id, username: r.author_name },
  body: r.body,
  createdAt: r.created_at,
  likeCount: r.like_count,
  likedByMe: r.liked_by_me === 1,
  commentCount: r.comment_count,
});
const toComment = (r: CommentRow): Comment => ({
  id: r.id,
  postId: r.post_id,
  parentId: r.parent_id,
  author: { id: r.author_id, username: r.author_name },
  body: r.body,
  createdAt: r.created_at,
});

const POST_SELECT = `
  SELECT p.id, p.body, p.created_at, u.id AS author_id, u.username AS author_name,
    (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
    EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $me) AS liked_by_me,
    (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
  FROM posts p JOIN users u ON u.id = p.user_id`;
const COMMENT_SELECT = `
  SELECT c.id, c.post_id, c.parent_id, c.body, c.created_at, u.id AS author_id, u.username AS author_name
  FROM comments c JOIN users u ON u.id = c.user_id`;

export function apiRoutes(db: Database) {
  // Compared against when the username is unknown, so a wrong username takes as long as a wrong password.
  const dummyHash = Bun.password.hashSync(crypto.randomUUID());

  const q = {
    userByName: db.query<User & { password_hash: string }, [string]>(
      "SELECT id, username, password_hash FROM users WHERE username = ?"),
    userBySession: db.query<User, [string]>(
      "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?"),
    addSession: db.query("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)"),
    dropSession: db.query("DELETE FROM sessions WHERE token = ?"),
    posts: db.query<PostRow, { me: number }>(`${POST_SELECT} ORDER BY p.created_at DESC, p.id DESC`),
    post: db.query<PostRow, { me: number; id: number }>(`${POST_SELECT} WHERE p.id = $id`),
    addPost: db.query<{ id: number }, [number, string, string]>(
      "INSERT INTO posts (user_id, body, created_at) VALUES (?, ?, ?) RETURNING id"),
    postOwner: db.query<{ user_id: number }, [number]>("SELECT user_id FROM posts WHERE id = ?"),
    dropPost: db.query("DELETE FROM posts WHERE id = ?"),
    unlike: db.query("DELETE FROM likes WHERE post_id = ? AND user_id = ?"),
    like: db.query("INSERT INTO likes (post_id, user_id) VALUES (?, ?)"),
    comments: db.query<CommentRow, [number]>(`${COMMENT_SELECT} WHERE c.post_id = ? ORDER BY c.created_at, c.id`),
    comment: db.query<CommentRow, [number]>(`${COMMENT_SELECT} WHERE c.id = ?`),
    addComment: db.query<{ id: number }, [number, number, number | null, string, string]>(
      "INSERT INTO comments (post_id, user_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id"),
    commentParent: db.query<{ post_id: number; parent_id: number | null }, [number]>(
      "SELECT post_id, parent_id FROM comments WHERE id = ?"),
    commentOwner: db.query<{ user_id: number }, [number]>("SELECT user_id FROM comments WHERE id = ?"),
    dropComment: db.query("DELETE FROM comments WHERE id = ?"),
  };

  const currentUser = (req: { cookies: BunRequest["cookies"] }): User | null => {
    const token = req.cookies.get(SESSION_COOKIE);
    return token ? q.userBySession.get(token) : null;
  };

  // Wraps a handler so it only runs for a logged-in user.
  const authed = <P extends string>(handler: (req: BunRequest<P>, me: User) => Response | Promise<Response>) =>
    (req: BunRequest<P>) => {
      const me = currentUser(req);
      return me ? handler(req, me) : fail(401, "Please log in");
    };

  const loadPost = (id: number, me: User) => {
    const row = q.post.get({ id, me: me.id });
    return row ? toPost(row) : null;
  };

  return {
    // 1. Log in
    "/api/login": {
      POST: async (req: BunRequest<"/api/login">) => {
        const body = await readJson(req);
        const username = typeof body.username === "string" ? body.username.trim() : "";
        const password = typeof body.password === "string" ? body.password : "";
        const row = q.userByName.get(username);
        const valid = await Bun.password.verify(password, row?.password_hash ?? dummyHash);
        if (!row || !valid) return fail(401, "Wrong username or password");

        const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
        q.addSession.run(token, row.id, new Date().toISOString());
        req.cookies.set(SESSION_COOKIE, token, {
          httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE_SECONDS,
          secure: process.env.COOKIE_SECURE === "true",
        });
        return Response.json({ id: row.id, username: row.username } satisfies User);
      },
    },

    // 2. Log out
    "/api/logout": {
      POST: (req: BunRequest<"/api/logout">) => {
        const token = req.cookies.get(SESSION_COOKIE);
        if (token) q.dropSession.run(token);
        req.cookies.delete({ name: SESSION_COOKIE, path: "/" });
        return ok();
      },
    },

    // 3. Who am I
    "/api/me": {
      GET: authed<"/api/me">((_req, me) => Response.json(me)),
    },

    "/api/posts": {
      // 4. List posts, newest first
      GET: authed<"/api/posts">((_req, me) => Response.json(q.posts.all({ me: me.id }).map(toPost))),
      // 5. Create a post
      POST: authed<"/api/posts">(async (req, me) => {
        const text = cleanText((await readJson(req)).body);
        if (!text) return fail(400, `Write between 1 and ${MAX_TEXT_LENGTH} characters`);
        const row = q.addPost.get(me.id, text, new Date().toISOString());
        const post = row && loadPost(row.id, me);
        return post ? Response.json(post, { status: 201 }) : fail(500, "Could not save the post");
      }),
    },

    // 6. Delete your own post
    "/api/posts/:id": {
      DELETE: authed<"/api/posts/:id">((req, me) => {
        const id = parseId(req.params.id);
        const owner = id ? q.postOwner.get(id) : null;
        if (!id || !owner) return fail(404, "Post not found");
        if (owner.user_id !== me.id) return fail(403, "You can only delete your own posts");
        q.dropPost.run(id);
        return ok();
      }),
    },

    // 7. Like or unlike a post (toggle)
    "/api/posts/:id/like": {
      POST: authed<"/api/posts/:id/like">((req, me) => {
        const id = parseId(req.params.id);
        if (!id || !q.postOwner.get(id)) return fail(404, "Post not found");
        if (q.unlike.run(id, me.id).changes === 0) q.like.run(id, me.id);
        const post = loadPost(id, me);
        return post ? Response.json(post) : fail(404, "Post not found");
      }),
    },

    "/api/posts/:id/comments": {
      // 8. List a post's comments, oldest first
      GET: authed<"/api/posts/:id/comments">((req) => {
        const id = parseId(req.params.id);
        if (!id || !q.postOwner.get(id)) return fail(404, "Post not found");
        return Response.json(q.comments.all(id).map(toComment));
      }),
      // 9. Comment on a post, or reply to a comment with { parentId }
      POST: authed<"/api/posts/:id/comments">(async (req, me) => {
        const id = parseId(req.params.id);
        if (!id || !q.postOwner.get(id)) return fail(404, "Post not found");
        const input = await readJson(req);
        const text = cleanText(input.body);
        if (!text) return fail(400, `Write between 1 and ${MAX_TEXT_LENGTH} characters`);

        let parentId: number | null = null;
        if (input.parentId !== undefined && input.parentId !== null) {
          const parent = typeof input.parentId === "number" ? q.commentParent.get(input.parentId) : null;
          if (!parent || parent.post_id !== id) return fail(400, "That comment is not on this post");
          // Replies stay one level deep: replying to a reply joins the same thread.
          parentId = parent.parent_id ?? (input.parentId as number);
        }

        const row = q.addComment.get(id, me.id, parentId, text, new Date().toISOString());
        const comment = row && q.comment.get(row.id);
        return comment ? Response.json(toComment(comment), { status: 201 }) : fail(500, "Could not save the comment");
      }),
    },

    // 10. Delete your own comment
    "/api/comments/:id": {
      DELETE: authed<"/api/comments/:id">((req, me) => {
        const id = parseId(req.params.id);
        const owner = id ? q.commentOwner.get(id) : null;
        if (!id || !owner) return fail(404, "Comment not found");
        if (owner.user_id !== me.id) return fail(403, "You can only delete your own comments");
        q.dropComment.run(id);
        return ok();
      }),
    },
  };
}

export const notFound = () => fail(404, "Not found");
