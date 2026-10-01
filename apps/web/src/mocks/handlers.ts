import { http, HttpResponse, delay } from "msw";
import { getDb, setSessionUserId, type MockPost, type MockUser } from "./db";
import {
  B,
  currentUser,
  errorResponse,
  mockConfig,
  paginate,
  toCard,
  toDetail,
  toMe,
  unauthenticated,
} from "./helpers";
import { ETC_BUILDING_ID, LOCATION_TEXT_MAX } from "@/lib/api/types";
import { messageHandlers } from "./handlers-messages";
import { socialHandlers } from "./handlers-social";

export { mockConfig };

function normalizeTag(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, "").toLowerCase();
}

function locationTextError(text: string): string | null {
  if (!text) return "장소를 입력해 주세요.";
  if (text.length > LOCATION_TEXT_MAX) return `장소는 ${LOCATION_TEXT_MAX}자 이하로 입력해 주세요.`;
  return null;
}

/** 계약(5.3)의 글 작성 검증을 단순 재현한다. */
function validatePost(body: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {};
  if (body.type !== "LOST" && body.type !== "FOUND") fields.type = "유형을 선택해 주세요.";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > 50) fields.title = "제목은 1~50자로 입력해 주세요.";
  const description = typeof body.description === "string" ? body.description : "";
  if (!description.trim() || description.length > 1000)
    fields.description = "설명은 1~1000자로 입력해 주세요.";
  const location = getDb().locations.find((l) => l.id === body.locationId);
  if (!location) fields.locationId = "위치를 선택해 주세요.";
  // 기타 위치는 장소 직접 입력(1~50자)이 필수, 다른 위치에는 입력할 수 없다(백엔드 계약).
  const locationText = typeof body.locationText === "string" ? body.locationText.trim() : "";
  if (location?.buildingId === ETC_BUILDING_ID) {
    const error = locationTextError(locationText);
    if (error) fields.locationText = error;
  } else if (locationText) {
    fields.locationText = "기타 위치에서만 입력할 수 있습니다.";
  }
  const occurredAt = typeof body.occurredAt === "string" ? Date.parse(body.occurredAt) : NaN;
  if (Number.isNaN(occurredAt)) fields.occurredAt = "일시를 입력해 주세요.";
  if (
    body.type === "FOUND" &&
    !(typeof body.storagePlace === "string" && body.storagePlace.trim())
  ) {
    fields.storagePlace = "보관 장소를 입력해 주세요.";
  }
  if (Array.isArray(body.tags) && body.tags.length > 8) fields.tags = "태그는 최대 8개입니다.";
  if (Array.isArray(body.photoIds) && body.photoIds.length > 3)
    fields.photoIds = "사진은 최대 3장입니다.";
  return fields;
}

export const handlers = [
  // 백엔드(Fastify)와 같이, Content-Type 이 application/json 인데 본문이 비어 있으면 400 으로 거절한다.
  // 해당하지 않으면 아무것도 반환하지 않아 다음 핸들러로 넘어간다.
  http.all(`${B}/*`, async ({ request }) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    if (!request.headers.get("content-type")?.includes("application/json")) return;
    const text = await request.clone().text();
    if (text.length > 0) return;
    return errorResponse(
      400,
      "FST_ERR_CTP_EMPTY_JSON_BODY",
      "Body cannot be empty when content-type is set to 'application/json'",
    );
  }),
  ...socialHandlers,
  ...messageHandlers,
  // ───── 인증 ─────
  http.post(`${B}/auth/signup`, async ({ request }) => {
    await delay(mockConfig.delayMs);
    const body = (await request.json()) as {
      loginId?: string;
      password?: string;
      nickname?: string;
    };
    const db = getDb();
    const fields: Record<string, string> = {};
    if (!/^[a-z0-9_]{4,20}$/.test(body.loginId ?? ""))
      fields.loginId = "아이디는 영소문자·숫자·_ 4~20자입니다.";
    if (!body.password || body.password.length < 8 || body.password.length > 64)
      fields.password = "비밀번호는 8~64자입니다.";
    const nickname = body.nickname?.trim() ?? "";
    if (nickname.length < 2 || nickname.length > 12) fields.nickname = "닉네임은 2~12자입니다.";
    if (Object.keys(fields).length)
      return errorResponse(400, "VALIDATION_ERROR", "입력값을 확인해 주세요.", fields);
    if (db.users.some((u) => u.loginId === body.loginId)) {
      return errorResponse(409, "LOGIN_ID_TAKEN", "이미 사용 중인 아이디입니다.");
    }
    if (db.users.some((u) => u.nickname.toLowerCase() === nickname.toLowerCase())) {
      return errorResponse(409, "NICKNAME_TAKEN", "이미 사용 중인 닉네임입니다.");
    }
    const user: MockUser = {
      id: db.nextIds.user++,
      loginId: body.loginId!,
      password: body.password!,
      nickname,
      createdAt: new Date().toISOString(),
      settings: { notifyMatch: true, notifyComment: true, notifyMessage: true },
    };
    db.users.push(user);
    setSessionUserId(user.id);
    return HttpResponse.json({ user: toMe(user) }, { status: 201 });
  }),

  http.post(`${B}/auth/login`, async ({ request }) => {
    await delay(mockConfig.delayMs);
    const body = (await request.json()) as { loginId?: string; password?: string };
    const user = getDb().users.find(
      (u) => u.loginId === body.loginId && u.password === body.password,
    );
    if (!user)
      return errorResponse(401, "INVALID_CREDENTIALS", "아이디 또는 비밀번호가 올바르지 않습니다.");
    setSessionUserId(user.id);
    return HttpResponse.json({ user: toMe(user) });
  }),

  http.post(`${B}/auth/logout`, async () => {
    setSessionUserId(null);
    return new HttpResponse(null, { status: 204 });
  }),

  // 탈퇴(백엔드와 같은 규칙): 비밀번호 확인 → 글·댓글 삭제, 아이디·닉네임 익명화, 세션 종료 → 204
  http.delete(`${B}/me`, async ({ request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const body = (await request.json()) as { password?: string };
    if (body.password !== user.password)
      return errorResponse(403, "WRONG_PASSWORD", "비밀번호가 올바르지 않습니다.");
    const db = getDb();
    const myPostIds = new Set(db.posts.filter((p) => p.authorId === user.id).map((p) => p.id));
    db.posts = db.posts.filter((p) => !myPostIds.has(p.id));
    const myCommentIds = new Set(
      db.comments.filter((c) => c.authorId === user.id).map((c) => c.id),
    );
    db.comments = db.comments.filter(
      (c) =>
        !myPostIds.has(c.postId) &&
        !myCommentIds.has(c.id) &&
        !(c.parentId != null && myCommentIds.has(c.parentId)),
    );
    db.notifications = db.notifications.filter((n) => n.userId !== user.id);
    user.loginId = `deleted_${user.id}`;
    user.nickname = `탈퇴한사용자${user.id}`;
    user.password = "!deleted";
    setSessionUserId(null);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${B}/me`, async () => {
    const user = currentUser();
    if (!user) return unauthenticated();
    return HttpResponse.json(toMe(user));
  }),

  // ───── 위치 / 태그 ─────
  http.get(`${B}/locations`, async () => {
    await delay(mockConfig.delayMs);
    return HttpResponse.json({ items: getDb().locations });
  }),

  http.get(`${B}/tags`, async ({ request }) => {
    const url = new URL(request.url);
    const preset = url.searchParams.get("preset") === "true";
    const q = url.searchParams.get("q") ?? "";
    const items = getDb().tags.filter((t) => (!preset || t.isPreset) && t.name.includes(q));
    return HttpResponse.json({ items });
  }),

  http.get(`${B}/tags/suggest`, async ({ request }) => {
    if (!currentUser()) return unauthenticated();
    const q = normalizeTag(new URL(request.url).searchParams.get("q") ?? "");
    const names = new Set<string>(getDb().tags.map((t) => t.name));
    getDb().posts.forEach((p) => p.tags.forEach((t) => names.add(t)));
    const items = [...names]
      .filter((name) => q && normalizeTag(name).includes(q))
      .slice(0, 8)
      .map((name, i) => ({
        id: i + 1,
        name,
        isPreset: getDb().tags.some((t) => t.name === name),
        isCategory: false,
      }));
    return HttpResponse.json({ items });
  }),

  // ───── 사진 ─────
  http.post(`${B}/photos`, async ({ request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof Blob))
      return errorResponse(400, "VALIDATION_ERROR", "파일이 필요합니다.");
    if (file.size > 10 * 1024 * 1024)
      return errorResponse(413, "FILE_TOO_LARGE", "사진은 10MB 이하만 올릴 수 있습니다.");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      return errorResponse(415, "UNSUPPORTED_TYPE", "JPEG, PNG, WebP 형식만 올릴 수 있습니다.");
    }
    const db = getDb();
    const photoId = db.nextIds.photo++;
    // 데이터 URL로 보관해 새로고침 전까지 미리보기가 유지된다.
    const url = await blobToDataUrl(file);
    db.photos.push({ photoId, url, width: 640, height: 480, ownerId: user.id, postId: null });
    return HttpResponse.json({ photoId, url, width: 640, height: 480 }, { status: 201 });
  }),

  http.delete(`${B}/photos/:id`, async ({ params }) => {
    const user = currentUser();
    if (!user) return unauthenticated();
    const db = getDb();
    const idx = db.photos.findIndex(
      (p) => p.photoId === Number(params.id) && p.ownerId === user.id,
    );
    if (idx < 0) return errorResponse(404, "NOT_FOUND", "사진을 찾을 수 없습니다.");
    db.photos.splice(idx, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // ───── 글 ─────
  http.get(`${B}/posts`, async ({ request }) => {
    await delay(mockConfig.delayMs);
    if (!currentUser()) return unauthenticated();
    const url = new URL(request.url);
    const type = url.searchParams.get("type");
    const status = url.searchParams.get("status");
    const locationId = url.searchParams.get("locationId");
    const buildingId = url.searchParams.get("buildingId");
    const tag = url.searchParams.get("tag");
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const db = getDb();
    const filtered = db.posts
      .filter((p) => p.status !== "CLOSED" || status === "CLOSED")
      .filter((p) => (!type || p.type === type) && (!status || p.status === status))
      .filter((p) => !locationId || p.locationId === Number(locationId))
      .filter(
        (p) =>
          !buildingId || db.locations.find((l) => l.id === p.locationId)?.buildingId === buildingId,
      )
      .filter((p) => !tag || p.tags.includes(tag))
      .filter(
        (p) => !q || p.title.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const page = paginate(filtered, url);
    return HttpResponse.json({ items: page.items.map(toCard), nextCursor: page.nextCursor });
  }),

  http.post(`${B}/posts`, async ({ request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const body = (await request.json()) as Record<string, unknown>;
    const fields = validatePost(body);
    if (Date.parse(String(body.occurredAt)) > Date.now() + 60_000) {
      return errorResponse(400, "FUTURE_TIME", "미래 시각은 입력할 수 없습니다.", {
        occurredAt: "미래 시각은 입력할 수 없습니다.",
      });
    }
    if (Object.keys(fields).length)
      return errorResponse(400, "VALIDATION_ERROR", "입력값을 확인해 주세요.", fields);
    const db = getDb();
    const photoIds = (body.photoIds as number[] | undefined) ?? [];
    if (photoIds.some((id) => !db.photos.some((p) => p.photoId === id && p.ownerId === user.id))) {
      return errorResponse(422, "PHOTO_NOT_OWNED", "사진을 사용할 수 없습니다. 다시 올려 주세요.");
    }
    const tags = [
      ...new Set(((body.tags as string[] | undefined) ?? []).map(normalizeTag).filter(Boolean)),
    ];
    const post: MockPost = {
      id: db.nextIds.post++,
      type: body.type as MockPost["type"],
      title: String(body.title).trim(),
      description: String(body.description),
      status: "OPEN",
      matchState: "PENDING",
      occurredAt: String(body.occurredAt),
      locationId: Number(body.locationId),
      locationText:
        typeof body.locationText === "string" && body.locationText.trim()
          ? body.locationText.trim()
          : null,
      lat: typeof body.lat === "number" ? body.lat : null,
      lng: typeof body.lng === "number" ? body.lng : null,
      storagePlace: typeof body.storagePlace === "string" ? body.storagePlace.trim() : null,
      hiddenFeatures:
        typeof body.hiddenFeatures === "string" && body.hiddenFeatures.trim()
          ? body.hiddenFeatures.trim()
          : null,
      photoIds,
      tags,
      authorId: user.id,
      createdAt: new Date().toISOString(),
    };
    db.posts.push(post);
    photoIds.forEach((id) => {
      const photo = db.photos.find((p) => p.photoId === id);
      if (photo) photo.postId = post.id;
    });
    // 실서버는 비동기 매칭이 PENDING → DONE 으로 바뀐다. 목에서는 잠시 후 DONE 처리한다.
    setTimeout(() => {
      post.matchState = "DONE";
    }, 3000);
    return HttpResponse.json(toDetail(post, user.id), { status: 201 });
  }),

  http.get(`${B}/posts/:id`, async ({ params }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const post = getDb().posts.find((p) => p.id === Number(params.id));
    if (!post) return errorResponse(404, "NOT_FOUND", "글을 찾을 수 없습니다.");
    return HttpResponse.json(toDetail(post, user.id));
  }),

  http.patch(`${B}/posts/:id`, async ({ params, request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const post = getDb().posts.find((p) => p.id === Number(params.id));
    if (!post) return errorResponse(404, "NOT_FOUND", "글을 찾을 수 없습니다.");
    if (post.authorId !== user.id) return errorResponse(403, "FORBIDDEN", "수정 권한이 없습니다.");
    if (post.status === "CLOSED" || post.status === "RETURNED") {
      return errorResponse(409, "POST_CLOSED", "종료된 글은 수정할 수 없습니다.");
    }
    const body = (await request.json()) as Record<string, unknown>;
    if (body.locationText !== undefined) {
      const isEtc =
        getDb().locations.find((l) => l.id === post.locationId)?.buildingId === ETC_BUILDING_ID;
      const text = typeof body.locationText === "string" ? body.locationText.trim() : "";
      const error = isEtc ? locationTextError(text) : "기타 위치에서만 입력할 수 있습니다.";
      if (error)
        return errorResponse(400, "VALIDATION_ERROR", "입력값을 확인해 주세요.", {
          locationText: error,
        });
      post.locationText = text;
    }
    if (typeof body.title === "string") post.title = body.title.trim();
    if (typeof body.description === "string") post.description = body.description;
    if (Array.isArray(body.tags))
      post.tags = [...new Set((body.tags as string[]).map(normalizeTag).filter(Boolean))];
    if (typeof body.storagePlace === "string") post.storagePlace = body.storagePlace.trim();
    if (typeof body.hiddenFeatures === "string")
      post.hiddenFeatures = body.hiddenFeatures.trim() || null;
    return HttpResponse.json(toDetail(post, user.id));
  }),

  http.post(`${B}/posts/:id/status`, async ({ params, request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const post = getDb().posts.find((p) => p.id === Number(params.id));
    if (!post) return errorResponse(404, "NOT_FOUND", "글을 찾을 수 없습니다.");
    if (post.authorId !== user.id) return errorResponse(403, "FORBIDDEN", "권한이 없습니다.");
    const body = (await request.json()) as { status?: string };
    if (body.status !== "CLOSED" || post.status === "CLOSED" || post.status === "RETURNED") {
      return errorResponse(409, "INVALID_TRANSITION", "변경할 수 없는 상태입니다.");
    }
    post.status = "CLOSED";
    return HttpResponse.json(toDetail(post, user.id));
  }),

  http.delete(`${B}/posts/:id`, async ({ params }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const post = getDb().posts.find((p) => p.id === Number(params.id));
    if (!post) return errorResponse(404, "NOT_FOUND", "글을 찾을 수 없습니다.");
    if (post.authorId !== user.id) return errorResponse(403, "FORBIDDEN", "권한이 없습니다.");
    // 계약(DELETE /posts/{id}): 작성자 본인 글을 상태와 무관하게 즉시 영구 삭제 → 204. 이미 없으면 404(멱등 아님).
    // 진행 중인 인수(REQUESTED/VERIFIED)가 있으면 409 ACTIVE_HANDOVER. '종료'는 POST /posts/{id}/status.
    const db = getDb();
    const active = db.handovers.some(
      (h) => h.postId === post.id && (h.status === "REQUESTED" || h.status === "VERIFIED"),
    );
    if (active) {
      return errorResponse(
        409,
        "ACTIVE_HANDOVER",
        "진행 중인 인수 요청이 있어 삭제할 수 없습니다. 먼저 인수를 완료하거나 거절해 주세요.",
      );
    }
    db.posts = db.posts.filter((p) => p.id !== post.id);
    db.comments = db.comments.filter((c) => c.postId !== post.id);
    db.matches = db.matches.filter((x) => x.lostPostId !== post.id && x.foundPostId !== post.id);
    db.notifications = db.notifications.filter((n) => n.target.postId !== post.id);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${B}/me/posts`, async ({ request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const url = new URL(request.url);
    const type = url.searchParams.get("type");
    const status = url.searchParams.get("status");
    const mine = getDb()
      .posts.filter(
        (p) =>
          p.authorId === user.id && (!type || p.type === type) && (!status || p.status === status),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const page = paginate(mine, url);
    return HttpResponse.json({ items: page.items.map(toCard), nextCursor: page.nextCursor });
  }),

  http.get(`${B}/users/:id`, async ({ params }) => {
    if (!currentUser()) return unauthenticated();
    const target = getDb().users.find((u) => u.id === Number(params.id));
    if (!target) return errorResponse(404, "NOT_FOUND", "사용자를 찾을 수 없습니다.");
    const postCount = getDb().posts.filter(
      (p) => p.authorId === target.id && (p.status === "OPEN" || p.status === "MATCHED"),
    ).length;
    return HttpResponse.json({
      id: target.id,
      nickname: target.nickname,
      createdAt: target.createdAt,
      postCount,
      isBlockedByMe: getDb().blocks.some(
        (b) => b.blockerId === currentUser()!.id && b.blockedId === target.id,
      ),
    });
  }),

  http.get(`${B}/users/:id/posts`, async ({ params, request }) => {
    if (!currentUser()) return unauthenticated();
    const posts = getDb()
      .posts.filter(
        (p) => p.authorId === Number(params.id) && (p.status === "OPEN" || p.status === "MATCHED"),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const page = paginate(posts, new URL(request.url));
    return HttpResponse.json({ items: page.items.map(toCard), nextCursor: page.nextCursor });
  }),
];

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
