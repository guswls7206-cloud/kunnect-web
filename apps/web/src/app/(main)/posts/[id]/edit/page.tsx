"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { TagInput } from "@/components/post/tag-input";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState, Spinner } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { postKeys, usePostDetail } from "@/features/posts/queries";
import { postEditSchema, type PostEditValues } from "@/features/posts/schemas";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import { parsePositiveIntId } from "@/lib/ids";
import { ETC_BUILDING_ID, LOCATION_TEXT_MAX, type PostDetail } from "@/lib/api/types";

function EditForm({ post }: { post: PostDetail }) {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const isFound = post.type === "FOUND";
  // 위치는 바꿀 수 없지만, 기타 위치 글은 직접 입력한 장소(locationText)를 고칠 수 있다.
  const isEtc = post.location.buildingId === ETC_BUILDING_ID;

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<PostEditValues>({
    resolver: zodResolver(postEditSchema),
    defaultValues: {
      type: post.type,
      title: post.title,
      description: post.description,
      tags: post.tags,
      storagePlace: post.storagePlace ?? "",
      hiddenFeatures: post.hiddenFeatures ?? "",
      locationText: post.locationText ?? "",
      needsLocationText: isEtc,
    },
  });

  const save = useMutation({
    mutationFn: (values: PostEditValues) =>
      api.posts.update(post.id, {
        title: values.title,
        description: values.description,
        tags: values.tags,
        ...(isEtc ? { locationText: values.locationText } : {}),
        ...(isFound
          ? { storagePlace: values.storagePlace, hiddenFeatures: values.hiddenFeatures }
          : {}),
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(postKeys.detail(post.id), updated);
      queryClient.invalidateQueries({ queryKey: postKeys.all });
      toast.show("글을 수정했어요.");
      router.replace(`/posts/${post.id}`);
    },
    onError: (error) => {
      setFormError(
        isApiError(error, 409)
          ? "종료된 글은 수정할 수 없어요."
          : isApiError(error)
            ? error.message
            : "수정하지 못했습니다.",
      );
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="글 수정" />
      <form
        onSubmit={handleSubmit((values) => {
          setFormError(null);
          save.mutate(values);
        })}
        noValidate
        className="card flex flex-col gap-6 p-5 sm:p-8"
      >
        <p className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-zinc-700">
          유형·위치·일시·사진은 수정할 수 없어요. 수정하면 비슷한 글을 다시 찾아요.
        </p>

        <Field label="제목" error={errors.title?.message} required>
          {(p) => <input {...p} {...register("title")} maxLength={50} className={inputClass} />}
        </Field>

        {isEtc && (
          <Field
            label="장소"
            error={errors.locationText?.message}
            hint="위치가 기타인 글은 장소를 고칠 수 있어요."
            required
          >
            {(p) => (
              <input
                {...p}
                {...register("locationText")}
                maxLength={LOCATION_TEXT_MAX}
                placeholder="장소를 직접 입력해 주세요"
                className={inputClass}
              />
            )}
          </Field>
        )}

        <Controller
          control={control}
          name="tags"
          render={({ field }) => (
            <TagInput value={field.value} onChange={field.onChange} error={errors.tags?.message} />
          )}
        />

        <Field label="설명" error={errors.description?.message} required>
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

        {isFound && (
          <>
            <Field label="현재 보관 장소" error={errors.storagePlace?.message} required>
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
              hint="다른 사람에게는 보이지 않아요."
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

        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" size="lg" onClick={() => router.back()}>
            취소
          </Button>
          <Button type="submit" size="lg" loading={save.isPending}>
            저장
          </Button>
        </div>
      </form>
    </div>
  );
}

export default function EditPostPage() {
  const parsedId = parsePositiveIntId(useParams<{ id: string }>().id);
  const { data: post, isPending, error, refetch } = usePostDetail(parsedId ?? 0);

  const notFound = (
    <ErrorState
      variant="notice"
      title="게시글을 찾을 수 없어요"
      message="삭제되었거나 주소가 잘못되었어요."
    />
  );
  if (parsedId === null) return notFound;
  if (isPending) return <Spinner />;
  if (error || !post) {
    return isApiError(error, 404) ? (
      notFound
    ) : (
      <ErrorState message="글을 불러오지 못했습니다." onRetry={() => refetch()} />
    );
  }
  // 권한·상태 때문에 수정할 수 없는 경우는 오류가 아니므로 빨간 오류 대신 중립 톤 안내로 보여 준다.
  const backToPost = { href: `/posts/${post.id}`, label: "글로 돌아가기" };
  if (!post.isMine) {
    return (
      <ErrorState
        variant="notice"
        title="수정할 수 없어요"
        icon="lock"
        action={backToPost}
        message="내가 쓴 글만 수정할 수 있어요."
      />
    );
  }
  if (post.status === "CLOSED" || post.status === "RETURNED") {
    return (
      <ErrorState
        variant="notice"
        title="수정할 수 없어요"
        icon="lock"
        action={backToPost}
        message="종료되었거나 반환이 끝난 글은 수정할 수 없어요."
      />
    );
  }
  return <EditForm post={post} />;
}
