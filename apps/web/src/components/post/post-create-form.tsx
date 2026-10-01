"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { useToast } from "@/components/ui/toast";
import { postKeys } from "@/features/posts/queries";
import { postCreateSchema, type PostCreateValues } from "@/features/posts/schemas";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { PostType } from "@/lib/api/types";
import { toLocalInputValue } from "@/lib/format";
import { LocationPicker } from "./location-picker";
import { OccurredAtPicker } from "./occurred-at-picker";
import { PhotoPicker, type PickedPhoto } from "./photo-picker";
import { TagInput } from "./tag-input";

const FIELD_NAMES = [
  "type",
  "title",
  "description",
  "locationId",
  "locationText",
  "occurredAt",
  "tags",
  "storagePlace",
  "hiddenFeatures",
] as const;
type FieldName = (typeof FIELD_NAMES)[number];

export function PostCreateForm({ initialType }: { initialType: PostType }) {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  // 입력 기본값은 "지금". 렌더마다 바뀌지 않도록 한 번만 계산한다.
  const now = useMemo(() => new Date(), []);
  const nowValue = useMemo(() => toLocalInputValue(now), [now]);

  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors },
  } = useForm<PostCreateValues>({
    resolver: zodResolver(postCreateSchema),
    defaultValues: {
      type: initialType,
      title: "",
      description: "",
      occurredAt: nowValue,
      tags: [],
      storagePlace: "",
      hiddenFeatures: "",
      locationText: "",
      needsLocationText: false,
    },
  });

  const type = useWatch({ control, name: "type" });
  const locationText = useWatch({ control, name: "locationText" }) ?? "";
  const isLost = type === "LOST";
  const uploading = photos.some((p) => p.status === "uploading");
  const failedPhotos = photos.filter((p) => p.status === "error").length;

  const create = useMutation({
    mutationFn: (values: PostCreateValues) =>
      api.posts.create({
        type: values.type,
        title: values.title,
        description: values.description,
        locationId: values.locationId,
        // 기타 위치일 때만 보낸다(서버는 다른 위치의 locationText 를 거부한다).
        ...(values.needsLocationText && values.locationText
          ? { locationText: values.locationText }
          : {}),
        occurredAt: new Date(values.occurredAt).toISOString(),
        tags: values.tags,
        ...(values.type === "FOUND"
          ? {
              storagePlace: values.storagePlace,
              ...(values.hiddenFeatures ? { hiddenFeatures: values.hiddenFeatures } : {}),
            }
          : {}),
        photoIds: photos.flatMap((p) => (p.status === "done" && p.photoId ? [p.photoId] : [])),
      }),
    onSuccess: (post) => {
      queryClient.invalidateQueries({ queryKey: postKeys.all });
      toast.show(
        isLost
          ? "분실글을 등록했어요. 비슷한 글을 찾아볼게요."
          : "습득글을 등록했어요. 비슷한 분실글을 찾아볼게요.",
      );
      router.replace(`/posts/${post.id}`);
    },
    onError: (error) => {
      if (!isApiError(error))
        return setFormError("글을 등록하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      if (error.fields) {
        for (const [name, message] of Object.entries(error.fields)) {
          if ((FIELD_NAMES as readonly string[]).includes(name))
            setError(name as FieldName, { message });
        }
      }
      setFormError(
        error.code === "RATE_LIMITED"
          ? "오늘 작성 가능한 글 수를 넘었어요. 내일 다시 시도해 주세요."
          : error.message,
      );
    },
  });

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    if (uploading) return setFormError("사진을 올리는 중이에요. 잠시 후 다시 눌러 주세요.");
    if (failedPhotos > 0)
      return setFormError("올리지 못한 사진이 있어요. 삭제하거나 다시 올려 주세요.");
    create.mutate(values);
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={isLost ? "잃어버렸어요" : "주웠어요"}
        subtitle={
          isLost
            ? "물건 정보를 남기면 비슷한 습득글을 찾아 드려요."
            : "주운 물건 정보를 남기면 비슷한 분실글을 찾아 드려요."
        }
      />

      <form onSubmit={onSubmit} noValidate className="card flex flex-col gap-6 p-5 sm:p-8">
        <fieldset className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1.5">
          <legend className="sr-only">글 유형</legend>
          {(["LOST", "FOUND"] as const).map((t) => (
            <label
              key={t}
              className={`flex min-h-11 cursor-pointer items-center justify-center rounded-lg text-sm font-semibold transition-[background-color,color] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-600 ${
                type === t
                  ? "bg-brand-600 text-white shadow-sm"
                  : "text-zinc-600 hover:text-zinc-900"
              }`}
            >
              <input type="radio" value={t} {...register("type")} className="sr-only" />
              {t === "LOST" ? "분실" : "습득"}
            </label>
          ))}
        </fieldset>

        <PhotoPicker photos={photos} onChange={(updater) => setPhotos(updater)} />

        <Field label="제목" error={errors.title?.message} required>
          {(p) => (
            <input
              {...p}
              {...register("title")}
              maxLength={50}
              placeholder={
                isLost ? "예: 검은색 에어팟 케이스를 잃어버렸어요" : "예: 검은 케이스 주웠습니다"
              }
              className={inputClass}
            />
          )}
        </Field>

        <Controller
          control={control}
          name="locationId"
          render={({ field }) => (
            <LocationPicker
              label={isLost ? "분실 위치" : "습득 위치"}
              value={field.value ?? null}
              onChange={(id, isEtc) => {
                field.onChange(id ?? undefined);
                setValue("needsLocationText", isEtc);
              }}
              error={errors.locationId?.message}
              locationText={locationText}
              onLocationTextChange={(text) =>
                setValue("locationText", text, { shouldValidate: Boolean(errors.locationText) })
              }
              locationTextError={errors.locationText?.message}
            />
          )}
        />

        <Controller
          control={control}
          name="occurredAt"
          render={({ field }) => (
            <OccurredAtPicker
              label={isLost ? "분실 일시" : "습득 일시"}
              value={field.value}
              onChange={field.onChange}
              error={errors.occurredAt?.message}
              now={now}
            />
          )}
        />

        <Controller
          control={control}
          name="tags"
          render={({ field }) => (
            <TagInput value={field.value} onChange={field.onChange} error={errors.tags?.message} />
          )}
        />

        <Field
          label="설명"
          error={errors.description?.message}
          hint="물건의 색·브랜드·특징을 적어 주세요."
          required
        >
          {(p) => (
            <textarea
              {...p}
              {...register("description")}
              rows={5}
              maxLength={1000}
              className={`${inputClass} py-3`}
            />
          )}
        </Field>

        {!isLost && (
          <>
            <Field
              label="현재 보관 장소"
              error={errors.storagePlace?.message}
              hint="예: 제가 가지고 있어요 / 학생회관 안내데스크"
              required
            >
              {(p) => (
                <input
                  {...p}
                  {...register("storagePlace")}
                  maxLength={100}
                  className={inputClass}
                />
              )}
            </Field>
            <Field
              label="비공개 특징"
              error={errors.hiddenFeatures?.message}
              hint="다른 사람에게는 보이지 않아요. 주인 확인용으로 쪽지에서 물어볼 특징을 적어 두세요."
            >
              {(p) => (
                <textarea
                  {...p}
                  {...register("hiddenFeatures")}
                  rows={3}
                  maxLength={300}
                  className={`${inputClass} py-3`}
                />
              )}
            </Field>
          </>
        )}

        {formError && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {formError}
          </p>
        )}

        <Button type="submit" size="lg" loading={create.isPending} disabled={uploading}>
          {uploading ? "사진 올리는 중…" : "등록하기"}
        </Button>
      </form>
    </div>
  );
}
