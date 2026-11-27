import { useEffect, useState, type FormEvent } from "react";
import { DEMO_USER, MAX_TEXT_LENGTH, type Comment, type Post, type User } from "../shared/types";
import { api, errorText } from "./api";

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const formatTime = (iso: string) => timeFormat.format(new Date(iso));

export function App() {
  // undefined = still checking the session, null = logged out
  const [me, setMe] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api.me().then(setMe, () => setMe(null));
  }, []);

  if (me === undefined) return <main className="page"><p className="muted">Loading…</p></main>;
  if (me === null) return <Login onLogin={setMe} />;
  return <Feed me={me} onLogout={() => api.logout().finally(() => setMe(null))} />;
}

function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function logIn(u: string, p: string) {
    setBusy(true);
    setError("");
    try {
      onLogin(await api.login(u, p));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    logIn(username, password);
  };

  return (
    <main className="page narrow">
      <h1>Log in</h1>
      <form onSubmit={submit} className="stack">
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>Log in</button>
      </form>
      <button type="button" className="link" disabled={busy}
        onClick={() => logIn(DEMO_USER.username, DEMO_USER.password)}>
        Use the demo account ({DEMO_USER.username} / {DEMO_USER.password})
      </button>
    </main>
  );
}

function Feed({ me, onLogout }: { me: User; onLogout: () => void }) {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listPosts().then(setPosts, (e) => { setPosts([]); setError(errorText(e)); });
  }, []);

  const replace = (p: Post) => setPosts((list) => list?.map((x) => (x.id === p.id ? p : x)) ?? list);

  async function publish(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const post = await api.createPost(draft);
      setPosts((list) => [post, ...(list ?? [])]);
      setDraft("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("Delete this post?")) return;
    try {
      await api.deletePost(id);
      setPosts((list) => list?.filter((p) => p.id !== id) ?? list);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <main className="page">
      <header className="top">
        <h1>Posts</h1>
        <span className="muted">
          {me.username} · <button type="button" className="link" onClick={onLogout}>Log out</button>
        </span>
      </header>

      <form onSubmit={publish} className="stack card">
        <label className="sr-only" htmlFor="new-post">New post</label>
        <textarea id="new-post" value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder="What's on your mind?" maxLength={MAX_TEXT_LENGTH} rows={3} />
        <div className="row">
          <span className="muted small">{draft.length}/{MAX_TEXT_LENGTH}</span>
          <button type="submit" className="primary" disabled={busy || !draft.trim()}>Post</button>
        </div>
      </form>

      {error && <p className="error" role="alert">{error}</p>}
      {posts === null && <p className="muted">Loading posts…</p>}
      {posts?.length === 0 && !error && <p className="muted">No posts yet. Write the first one.</p>}

      {posts?.map((post) => (
        <PostCard key={post.id} post={post} me={me} onChange={replace} onDelete={() => remove(post.id)} />
      ))}
    </main>
  );
}

function PostCard({ post, me, onChange, onDelete }: {
  post: Post; me: User; onChange: (p: Post) => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  async function like() {
    // Show the change right away, then trust the server's answer.
    onChange({ ...post, likedByMe: !post.likedByMe, likeCount: post.likeCount + (post.likedByMe ? -1 : 1) });
    try {
      onChange(await api.toggleLike(post.id));
    } catch (e) {
      onChange(post);
      setError(errorText(e));
    }
  }

  return (
    <article className="card">
      <div className="meta">
        <strong>{post.author.username}</strong>
        <time className="muted small" dateTime={post.createdAt}>{formatTime(post.createdAt)}</time>
      </div>
      <p className="body">{post.body}</p>
      <div className="actions">
        <button type="button" onClick={like} aria-pressed={post.likedByMe} className={post.likedByMe ? "liked" : ""}>
          {post.likedByMe ? "Liked" : "Like"} · {post.likeCount}
        </button>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          Comments · {post.commentCount}
        </button>
        {post.author.id === me.id && <button type="button" className="danger" onClick={onDelete}>Delete</button>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {open && (
        <Comments postId={post.id} me={me}
          onCountChange={(delta) => onChange({ ...post, commentCount: post.commentCount + delta })} />
      )}
    </article>
  );
}

function Comments({ postId, me, onCountChange }: {
  postId: number; me: User; onCountChange: (delta: number) => void;
}) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.listComments(postId).then(setComments, (e) => { setComments([]); setError(errorText(e)); });
  }, [postId]);

  async function add(body: string, parentId?: number) {
    setError("");
    try {
      const c = await api.addComment(postId, body, parentId);
      setComments((list) => [...(list ?? []), c]);
      onCountChange(1);
      setReplyTo(null);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  }

  async function remove(id: number) {
    try {
      await api.deleteComment(id);
      // The server also deletes the comment's replies.
      const gone = (comments ?? []).filter((c) => c.id === id || c.parentId === id).length;
      setComments((list) => list?.filter((c) => c.id !== id && c.parentId !== id) ?? list);
      onCountChange(-gone);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const topLevel = comments?.filter((c) => c.parentId === null) ?? [];
  const repliesTo = (id: number) => comments?.filter((c) => c.parentId === id) ?? [];

  const line = (c: Comment, threadId: number) => (
    <div key={c.id} className="comment">
      <p>
        <strong>{c.author.username}</strong> {c.body}
      </p>
      <span className="muted small">
        {formatTime(c.createdAt)} · <button type="button" className="link" onClick={() => setReplyTo(threadId)}>Reply</button>
        {c.author.id === me.id && (
          <> · <button type="button" className="link danger" onClick={() => remove(c.id)}>Delete</button></>
        )}
      </span>
    </div>
  );

  return (
    <section className="comments">
      {comments === null && <p className="muted small">Loading…</p>}
      {comments?.length === 0 && <p className="muted small">No comments yet.</p>}
      {topLevel.map((c) => (
        <div key={c.id} className="thread">
          {line(c, c.id)}
          {(repliesTo(c.id).length > 0 || replyTo === c.id) && (
            <div className="replies">
              {repliesTo(c.id).map((r) => line(r, c.id))}
              {replyTo === c.id && (
                <CommentForm id={`reply-${c.id}`} label={`Reply to ${c.author.username}`} autoFocus
                  onSubmit={(body) => add(body, c.id)} onCancel={() => setReplyTo(null)} />
              )}
            </div>
          )}
        </div>
      ))}
      <CommentForm id={`comment-${postId}`} label="Write a comment" onSubmit={(body) => add(body)} />
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function CommentForm({ id, label, autoFocus, onSubmit, onCancel }: {
  id: string; label: string; autoFocus?: boolean;
  onSubmit: (body: string) => Promise<boolean>; onCancel?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    if (await onSubmit(draft)) setDraft("");
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="row">
      <label className="sr-only" htmlFor={id}>{label}</label>
      <input id={id} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={label}
        maxLength={MAX_TEXT_LENGTH} autoFocus={autoFocus}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel?.(); }} />
      {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      <button type="submit" disabled={busy || !draft.trim()}>Send</button>
    </form>
  );
}
