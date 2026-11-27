import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { apiRoutes, notFound } from "../src/api";
import { openDb } from "../src/db";
import { DEMO_USER, type Comment, type Post, type User } from "../src/shared/types";

let server: Server<undefined>;
let cookie = "";

const call = (path: string, method = "GET", body?: unknown, withCookie = true) =>
  fetch(new URL(path, server.url), {
    method,
    headers: {
      ...(withCookie && cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(() => {
  server = Bun.serve({ port: 0, routes: apiRoutes(openDb(":memory:")), fetch: notFound });
});
afterAll(() => server.stop(true));

describe("auth", () => {
  test("rejects a wrong password and an unknown user the same way", async () => {
    const a = await call("/api/login", "POST", { username: "demo", password: "nope" });
    const b = await call("/api/login", "POST", { username: "ghost", password: "nope" });
    expect(a.status).toBe(401);
    expect(await b.json()).toEqual(await a.json());
  });

  test("blocks endpoints when logged out", async () => {
    expect((await call("/api/posts")).status).toBe(401);
    expect((await call("/api/me")).status).toBe(401);
  });

  test("logs in the demo account with an http-only cookie", async () => {
    const res = await call("/api/login", "POST", DEMO_USER);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    cookie = setCookie.split(";")[0] ?? "";
    const me = (await (await call("/api/me")).json()) as User;
    expect(me.username).toBe("demo");
  });
});

describe("posts, likes and comments", () => {
  let mine: Post;

  test("lists the seeded posts newest first", async () => {
    const posts = (await (await call("/api/posts")).json()) as Post[];
    expect(posts.length).toBe(2);
    expect(posts[0]?.author.username).toBe("demo");
    expect(posts[1]?.likedByMe).toBe(true);
    expect(posts[1]?.commentCount).toBe(1);
  });

  test("creates a post and rejects an empty one", async () => {
    expect((await call("/api/posts", "POST", { body: "   " })).status).toBe(400);
    expect((await call("/api/posts", "POST", { body: "x".repeat(501) })).status).toBe(400);
    const res = await call("/api/posts", "POST", { body: "  hello  " });
    expect(res.status).toBe(201);
    mine = (await res.json()) as Post;
    expect(mine.body).toBe("hello");
    expect(mine.likeCount).toBe(0);
  });

  test("toggles a like on and off", async () => {
    const on = (await (await call(`/api/posts/${mine.id}/like`, "POST")).json()) as Post;
    expect(on).toMatchObject({ likedByMe: true, likeCount: 1 });
    const off = (await (await call(`/api/posts/${mine.id}/like`, "POST")).json()) as Post;
    expect(off).toMatchObject({ likedByMe: false, likeCount: 0 });
    expect((await call("/api/posts/9999/like", "POST")).status).toBe(404);
  });

  test("adds, lists and deletes a comment", async () => {
    const res = await call(`/api/posts/${mine.id}/comments`, "POST", { body: "nice" });
    expect(res.status).toBe(201);
    const c = (await res.json()) as Comment;
    let list = (await (await call(`/api/posts/${mine.id}/comments`)).json()) as Comment[];
    expect(list.map((x) => x.body)).toEqual(["nice"]);
    expect((await call(`/api/comments/${c.id}`, "DELETE")).status).toBe(200);
    list = (await (await call(`/api/posts/${mine.id}/comments`)).json()) as Comment[];
    expect(list).toEqual([]);
  });

  test("will not delete someone else's post or comment", async () => {
    const posts = (await (await call("/api/posts")).json()) as Post[];
    const sams = posts.find((p) => p.author.username === "sam");
    expect((await call(`/api/posts/${sams?.id}`, "DELETE")).status).toBe(403);
    expect((await call("/api/posts/abc", "DELETE")).status).toBe(404);
  });

  test("deleting a post removes it and its comments", async () => {
    await call(`/api/posts/${mine.id}/comments`, "POST", { body: "bye" });
    expect((await call(`/api/posts/${mine.id}`, "DELETE")).status).toBe(200);
    expect((await call(`/api/posts/${mine.id}/comments`)).status).toBe(404);
  });

  test("logout ends the session", async () => {
    expect((await call("/api/logout", "POST")).status).toBe(200);
    expect((await call("/api/me")).status).toBe(401);
  });

  test("unknown api paths return 404 json", async () => {
    const res = await call("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});
