import { useEffect, useState, type FormEvent } from "react";
import { Heart, LogOut, MessageCircle, Send, Trash2 } from "lucide-react";
import { DEMO_USER, MAX_TEXT_LENGTH, type Comment, type Post, type User } from "../shared/types";
import { api, errorText } from "./api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// ---------- small helpers ----------

const fullTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60], ["minute", 60], ["hour", 24], ["day", 7], ["week", 4.35], ["month", 12], ["year", Infinity],
];

function timeAgo(iso: string) {
  let value = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return unit === "second" ? "just now" : relative.format(Math.round(value), unit);
    value /= size;
  }
  return fullTime.format(new Date(iso));
}

function Time({ iso }: { iso: string }) {
  return <time dateTime={iso} title={fullTime.format(new Date(iso))}>{timeAgo(iso)}</time>;
}

const AVATAR_COLORS = [
  "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-100",
  "bg-sky-100 text-sky-900 dark:bg-sky-900/60 dark:text-sky-100",
  "bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100",
  "bg-rose-100 text-rose-900 dark:bg-rose-900/60 dark:text-rose-100",
];

function UserAvatar({ user, className }: { user: User; className?: string }) {
  const color = AVATAR_COLORS[user.id % AVATAR_COLORS.length];
  return (
    <Avatar className={className}>
      <AvatarFallback className={cn("text-xs font-semibold", color)}>
        {user.username.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

function ErrorText({ children }: { children: string }) {
  return children ? <p role="alert" className="text-destructive text-sm">{children}</p> : null;
}

// ---------- app ----------

export function App() {
  // undefined = still checking the session, null = logged out
  const [me, setMe] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api.me().then(setMe, () => setMe(null));
  }, []);

  if (me === undefined) return <p className="text-muted-foreground p-8 text-center text-sm">Loading…</p>;
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

  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Log in</CardTitle>
          <CardDescription>Post, like and comment.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); logIn(username, password); }}>
            <div className="grid gap-2">
              <Label htmlFor="username">Username</Label>
              <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)}
                autoComplete="username" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password" required />
            </div>
            <ErrorText>{error}</ErrorText>
            <Button type="submit" disabled={busy} className="w-full">Log in</Button>
          </form>
        </CardContent>
        <CardFooter className="flex-col gap-3">
          <div className="text-muted-foreground flex w-full items-center gap-3 text-xs">
            <Separator className="flex-1" /> or <Separator className="flex-1" />
          </div>
          <Button variant="outline" className="w-full" disabled={busy}
            onClick={() => logIn(DEMO_USER.username, DEMO_USER.password)}>
            Try the demo account
          </Button>
          <p className="text-muted-foreground text-xs">
            {DEMO_USER.username} / {DEMO_USER.password}
          </p>
        </CardFooter>
      </Card>
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
    <div className="min-h-svh">
      <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur">
        <div className="mx-auto flex h-14 max-w-xl items-center justify-between px-4">
          <span className="font-semibold tracking-tight">Likes</span>
          <div className="flex items-center gap-2">
            <UserAvatar user={me} className="size-7" />
            <span className="text-sm">{me.username}</span>
            <Button variant="ghost" size="icon" aria-label="Log out" title="Log out" onClick={onLogout}>
              <LogOut />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-xl gap-4 px-4 py-6">
        <Card className="gap-3 py-4">
          <form onSubmit={publish}>
            <CardContent className="flex gap-3 px-4">
              <UserAvatar user={me} className="mt-1" />
              <div className="grid flex-1 gap-2">
                <Label htmlFor="new-post" className="sr-only">New post</Label>
                <Textarea id="new-post" value={draft} onChange={(e) => setDraft(e.target.value)}
                  placeholder="What's on your mind?" maxLength={MAX_TEXT_LENGTH}
                  className="min-h-20 resize-none border-0 px-0 shadow-none focus-visible:ring-0 dark:bg-transparent" />
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs tabular-nums">{draft.length}/{MAX_TEXT_LENGTH}</span>
                  <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
                    <Send /> Post
                  </Button>
                </div>
              </div>
            </CardContent>
          </form>
        </Card>

        <ErrorText>{error}</ErrorText>
        {posts === null && <p className="text-muted-foreground py-8 text-center text-sm">Loading posts…</p>}
        {posts?.length === 0 && !error && (
          <p className="text-muted-foreground py-8 text-center text-sm">No posts yet. Write the first one.</p>
        )}

        {posts?.map((post) => (
          <PostCard key={post.id} post={post} me={me} onChange={replace} onDelete={() => remove(post.id)} />
        ))}
      </main>
    </div>
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
    <Card className="gap-3 py-4">
      <CardContent className="grid gap-3 px-4">
        <div className="flex items-center gap-3">
          <UserAvatar user={post.author} />
          <div className="grid leading-tight">
            <span className="text-sm font-medium">{post.author.username}</span>
            <span className="text-muted-foreground text-xs"><Time iso={post.createdAt} /></span>
          </div>
          {post.author.id === me.id && (
            <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive ml-auto"
              aria-label="Delete post" title="Delete post" onClick={onDelete}>
              <Trash2 />
            </Button>
          )}
        </div>

        <p className="text-[15px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{post.body}</p>

        <div className="-ml-2 flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={like} aria-pressed={post.likedByMe}
            aria-label={post.likedByMe ? "Unlike" : "Like"}
            className={cn("tabular-nums", post.likedByMe && "text-like hover:text-like")}>
            <Heart className={cn(post.likedByMe && "fill-current")} /> {post.likeCount}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}
            aria-label={open ? "Hide comments" : "Show comments"} className="tabular-nums">
            <MessageCircle /> {post.commentCount}
          </Button>
        </div>
        <ErrorText>{error}</ErrorText>

        {open && (
          <>
            <Separator />
            <Comments postId={post.id} me={me}
              onCountChange={(delta) => onChange({ ...post, commentCount: post.commentCount + delta })} />
          </>
        )}
      </CardContent>
    </Card>
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

  const line = (c: Comment, threadId: number, small = false) => (
    <div key={c.id} className="flex gap-2">
      <UserAvatar user={c.author} className={small ? "size-6" : "size-7"} />
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="bg-muted w-fit max-w-full rounded-lg px-3 py-2">
          <p className="text-xs font-medium">{c.author.username}</p>
          <p className="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap">{c.body}</p>
        </div>
        <div className="text-muted-foreground flex items-center gap-3 px-1 text-xs">
          <Time iso={c.createdAt} />
          <button type="button" className="hover:text-foreground font-medium focus-visible:underline focus-visible:outline-none"
            onClick={() => setReplyTo(threadId)}>
            Reply
          </button>
          {c.author.id === me.id && (
            <button type="button" className="hover:text-destructive font-medium focus-visible:underline focus-visible:outline-none"
              onClick={() => remove(c.id)}>
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <section className="grid gap-3" aria-label="Comments">
      {comments === null && <p className="text-muted-foreground text-sm">Loading…</p>}
      {comments?.length === 0 && <p className="text-muted-foreground text-sm">No comments yet. Start the conversation.</p>}
      {topLevel.map((c) => (
        <div key={c.id} className="grid gap-2">
          {line(c, c.id)}
          {(repliesTo(c.id).length > 0 || replyTo === c.id) && (
            <div className="ml-9 grid gap-2">
              {repliesTo(c.id).map((r) => line(r, c.id, true))}
              {replyTo === c.id && (
                <CommentForm id={`reply-${c.id}`} label={`Reply to ${c.author.username}`} autoFocus
                  onSubmit={(body) => add(body, c.id)} onCancel={() => setReplyTo(null)} />
              )}
            </div>
          )}
        </div>
      ))}
      <CommentForm id={`comment-${postId}`} label="Write a comment" onSubmit={(body) => add(body)} />
      <ErrorText>{error}</ErrorText>
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
    <form onSubmit={submit} className="flex items-center gap-2">
      <Label htmlFor={id} className="sr-only">{label}</Label>
      <Input id={id} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={label}
        maxLength={MAX_TEXT_LENGTH} autoFocus={autoFocus} className="h-8"
        onKeyDown={(e) => { if (e.key === "Escape") onCancel?.(); }} />
      {onCancel && <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>}
      <Button type="submit" size="icon" className="size-8 shrink-0" disabled={busy || !draft.trim()} aria-label="Send">
        <Send />
      </Button>
    </form>
  );
}
