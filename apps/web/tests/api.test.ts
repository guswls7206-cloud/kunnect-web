import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";

describe("API 클라이언트 + 목 서버", () => {
  it("로그인 전에는 /me 가 401 UNAUTHENTICATED 를 던진다", async () => {
    await expect(api.me.get()).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("잘못된 자격 증명은 INVALID_CREDENTIALS", async () => {
    await expect(
      api.auth.login({ loginId: "demo_a", password: "wrong-password" }),
    ).rejects.toMatchObject({
      status: 401,
      code: "INVALID_CREDENTIALS",
    });
  });

  it("로그인 후 /me 와 글 목록을 가져온다", async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
    const me = await api.me.get();
    expect(me.nickname).toBe("데모A");
    const lost = await api.posts.list({ type: "LOST" });
    expect(lost.items.length).toBeGreaterThan(0);
    expect(lost.items.every((p) => p.type === "LOST")).toBe(true);
  });

  it("커서 페이지네이션이 동작한다", async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
    const first = await api.posts.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await api.posts.list({ limit: 2, cursor: first.nextCursor });
    expect(second.items[0].id).not.toBe(first.items[0].id);
  });

  it("가입 시 중복 아이디는 409 LOGIN_ID_TAKEN", async () => {
    const error = await api.auth
      .signup({ loginId: "demo_a", password: "password1", nickname: "새닉네임" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "LOGIN_ID_TAKEN" });
  });

  it("가입 입력 규칙 위반은 fields 와 함께 400", async () => {
    const error = await api.auth
      .signup({ loginId: "A", password: "short", nickname: "x" })
      .catch((e) => e);
    expect(error).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(Object.keys(error.fields)).toEqual(
      expect.arrayContaining(["loginId", "password", "nickname"]),
    );
  });

  it("습득글은 보관 장소가 없으면 400", async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
    const error = await api.posts
      .create({
        type: "FOUND",
        title: "제목",
        description: "설명",
        locationId: 1,
        occurredAt: new Date().toISOString(),
        tags: [],
        photoIds: [],
      })
      .catch((e) => e);
    expect(error.fields).toHaveProperty("storagePlace");
  });

  it("글 작성 후 상세에서 조회되고 태그가 정규화된다", async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
    const post = await api.posts.create({
      type: "LOST",
      title: "테스트 글",
      description: "설명",
      locationId: 1,
      occurredAt: new Date().toISOString(),
      tags: ["Black Case", "지갑"],
      photoIds: [],
    });
    const detail = await api.posts.get(post.id);
    expect(detail.isMine).toBe(true);
    expect(detail.tags).toEqual(["blackcase", "지갑"]);
  });

  it("다른 사람 글의 비공개 특징은 숨겨진다", async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
    const detail = await api.posts.get(2); // demo_b 의 습득글
    expect(detail.hiddenFeatures).toBeNull();
  });

  describe("기타 위치(locationText)", () => {
    const base = {
      type: "LOST" as const,
      title: "제목",
      description: "설명",
      occurredAt: new Date().toISOString(),
      tags: [],
      photoIds: [],
    };
    const etcId = async () =>
      (await api.meta.locations()).items.find((l) => l.buildingId === "etc")!.id;

    it("위치 목록은 사용자 지정 12곳이고 마지막이 기타다", async () => {
      const names = (await api.meta.locations()).items.map((l) => l.buildingName);
      expect(names).toHaveLength(12);
      expect(names[0]).toBe("학생회관");
      expect(names.at(-1)).toBe("기타");
    });

    it("기타인데 장소가 없으면 400, 있으면 저장되고 카드·상세에 함께 내려온다", async () => {
      await api.auth.login({ loginId: "demo_a", password: "demo1234" });
      const locationId = await etcId();
      const error = await api.posts.create({ ...base, locationId }).catch((e) => e);
      expect(error.fields).toEqual({ locationText: "장소를 입력해 주세요." });
      const post = await api.posts.create({ ...base, locationId, locationText: "  체육관 앞  " });
      expect(post.locationText).toBe("체육관 앞");
      const card = (await api.posts.list({ buildingId: "etc" })).items.find(
        (c) => c.id === post.id,
      );
      expect(card).toMatchObject({ locationName: "기타", locationText: "체육관 앞" });
    });

    it("기타가 아닌 위치에 장소를 보내면 400", async () => {
      await api.auth.login({ loginId: "demo_a", password: "demo1234" });
      const error = await api.posts
        .create({ ...base, locationId: 1, locationText: "x" })
        .catch((e) => e);
      expect(error.fields).toEqual({ locationText: "기타 위치에서만 입력할 수 있습니다." });
    });

    it("수정: 기타 글만 장소를 고칠 수 있다", async () => {
      await api.auth.login({ loginId: "demo_a", password: "demo1234" });
      // 시드 6번은 demo_a 의 기타 위치 글, 1번은 학생회관 글
      expect((await api.posts.update(6, { locationText: "체육관 뒤" })).locationText).toBe(
        "체육관 뒤",
      );
      expect(await api.posts.update(6, { locationText: " " }).catch((e) => e.fields)).toEqual({
        locationText: "장소를 입력해 주세요.",
      });
      expect(await api.posts.update(1, { locationText: "x" }).catch((e) => e.fields)).toEqual({
        locationText: "기타 위치에서만 입력할 수 있습니다.",
      });
    });
  });
});
